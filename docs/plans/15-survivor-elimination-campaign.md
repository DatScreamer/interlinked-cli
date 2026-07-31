# Survivor Elimination Campaign — whole-codebase mutation hardening

**Status:** ready to execute. The per-edit mutation gate is shipped and enforcing;
this is the plan for using it to eliminate surviving mutants across the entire
codebase, one file at a time, optionally across several agents in parallel.

Companion documents: `docs/plans/10-mutation-testing.md` (why mutation testing,
phased rollout), `docs/design/per-edit-cloud-mutation-testing.md` (the gate's
architecture), `docs/design/per-edit-mutation-identity-and-manifest.md` (stable
mutant identity + manifest model). Read this one to *do the work*; read those to
understand the machinery.

**Umbrella roadmap: `docs/plans/16-monotonic-quality-enforcement.md`.** This
campaign is the tactical layer under it. Plan 16 covers the surrounding program —
the three-tier verification budget, typed survivor dispositions (which supersede
the free-text `accepted_reason` used in §5 here), property/fuzz/negative-boundary
verifiers, authority separation for accepts, anti-gaming trajectory rules, and
the conformance-suite endgame that makes mutation score double as a portability
metric. Every gap listed in §9 below is tracked there with a build order. Read
plan 16 first if you are deciding *what to build*; read this one if you are
*killing mutants today*.

## TL;DR for an agent picking this up cold

1. Pick one unmeasured/worst file from the work list (§6). Claim it (§7).
2. Read its survivors out of the manifest (§3). Understand what each proves.
3. Write tests that kill them — in the file's companion test file. The per-edit
   gate measures automatically when you edit; it blocks on NEW survivors.
4. Re-read survivors. Repeat until the remaining ones are genuinely unkillable.
5. Annotate only those as equivalent, one at a time, with a real reason (§5).
6. Run the file's tests bare, record the result, report the before/after count.

**Sequencing warning — read before a large push.** Every per-file count in §6 is
a **floor**, not a total: the manifest silently omits mutants that do not anchor
to a function symbol (§9, and the design note in plan 16's build-order section).
Landing that identity fix changes the denominator for many files. For a handful
of units the drift is harmless — measure live (§4a) and proceed. Before
committing a fleet of agents to the work list, land the identity fix and
re-sweep first, or you will harden files against undercounted baselines and
re-derive every number afterward anyway.

**The prime directive:** a surviving mutant means *a behavior no test checks*.
The fix is almost always a better test — not a weaker gate, not an annotation,
not deleting the code. You may never lower a water-line to make a gate pass
(`.interlinked/*baseline*.json`, `metric-caps.json`); the baseline-integrity
gate blocks it and doing it is the canonical gate-gaming move.

## 1. Why this campaign exists

Coverage says a line *ran*. Mutation says a line was *checked*. This repo sits at
**~71% mutation score with ~25k surviving mutants across ~735 measured files** —
and the worst offenders are the harness's own guard rules, security classifiers,
and check detectors. That is the inversion this campaign fixes: the code that
enforces quality everywhere else is the least verified code in the tree.

The flywheel: every killed mutant is a test that will catch a real regression;
every test added raises the file's floor, and the gate then enforces that floor
against all future edits, including by other agents. The work compounds.

## 2. Preconditions (verify before starting)

```bash
interlinked harness status          # daemon must be running
interlinked caps                    # effective caps + provenance
npx vitest run <one test file>      # the runner works
```

The per-edit mutation gate must be enabled with at least one reachable runner
endpoint. Configuration lives in `.interlinked/guard-rules.local.json`
(gitignored — machine-local runner endpoints and credentials never belong in
committed policy):

```json
{
  "per_edit_mutation": {
    "enabled": true,
    "mode": "block",
    "unavailable_behavior": "allow_unmeasured",
    "budget_ms": 30000,
    "harvest_budget_ms": 25000,
    "runner_url": "http://127.0.0.1:8790/"
  }
}
```

`runner_urls: []` may list additional endpoints; several runners shard the
measured file into line ranges to cut wall-clock. Endpoint count is a local
performance detail and has no effect on the survivor invariant.

**If the gate reports `[mutation:not-measured]`, that is NOT a pass.** Check
runner reachability and test selection before proceeding; a file you cannot
measure is a file you cannot harden.

## 3. Reading the survivors for a file

> **The manifest is a SNAPSHOT, not a live view.** It changes only when a
> measured pass persists it. Reading it tells you where a file stood at its last
> measurement — it will NOT reflect tests you just wrote. To get a fresh count
> you must re-measure (§4a). Reporting manifest numbers as an "after" count is a
> false claim.

The live gate's state is `.interlinked/mutation-manifest.json` (machine-local,
gitignored, regenerable). To list a file's survivors:

```bash
node -e "
const {readFileSync}=require('fs');
const f=process.argv[1];
const m=JSON.parse(readFileSync('.interlinked/mutation-manifest.json','utf8'));
const syms=m.files[f]||{};
let n=0;
for(const s of Object.values(syms))
  for(const [id,mu] of Object.entries(s.mutants))
    if(mu.status==='survived'){n++;console.log(id, s.qualifiedName, mu.mutator, JSON.stringify(mu.originalLexeme),'->',JSON.stringify(mu.replacement));}
console.log('survivors:', n);
" src/path/to/file.ts
```

Each row is a claim: *"this token could be changed to that, and your whole test
suite would still pass."* Read it as a bug report about the tests.

## 4. The per-file unit — protocol and definition of done

One file per unit. Small, self-contained, independently verifiable; the tree
stays committable after each.

1. **Measure/read** the file's survivors (§3). Record the starting count.
2. **Classify** each survivor:
   - *killable* → a test asserting the behavior the mutant changes. The default.
   - *dead code* → the mutant survives because nothing needs the code. Delete
     the code (with justification), don't test it.
   - *genuinely equivalent* → no observable behavior differs. Rare (§5).
3. **Write the tests** in the companion test file (`<name>.test.ts`). Label them
   in the repo's MUST-FIRE / MUST-NOT-FIRE convention where the file is a
   detector — the same cases also satisfy the Check Evidence Contract, so a
   single effort advances the mutation score and the evidence contract together.
4. **Know what the gate does and does not cover.** The per-edit mutation gate
   measures only when the change set contains a **product source file**
   (`primaryCodeFile` in `mutation/gate.ts` skips test paths by design). A
   **test-only edit — the normal shape of this campaign — triggers NO
   measurement.** So the gate is a safety net for source changes, not your
   progress meter; measure explicitly (§4a). When the gate *does* fire, a block
   naming a new survivor means your edit added an unchecked behavior — fix it,
   never bypass it.
5. **Verify bare:** `npx vitest run <file>.test.ts` as its own command with the
   summary visible. Piped or `;`-chained runs are NOT recorded as evidence by
   the harness and will leave the TDD state stale.
6. **Re-measure (§4a) and report before → after** with the fresh count.

## 4a. Re-measuring one file on demand

This is the step that closes the loop; without it you are guessing. A local
helper under `scratch/` (gitignored, machine-local — not part of the shipped
CLI) measures one file through the real engine using the gate's own overlay set:

```bash
npx tsx scratch/measure-file.mts src/path/to/file.ts        # prints "N mutants, M survivors"
MEASURE_RUNNER=<endpoint> npx tsx scratch/measure-file.mts src/path/to/file.ts
```

Two failure modes to recognize rather than misreport:

- **`NOT MEASURABLE: no_tests`** — the engine found no test in scope. Sometimes
  real (the file's tests live under a non-companion name), but it is ALSO what a
  stale/broken runner returns for a file that measures fine elsewhere. Retry
  against a different configured endpoint before concluding the file is
  unmeasurable, and report the discrepancy.
- **A count that did not move** after adding tests — your assertions do not
  actually distinguish the mutated behavior. Read the surviving rows again;
  the mutant tells you exactly which token is unchecked.

### If `scratch/measure-file.mts` is missing

`scratch/` is gitignored, so the helper does not survive a fresh clone or a
scratch wipe. It is ~60 lines and rebuilding it is mechanical — it POSTs one
job to a runner endpoint and prints the survivors. The contract it must honor:

1. **Overlay set = target + companion test + transitive local deps.** Build it
   with `collectLocalDeps` from `src/harness/mutation/local-deps.ts`, seeded from
   both the target and its `.test.ts` companion. Without the deps, a target that
   imports an uncommitted sibling fails to load in the runner's checkout and the
   run reports `no_tests` (that bug cost a day in 2026-07).
2. **Send an explicit whole-file `range`** (`{start: 1, end: <line count>}`).
   **This is load-bearing:** the runner adds `--incremental` only to *unranged*
   requests, and that cache replays a prior report — so an unranged measurement
   reports yesterday's survivors and makes freshly-added tests look useless.
3. **POST body:** `{ file, overlayContent, overlays, range, job_id }` to the
   runner URL (default `http://127.0.0.1:8790/`, override via an env var).
   Use a generous timeout (~300s); a whole-file measurement is slow but bounded.
4. **Response handling:** a `not_measurable: {reason, detail}` body is a 200, not
   an error — print it verbatim and exit without a count. Otherwise flatten
   `files[*].mutants[]`, count `status === "Survived"`, and print
   `"<N> mutants, <M> survivors"` followed by one line per survivor
   (`L<line>  <mutatorName> -> <replacement>`).

Print **both** numbers, always — survivor count alone is uninterpretable while
the manifest undercounts totals (§9).

**Definition of done for a unit:** survivors reduced to killable-zero (only
annotated equivalents remain), the file's tests green in a bare run, typecheck
clean, and the before/after counts stated. Do not claim a file is done on a
`not-measured` result.

## 5. Equivalence annotation — the narrow escape

Some mutants cannot be killed because no observable behavior changes (a default
arm the caller never branches on; a value nothing reads). For those only:

```bash
interlinked mutation accept \
  --file src/path/to/file.ts \
  --id <mutantId> \
  --reason "why no test can possibly kill this — mechanism, not vibes"
```

This flips the mutant to `equivalent` in the manifest with the reason recorded
in-band, so the accepted floor stays auditable. A blank reason is refused.

**Discipline — read this before accepting anything:**

- **Assume killable first.** If you can describe an input where behavior
  differs, it is killable. Write that test instead.
- **Agent-facing prose is BEHAVIOR in this repo.** A guard's `reason` /
  `suggestion` text is the only guidance an agent gets when a block fires;
  mutating it away is a real defect. Assert the load-bearing content (rule id,
  the actionable phrase, the suggested alternative) rather than accepting.
  Two message-quality defects shipped in one 2026-07 session precisely because
  no test asserted message content.
- **Never bulk-accept.** One mutant, one reason, one command. A sweep of accepts
  is indistinguishable from giving up, and it silently inflates the floor.
- **Budget:** if a file needs more than a couple of accepts, stop and escalate —
  that is a signal about the design (or about your classification), not about
  the mutants.

### Recognized survivor classes (name the class, don't improvise a reason)

Measured during the first campaign units. Naming the class is what makes a claim
checkable by someone else:

| Class | Shape | Correct resolution |
|---|---|---|
| **unchecked behavior** | the mutant changes an output nothing asserts | write the test — the default, the large majority |
| **dead code** | the mutant changes code that cannot affect any output (e.g. a guard whose value never alters the return) | **fix the source** — delete it, or implement what it was meant to do. Do NOT accept; accepting seals dead code in as "reviewed" |
| **defensive guard over an already-safe call** | forcing the guard true makes the call throw *immediately*, with no partial side effect, and the throw is swallowed by a blanket catch with nothing after it — identical end state | argue it precisely, then leave **unresolved** unless the argument is mechanical. Common in "never throws" capture/proxy modules |
| **syntactic no-op** | removing the statement provably changes nothing (`void err` → `{}`), or a type cast that cannot change a runtime value (`null as T` is still `null`) | genuinely provable; the strongest accept candidates |

**The defensive-guard class carries a hidden dependency.** Its equivalence holds
only while the surrounding control flow does: the guarded call must stay last,
and the catch must stay a pure swallow. Add one statement after the call, or make
the catch log, and the mutants become killable again — silently, because a prose
`accepted_reason` has no way to notice. Until dispositions carry invalidation
inputs, prefer leaving this class unresolved over accepting it.

## 6. Work list — waves, worst first

Counts are survivors/total at the 2026-07 baseline sweep; re-read live numbers
before starting a file (§3).

### Wave 1 — the guards (security-relevant, worst scores)

| File | Survivors | Kill strategy |
|---|---|---|
| `src/harness/rules/builtin-rules-processes.ts` | 397/398 | Extend `src/harness/__tests__/guard-corpus.test.ts` — it runs cases through the REAL `evaluatePreToolUse`. Per rule: a MUST-BLOCK command, a near-miss MUST-ALLOW, and an assertion on the block reason's load-bearing phrase. That triple kills regex, action, `enabled`, and message mutants together. |
| `src/harness/check-engine/tool-catalog.ts` | 326/513 | Table-driven: assert each entry's resolved behavior, not the table's shape. |
| `src/harness/checks/supply-chain.ts` | 281/424 | Pure classifiers (typosquat distance, license parsing) — fixture pairs on either side of every threshold. |
| `src/harness/evaluator/write-content-guards-content-quality.ts` | 232/451 | Same corpus shape as the guards. |

### Wave 2 — the detector family (dual-purpose with the Check Evidence Contract)

`src/harness/checks/ubs-language-specific/*` (`js-security-checks` 261/630,
`cross-language-checks` 242/458, `python-checks` 237/579,
`quality-smell-checks` 217/555), `src/harness/checks/agent-safety-js-correctness.ts`
(262/558), `src/harness/checks/cross-file.ts` (216/482),
`src/harness/checks/regex-interpolation.ts` (211/710),
`src/harness/checks/test-hygiene-quality.ts` (207/509).

Kill strategy is formulaic: for each detector, MUST-FIRE fixtures (one per
distinguishable branch) and MUST-NOT-FIRE fixtures (the legitimate patterns it
must not flag). Mechanical enough to delegate widely.

### Wave 3 — formatters and prose-bearing modules

`src/commands/verify/section-table-ubs.ts` (212/331),
`src/harness/statusline-snapshot.ts` (195/372), `src/lib/secrets.ts` (210/398),
`src/harness/deletion-hygiene.ts` (186/389), and the remaining long tail.
Expect a higher share of true equivalents here — and apply §5's prose rule
strictly, because several of these files *are* the product's voice.

Re-derive the live worst list any time:

```bash
node -e "
const {readFileSync}=require('fs');
const m=JSON.parse(readFileSync('.interlinked/mutation-manifest.json','utf8'));
const rows=[];
for(const [f,syms] of Object.entries(m.files)){let s=0,t=0;
  for(const sym of Object.values(syms)) for(const mu of Object.values(sym.mutants)){t++; if(mu.status==='survived')s++;}
  if(s)rows.push([s,t,f]);}
rows.sort((a,b)=>b[0]-a[0]);
for(const [s,t,f] of rows.slice(0,25)) console.log(String(s).padStart(4),'/',String(t).padStart(4),f);
"
```

## 6a. Progress ledger — completed units (APPEND HERE, do not re-pick)

**Check this table before choosing a file from §6.** The work list is static; this
is the record of what has actually been done. Append one row per completed unit,
with numbers from a live measurement (§4a), not from the manifest.

| Date | File | Before → After | Tests added | Left unresolved | Notes |
|---|---|---|---|---|---|
| 2026-07-30 | `src/harness/structure/adoption.ts` | 30 → **14** (of 71) | 8 | 14 | All 14 are **dead code**, not test gaps: `hasConfigFile` cannot alter any return value (see §5 class table). Resolution is a source fix, not accepts — pending decision to delete the `configKey`/`hasConfigFile` chain (and the then-unused `config` parameter of `computeAdoption`). |
| 2026-07-30 | `src/harness/replay/sse-reassembly.ts` | 32 → **8** (of 135) | 26 | 8 | 2 are syntactic no-ops (provable); 6 are the **defensive-guard** class and are staleness-dependent — left `unresolved`, deliberately not accepted. |
| 2026-07-30 | `src/lib/codex-feature-flag.ts` | 30/104 snapshot → **5/117** live | 14 | 5 | Denominator changed because the manifest undercounts module-scope mutants (§9). Remaining 5 are redundant `$` anchors in per-line regexes and a literal feeding only a boolean `.test()`. |

Totals so far: **92 → 27 survivors, ~48 tests added, 0 deletions, 0 accepts,
0 source edits.** Every "after" figure was verified by an independent measurement
rather than taken from the executing agent's report.

**Ledger discipline:** a unit is recorded only after a live re-measurement. If you
finish work but cannot measure (runner down, `no_tests`), record the row with
`After = unmeasured` and say so — never infer a count.

## 7. Running this in parallel across several agents

Parallelism is supported with three hard rules. Violating them corrupts shared
state rather than merely slowing things down.

**Rule 1 — one file per agent, claimed up front.** The harness auto-reserves
files it sees being edited, but the campaign's unit is a source+test pair, so
claim both explicitly in whatever task ledger coordinates the run. Two agents
in the same pair will fight the reservation layer and each other's tests.

**Rule 2 — never let two agents write the manifest concurrently.** The live
manifest is a single JSON document rewritten wholesale on every clean measured
pass. Concurrent writers are last-writer-wins: a lost update silently drops a
file's baseline, which then re-adopts its survivors as an accepted floor on next
sighting — a corrupted ratchet that looks like progress.

**Measured 2026-07-29: this campaign's normal shape writes the manifest ZERO
times.** Adding tests is a test-only change set, which triggers no measurement
(§4 step 4), and the §4a measure helper is read-only. So *pure test-addition
work parallelizes safely on one shared tree*, provided each agent owns a disjoint
source+test pair (Rule 1). Reservations arbitrate anything that overlaps anyway.

Worktree isolation (one per agent, each root carrying its own `.interlinked/`)
becomes necessary only when agents also edit **source** — deleting dead code,
fixing a defect — because those change sets do trigger measured passes that
persist. Note that a fresh worktree does not inherit gitignored local rules, so
its runner configuration must be provisioned before the gate can measure there.
Per-file manifest sharding (§9) removes the constraint entirely.

**Rule 3 — accepts escalate, regardless of model.** No executing agent runs
`interlinked mutation accept` for its own unit; it *reports* candidates with a
mechanism and a reviewer decides.

The reason is **conflict of interest, not capability.** An agent judging whether
its own remaining survivors are unkillable is grading its own homework, and the
convenient answer is always "unkillable." Measured evidence that this is not
hypothetical: on `structure/adoption.ts` the executing agent's analysis was
*correct* — 14 mutants genuinely could not be killed — yet the right resolution
was **fix the source** (dead code), not annotate 14 equivalents. With accept
rights it would very likely have filed 14 tidy justifications and sealed a real
defect in behind them. Raising the model tier does not remove that incentive.

**Model routing.** Task shapes differ in judgment demand: Wave 2's fixture
corpuses are formulaic; Wave 1 (what a guard's message must promise) and Wave 3
(whether a mutant is truly unobservable) are judgment-heavy. That said, **this
campaign's standing decision is to run every wave on the strongest available
model**, including the parallel units — the wall-clock bottleneck is measurement
(tens of seconds per file), not inference, so a stronger model costs tokens
rather than throughput.

**Verification is model-independent.** Machine-verify every reported number by
re-measuring (§4a) no matter who produced it. This is not distrust of a
particular tier — a self-reported count is an unverified claim from any source,
and re-measuring costs ~40 seconds. Observed across the first three units:
survivor counts were accurate 3/3, but secondary counts (tests added) were wrong
in 2/3 reports. Both defects in the measurement machinery itself (§9) surfaced
*because* the numbers were checked rather than accepted.

**Throughput reality.** One scoped measurement is tens of seconds against a
warm runner, and runners are a shared finite resource: N agents contend. Expect
queueing rather than linear speedup, and prefer more files per agent over more
agents per file.

## 8. Anti-patterns (each has been attempted; each is rejected)

| Anti-pattern | Why it fails |
|---|---|
| Lowering a baseline / cap so the gate passes | Blocked by the baseline-integrity gate; defeats every ratchet at once. |
| Bulk-accepting survivors as "equivalent" | Inflates the accepted floor invisibly; indistinguishable from abandoning the file. |
| Asserting mock interactions instead of behavior | `mock_only_test` flags it, and mutants survive anyway — a mock assertion checks the call you wrote, not the value produced. |
| Deleting the code the mutant lives in, to make it go away | Only valid when the code is genuinely dead; say so explicitly and prove nothing consumes it. |
| Treating `[mutation:not-measured]` as clean | It means no verdict. Fix the runner or the test scope. |
| Splitting one branchy change across edits to dodge the cyclomatic slew limit | The tolerance is a regression detector, not a budget; extract a helper. |
| Piped test runs (`vitest … | tail`) as evidence | The harness cannot see the summary; TDD state goes stale and the commit gate wedges. |

## 9. Known gaps — fix these when they start to bite

> Each gap below is carried into the "Build order and rationale" section of
> `docs/plans/16-monotonic-quality-enforcement.md`. Fix them there (with the
> surrounding infrastructure) rather than patching them ad hoc here.

- **Manifest durability + sharding.** The full manifest is machine-local and
  gitignored by design (a large, regenerable measurement artifact). What *should*
  travel is a slim committed floor file — per-file score plus the accepted
  equivalents with their reasons — which also becomes the audit surface for
  Rule 3 and the git-visible record of accepts. Sharding the local manifest
  per file additionally removes the concurrent-writer constraint (§7 Rule 2).
- **Test-scope derivation is filename-based.** A file covered only by a
  differently-named or differently-run test measures as untested and cannot be
  hardened by this loop (~290 files at the baseline sweep). The fix is a
  coverage-ownership map: path → (runner, include globs, how to invoke), shared
  by the mutation scope derivation and the coverage-obligation ledger.
- **The manifest silently omits mutants outside a function symbol — every
  recorded count is a FLOOR, not a total.** Verified 2026-07-29 on
  `src/lib/codex-feature-flag.ts`, unchanged in git since June: the manifest
  records 5 symbols / 104 mutants, all of them functions, while a live
  measurement of the identical source reports **117**. The 13 missing mutants
  belong to module-scope constants (`FEATURE_FLAG_REGEX`,
  `LEGACY_FEATURE_FLAG_REGEX`, …) which the identity layer anchors to no
  enclosing symbol. Consequences: baseline totals (including the ~25k sweep
  figure) undercount; and a survivor living in a module-scope constant can
  never be recorded, ratcheted, blocked, or annotated — it is outside the gate
  entirely. That matters here because module-scope constants in this repo are
  regexes, catalogs, and key names, several of them security-relevant. Until
  identity anchors module-scope declarations, **always quote both numbers**
  (`N mutants, M survivors`) from a live measurement rather than survivor
  counts alone, and never compare a manifest snapshot against a live total.
- **A stale runner reports `no_tests` instead of failing loudly.** Observed
  2026-07-29: one configured endpoint returned `NOT MEASURABLE: no_tests` for
  `structure/adoption.ts` while another measured the same file at 71 mutants.
  Because `no_tests` reads as "not measurable" rather than "runner broken", a
  degraded endpoint silently converts real measurements into non-verdicts — and
  may account for part of the baseline sweep's ~290 "unmeasurable" files. Until
  the runner distinguishes "this repo has no such test" from "my checkout is
  stale", cross-check an unexpected `no_tests` against a second endpoint (§4a).
- **Per-edit test runs are off here.** `per_edit_coverage.enabled: false` in the
  local rules, because `coverage-overlay.ts` `cpSync`-mirrors every top-level
  entry except `.git`/`.interlinked`/`node_modules` — including `dist/`,
  `coverage/`, `reports/`, `.wrangler/`, `.stryker-tmp/` (~3.2GB per edit).
  Adding those to `SKIP_ENTRIES` is the small fix that would make the automatic
  per-edit affected-test run affordable. Until then the full suite runs between
  units (orchestrator's job), not per edit.
- **No `procfs_probe_in_test` detector.** Tests that probe `/proc/...` as an
  "unwritable path" hang Linux CI (recursive mkdir spins). The safe fixture is a
  path nested under a regular *file* (ENOTDIR everywhere). Worth a write-time
  check so the class cannot return.
