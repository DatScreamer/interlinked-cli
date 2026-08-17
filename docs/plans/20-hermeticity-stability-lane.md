# Hermeticity / stability lane — flaky-evidence quarantine

**Status:** design proposal, 2026-08-14. Not built. This is one of six parallel
design memos covering the evidence layer sketched in
[`session-2026-08-11-synthesis.md`](../design/session-2026-08-11-synthesis.md)
Part 6 — specifically the **Hermeticity/stability** row of the verification-stack
table and the `stabilityEvidence` row of the receipt-field table. See
**Depends on / feeds** at the end for how this memo composes with the other five.

**Companion docs:** [`session-2026-08-11-synthesis.md`](../design/session-2026-08-11-synthesis.md)
Parts 4–7 and 11 (the spec seed);
[`per-edit-cloud-mutation-testing.md`](../design/per-edit-cloud-mutation-testing.md)
(the mutation gate whose kill verdicts this lane qualifies);
[`test-oracle-integrity.md`](../design/test-oracle-integrity.md) §4.2 (the
skipped-tests water-line this lane must not become a bypass for);
[`verification-density-program.md`](../design/verification-density-program.md)
(the Check Evidence Contract any new detector must satisfy);
[`19-test-receipt-blinded-review-machine.md`](./19-test-receipt-blinded-review-machine.md)
(the receipt this lane's output is a field of);
[`18-verification-evidence-ledger.md`](./18-verification-evidence-ledger.md)
(the envelope this lane's records eventually federate into).

---

## 1. Problem + evidence

### 1.1 The unsound-kill chain

A mutation kill is an argument of exactly this shape: *the test failed with the
mutant applied and passed without it, therefore the test observes the mutated
behavior.* The argument has a silent premise — **the test's verdict is a
function of the code alone.** When a test's verdict is also a function of
ordering, ambient environment, seed, worker count, wall clock, or leaked
resources, the inference is invalid in both directions:

- a test that fails for an ambient reason during the mutant run and passes
  during the clean run **certifies a kill that never happened**; and
- a test that passes for an ambient reason during the mutant run **leaves a
  survivor on the worklist that a stable suite would have killed**, sending an
  agent to write a redundant test against code that was already covered.

The synthesis states the consequence as a rule: *"Quarantine as unstable
evidence. A flaky case cannot certify a kill even if one run passed"*
(`session-2026-08-11-synthesis.md:282`). Nothing in the tree implements it.
`applyMeasuredRun` (`src/harness/mutation/manifest.ts:432-456`) folds whatever
status the engine reported into the manifest with no stability input at all, and
the red/green precondition that guards the whole measurement is a single boolean
from a single run: `const suiteRed = input.testRun?.overlayGreen === false;`
(`src/harness/mutation/evaluate.ts:154`).

This is not hypothetical arithmetic on a small number. The campaign folded
**about 4,506 kills across 32 files** into the manifest in one follow-up round
(`session-2026-08-11-synthesis.md:82-84`), and the saved manifest snapshot
records **81,778 killed mutants over 705 files** with **zero typed dispositions**
(`session-2026-08-11-synthesis.md:91-102`). Every one of those verdicts rests on
one run of one ordering in one environment.

### 1.2 The live case — measured this session, not inherited

`scratch/fleet-r3/repair-followups.txt` (tail) records an independent green-check
finding: `activity.test.ts` fails 3 tests *only* in the full dirty-set run,
passes clean alone, "polluter unknown", with the suggested next step "hunt the
polluter with `vitest --sequence.shuffle` bisection."

I reproduced and root-caused it. **Measured, this session, output in transcript:**

| Trial | Command | Result |
|---|---|---|
| A | `npx vitest run src/commands/activity.test.ts` | **3 failed** / 30 passed |
| B | `NO_COLOR=1 npx vitest run src/commands/activity.test.ts` | 33 passed |
| C | `CI=1 npx vitest run src/commands/activity.test.ts` | 33 passed |
| D | `--no-file-parallelism status.test.ts activity.test.ts` | 3 failed (same 3) |
| E | `--no-file-parallelism --no-isolate status.test.ts activity.test.ts` | **8 failed** — the same 3 in activity, **plus 5 in `status.test.ts`** |

The three failing cases in trials A/D/E are `prints the empty-state line when
there is no activity`, `does not label an empty local fallback as '(local)'`,
and `renders a populated table with the token totals footer`.

The mechanism, verified in source:

1. `src/lib/formatter.ts:8` resolves colour **once, at module evaluation**:
   `const supportsColor = !process.env.NO_COLOR && !process.env.CI && process.stdout.isTTY !== false;`
2. `src/commands/activity.test.ts:28` sets `process.env.NO_COLOR = "1"` as a
   plain top-level statement — which runs *after* the hoisted static imports
   have already evaluated `formatter.js`. The assignment is a no-op for its own
   module graph.
3. Six files away, `src/commands/status.test.ts:15-20` does the same thing
   **correctly**, and its comment names this exact hazard verbatim: *"The
   formatter resolves `supportsColor` from env at module-load time, so this must
   run before the module graph loads — `vi.hoisted` executes before the static
   imports above are evaluated."*

So the three verdicts are a function of ambient `NO_COLOR` / `CI` / TTY-ness, not
of the code under test. The followups' observation ("fails only in the full set")
and mine ("fails alone, passes under `CI=1`") are the *same defect observed from
two ambient starting points* — which is itself the finding: the direction of the
flake is environment-dependent, so "passes alone" and "fails alone" are both
uninformative single samples.

Trial E is the sharper result. With module isolation off, `status.test.ts` —
the file that does the hoisting correctly — **also fails**, because
`formatter.js` is now shared and was already evaluated by the other file's graph
before `status.test.ts`'s `vi.hoisted` ran. Correct local hygiene does not
survive a shared registry. Ordering is a real, load-bearing input to this
suite's verdicts.

### 1.2a The failing assertions are the campaign's own kill assertions

This is the part that closes the loop, and it was not in the followups note.
`git diff src/commands/activity.test.ts` (uncommitted at the time of writing;
file mtime 2026-08-13 13:08, i.e. mid-campaign) shows **every one of the three
failing assertions was added by the survivor-kill campaign**:

| Failing case | Failing assertion | Provenance |
|---|---|---|
| `prints the empty-state line…` | `toContain("Activity Feed\n")` | added by the diff |
| `does not label an empty local fallback as '(local)'` | whole case | added by the diff |
| `renders a populated table…` | `toContain("Totals: 10 in / 20 out / 5 cache")`, `toContain("Activity Feed (local)\n")` | added by the diff |

At `HEAD` the same file asserts `toContain("Activity Feed")` and
`toContain("Activity Feed (local)")` — **without** the trailing `\n`
(`git show HEAD:src/commands/activity.test.ts`, lines 330, 341, 428). Those
loose forms are colour-tolerant and still pass in every trial. The campaign
tightened them into exact, whitespace-anchored strings — which is exactly the
right instinct for killing a `StringLiteral` mutant, and exactly what turns a
colour-tolerant assertion into an environment-dependent one.

So the sequence is: an agent hardened assertions to kill mutants; the hardened
assertions became sensitive to an ambient variable the file's own guard fails to
control; those kills were folded into the manifest as `killed`; and no gate in
the repo can distinguish them from kills that hold. That is the abstract risk in
§1.1 with names, line numbers, and a reproduction — in the very campaign whose
~4,506 kills the manifest now carries.

### 1.3 The same class, twice before, already costed in the ledger

`src/harness/check-registry/entries-taste.ts:228-232` records the precedent in
the `timing_flake` entry's own comment: *"Both instances found in this repo
(2026-08-05/06) passed in isolation and failed only under a loaded full-suite
run — and because vitest emits NO coverage report when any test fails, each one
cost an entire measurement."* A flake is not only bad evidence; in this repo it
has repeatedly consumed a whole measurement round.

Two further recorded instances of environment-shaped instability:

- `vitest.stryker.config.ts:61-69` quarantines `content-gate.test.ts` from
  **mutation runs only**, because it spawns real `biome`, which fails-open inside
  Stryker sandboxes, fails the dry run, and "poison[s] every graph-widened scope
  that transitively includes it." The comment states the cost honestly: *"Kill-power
  cost: mutants only this file kills read as survivors."* That is a hand-rolled,
  one-line, permanent quarantine with no owner, no expiry, and no ledger — the
  exact artifact this memo proposes to make first-class.
- `vitest.unit.config.ts:24-36` records a CI-lane quarantine whose stated root
  cause was a `/proc` `mkdir` spin on the Linux runner, which "mimicked a
  positional hang until the shards isolated two guilty files at once." Order-
  dependence again, diagnosed by hand, over weeks.

### 1.4 Why nothing currently in the tree can see this class

Three shipped mechanisms look like they cover it and do not:

- **`retry: 1`** (`vitest.config.ts:46`) *converts* a flake into a silent pass
  when it flips, and does nothing when — as here — the defect is deterministic
  within a given environment. Trial E's output shows `(retry x1)` on every
  failure: the retry ran and changed nothing.
- **The flake double-run guard** (`src/harness/evaluator/test-flake-guard.ts:40-90`,
  gated by `per_edit_coverage.flake_check`, default off —
  `src/harness/server/post-tool-flake-phase.ts:63`, `src/harness/types/config.ts:387`)
  runs the affected suite twice **back-to-back, in the same process environment
  and the same ordering**. It compares two samples drawn from one point of the
  parameter space. For every case in §1.2 it would report agreement and return
  `null`. This is a structural blind spot, not a tuning problem: a double-run can
  only see nondeterminism that varies *within* a fixed configuration.
- **The gates that run the whole suite** pin the environment axis to a single
  point and mask the defect: `scripts/git-hooks/pre-push:205` and
  `scripts/ci-local.sh:26` both run `CI=1 npm test`, and GitHub Actions sets
  `CI` implicitly (`.github/workflows/ci.yml:79-80`). `CI=1` forces
  `supportsColor === false` at `formatter.ts:8`. Every gate this repo runs is
  blind to this bug **by construction**, which is why it survived to be found by
  an ad-hoc green-check.

The unit lane additionally runs sharded (`ci.yml:80`,
`npm run test:unit -- --shard=…`), so the file ordering each job sees is a
function of the shard split — an input nobody records and nobody can reproduce
from a failure log.

**The problem statement, in one line:** test verdicts are consumed as evidence
by the mutation manifest, the coverage ratchet, and (per plan 19) test receipts,
but no surface in the repo measures whether a verdict is stable under the
inputs it is not supposed to depend on.

---

## 2. Current state (verified, file:line)

### 2.1 What runs the tests

| Fact | Location |
|---|---|
| Base config: `include: ["src/**/*.test.ts", "scripts/**/*.test.mjs", "scripts/**/*.test.mts"]` | `vitest.config.ts:13` |
| Two setup files, `home-sandbox` first (owns `HOME` before any test module loads) | `vitest.config.ts:21` |
| `testTimeout` / `hookTimeout` 30s | `vitest.config.ts:38-39` |
| `retry: 1` — "the flake-tolerance floor" | `vitest.config.ts:46` |
| `env: { INTERLINKED_SKIP_DISTILLED_RULES: "1" }` — the one declared env point | `vitest.config.ts:55-57` |
| `maxWorkers: 1` **in CI only**; local keeps vitest's default | `vitest.config.ts:87` |
| Viz reporter is opt-in via `INTERLINKED_VIZ=1` | `vitest.config.ts:28-30` |
| Lane split: unit excludes `**/*.integration.test.ts` | `vitest.unit.config.ts:21-23` |
| Mutation config deliberately **omits** `retry` (Stryker's dry run keys off "did any attempt fail") | `vitest.stryker.config.ts:30-41` |
| Mutation config excludes `content-gate.test.ts` from mutation runs only | `vitest.stryker.config.ts:61-69` |
| Test scope for a mutation run is supplied per-run via `INTERLINKED_MUTATION_TESTS` | `vitest.stryker.config.ts:44-56` |

None of the four vitest configs (`vitest.config.ts`, `vitest.unit.config.ts`,
`vitest.integration.config.ts`, `vitest.stryker.config.ts`) sets
`sequence.shuffle`, `sequence.seed`, or a custom sequencer — verified by grep,
zero hits. **Ordering is whatever vitest's default sequencer produces, it varies
with the shard split in CI, and it is never recorded.**

### 2.2 What already detects flakiness, and its exact blind spot

| Surface | What it does | Blind to |
|---|---|---|
| `test-flake-guard.ts:40-67` `flakeDivergence` | pass↔fail flip, or differing failing-file sets across two runs | anything that does not vary within one fixed environment + ordering |
| `test-flake-guard.ts:81-90` `runFlakeDoubleCheck` | orchestrates the two runs; never throws; warn-only | same |
| `post-tool-flake-phase.ts:63` | `if (cfg?.flake_check !== true) return;` — opt-in, default off | not running at all by default |
| `non_deterministic_test` (`entries-taste.ts:213-226`; detector `checks/test-hygiene-isolation.ts:195-227`) | `Date.now()` / `new Date()` / `Math.random()` in a test body, suppressed file-wide when a fake clock is installed | env reads, ordering, shared module state, leaked handles |
| `timing_flake` (`entries-taste.ts:227-245`; detector `checkHardcodedTimeoutInTests`, `test-hygiene-isolation.ts:241`) | hardcoded `setTimeout(_, NNNN)` waits | same |
| `checkRealIoInTests` (`test-hygiene-isolation.ts:57`) | real I/O in tests | same |

`findProcessEnvOutsideConfig` (`checks/env-access-scope.ts:55-58`) is the one
detector that looks at `process.env` at all, and it **returns early for every
test file** (`env-access-scope.ts:21` defines `TEST_RE`, `:57` returns `[]`).
The live case's shape — a test file writing `process.env` at module top level,
after its own static imports — is detected by nothing.

### 2.3 What consumes a test verdict as evidence

| Consumer | Site | Stability input today |
|---|---|---|
| Mutation manifest fold | `mutation/manifest.ts:432-456` `applyMeasuredRun` | none |
| New-survivor block set | `mutation/manifest.ts:347-362` `computeNewSurvivors` | excludes accepted + **identity**-quarantined symbols only |
| Red/green precondition | `mutation/evaluate.ts:154` | one boolean from one run |
| Receipt | `mutation/types.ts:178-187` `MutationReceipt` | fields are overlay hash, generation, sites, engine, version, time — no stability field |
| Provenance | `mutation/types.ts:129-138` `MeasurementProvenance` | records `at` / `scope` / `testCount` / `surface` / `engine` — **not** ordering, seed, worker count, or env point |

### 2.4 Two existing uses of the words this memo needs

Both must be kept distinct in naming and in code, or the design will be
misread on arrival:

- **`IdentityInstability` / "quarantined"** (`mutation/instability.ts:1-8`,
  `types.ts:87-93`) is about **mutant-id churn** — a symbol whose mutant id set
  changes while its content hash does not. It downgrades BLOCK→WARN after churn
  and clears after `QUARANTINE_STABILITY_THRESHOLD = 3` consecutive stable runs
  (`manifest.ts:371`, applied at `:436`). It says nothing about test verdicts.
- **`.interlinked/e2e-stability.mjs`** is the daemon burst probe (5000 events,
  p99 + RSS budget) named in `CLAUDE.md`. Unrelated.

This memo therefore uses **`TestInstability`**, **`FlakeSignature`**, and
**`stability-quarantine.json`** — never bare `instability` or bare `stability`
in a mutation-adjacent identifier.

### 2.5 What does not exist (confirmed by grep, not assumed)

- No `interlinked stability` command; no registrar for one
  (`src/registrars/` listing, `src/index.ts:84-106`).
- No repeat/matrix runner: no source file varies ordering, seed, worker count,
  or environment across runs and compares verdicts.
- No leaked-handle / leaked-file / leaked-child detection anywhere.
  (`mutation/pending-handles.test.ts` is about *runner job handles*, not OS
  handles — it tests `pendingHandlesFrom` in `mutation/gate.ts`.)
- No quarantine ledger for tests, and no consumer that could read one.
- The viz test feed (`src/lib/viz/test-events.ts:23-41`, producer
  `reporter-vitest.ts:119-135`) records `ts / kind / run_id / label / file /
  name / status / ms / error / tallies` — a per-case stream with **no trial
  identity**: nothing records which ordering, seed, worker count, or env point
  produced a verdict. It is the right pipe and it is one field short.

---

## 3. Design

### 3.0 The contract, in one sentence

**A test verdict is admissible as evidence only against a declared trial
identity, and only when the verdict has been observed to be invariant across the
axes it must not depend on.** Everything below is machinery for producing,
recording, and consuming that one judgment.

Three consequences that shape every decision:

1. **This is measurement, not judgment** — running a suite N times under
   declared conditions and comparing verdict multisets is a pure function of
   observed data. No LLM appears anywhere in this lane, at any cadence. It sits
   comfortably inside the deterministic-only constraint.
2. **It cannot sit on the per-edit path.** N trials cost N suite runs. The lane
   is stop / pre-push / nightly cadence, plus one cheap static detector that can
   ride the edit path.
3. **Stability is a precondition, never a credit.** A stable test earns no
   score, no ratchet movement, no debt discharge. It earns only the right for
   its verdict to be *used*. This is the anti-Goodhart posture: making a test
   stable by deleting its assertions buys nothing.

### 3.1 Data shapes

**UNVERIFIED SKETCH.** No file below has been written or type-checked. Per this
task's constraint no `src/` edits accompany this memo; these are proposals for
review, not a scaffold ready to land.

```typescript
// src/harness/stability/types.ts — PROPOSED, UNVERIFIED SKETCH

/**
 * The axes a verdict must not depend on. Each is a knob the trial runner can
 * set; each is recorded in the trial identity. Adding a member forces every
 * switch to handle it (the reservations edge-defined-once discipline).
 */
export type StabilityAxis =
	| "order"        // file execution order within the run
	| "env"          // declared ambient environment point
	| "seed"         // PRNG seed handed to the runner (and to fast-check)
	| "concurrency"  // worker count / isolation mode
	| "clock"        // system time + timezone offset
	| "repetition";  // same point, run again — the only axis flake_check varies

/**
 * One environment point the matrix runs against. NOT free-form: a closed,
 * committed list, so a trial identity is reproducible from the record alone.
 * `id` is what appears in a FlakeSignature; `vars` is what the runner sets.
 */
export interface EnvPoint {
	id: string;                        // e.g. "ci", "bare", "no-color", "tty"
	vars: Record<string, string | null>; // null ⇒ delete the variable
}

/** A single, fully-determined run configuration. Content-addressed by `id`. */
export interface TrialSpec {
	/** sha256 over the normalized spec — the reproduction key. */
	id: string;
	/** Test files in the exact order they must execute. */
	files: string[];
	env: EnvPoint;
	seed: number;
	workers: number;
	isolate: boolean;
	/** ISO instant the fake clock is pinned to, or null for the real clock. */
	clockPin: string | null;
	timezone: string | null;
	/** Runner adapter that executes this spec — "vitest" today. */
	runner: string;
}

/** Terminal verdict of one test case in one trial. Mirrors TestStatus
 *  (src/lib/viz/test-events.ts:20) plus the states a trial can add. */
export type CaseVerdict = "pass" | "fail" | "skip" | "todo" | "absent" | "errored";

/** Stable identity of a test case across trials: file + full name. Renaming a
 *  case is a NEW id — which is correct, the old evidence no longer binds. */
export type TestCaseId = string; // `${file}::${fullName}`

export interface TrialResult {
	spec: TrialSpec;
	startedAt: string;
	durationMs: number;
	/** Verdict per case. Absent cases are recorded as "absent", never omitted —
	 *  "this trial never ran the case" and "the case passed" must not collapse. */
	verdicts: Record<TestCaseId, CaseVerdict>;
	/** Resources still open after the runner reported completion (M3). */
	leaks: LeakObservation[];
	/** Non-fatal runner diagnostics (exit code, stderr head). */
	runnerNote?: string;
}

export type LeakKind = "handle" | "file" | "child_process" | "listener" | "temp_dir";

export interface LeakObservation {
	kind: LeakKind;
	/** Free-form description bounded to one line — a path, an fd type, a pid. */
	detail: string;
	/** The case that was executing when the resource was first observed, when
	 *  the runner can attribute it. Null ⇒ file-level or run-level attribution. */
	attributedTo: TestCaseId | null;
}

/**
 * The classification. Derived by a PURE function from a set of TrialResults —
 * never asserted by an author, never inferred by a model.
 */
export type FlakeClass =
	| "stable"                    // identical verdict across every trial
	| "order_dependent"           // varies with `order` only
	| "env_dependent"             // varies with `env` only  ← the live case
	| "seed_dependent"
	| "concurrency_dependent"
	| "clock_dependent"
	| "resource_leak"             // stable verdicts, but leaks observed
	| "intermittent"              // varies under `repetition` alone (true nondeterminism)
	| "multi_axis"                // varies across ≥2 axes — no single witness
	| "unmeasured";               // fewer than 2 trials cover this case

export interface FlakeSignature {
	testId: TestCaseId;
	class: FlakeClass;
	/** The axes whose variation reproduces the verdict change. Empty for
	 *  "stable" and "resource_leak". */
	axes: StabilityAxis[];
	/** Minimal reproducing pair, when bisection found one: two trial ids whose
	 *  specs differ on exactly the named axes and whose verdicts differ. */
	witness: { trialA: string; trialB: string; verdictA: CaseVerdict; verdictB: CaseVerdict } | null;
	/** For order_dependent: the minimal preceding-file set that reproduces.
	 *  For env_dependent: the minimal variable set. Produced by M0's bisector. */
	minimalCause: string[];
	/** Distinct verdicts observed, and how many trials produced each. */
	distribution: Record<CaseVerdict, number>;
	observedAt: string;
	/** Content hash of the test file at observation time — the invalidation
	 *  input. Editing the file retires the signature. */
	testFileHash: string;
}

/**
 * One ledger row. A quarantine WITHDRAWS EVIDENCE VALUE; it never skips,
 * disables, or excludes the test from any run. See §3.5 and §7 risk 2.
 */
export interface QuarantineEntry {
	testId: TestCaseId;
	signature: FlakeSignature;
	/** Who owns fixing it. Required — an unowned quarantine is abandoned debt. */
	owner: string;
	/** ISO date. A lapsed entry does not auto-delete; it reports as `expired`,
	 *  which is a louder state than `active`. */
	expiresAt: string;
	/** Free-form link to an issue/commit. Prose, and labeled as prose. */
	note?: string;
	enteredAt: string;
	/** Consecutive clean matrix runs since entry. Clears at CLEAR_THRESHOLD,
	 *  mirroring mutation/instability.ts's model (manifest.ts:368-369). */
	consecutiveStableRuns: number;
}

export interface QuarantineLedger {
	version: 1;
	/** Minimum trials per axis the matrix must run for a clean result to count.
	 *  A WATER-LINE: may only rise (see §4, baseline-integrity). */
	min_trials_per_axis: number;
	/** Shrink-only exemption list. */
	entries: QuarantineEntry[];
}

/**
 * What this lane hands to plan 19's receipt (`stabilityEvidence`) and to plan
 * 18's ledger envelope. Deliberately a summary, not the full matrix: the
 * receipt binds to it by hash and the matrix stays in its own artifact.
 */
export interface StabilityEvidence {
	/** Trial ids that covered this test, and the axes they spanned. */
	trialIds: string[];
	axesCovered: StabilityAxis[];
	trialsPerAxis: Record<StabilityAxis, number>;
	class: FlakeClass;
	quarantined: boolean;
	leaks: LeakObservation[];
	/** sha256 over the TrialResult set — the invalidation input for anything
	 *  that cites this evidence. */
	matrixHash: string;
	measuredAt: string;
}
```

Two shape decisions worth defending:

- **`verdicts` records `absent` explicitly.** A trial that never executed a case
  and a trial in which the case passed are different facts. Collapsing them is
  how a shard-split flake hides: the case simply is not in this shard, so
  "no failure observed" reads as green.
- **`FlakeSignature.minimalCause` is a string list, not a structured cause.**
  For `order_dependent` it holds file paths; for `env_dependent`, variable
  names. Making it a union would demand a taxonomy this repo has N=1 evidence
  for. One flat, honest field now; specialize when a second codebase disagrees.

### 3.2 Module layout

Every file below is new, and every file is well under the 500-line cap
(`src/harness/large-file-policy.ts`, `DEFAULT_MAX_LINES`). Nothing is added to
`src/harness/mutation/gate.ts` (455 lines — 45 from the cap) or to
`src/registrars/quality.ts` (452 lines — 48 from the cap); both are too close to
the ratchet to absorb a new surface, which is why §3.3 proposes a new registrar.

```
src/harness/stability/
  types.ts              # §3.1 — types only, no executable surface
  trial-spec.ts         # spec normalization + content-addressed id
  env-points.ts         # the committed EnvPoint list + resolution
  classify.ts           # PURE: TrialResult[] → FlakeSignature[]  ← the core
  bisect.ts             # delta-debugging over one axis → minimalCause
  matrix.ts             # plan a TrialSpec[] from a scope + axis selection
  quarantine.ts         # ledger load/save/merge; shrink-only verdicts
  evidence.ts           # TrialResult[] → StabilityEvidence (the export seam)
  runners/
    types.ts            # StabilityRunner interface — one method, injectable
    vitest-runner.ts    # vitest adapter: spawn, JSON reporter, parse
  leaks/
    detect.ts           # M3: handle/file/child observation + attribution

src/commands/
  stability.ts          # subcommand dispatch (thin)
  stability/
    run.ts              # `stability run`
    bisect.ts           # `stability bisect`
    quarantine.ts       # `stability quarantine list|add|clear`
    report.ts           # `stability report` (+ --json)

src/registrars/
  stability.ts          # registerStabilityCommands(program)
```

`classify.ts` is the module everything else exists to serve, and it is a pure
function of its inputs — which is what makes the whole lane testable without a
runner and mutation-testable at low cost.

The `StabilityRunner` seam matters for portability, which is the product
(`CLAUDE.md`, goal 1). Vitest is this repo's runner; the matrix concept is not
vitest-specific. The adapter interface is deliberately one method:

```typescript
// src/harness/stability/runners/types.ts — PROPOSED, UNVERIFIED SKETCH
export interface StabilityRunner {
	readonly name: string;
	/** Execute exactly this spec and report per-case verdicts. Must not throw:
	 *  a runner failure is a TrialResult with `runnerNote` set and every
	 *  in-scope case recorded as "errored". */
	run(spec: TrialSpec, signal: AbortSignal): Promise<TrialResult>;
}
```

### 3.3 CLI surface

```bash
# M0 — the spike. Bisect one failing/suspect case down to its minimal cause.
interlinked stability bisect <testFile> [--case <name>] \
    [--axis env|order] [--budget-trials 24] [--json]

# M2 — run the matrix over a scope and write the trial set.
interlinked stability run [--scope <glob>] [--axes env,order,seed,concurrency] \
    [--trials <n>] [--budget-ms <ms>] [--json]

# M4 — the ledger.
interlinked stability quarantine list [--json]
interlinked stability quarantine add <testId> --owner <who> --expires <date>
interlinked stability quarantine clear <testId>

# M2 — read the last matrix without re-running it.
interlinked stability report [--since 7d] [--class order_dependent] [--json]
```

Every subcommand follows the house output-mode pattern
(`getOutputMode(opts)` + `output(mode, data, {...})`, `CLAUDE.md` Conventions).
`stability run` and `stability bisect` **exit 0 by default** and report; a
`--fail-on <class>` flag is the gating surface, mirroring the documented
"`interlinked verify` reports but does not gate" split
(`session-2026-08-11-synthesis.md:351`).

`registerStabilityCommands` is a **new registrar file** rather than an addition
to `src/registrars/quality.ts` (452/500 lines), wired in `src/index.ts`
alongside the existing 23 registrars (`src/index.ts:24-39, 84-106`).

### 3.4 Hook phases and cadence

The synthesis's cadence table (`session-2026-08-11-synthesis.md:419-426`) already
assigns this work; the mapping is mechanical.

| Cadence | What runs | Blocking? |
|---|---|---|
| **PreToolUse** | nothing from this lane except the M1 static detector | warn only |
| **PostToolUse** | nothing new; the existing `flake_check` double-run stays as-is | warn only |
| **Stop** | if the session edited test files, check them against the quarantine ledger and warn on any edit to a quarantined test that does not clear it | warn only |
| **Pre-push / CI** | `stability run --axes env` over the **changed** test files (cheap: 2–3 trials) | opt-in `--fail-on` |
| **Nightly** | full matrix over the whole suite; refresh ledger; expire lapsed entries | report only |

The M1 detector is the only new thing on the edit path, and it is a **warning**,
not a `pre_block`. Justification, stated plainly because the FP bar is a house
rule: the shape "test file assigns `process.env.X` at module top level" is
statically decidable with near-zero FP, but the *harm* requires that some
transitively imported module read that same key at module scope. That second
half is a cross-file join through the project graph — affordable at verify
cadence, not at the edit gate, and heuristic when the read is dynamic. A check
that blocks on half a proof is exactly the wrong trade for `pre_block`
(`CLAUDE.md`: "`pre_block` is reserved for fully-deterministic, zero-FP errors
only"). It ships at `pre_warn` with a `[heuristic]` tag and a fix instruction
that names `vi.hoisted` and points at `src/commands/status.test.ts:15-20` as the
in-repo worked example.

### 3.5 Consumption rules — what a quarantine actually does

This is the part that must not be got wrong.

**A quarantine withdraws evidence value. It never changes what runs.**
A quarantined test still executes in every lane, still reports pass/fail, still
reddens CI when it genuinely breaks. What changes is that downstream consumers
refuse to *cite* it.

| Consumer | Rule |
|---|---|
| Mutation kill certification | A `killed` status whose killing test set intersects the quarantine ledger is folded as **`indeterminate`**, not `killed`. `MutantStatus` already has that member (`mutation/types.ts:23-29`) and it already means "a run that could not conclude" — no new status is needed. |
| Survivor worklist | A survivor whose *only* covering tests are quarantined is reported with an explicit `unqualified: unstable_tests` marker rather than being handed to an agent as work. Writing a test to kill a mutant that a flaky test already kills is wasted spend. |
| Test receipts (plan 19) | `stabilityEvidence` is populated from `StabilityEvidence`; a `quarantined: true` receipt cannot discharge a mutation obligation. |
| Coverage ratchet | **Unchanged.** Coverage is a line-execution fact, far less order-sensitive than a verdict, and touching the coverage ratchet here would couple two ratchets for no measured reason. Revisit only with evidence. |
| `interlinked verify` | Reports quarantine count + expired entries in its summary. Advisory. |

Three properties of the ledger that follow from the house rules:

1. **Shrink-only.** `entries` is an exemption list, so it may only shrink —
   the same direction as `untested-files.files` and `check-evidence` exemptions
   (`evaluator/baseline-integrity-gate.ts:283, 324`).
2. **`min_trials_per_axis` may only rise.** It is the knob that decides how hard
   the matrix looks; an agent that lowers it makes everything stable. Same class
   as `min_coverage` (`baseline-integrity-gate.ts:277, 355`).
3. **Entering the ledger is never automatic.** The matrix *proposes*; a human or
   an explicit `stability quarantine add` *records*. An auto-quarantine loop
   would let an agent quarantine its way out of a red suite, and would make the
   ledger grow silently — the opposite of a shrink-only artifact.

### 3.6 Storage and gitignore carve-out

| Artifact | Path | Tracked? |
|---|---|---|
| Quarantine ledger | `.interlinked/stability-quarantine.json` | **committed — carve-out required** |
| Trial results (the matrix) | `.interlinked/stability-trials.jsonl` | gitignored (bulk, machine-local) |
| Last report | `.interlinked/stability-report.json` | gitignored (derived) |

`.gitignore:171` blanket-ignores `.interlinked/*` with explicit `!` carve-outs
for every committed policy artifact (`:172-201`). The ledger needs the same
treatment, and for the same stated reason the `skipped-tests-baseline.json`
carve-out gives (`.gitignore:181-184`): *a repo quarantining more of its
evidence must surface in PR diffs.*

`stability-trials.jsonl` stays gitignored and bounded. It is append-only and
should be readable through `interlinked query` by registering a source in
`src/commands/query/sources.ts:26-108` (`name: "trials", file:
"stability-trials.jsonl"`) so it inherits the bounded-scan discipline rather
than inviting a full read.

---

## 4. Integration points

**Registrars.** New file `src/registrars/stability.ts` exporting
`registerStabilityCommands(program)`; import + call in `src/index.ts` alongside
the existing set (`src/index.ts:24-39, 84-106`). Not folded into
`registrars/quality.ts` — see §3.3.

**Check registry.** Exactly **one** new check, the M1 detector. Following the
documented seven-step recipe (`CLAUDE.md`, "Shared patterns when adding another
agent-quality check"):

| Step | Landing site |
|---|---|
| Detector | `src/harness/checks/test-hygiene-isolation.ts` (376 lines — room for one more detector under the cap) |
| Registry entry | `src/harness/check-registry/entries-warnings.ts` — `pre_warn`, severity `warning`, `determinism: partially_deterministic` |
| Metadata | `src/harness/check-metadata.ts` |
| Advisory policy | **default gate**, not `DEFAULT_ADVISORY_SKIPS` — the shape is narrow and the fix is one-line, so it clears the "low FP + catches real bugs" bar in `CLAUDE.md`'s decision rule |
| Parity test | `AGGREGATED_IN_JSON` in `__tests__/check-pipeline-parity.test.ts` |
| Evidence | tier `pre_warn` ⇒ 2 MUST-FIRE / 2 MUST-NOT-FIRE + 100% branch + corpus + mutation (`CLAUDE.md`, Check Evidence Contract table) |
| Docs counts | `npm run docs:build` **before** the registry edit lands, per `reference_docfreshness_count_gate_ordering` |

Adding one check moves `getCheckInventory()`'s inline-family count
(`src/harness/check-inventory.ts`) and the `gen:*` markers in `CLAUDE.md` /
`docs/generated/`; `npm run docs:check` fails CI if they drift.

**`.interlinked/` files.** Three new paths (§3.6), one gitignore carve-out.

**Baseline-integrity implications.** The ledger is agent-writable, so it is a
gaming surface by construction and must be registered as a guarded baseline:

- add `"stability-quarantine"` to `BaselineKind`
  (`evaluator/baseline-integrity-gate.ts:35-44`);
- add `stability-quarantine` to `BASELINE_FILE_RE` (`:47`) and `KIND_MAP` (`:49-58`);
- add a `case` to the dispatch at `:422-433` with two directions —
  `min_trials_per_axis` may only rise, `entries` may only shrink;
- add it to the **commit-gate backstop** (`evaluator/commit-baseline-gate.ts`),
  because it is git-tracked and therefore stageable through `apply_patch` or a
  sub-agent — the exact hole that backstop exists to close (`CLAUDE.md`).

**Interaction with the skipped-tests water-line.** `.interlinked/skipped-tests-baseline.json`
pins `max_skipped: 0` with an empty grandfather map, enforced by the same gate
(`baseline-integrity-gate.ts:215-263`) and documented at
`docs/design/test-oracle-integrity.md` §4.2. A quarantine mechanism that
*skipped* tests would be a laundering path straight through that water-line:
skip count rises, gate fires, agent adds a grandfather entry, water-line erodes.
§3.5's "withdraws evidence value, never skips" rule is what keeps the two
systems orthogonal, and the M4 tests must pin it: **a quarantine entry must never
change `countSkippedTests`' result for any file.**

**Mutation surfaces.** Consumption (M5) touches:
`mutation/manifest.ts:432` (`applyMeasuredRun` gains an optional
`unstableTests: Set<TestCaseId>` argument, defaulting empty so every existing
caller is unchanged) and `mutation/measure.ts:636` (`recordMeasurement` passes
it through). `mutation/gate.ts` is at 455/500 lines and must not absorb this —
the ledger read belongs in `stability/quarantine.ts`, injected.

**The viz test feed.** `TestEvent` (`src/lib/viz/test-events.ts:23-41`) gains
one optional field, `trial_id?: string`, and `InterlinkedVizReporter`
(`reporter-vitest.ts:99-105`) stamps it from an env var the trial runner sets.
The reporter is duck-typed and defensive by design
(`reporter-vitest.ts:8-13`), and the field is optional, so no existing consumer
breaks and the dashboard's TESTS lens keeps working unchanged. This turns the
existing feed into the matrix's record-keeper instead of building a second one.

---

## 5. Milestones

Each milestone lands independently, is verifiable on its own, and leaves the
tree committable.

### M0 — `stability bisect`, one axis, and the live case as the proof

**Smallest independently-landable, independently-verifiable spike.** Build
`stability/types.ts`, `trial-spec.ts`, `env-points.ts`, `runners/vitest-runner.ts`,
`bisect.ts` (delta-debugging over one axis only), plus
`commands/stability/bisect.ts` and the registrar. No ledger, no matrix planner,
no classification beyond "these two trials disagree", no leak detection.

The env axis comes first because it *is* the live case, measured (§1.2) — not
because it is easier.

**Verification (all three required):**

1. `interlinked stability bisect src/commands/activity.test.ts --axis env`
   reproduces the §1.2 trial table: 3 named cases flip between the `bare` and
   `ci` env points, and the bisector minimizes `minimalCause` to the single
   variable `NO_COLOR`.
2. Applying the `vi.hoisted` fix — mirroring `src/commands/status.test.ts:15-20`
   — makes the same command report `stable` for all 33 cases across both env
   points.
3. A unit fixture proves the bisector's minimization on a synthetic 8-variable
   input in ≤4 trials (delta-debugging, not linear scan).

Verification 2 is the deliverable that makes the milestone worth landing on its
own: it fixes a real defect that every current gate is blind to.

### M1 — the static detector for the class

`test_env_write_after_import`: a test file that assigns `process.env.<KEY>` at
module top level while having static imports and no `vi.hoisted` / `vi.stubEnv`
wrapper. `pre_warn`, warning severity, default gate. Full seven-step registry
recipe (§4).

**Verification:** fires on `src/commands/activity.test.ts:28`; does **not** fire
on `src/commands/status.test.ts:15-20`; does not fire on a `beforeEach`-scoped
assignment; does not fire on a test file with no static imports. Plus a
repo-wide corpus run recording the true fire count, per the Check Evidence
Contract's corpus obligation — calibrated against the tree, never against
fixtures (`CLAUDE.md`).

### M2 — the matrix runner and classifier

`matrix.ts` (plan a `TrialSpec[]` from scope × axes × trial budget),
`classify.ts` (pure `TrialResult[] → FlakeSignature[]`), `commands/stability/run.ts`
and `report.ts`, the `trial_id` field on `TestEvent`, and the `query` source
registration.

**Verification:** classification is a pure function, so it is unit-tested
exhaustively against synthetic `TrialResult` sets — one fixture per `FlakeClass`
member, including `multi_axis` and `unmeasured`. Plus one live run: the matrix
over `src/commands/` reproduces M0's `env_dependent` finding without being told
which axis to look at.

### M3 — leak detection

`leaks/detect.ts`: open handles (`process.getActiveResourcesInfo()`), child
processes, and temp directories surviving the run, attributed to the executing
case where the runner can supply it.

**Verification:** a fixture test that leaks an interval, an unclosed file
descriptor, and a child process is detected with correct `LeakKind` for each;
a clean fixture reports none. Dogfood run over the real suite, with the raw
count reported honestly rather than tuned to zero.

### M4 — the quarantine ledger

`quarantine.ts`, `commands/stability/quarantine.ts`, the
`.interlinked/stability-quarantine.json` artifact, the gitignore carve-out, the
`baseline-integrity-gate.ts` kind + `commit-baseline-gate.ts` backstop.

**Verification:** the baseline-integrity gate blocks (a) lowering
`min_trials_per_axis` and (b) adding an entry — both via the direct write path
and via a staged `git commit`, mirroring the existing gate tests. Plus the
orthogonality pin: adding a quarantine entry does not change
`countSkippedTests` for any file.

### M5 — consumption

`evidence.ts` (the `StabilityEvidence` export seam), the optional
`unstableTests` parameter on `applyMeasuredRun` / `recordMeasurement`, and the
survivor-worklist `unqualified: unstable_tests` marker.

**Verification:** with a quarantined test in the ledger, a measured run that
reports `killed` for a mutant whose covering set includes it folds as
`indeterminate`; with an empty ledger the fold is byte-identical to today's
(a regression pin over the existing `applyMeasuredRun` tests).

### M6 — cadence placement

Pre-push: `stability run --axes env` over changed test files only, warn-only
first. Nightly: a full-matrix script. Stop-event nudge for edits to quarantined
tests.

**Verification:** pre-push wall-clock delta measured and reported on a
representative change (the budget claim is the deliverable, not the wiring);
the existing pre-push worktree-export contract (`scripts/git-hooks/pre-push:88-114`)
is preserved — the stability run executes in `$GATE_DIR`, not the working tree.

---

## 6. Evidence obligations

**Per-milestone unit obligations.** Every new module is pure or injectable, so
each ships with its own test file. `classify.ts` and `bisect.ts` are the two
that carry real logic and get exhaustive fixture coverage (one case per
`FlakeClass`; bisection minimality asserted, not just correctness).

**Check Evidence Contract (M1 only).** `pre_warn` tier ⇒ 2 MUST-FIRE / 2
MUST-NOT-FIRE labeled cases, 100% branch coverage, corpus run required, mutation
evidence required (`CLAUDE.md`, contract table). New checks get **no**
grandfathering in `.interlinked/check-evidence-baseline.json`, and adding one
there would itself be blocked by `baseline_integrity_gate`. Labeled with the
`describe("… — positive (must fire)")` convention the parser recognizes
(`src/harness/check-evidence/case-parser.ts`).

**Corpus scan (M1).** Run the detector over the whole tree and record the count
in `.interlinked/check-corpus.json` before choosing the severity. The house
precedent is explicit: `halstead_difficulty` was calibrated on fixtures at 25
and fired 2,226 times against the real tree (`CLAUDE.md`). Expected fire count
for `test_env_write_after_import` is small — `activity.test.ts` is one known
instance and `status.test.ts` is a known negative — but "expected" is not
"measured", and the measured number decides.

**Dogfood corpus (M2/M3).** The first full matrix run over this suite is itself
the corpus. Its output is the first honest answer to "how much of this repo's
test evidence is order- or environment-dependent?" — a number nobody has. Report
it raw. Two known instances (`content-gate.test.ts` in mutation scope,
`recurrence.test.ts` in the CI lane) are already documented in config comments
and should appear in the results; if they do not, the matrix is not covering
their axes and that is the finding.

**Anti-obligation.** Do not derive a repo-wide "stability score." A single
number invites a ratchet, a ratchet invites Goodharting, and the honest output
here is a *list of signatures with owners*, not a percentage.

---

## 7. Risks + anti-goals

**Risk 1 — the lane becomes a skip factory.** The single largest failure mode:
an agent under a red suite quarantines its way to green. Mitigations are
structural, not procedural: quarantine never changes what runs (§3.5); entries
require an owner and an expiry; the ledger is shrink-only under
`baseline_integrity_gate` with a commit-gate backstop; entry is never automatic.
The `content-gate.test.ts` exclusion (`vitest.stryker.config.ts:61-69`) is the
cautionary in-repo precedent — a permanent, unowned, un-expiring quarantine that
silently costs kill power, recorded only in a comment.

**Risk 2 — Goodharting stability itself.** A test with no assertions is
perfectly stable. Therefore stability is a *precondition* for evidence, never a
credit toward any score, ratchet, or debt discharge (§3.0). Stability composes
with plan 19's contract-grounding and assertion-quality layers precisely because
neither can substitute for the other.

**Risk 3 — cost.** An N-axis matrix multiplies suite runs. Bounded by: axis
selection per cadence (pre-push runs `env` only, over changed files), a
`--budget-ms` ceiling, and the nightly slot for anything wide. The lane must
never reach the per-edit path; §3.4 states that as a design constraint rather
than a default that could later be flipped.

**Risk 4 — determinism policy.** No LLM appears anywhere in this lane. Running a
suite and comparing verdict multisets is measurement. The classifier is a pure
function over recorded data. This is compatible with
`feedback_harness_deterministic_only` without qualification, and it should stay
that way even when the obvious temptation arrives: *"ask a model why this test
is flaky."* That belongs in a Tier 3 review lane consuming this lane's output,
not inside it.

**Risk 5 — false positives from the matrix itself.** A trial can fail for
reasons that are the *matrix's* fault: an env point that breaks a test
legitimately (a test that genuinely requires `CI=1`), a clock pin that trips a
date-boundary assertion. Mitigation: `EnvPoint` is a small committed list, not
free-form; a test may declare its required point via an inline directive
(reusing the existing `// interlinked-ignore:` grammar rather than inventing a
second one); and the classifier's `multi_axis` class exists precisely so that
"varies for several reasons" is reported as unresolved rather than mis-attributed
to whichever axis was tested first.

**Risk 6 — vitest-shaped design.** Interlinked's product is portability
(`CLAUDE.md`, goal 1); this repo is a single-runner test fixture. The
`StabilityRunner` seam (§3.2) is the hedge, and it is deliberately one method.
The axis taxonomy is runner-independent; the *knobs* are not, and they live only
in the adapter.

**Risk 7 — N=1.** The `FlakeClass` taxonomy is derived from four incidents in
one repo (the live `NO_COLOR` case; two `timing_flake` instances; the
`/proc`-mkdir CI hang). Per the house N=1 discipline, this memo therefore adds
**one** registry check and keeps everything else as a CLI lane plus a ledger —
no registry-wide rework, no new phase, no scope/phase field changes. Widening
the taxonomy waits for a second, genuinely different codebase.

**Anti-goal 1 — do not make this a ratchet.** No `stability-baseline.json` with
a score. The only water-line is `min_trials_per_axis` (how hard we look), which
is a *search-effort* floor, not a quality score.

**Anti-goal 2 — do not touch `retry: 1`.** It is load-bearing for the CI lane
split and its removal is a separate decision with its own evidence
(`vitest.config.ts:41-46`). This lane makes retry's masking effect *visible*;
it does not unilaterally remove the mask.

**Anti-goal 3 — do not replace the existing `flake_check` double-run.** It
covers the `repetition` axis cheaply at PostToolUse and is already built and
tested. This lane adds the axes it structurally cannot see; the double-run
becomes the repetition axis's per-edit sampler.

**Anti-goal 4 — a quiet lane is not a dead lane.** Once the live case is fixed
this lane may find nothing in this repo for weeks. Per `CLAUDE.md`'s central
corollary, that measures the agent and the suite, not the lane. Point it at
human-authored legacy tests and it earns its keep immediately.

---

## 8. Open decisions for the user

1. **Fix the live case now, or leave it as M0's fixture?** The `vi.hoisted` fix
   to `src/commands/activity.test.ts:28` is a three-line change that makes three
   currently-broken tests honest. It has some urgency independent of this plan:
   the file is **uncommitted**, carries campaign-added kill assertions (§1.2a),
   and is red in any environment without `CI` or `NO_COLOR` set — so committing
   it as-is lands an environment-dependent test that the `CI=1` pre-push gate
   will wave through. Fixing it now removes M0's live proof case (a synthetic
   would substitute); leaving it keeps a known-broken test in the tree until M0
   lands. **Recommendation: fix it now** — and let M0's verification pin the
   fixed shape as its MUST-NOT-FIRE case.

2. **Should `stability run` ever gate, or only ever report?** §3.3 proposes
   report-by-default with an opt-in `--fail-on <class>`. The alternative is a
   lane that can never fail a push, on the theory that a stability failure
   should always route to a human. This is a policy call about how much
   authority a measurement lane gets.

3. **Auto-propose quarantine entries, or require every entry to be typed by
   hand?** §3.5 proposes never-automatic. A middle option — the matrix writes
   *proposals* to a separate uncommitted file that a human promotes — costs one
   more artifact and removes the friction of transcribing a signature by hand.

4. **How far does `min_trials_per_axis` start?** 2 makes the lane cheap and
   catches deterministic-per-environment defects like the live case. 5 starts
   catching genuinely intermittent behavior. The water-line may only rise, so
   the starting value is the one decision that cannot be walked back cheaply.

5. **Does the quarantine ledger belong in this repo's committed set at all, or
   should it be per-developer?** Committed makes quarantine visible in PR
   diffs (the argument every other water-line makes). Per-developer avoids merge
   conflicts on a file several agents may touch concurrently. **Recommendation:
   committed**, matching `skipped-tests-baseline.json`.

6. **Priority relative to the five sibling memos.** This lane is a *precondition*
   for two of them (plan 19's `stabilityEvidence`, plan 18's evidence strength
   for test-derived claims), which argues for landing M0–M2 early; but it
   produces no new capability on its own beyond the bug fix, which argues for
   landing it behind them. This is the sequencing call the integrator agent
   needs from you.

---

## 9. Effort estimates per milestone

Rough, session-equivalent, not a commitment.

| Milestone | Estimate | Why |
|---|---|---|
| M0 | 1–1.5 sessions | The vitest adapter (spawn + JSON-reporter parse + verdict normalization) is the only genuinely new surface; the bisector is a textbook delta-debugging loop over a pure predicate. The live case is already root-caused, which removes the usual diagnostic cost. |
| M1 | 0.5–1 session | The seven-step registry recipe is well-trodden here, and the detector is a shallow AST/regex shape. The corpus run is the real work. |
| M2 | 1.5–2 sessions | `classify.ts` needs one fixture per `FlakeClass` member and careful handling of `absent`/`unmeasured`; the matrix planner has real combinatorial edge cases. |
| M3 | 1–1.5 sessions | Leak attribution is the hard part — `getActiveResourcesInfo()` is easy, tying a handle back to the case that opened it is not. Scope down to file-level attribution if it fights back. |
| M4 | 1 session | Mechanical: the baseline-integrity gate has a well-established add-a-kind pattern, and the commit-gate backstop mirrors three existing kinds. |
| M5 | 1 session | Two optional parameters threaded through existing writers, plus the "empty ledger ⇒ byte-identical" regression pin. |
| M6 | 0.5–1 session | Wiring plus a measured latency claim. The care is in not regressing the pre-push worktree-export contract. |

Total: roughly **6.5–9 sessions across 7 milestones**, risk front-loaded at M0
(runner adapter) and M3 (leak attribution). M0 alone is independently worth
landing: it ships a real bug fix that no current gate can see.

---

## Depends on / feeds

- **Depends on nothing.** This is the only one of the six memos with no upstream
  dependency — it reads the test suite and writes its own artifacts. M0 in
  particular touches no shared schema and can land before any sibling.
- **Feeds the test-receipt plan** ([`19-test-receipt-blinded-review-machine.md`](./19-test-receipt-blinded-review-machine.md))
  directly and by name. That memo declares `stabilityEvidence` as a
  "consumes (attach point only, not built here)" field and explicitly names
  "whichever sibling plan builds Round 5's hermetic repeat-matrix runner" —
  **this is that plan.** `StabilityEvidence` (§3.1) is the concrete shape behind
  its attach point; the two must agree on field names before either lands, and
  plan 19's `stabilityEvidence` description ("process boots, orderings, seeds,
  clock/environment policy, leakage findings, repetitions, and failures",
  `session-2026-08-11-synthesis.md:266`) is satisfied member-for-member by
  `trialIds` / `axesCovered` / `trialsPerAxis` / `leaks` / `class`.
- **Feeds the evidence-substrate plan** ([`18-verification-evidence-ledger.md`](./18-verification-evidence-ledger.md)).
  A `FlakeSignature` is naturally an `EvidenceRecord` with
  `kind: "test_case"`, `strength: "measured"`, `verifier: {name: "interlinked-stability"}`,
  and `invalidatedBy: ["testsHash", "environmentHash"]`. More importantly, this
  lane supplies that envelope's missing **downgrade** path: a claim whose
  underlying test is quarantined should read as `disputed`, which is a state
  that substrate already declares. `stability-trials.jsonl` is deliberately
  typed and content-addressed so migration into the unified ledger is a
  storage-layer swap.
- **Feeds the dispositions plan** ([`18-mutation-disposition-registration.md`](./18-mutation-disposition-registration.md)).
  A `killed` disposition and a `CounterexampleSearchEvidence` attached to
  `unresolved` (`mutation/disposition.ts:116-128`) are both only as sound as the
  test that produced them. A future certificate issuer should refuse a
  test-derived counterexample sourced from a quarantined test — the same way it
  already refuses a certificate whose bound hashes have moved
  (`mutation/accept.ts:94-107`).
- **Feeds the mutation manifest** (`src/harness/mutation/manifest.ts`) through
  M5's `unstableTests` parameter — the only change this lane makes to existing
  mutation code, and it defaults to empty so every current caller is unaffected.
- **Shares infrastructure with, rather than depends on:** the viz test feed
  (`src/lib/viz/test-events.ts`, `reporter-vitest.ts`), which gains one optional
  `trial_id` field and becomes the matrix's recorder; and the existing
  `flake_check` double-run (`evaluator/test-flake-guard.ts`), which becomes this
  lane's per-edit sampler for the `repetition` axis rather than being replaced.
- **Must be reconciled with, not duplicated by:** `IdentityInstability`
  (`mutation/instability.ts`) — same quarantine *pattern*, different subject
  (mutant ids vs test verdicts). Whoever builds M4 should read that module first
  and reuse its consecutive-stable-runs shape rather than inventing a second one.
