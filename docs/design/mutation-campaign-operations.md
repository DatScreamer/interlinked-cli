# Mutation campaign — operating constraints

Written 2026-08-05 after building the local mutation pipeline. Everything here
is measured, not assumed; each item cost a failed run to learn.

## What parallelizes, and what must not

Per-file work parallelizes. Anything touching shared state serializes.

| Parallel | Limit |
|---|---|
| Mutation measurement across files | **Cores.** One run saturates ~3-4 of a 10-core box, so 2-3 shards, not 10. Tune with `INTERLINKED_STRYKER_CONCURRENCY`. |
| Agents writing tests | Inference-bound. Effectively unlimited — the cheap axis. |
| Corpus adjudication | Each check's hits are independent. |
| Adversarial input construction | Proven: 6 agents over disjoint batches. |

| Sequential | Why |
|---|---|
| Manifest merge | N processes folding one JSON = lost update. Shards write isolated reports; **one** merge folds them. |
| Baseline / water-line updates | Compare-and-swap on a single file. |
| Full `vitest run --coverage` | A scoped coverage run overwrites the shared report — the bug behind 3748 phantom findings. |
| The loop within one file | measure → harden → re-measure → accept is a strict chain. |

## Memory is the binding constraint, not CPU

A single Stryker run reached **1.36 GB RSS**; one launched with an 8 GB heap
starved the machine and silently killed three unrelated full-suite runs. Two
concurrent runs, or one run plus a full suite, reliably OOM.

Consequences:
- Never run an ad-hoc measurement while a sweep is active.
- The runner needs a **semaphore (2 slots)**, not a global lock — sweep shards
  are supposed to run 2-wide. Not yet built.
- On failure the runner must preserve the child's FULL stderr. It currently
  truncates at 300 chars, which cut off V8's `<--- Last few GCs --->` banner and
  made an OOM indistinguishable from "this file cannot be measured".

## The sandbox: use Stryker's DEFAULT temp dir

Four attempts, three wrong. Recorded because each wrong answer looked correct:

| tempDirName | Rationale | What actually happened |
|---|---|---|
| per-run dir in repo | isolate shards from each other | never cleaned → **5.8 GB** across 18 runs → OOM killed unrelated jobs |
| OS temp dir (out of repo) | keep the daemon from indexing copies | **every run reported "No tests were executed"** — Stryker resolves the vitest config and module paths relative to the sandbox |
| `.stryker-tmp/<runId>` | in-repo *and* under the always-ignored name | Stryker's auto-ignore keys off the CONFIGURED dir, so each run ignored only its OWN sandbox and copied its siblings' → recursive `.stryker-tmp/A/sandbox/.stryker-tmp/B/sandbox/...` and ENOENT when a sibling was cleaned mid-copy |
| **default `.stryker-tmp`** | — | ✅ 0 errors, self-cleaning, stays ~120 KB |

The custom `tempDirName` was solving a problem that does not exist: Stryker already
creates a unique `sandbox-XXXX` per run. Every failure came from stacking isolation
on top of isolation.

Corollary: **never delete the sandbox root from inside a run.** With the shared
default dir, that destroys a concurrent shard's sandbox. Stryker removes its own
sandbox on success and keeps it on failure; reclaim leftovers between passes.

## A red suite emits NO coverage report

`vitest run --coverage` skips report generation entirely when any test fails —
no `coverage/` directory, no text summary, no error. Measured 2026-08-05: two
full runs (~470s and ~350s) each executed all 27,948 tests, printed the failure
summary, and wrote nothing. With 7 failures out of 27,948 that reads as a crash
during report generation, and the first diagnosis was an OOM — the machine was
genuinely low on memory and `lcov` over 584 files is the expensive reporter, so
the wrong explanation fit the evidence perfectly.

The tell that separates them: a scoped run over one PASSING file prints its
summary in 5s. If that works, the report path is fine and the failures are the
cause. Check `^ FAIL` in the log before blaming memory.

Corollary for the timing tests: **five of the seven failures were load
artifacts** (30s–147s timeouts on subprocess-spawning tests under a 4x-loaded
box), so a coverage run can fail purely because it is a coverage run, and then
withhold the number it was launched to produce. Green the suite first, measure
second.

## Agents leave mutants applied — verify independently, by staleness

The most accurate way for an agent to confirm a kill is to apply the mutant, watch
its test fail, and restore. That method also puts corrupted code in `src/` as a
routine step, so any interruption strands it.

Measured 2026-08-05 over ~20 agents: **3 mutants left applied**, ~15% leak rate on
a step every agent was explicitly instructed to perform AND to prove with
`git diff --stat`. Several of those agents reported `source_unmodified: true`.
An agent's attestation about filesystem state is unverifiable from inside the
agent, so it degrades into a statement of intent. Only an outside check is real.

What was stranded, and why each would have survived review:

| File | Mutant | Why it hides |
|---|---|---|
| `verify/suppressions.ts` | `idx === -1` → `idx + 1 === -1` | typechecks; the not-found guard silently never fires |
| `commands/status.ts` | object literal → `{} as ServerStatus` | the cast the agent added to satisfy tsc also silences tsc |
| `experience/build.ts` | `return …` DELETED from a `case` | pure fallthrough — legal TS, no diagnostic, corrupts counts downstream |

**Detect by staleness and size, never by ownership.** Four detector revisions were
wasted trying to attribute a dirty file to an agent: workflow agents are
enumerable from the transcript dir, `Agent`-tool dispatches are not, so every
attribution scheme had a blind spot and produced false alarms on live
mid-verify edits (nearly reverting a working agent's state).

The version that works ignores identity:

    dirty non-test src file  AND  mtime >= 20 min  AND  added lines <= 3

A mutant is applied for seconds and is 0-3 lines; authored work is 8-97 lines and
is being touched. Note the deletion mutant scored **+0**, so bound on *added*
lines, not total diff size. Same principle as stale-lock detection: age is
observable, liveness is not.

## Repo-wide gates deadlock a parallel wave

Measured 2026-08-05 during a 20-agent mutation wave. Two agents produced ZERO
work — 188 survivors untouched — and their notes named the cause: every `Edit`,
against their own assigned file, was refused by the `transient-debt` pre-block
gate because an UNRELATED file carried a `TS2532`. The strike counter climbed
across retries while the agent had no legal way to comply: the offending file
belonged to a different agent and was explicitly out of scope.

The gate is correct for one agent — it stops you deferring type debt
indefinitely. Under parallelism the same rule is a single point of failure:
**one agent's in-flight breakage deadlocks every other agent, and the victims
cannot clear it.** Scope debt to the acting agent's own files, or exempt files
another session currently owns, before running any wide fan-out.

The upstream cause compounds it. The daemon had thrashed itself down
(2015 `anti-stomp` exits in two hours — 8 concurrent agents each hook-spawning a
singleton and losing the race), so the content gate stopped enforcing and
type-broken test files landed that it would normally have blocked. The tell was
not an error message; it was files appearing on disk that a running gate would
have refused. **Gate enforcement silently depends on daemon liveness** — check
`harness status` before trusting that a wave was gated at all.

Recovery took one scoped repair agent (24 errors / 9 files → 0).

## Never measure the whole suite while mutation agents are live

Mutation agents verify by APPLYING a mutant to source, running the test, and
reverting. So at any instant during a wave, several source files are
deliberately corrupted. A concurrent full-suite or coverage run measures that
corruption.

Measured 2026-08-05: a `vitest run --coverage` launched alongside three live
agents came back with 3 failing files — all of them tests correctly failing
against a mutant that was applied at that moment (`if (bytes === 0)` →
`if (false)` in `formatBytes`). Because the suite was red, vitest emitted **no
coverage report at all**, so the run produced nothing after several minutes.

Neither symptom is a defect: the tests were right, the agents were right, the
scheduler (me) was wrong. Sequence it instead —

1. wave runs → 2. all agents stop → 3. confirm `git diff` on non-test `src/**`
   is clean → 4. full suite / coverage.

The abandoned-mutant detector (staleness + small diff) is what tells you step 3
is genuinely done rather than momentarily quiet.

**Per-file Stryker runs are NOT exempt.** A scoped run looks isolated but its
test set comes from the IMPORT GRAPH, so it routinely pulls in files another
agent is mutating. Measured 2026-08-05: measuring `commands/coverage.ts` failed
its dry run because the graph-selected scope included
`commands/adopt-steps.test.ts`, whose source was mutated at that moment by a live
agent on an unrelated file. The two share nothing by name — only a test
neighborhood.

Consequence: during a wave, you may measure ONLY files whose entire
import-graph scope is untouched by any live agent, which in practice means
serializing measurement behind the wave. Budget for that; it is why
measure-before-dispatch beats measure-during.

**Stronger form: a loaded box makes Stryker REPORT FAILURE, not run slow.**
A background sweep over 728 files was launched while a `chdir`-conversion agent
ran 32 test files and other commands ran ad hoc. It failed **70%** of runs (12
dry-run aborts, 5 unparseable, 2 `npx ETIMEDOUT`). Every failure was contention:
`commands/compact.ts`, which failed in the sweep, measured cleanly the moment the
machine was idle (212 mutants, 69.3%). Stryker's dry run validates that the
initial test run PASSES; a test that is merely slow under load trips that check
and aborts the whole file with the generic ConfigError.

So mutation measurement needs an otherwise-idle machine — it cannot share with
agents, test runs, or a second measurement. That is a scheduling conflict with
the hardening work, which is why a full sweep is an overnight job rather than
something to interleave.

**Cautionary note on diagnosing this.** The first hypothesis for the 70% was 32
test files matching `grep -l "process.chdir"`. Wrong: 28 of them only carried an
explanatory COMMENT mentioning chdir, converted in an earlier session. A `grep -l`
matches comments, and "32 files match" was read as "32 files are broken" without
checking whether the matches were live code. Cost: one agent-run on a non-problem.
Grep for the call, not the word — and confirm the failure reproduces in isolation
before theorising about its cause.

## Survivor data lives in two different places

- **Per-file `--record` runs** write `.interlinked/mutation-manifest.json`.
- **Sweep shards run with `record:false`** on purpose (N processes folding one JSON
  loses updates), so their survivors are in the saved report copy at
  `scratch/mutation-out/reports/<slug>.json` — NOT in the manifest.

An agent told to read the manifest for a sweep-measured file finds nothing and
works blind. One did exactly that, correctly diagnosed it, and still produced 13
useful tests — but the instruction was wrong. Point agents at the right source:

    node -e "const r=require('./scratch/mutation-out/reports/<slug>.json');const f=Object.values(r.files)[0];for(const m of f.mutants){if(m.status==='Survived')console.log(m.location.start.line,'|',m.mutatorName)}"

## Counting concurrent runs

Count DISTINCT generated config paths (`mutation-out/runs/<slug>-<pid>/`). Two
earlier attempts both over-counted and made the guard refuse real work:
matching `@stryker-mutator/core` also caught ~3 child-proxy workers (298 of 303
files refused); matching `stryker run` still caught both the `npm exec` wrapper
and the resolved binary, so two shards read as four.

## What makes an agent's kill-count accurate

Measured across ~12 hardening rounds. The arc: **claimed 24 → measured 7**, then
81→46, 10→6, and finally 21→21, 18 kills + 6 equivalent → exact, 18 + 11 → exact.

Three things produced the accurate reports, and all three are harness design
rather than model capability:

1. **Give them the real survivor list** (file + line + mutator), not a request to guess.
2. **Tell them exact-equality beats substring.** A single `toBe` on a whole
   generated output killed 21 mutants where a dozen `toContain` checks killed
   none — `toContain` is indifferent to everything around the substring, so it can
   never kill a separator or whitespace literal.
3. **Make "proven equivalent" a valid terminal answer.** Every perfectly
   calibrated report included equivalence claims; every overclaim came from an
   agent that believed it had to kill everything. A file finishing at "N
   survivors, all N proven equivalent" is DONE — that is what *unjustified* means
   in the goal.

Re-measure regardless. The gate is what makes the loop converge.

**End of the arc, measured 2026-08-05.** `src/commands/watch.ts`: agent reported
76 survivors → 61 killed, 15 proven equivalent, 0 unresolved. Central Stryker
re-measure: 482 mutants, 463 killed, **16 survived, score 96.1%** — and every one
of the 16 sits at a site the agent had proved equivalent (the `agents || []`
fallback, the 14-mutant `sortTasksForDisplay` branch-2 block, the
`rawInterval !== undefined` guard). Line numbers differ from the agent's report
only because it cited the older sweep's numbering.

Predicted 16, measured 16, same mutants. Compare the first round of this same
campaign: claimed 24, measured 7. Nothing about the model changed between those
two numbers — the three harness properties did (real survivor list; exact-equality
over substring; equivalence as a valid terminal answer). The agent that produced
the exact result is also the one that revised its own kill count DOWNWARD
mid-report after finding one claimed kill was actually equivalent.

A file finishing at "16 survivors, all 16 justified" IS zero unjustified
survivors. That is the terminal state, not a shortfall.

**But the residual bias is one-directional — measured over four files.** Same
prompt, same model, central Stryker re-measure against each agent's prediction:

| File | Agent predicted | Stryker measured | Gap |
|---|---|---|---|
| `commands/watch.ts` | 16 | 16 | 0 |
| `commands/verify/verify-tools.ts` | 1 | 3 | +2 |
| `commands/init.ts` | 7 | 10 | +3 |
| `harness/change-propagation.ts` | 13 | 18 | +5 |

Mean +2.5, **never negative.** Random error would scatter both ways; this is
bias. An agent that has reasoned hard about a mutant tends to believe it handled
it, so every miss lands in the optimistic direction. Two consequences:

1. **Never close a file on the agent's own "0 unresolved."** Budget one central
   re-measure per file; it is nearly free in tokens (a bash call, no agent) while
   the hardening pass costs ~361k. Verification is the cheap half of this loop.
2. `verify-tools.ts` got the COUNT right (1) and the SET wrong (3 measured, a
   different mutant) — so comparing counts is not enough. Compare survivor
   LOCATIONS against the claimed-equivalent set, which is how `watch.ts` was
   confirmed genuinely complete.

Scores still rose sharply on every file (≈80-84% → 95.6-98.7%). The bias is a
reason to verify, not a reason to distrust the method.

**The error lives in `already_dead`, not in `killed`.** Extending to seven files
and sorting by how many survivors the agent claimed were ALREADY dead:

| File | claimed already_dead | gap |
|---|---|---|
| `commands/watch.ts` | **0** | **0** |
| `commands/verify/verify-tools.ts` | 73 | +2 |
| `commands/mutation.ts` | 69 | +2 |
| `commands/init.ts` | 66 | +3 |
| `harness/change-propagation.ts` | 45 | +5 |
| `commands/experience/build.ts` | 93 | +8 |
| `harness/behavioral-diff-checks-oracle.ts` | 89 | +11 |

The only agent with a perfect prediction is the only one that claimed nothing was
already dead — i.e. it applied and verified every mutant individually. That is
not a coincidence about that agent; it is structural:

- a `killed` claim is *verified* (apply → watch the test fail → restore)
- an `already_dead` claim is usually *inferred* ("the existing test looks like it
  covers that line")

Inference is where the optimism enters — and it is the same mistake the whole
practice exists to catch: assuming a test that TOUCHES a line would NOTICE if the
line were wrong. Mutation testing exists precisely because that assumption is
often false, so an agent applying it to its own shortcut is self-undermining.

**Instruction for future waves:** an `already_dead` claim requires the same
apply-and-watch-it-fail evidence as a `killed` claim. Anything not verified that
way should be reported as `unresolved`, not `already_dead`.

**Confirmed prospectively, not just fitted.** `commands/verify/suppressions.ts`
was measured AFTER predicting the outcome from this rule. Its agent applied all
90 listed mutants individually (88 confirmed dead, 2 proved equivalent) and
inferred nothing. Predicted 2-3 survivors; Stryker measured **3 — at lines 49,
58 and 103, exactly the three it named**, including the `dot >= 0` edge case it
had flagged as not fitting cleanly in either bucket.

Two agents verified rather than inferred (`watch.ts`, `suppressions.ts`): gaps of
**0 and 0**. Six inferred: gaps averaging **+5.2**.

**But verification alone is not sufficient — a third agent applied every mutant
and still came in +7.** `commands/status.ts`: predicted 1 survivor, measured 8
(lines 88/89/90, 190x2, 200x2, 372). Decomposed:

- 372 — the `formatBytes` equivalent, correctly predicted
- 88/89/90 — the dead-store initializer. The agent FOUND these and described them
  accurately ("mutating the initializer to `{}` left all 82 tests green"), then
  filed them under `already_dead`. Tests staying green IS survival; the
  observation was right and the bucket was wrong.
- 190x2, 200x2 — guidance-branch conditionals, genuinely missed

So there are two independent failure modes, and applying mutants only fixes the
first:

1. **Inference** — "the test looks like it covers this" (the +5.2 class)
2. **Mis-bucketing** — observing survival, then recording it as already-dead

Mode 2 is why the report must carry EVIDENCE rather than a conclusion. Require
each `already_dead` row to name the test that failed:
`already_dead: L42 ArithmeticOperator — "formats 1024 as 1.0 KB" FAILED`.
A row that cannot name a failing test is, by definition, not already-dead — which
makes the taxonomy self-checking instead of relying on the agent's judgement at
the moment it writes the summary.

**The corrected instruction, validated prospectively on two more files.** Agents
dispatched with "an `already_dead` claim requires the same apply-and-watch-it-fail
evidence as a `killed` claim":

| File | agent predicted | Stryker measured |
|---|---|---|
| `commands/verify/suppressions.ts` | 2-3 | **3** |
| `commands/check.ts` | 10 | **10** |

`check.ts` is the load-bearing case: unlike `suppressions.ts` (where the answer was
"nothing to do"), it involved real work — 84 mutants killed, 8 tests added, 10
proved equivalent — and its agent explicitly noted that the 76 mutants killed by
pre-existing tests were "measured individually, not assumed." Exact prediction.

Running tally: agents that demanded apply-evidence of themselves went 3-for-4
exactly (`watch.ts`, `suppressions.ts`, `check.ts`; `status.ts` failed on
taxonomy, not measurement). Agents that inferred went 0-for-6.

**Corollary — measure BEFORE dispatching.** `suppressions.ts` burned ~122k tokens
to establish that the file was already fine (0 tests needed). A Stryker run costs
a bash call. Across seven measured files, 40-90% of every stale survivor list was
already dead, so roughly half of wave-1 agent spend went to re-confirming history.
Sweep first, dispatch only where survivors are real.

## Stryker configuration facts (each one cost a failed run)

- `--jsonReporter.fileName` is **rejected** on the CLI. The report path is
  settable only in a config file.
- The config file is a **positional** argument: `stryker run <configFile>`.
  `--configFile` is also rejected.
- `tempDirName` must stay **inside the repo**. Pointing it at the OS temp dir
  made every run report "No tests were executed" while the same tests passed
  standalone — Stryker resolves the vitest config and module paths relative to
  the sandbox. Use `.stryker-tmp/<runId>`: on Stryker's always-ignored list (so
  no run copies another's sandbox) and exempt from the harness pipeline via
  `isGeneratedArtifactPath`.
- An in-repo sandbox under any OTHER name is not auto-ignored, so each run
  copies the previous run's sandbox — quadratic disk plus daemon churn (~1GB
  observed, with the daemon restart-looping on its RSS ceiling).

## The dry-run killer class

Stryker's vitest runner pins its own pool (worker threads) and **overrides
`pool` set in `vitest.stryker.config.ts`**. Anything that cannot run in a worker
thread aborts the entire dry run with a generic *"There were failed tests in the
initial test run"* that names nothing at default log level.

Found instance: `process.chdir()` throws in a worker. A single such test aborted
every file whose import-graph scope contained it — invisible until the scope
widened past one companion test. Swept from 59 test files; the replacement is
`vi.spyOn(process, "cwd").mockReturnValue(dir)` (use `realpathSync(dir)` when
the test needs the canonical symlink-resolved form).

**To find the next one:** run with `--logLevel trace` and grep for
`failed in the initial test run`. Budget several minutes — a 60-file dry run is
slow, and killing it early yields nothing.

## Agent delegation

Tightly-scoped tasks ("adjudicate these 9 sites", "cover these exact lines")
returned precise results including honest refusals. One open-ended task
("diagnose and fix until green", with permission to run long jobs) consumed
~531k tokens over 551 tool calls, produced no measurement, and left a
memory-hogging process running that broke unrelated work.

Scope agent tasks to a bounded deliverable. Keep open-ended loops with
expensive side effects in the main agent.

**Never accept an agent's own count.** A careful agent reported "24 of 24
mutants killed"; re-measurement showed 7. It had not cheated — it asserted
`Option#flags` and `parseAsync` forwarding, neither of which reads
`Option#description`, and the survivors were description strings (pure data with
no other observable). Round 2, given the measured number instead of its own,
diagnosed this correctly. The gate is what makes the loop converge.
