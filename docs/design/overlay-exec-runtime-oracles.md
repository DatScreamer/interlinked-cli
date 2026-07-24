# Overlay exec — running runtime oracles before the bytes land

**Status:** Spike RUN 2026-07-20 (§0). Runner + wire contract shipped (uncommitted);
`SKIP_ENTRIES` fix is the follow-up. Sourced from `docs/external-pulse/bun-in-rust.md` §2.2.

## 0. Spike result (2026-07-20) — the thesis was falsified, then restored

Job 0 (the noop probe, §3) measured overlay build/run/cleanup on this repo across
9 runs (`scratch/probe-overlay-cost.mts`, `scratch/probe-overlay-cost` output):

| Phase | p50 | p90 |
|---|---|---|
| `overlayBuild` (cpSync mirror) | **10,715 ms** | 13,736 ms |
| `noopJob` (`node -e process.exit(0)`) | 42 ms | 104 ms |
| `cleanup` (rm -rf) | 2,213 ms | 3,697 ms |

So the design-doc assumption below — that overlay build is "a rounding error on top of
the coverage run we already pay" — was **wrong for this repo**. The noop job is 42 ms; the
entire cost is the tree copy. Root cause: `SKIP_ENTRIES` in `coverage-overlay.ts` excludes
only `.git` / `node_modules` / `.interlinked`, so every build cpSync-mirrors **3.2 GB**,
dominated by gitignored non-source dirs the suite never needs — `reference-repos/` (866 MB),
`cloud/` (208 MB), `.archive/` (69 MB), `tmp/` (14 MB). The real source surface
(`src`+`docs`+`dist`+`scripts`+configs) is ~30 MB.

**Counterfactual, measured:** copying only the source surface takes **0.62 s** vs **8.6 s**
for the full copyable set — a **14× reduction**. So local overlay-exec IS viable; the
blocker is the skip list, not the approach.

**Two conclusions:**
1. **This is a latent perf bug in the shipped, default-on coverage gate**, not just the
   spike — every gated edit that actually builds the overlay (i.e. isn't budget-deferred)
   copies 1.2 GB of reference repos + cloud worker + archives. The fix (make `SKIP_ENTRIES`
   gitignore-aware, or add the heavy non-source dirs) is a ~14× speedup to an existing gate.
   It is its own careful unit — the overlay is load-bearing, so it needs an integration
   test proving the coverage gate still computes correct coverage against the trimmed tree.
2. **The runtime-oracle thesis holds once the overlay is trimmed.** With build at ~0.6 s and
   the noop at 42 ms, a leak/flake job has ~24 s of the budget to itself. Route the heavy
   instrumented jobs (ASan, Miri) to the Sandbox regardless (cold instrumented rebuild), per
   §5; the light ones (leak, flake) run local.

**Shipped this spike (uncommitted):**
- `src/harness/overlay-command-runner.ts` — `runArgvInOverlay(argv, overlayRoot, budgetMs, spawn?, env?)`,
  the generic bounded-argv seam (§2), + `resolveOverlayBin`. 8 tests, injectable spawn.
- `src/harness/sandbox-jobs/types.ts` — the `SandboxJobRequest` wire contract with the
  **no-argv security invariant** (§5) enforced by `isValidSandboxJobRequest` (rejects any
  smuggled `command`/`argv`/`script`/… channel). 4 tests.
- `coverage-runner.ts` `SpawnFn` gained an `env` option (for `--expose-gc` leak probes).

The original plan below is unchanged; §0 supersedes the "build is free" premise in §3/§7.

---


**The thesis, in Jarred's words:**

> For stability issues, knowing as early as possible is best. Fuzzing happens after code is
> merged. CI happens when code is pushed. Runtime safety checks & address sanitizer happen
> when code is run (hopefully in development, before CI).

Every stability tool Bun had fired **after the bytes landed**. His fix was to change
languages so the compiler moved the check to the earliest possible moment. Ours is to move
the tools instead — to `tool_input`, before the write.

**This is not a new idea in this repo.** `test-category-adoption-from-the-wild.md` §6's
per-edit cost router already assigns *Sanitizers (ASan/TSan/Miri)* and *bounded fuzz-smoke* to
**PreToolUse**, escalating to cloud because "cold instrumented rebuild blows the box." And
`harness-firefox-bug-class-checks-plan.md` already designed the Tier-3 `verify --dynamic`
surface, then deferred it. The idea is written down. It is unbuilt. What the Bun post adds is
the evidence that it pays, and the answer to two of that plan's open questions.

---

## 1. What executes today

Nothing that we generate. Precisely:

| Thing | Reality |
|---|---|
| `scaffold-fuzz.ts` | emits a fast-check / Hypothesis property test as a **suggestion string**. Its own header: *"The scaffolds are SUGGESTIONS — they do not execute."* |
| `checks/property-testing.ts` | `checkUntestedInversePair`, `checkUntestedIdempotent` — **static** detection of round-trip pairs lacking tests |
| `asan`/`ubsan`/`lsan`/`tsan`/`miri`/`valgrind`/`cargo-fuzz`/`libfuzzer`/`atheris` | **zero occurrences** in `src/` |
| `sanitizer-registry.ts` | false friend — recognizes *data*-sanitizers (`DOMPurify.sanitize`) for taint tracking |
| `fixture-leak.ts` | static path heuristic for orphan test fixtures. No memory-leak detection anywhere |

Three things genuinely run code: the coverage overlay's suite run, the `affected_tests`
quality check, and cloud Stryker. Two footnotes worth knowing:

- **Rust tests never execute.** `TEST_DISPATCHERS` (`quality-checks/test-dispatchers.ts`) maps
  rust → `cargo test --no-run`. It compiles and stops. The cheapest Rust runtime win available
  is dropping `--no-run`, long before any Miri.
- **Per-edit coverage is js/ts/python only** (`coverageLanguageForPath`). Go and Rust are never
  coverage-gated, even at commit.

## 2. The seam, and the mistake not to make

`createCoverageOverlay(projectRoot, editedRelPath, proposedContent, extraFiles?)`
(`coverage-overlay.ts:176`) already produces exactly what a runtime oracle needs: a real
on-disk shadow tree, `node_modules` symlinked, `.git`/`.interlinked` skipped, `realpathSync`'d
so coverage engines' `relative()` paths resolve. And `runSuite` (`coverage-runner.ts:290`)
already spawns a bounded argv against it, resolves a bare bin to the tree's
`node_modules/.bin`, times it, and never throws. `CoverageRunOpts.testCommand?: string[]` is
already an arbitrary-argv override.

**The mistake:** exposing `runAgainstOverlay(argv, overlayRoot, budgetMs)` as a standalone
entry point that builds its own overlay.

`mirrorProjectInto` is a `cpSync` of the entire working tree. That cost is paid once per
gated edit today and is amortized against a multi-second suite run. A second job that builds
its own overlay pays it twice. Worse, `sweepStaleOverlays` exists because seven leaked trees
once filled 24 GB of disk — doubling overlay creation doubles that exposure.

**So jobs compose inside one overlay lifetime.** The correct seam is `runOverlayAndDecide`
(`evaluator/coverage-write-guard.ts:178-268`), which already owns the overlay in a `try` and
cleans it in a `finally`. The coverage run happens at L201; the CRAP gate at L253. A runtime
oracle runs **after CRAP, before the baseline is staged** — inside the same `try`, against the
same `overlay.overlayRoot`.

```
overlay = createOverlay(...)          // L191, cpSync — paid once
try {
    result = coverageRunner.run(...)  // L201
    ... red-bar, coverage, CRAP gates ...
    for (const job of runtimeOracleJobs(ctx))   // ← NEW: same tree, remaining budget
        if (decision = await job(overlay, remainingBudget)) return decision
    stageBaseline()
} finally { overlay.cleanup() }        // L266
```

`remainingBudget = ctx.budgetMs - result.suiteMs`. If the coverage run consumed the 25 s
budget, no oracle runs — and `deferForBudget` has already fired anyway.

### Two small blockers in the existing code

1. **`SpawnFn` cannot set env.** `defaultSpawn` (`coverage-runner.ts:230`) passes only
   `{ shell: false, stdio, cwd }` — no `env` key — so children inherit `process.env`
   unmodified. A leak probe needs `--expose-gc`. Widen the options bag with an optional
   `env?: Record<string,string>`; `defaultSpawn` merges over `process.env`. Backward
   compatible, one call site.
2. **`runSuite`'s bin resolution is trapped inside a coverage-shaped function.** Extract
   `resolveBin(projectRoot, rawBin)` (5 lines) so oracle jobs get local-`.bin` resolution for
   free.

Neither is a redesign. The overlay primitive is already job-agnostic; only the *result
contract* (`CoverageRunResult`) is coverage-shaped.

## 3. The spike (≤1 day) — measure before building

The detectors in `bun-regression-detectors.md` have no viability risk. This does. The spike's
only job is to answer: **does a second command fit in the budget, and what does the overlay
itself cost?**

### Job 0 — `noop`

Run `node -e "process.exit(0)"` against the overlay. This measures nothing about the code and
everything about the harness: overlay `cpSync` ms, spawn ms, teardown ms. Instrument
`runOverlayAndDecide` to emit `{overlayBuildMs, jobMs, cleanupMs}` for 20 real edits on this
repo.

**This is the number that decides the program.** If `overlayBuildMs` is 800 ms on a
1,000-file repo, every runtime oracle is a rounding error on top of a cost we already pay, and
the whole plan is cheap. If it's 5 s, the local tier is dead and everything routes to the
Sandbox — which is also a result, and it writes §5's RFC for us.

### Job 1 — `leak_probe`

The JS analog of Bun's `Bun.build()` table (500 → 2,000 builds; 1,914 MB → 6,745 MB before,
levelling at 609 MB after).

Run the **affected tests** (`selectAffectedTests`, already computed for the scoped coverage
route) K times in one `node --expose-gc` process, forcing `global.gc()` between runs and
sampling `process.memoryUsage().heapUsed`.

**The measurement is the hard part, not the runner.** A single before/after delta is noise:
GC is nondeterministic, the JIT warms, module graphs cache. So:

- Sample at K = 1, 2, 3 iterations. Fit a line. Report a leak only when the slope exceeds the
  threshold **and** R² > 0.95 — i.e. memory grows *linearly with iterations*, which is what a
  leak looks like and what noise does not.
- K = 3 triples the affected-suite cost. Gate `leak_probe` on `remainingBudget > 3 × suiteMs`,
  which for a scoped 2 s suite is comfortable and for a full suite never fires.
- Threshold is a water-line: `.interlinked/leak-baseline.json`, per test file, bytes-per-iteration,
  may only shrink. That makes it the 8th entry in `baseline-integrity-gate.ts` (`BaselineKind`
  union → `BASELINE_RE` → `KIND_MAP` → a `detectLeakBaseline` → `switch` case), so an agent
  cannot raise its own leak ceiling.

**Do not import the edited module to probe it.** `harness-firefox-bug-class-checks-plan.md`
§Tier-3 already settled this: *"Importing a changed module to test it executes that module's
top-level code… can hit real services (DB connect on import, fetch on import), depend on env
vars, mutate global state."* The probe runs the repo's **own tests**, which the repo has
already decided are safe to run. This is also the deeper lesson from Bun: he didn't synthesize
inputs against pure functions — he ran the existing suite under instrumentation. The suite is
the harness.

### Acceptance

The spike succeeds if, on a scoped-test route, `overlayBuildMs + 3 × suiteMs` fits inside
25 s at p50 on this repo. It fails informatively otherwise, and the output is §5.

## 4. Job routing

Following `test-category-adoption-from-the-wild.md` §6, and constrained by what we can dogfood:

| Job | Kind | Where | Why |
|---|---|---|---|
| `leak_probe` | js/ts | **local**, per-edit | pure `node --expose-gc`; no rebuild |
| `flake_probe` | js/ts | **local**, per-edit | rerun affected tests K× with `--sequence.shuffle` + fixed seed. Zero new instrumentation, binary result. The cheapest real runtime oracle we have. |
| `fuzz_smoke` | any | local, **bounded** | time-boxed run of an *existing* fuzz target. We have none — deferred until a repo does |
| `asan` / `miri` | rust / c | **cloud** | cold instrumented rebuild blows the box (§6's own verdict) |
| `cargo test` (drop `--no-run`) | rust | local | trivial, high value, unrelated to overlays |

Note `flake_probe` is not in the Bun post. It is here because it is the one runtime oracle
that needs **no new instrumentation, no sanitizer, no fuzz corpus** — and nondeterminism is a
bug class this harness already cares about (`nondeterminism-flow`, `clock_mock_added`). If the
spike shows budget headroom, ship `flake_probe` before `leak_probe`.

## 5. RFC — `SandboxJobRunner`

A `cloud/mutation-worker` implementation exists **in the local working tree only** — `cloud/` is
gitignored (`.gitignore:66`), so it is **not checked in** and a fresh clone does not have it.
Treat cloud execution as a client/protocol seam owned by this package, with the Worker owned by
the server workstream. (Do not read "the Worker exists" as "the Worker ships.")

That said, the local copy already demonstrates the whole pattern:
`getSandbox(ns, repoSandboxId)` → `seedOnce` (clone if absent, warm-kept) → `resetWorkTree` →
`syncDeps` (lockfile-diff `npm ci --ignore-scripts`) → `writeOverlays` → `exec` →
`readFile(report)`. **Only two things are mutation-specific**: the `npx stryker run` command and
`REPORT_PATH`. Everything else — auth, sandbox identity, reset, deps, the `FileOverlay[]` wire
shape, the `AbortController` budget — is already job-agnostic.

Client side, `MutationRunner` is `{ available(), run(file, overlayContent, overlays?) }` and
`createCloudMutationRunner` POSTs `{file, overlayContent, overlays}` and throws on non-`ok`
(which the gate turns into an honest `[mutation:not-measured]` allow, never a forged pass).

### The security constraint: no `command` field on the wire

The obvious generalization is to add `command: string[]` to the request. **Do not.**

The Worker today executes a fixed command against attacker-influenced *content*. That is a
sandbox executing the user's own code — which is what it is for. Adding a command field
converts `MUTATION_TOKEN` from "may run this repo's test suite" into a **general remote-code-execution
credential against every warm, per-repo sandbox the Worker holds**. Sandboxes are keyed by
`repoSandboxId(repoUrl)` and kept warm across requests; a leaked token plus a free-form command
is lateral movement across tenants.

Instead, send a **discriminant**:

```ts
type JobKind = "mutation" | "leak" | "flake" | "asan" | "miri";
interface SandboxJobRequest { repo?: string; overlays: FileOverlay[]; job: JobKind; budgetMs: number }
interface SandboxJobResult  { exitCode: number; stdout: string; stderr: string; report?: unknown }
interface SandboxJobRunner  { available(): boolean; run(req: SandboxJobRequest): Promise<SandboxJobResult> }
```

The Worker owns `JOB_TABLE: Record<JobKind, {command: string, reportPath?: string}>`. The blast
radius of a stolen token stays exactly where it is today. This is
`feedback_local_checks_not_a_trust_boundary` applied one layer out: the cloud tier *is* the
trust boundary, so its interface must not be a shell.

### Obligations

Do **not** extend `coverage-obligation-ledger.ts` — it is coverage-shaped
(`CoverageObligation.kind: "coverage"`, `reason: "budget_exceeded"`). Use the generic engine:
`obligations.ts` already defines `ObligationKind = "coverage" | "mutation" | "red_suite"` and
`METRIC_DESCRIPTORS`, where `MUTATION_DESCRIPTOR` is
`{dischargeSources: ["cloud"], enforcementCadence: "push", staleAfterEdits: null}`. A `leak` or
`asan` obligation is that same shape: measured in the cloud, enforced at push. Append via
`appendDebtTxn` (`obligation-ledger-io.ts:30`), read via `readOpenDebts`.

### Wiring

The daemon-side template already exists: `runMutationWriteGate`
(`server/pre-tool-coverage-gates.ts:200-239`) lazily `import()`s the cloud runner only when
`cfg.runner_url` is set, defaults `budget_ms ?? 25_000`, injects `fetch`, and returns
`null`-on-unavailable rather than blocking. Copy it. The pipeline slot is
`pre-tool-pipeline.ts:342-370`, between the mutation gate and the commit gates.

Config: `per_edit_runtime_oracles?: { enabled: boolean; jobs: JobKind[]; budget_ms?: number; runner_url?: string; token?: string }`,
default `{ enabled: false, jobs: [] }` — same posture as `per_edit_mutation`, which ships
default-off with no `runner_url` and therefore builds a `null` runner and reports honestly.

## 6. Order

1. **Spike** — Job 0 (`noop`) instrumentation. One day. Decides everything below.
2. `SpawnFn.env` + `resolveBin` extraction. Trivial, unblocks the rest.
3. `flake_probe` local, advisory. No new instrumentation; validates the job-inside-overlay seam.
4. `leak_probe` local + `.interlinked/leak-baseline.json` as the 8th ratchet water-line.
5. `SandboxJobRunner` RFC → implementation, discriminant-only wire, `asan`/`miri` jobs.
6. Drop `--no-run` from the Rust test dispatcher. (Unrelated to all of the above; do it first
   because it takes five minutes.)

## 7. What this does not claim

Bun runs coverage-guided fuzzing 24/7 across fourteen parsers and has executed them 100 billion
times, yielding ~15 PRs. That is a *campaign*, not a gate — the right home is Agent CI, and the
right cadence is continuous, not per-edit. Nothing here proposes fuzzing on the hook path
beyond a time-boxed smoke of an existing target.

And the honest limit of the whole program: a per-edit leak probe on a 2-second scoped suite
observes what those tests observe. Bun's leak table came from a 2,000-iteration loop over
`Bun.build()` — a purpose-built stress test a human wrote because he suspected a leak. The
harness can enforce that such a test, once written, keeps passing. It cannot write it.
