# Incremental Per-Edit Coverage + CRAP Ratchet

**Status:** implementation plan, 2026-06-11. Requested by the user. Amended
the same day after a codebase-verified review: isolation-boundary
precondition (section 5.3), shard instability quarantine (section 7.1),
single accepted-coverage store (section 8.6), red-bar regression-versus-debt
policy (section 9.4), rename baseline carry-over (section 9.2), async-runner
prerequisite (section 10.1), selection-cost budget prediction (section 10.2),
and an explicit empty-selection contract change (section 8.3).

**Progress:** Phase 0 spike complete 2026-06-11, verdict GO — results and the
adapter decision at `incremental-per-edit-coverage-phase0-spike.md`; probe at
`.interlinked/spike-coverage-shards.mjs`. Phase 1 core landed
(`src/harness/coverage-index/{types,aggregate}.ts`). The section 8.6 store
collision is fixed: the per-edit ledger baseline moved to
`.interlinked/coverage-edit-baseline.json` with a cross-store regression test.

**Audience:** engineers working on the Interlinked CLI harness, especially
PreToolUse enforcement, coverage runners, coverage normalization, test
selection, persistent harness state, Stop/commit reconciliation, and test-quality
policy.

**Related:**

- `docs/design/per-edit-coverage-enforcement.md` — existing apply-before-disk
  coverage enforcement and budget deferral.
- `docs/design/test-quality-harness-local-first.md` — broader local-first test
  quality model.
- `docs/design/incremental-posttooluse.md` — caching and incrementality patterns
  for synchronous hook work.
- `docs/design/open-obligation-ledger.md` — deferred-work semantics.
- `src/harness/evaluator/coverage-write-guard.ts` — current PreToolUse coverage,
  red-bar, and CRAP gate.
- `src/harness/coverage-test-selector.ts` — current reverse-dependency affected
  test selection.
- `src/harness/coverage-obligation-ledger.ts` — current runtime estimate,
  coverage baseline, and deferred obligations.
- `src/harness/coverage-ratchet.ts` — current verify-time per-file high-water
  ratchet (subsumed by the index; see section 8.6).

---

## 1. Origin and user intent

Cyclomatic complexity is cheap to calculate from proposed source text. Coverage
is different: authoritative coverage normally requires instrumenting code and
executing tests. That makes coverage comparatively slow, especially if every
edit starts a new test process or runs the full suite.

The user identified the product opportunity behind removing that latency:

1. If coverage can be measured quickly enough before an edit lands, it becomes a
   true PreToolUse enforcement signal rather than a later advisory.
2. The harness can block an edit that decreases coverage.
3. Because CRAP combines cyclomatic complexity and coverage, the same fresh
   coverage result can block an edit that increases CRAP without another test
   run.
4. Existing quality debt should not make a file untouchable. If a file is
   already on the wrong side of a coverage or CRAP threshold, merely touching it
   should warn the agent, but should not block an edit that leaves the metric
   flat or improves it.

The intended policy is therefore a **ratchet**, not a blanket minimum-quality
gate:

- **Block regressions introduced by the proposed edit.**
- **Warn about pre-existing debt encountered by the edit.**
- **Allow neutral or improving edits, even when the file remains below the
  desired threshold.**

This distinction is load-bearing. A future implementation must not turn an
existing low-coverage file or high-CRAP function into an absolute edit freeze.

---

## 2. Product outcome

For an eligible source edit, the harness should answer before the real write:

1. What are the source file's current line and branch coverage metrics?
2. What would those metrics be after applying the proposed edit and its sibling
   test edits atomically?
3. What are the current per-function CRAP scores?
4. What would those CRAP scores be after the proposed edit?
5. Is the proposed state based on fresh, complete-enough runtime evidence?

The resulting behavior is:

| Condition | PreToolUse result |
|---|---|
| Coverage decreases | Block |
| A matched function's CRAP score increases | Block |
| A new function starts at or above the configured CRAP threshold | Block |
| A new file starts below the configured coverage threshold | Block |
| Existing coverage is below threshold, but does not decrease | Allow + warn |
| Existing CRAP is above threshold, but does not increase | Allow + warn |
| Metrics improve but remain beyond thresholds | Allow + warn |
| Metrics are healthy and remain flat or improve | Allow silently |
| A selected test shard newly fails (passed at baseline) | Block |
| A selected test shard was already failing at baseline | Allow + warn |
| Evidence is stale, incomplete, unavailable, or over budget | Full-run fallback or defer; never guess-block |

The user-visible warning should make ownership clear: the agent did not create
the debt, but it is working in a risky area and should improve it when practical.

---

## 3. Definitions

### 3.1 Coverage

Coverage is runtime evidence produced by executing instrumented code under
tests. The implementation must keep dimensions distinct:

- **Line coverage:** covered executable lines / executable lines.
- **Branch coverage:** covered branch outcomes / branch outcomes.
- **Function coverage:** entered functions / functions.
- **Statement coverage:** covered statements / statements.

The primary ratchets in this plan are line and branch coverage. Function and
statement data remain useful for reporting and CRAP attribution.

An unqualified "coverage percentage" is insufficient for enforcement. Every
stored baseline, comparison, warning, and block must name its dimension and
retain absolute covered/total counts where the source format provides them.

### 3.2 CRAP

CRAP is calculated per function:

```text
CRAP = complexity² × (1 − coverage)³ + complexity
```

`coverage` is the function's coverage fraction from `0` to `1`. Cyclomatic
complexity is calculated from source. Coverage must come from fresh runtime
evidence for the proposed overlay.

CRAP has a minimum equal to the function's cyclomatic complexity, even at 100%
coverage. Therefore a new highly complex function can have a CRAP increase even
when it is fully covered. That is intentional: decomposition and testing are
both valid ways to reduce CRAP.

### 3.3 Regression versus debt

- **Regression:** the proposed edit makes a metric worse than the accepted
  pre-edit state.
- **Debt:** the accepted pre-edit state is already outside a configured
  threshold.
- **Threshold warning:** advisory feedback caused by debt, independent of
  whether the proposed edit worsens it.
- **Ratchet block:** deterministic refusal caused by a measured regression.

---

## 4. Existing substrate

This is not a greenfield implementation. The repository already contains:

- Apply-before-disk overlays that materialize the proposed source and sibling
  edits without changing the real worktree.
- JS/TS and Python coverage runners.
- Per-file and per-line coverage readers.
- A canonical coverage model and LCOV adapters.
- Reverse-dependency affected-test selection.
- Full-suite fallback when selection cannot prove a complete subset.
- Per-edit runtime estimates and budget-based deferral.
- Deferred coverage obligations and Stop/commit relief paths.
- Coverage-drop blocking.
- Uncovered-added-line blocking.
- Red-suite blocking.
- Per-function cyclomatic analyzers.
- CRAP calculation using the canonical formula.
- Pre-edit CRAP snapshots and PostToolUse "riser" warnings.
- Commit-time full-suite coverage, CRAP, and cyclomatic enforcement.

The current implementation still pays for a coverage test run on each enforced
edit. Its CRAP PreToolUse behavior is also primarily an absolute touched-function
threshold: a touched function at or above the threshold blocks even if the edit
does not worsen it. The red-bar block likewise fires on any red overlay run,
with no comparison against the shard's prior pass/fail state. Neither matches
the regression-versus-debt policy in this document (section 9.4 fixes the red
bar; section 8.5 fixes CRAP).

The missing primitive is an **authoritative, replaceable coverage contribution
index** that lets the harness update aggregate coverage by rerunning only the
affected test shards.

---

## 5. Why aggregate coverage caching is insufficient

### 5.1 A source/test pair is not the whole coverage universe

Running `foo.test.ts` and measuring `foo.ts` answers:

> How much of `foo.ts` did this selected test file execute?

It does not answer:

> How much of `foo.ts` does the complete test suite execute?

Integration tests, command-level tests, plugin tests, fixtures, and indirect
imports may also cover `foo.ts`. A targeted result must never be compared
directly with a full-suite baseline; the scopes differ, so the apparent drop may
be entirely artificial.

The shard index solves this by retaining the unchanged contributions from every
other valid shard and replacing only the rerun shards. The proposed aggregate
therefore preserves one consistent test universe.

### 5.2 Overlapping contributions require replacement

Suppose tests A and B both cover line 10:

```text
A covers {10, 11}
B covers {10, 12}
aggregate covers {10, 11, 12}
```

After an edit, A is rerun and now covers only `{11}`. An aggregate-only cache
cannot safely subtract A's old contribution to line 10 because B still covers
it. Replacing an old aggregate with a new targeted report is also wrong because
the targeted report omits B.

Incremental coverage therefore requires coverage contributions stored by a
replaceable execution unit:

```text
aggregate coverage = union(contribution for each valid test shard)
```

When shard A is rerun:

1. Remove A's old contribution.
2. Insert A's new contribution.
3. Recompute the union with every unchanged valid shard.

This is exact for coverage presence. Hit counts may be summed for diagnostics,
but enforcement only needs stable coverage element identity plus covered/not
covered.

### 5.3 Replacement is exact only at an isolation boundary

Union-by-replacement assumes a shard's contribution is independent of which
other shards ran alongside it. That assumption fails when test state leaks
across the shard boundary:

- Vitest with `isolate: false` shares one module registry across the test
  files in a worker, so a file's contribution depends on its co-scheduled
  files.
- pytest session- and module-scoped fixtures attribute setup execution to
  whichever shard ran it first. A shard rerun alone executes setup lines it
  did not "own" in the indexed baseline run.

Both produce contribution churn with no source change, which the ratchet
would misread as a coverage delta.

Requirements:

1. A shard boundary must coincide with the runner's effective isolation
   boundary. When the runner is configured with weaker isolation
   (`isolate: false`, shared worker state), degrade shard granularity to the
   actual isolation unit — up to one shard per whole run if necessary.
2. The isolation configuration is a validity input: record it in the
   manifest and invalidate the index when it changes (section 11).
3. Contribution churn across reruns with identical validity hashes is shard
   instability (section 7.1), not a metric change.

---

## 6. Execution unit: stable test shards

The portable contract is a **test shard**, not necessarily an individual test
case or test file.

A shard is a deterministic group of tests whose coverage contribution can be
replaced as one unit. Examples:

- One test file when the runner exposes file-level attribution.
- One pytest coverage context or deterministic group of test files.
- A configured package/test target for runners that cannot expose finer
  attribution.

A Vitest *worker's* test-file group is NOT a valid shard identity:
file-to-worker assignment is scheduling-dependent and varies run to run,
which violates the stable-identity requirement. Shard membership must derive
deterministically from test identity (file path, configured group), never
from runtime scheduling.

Individual-test attribution is an optional optimization. The correctness model
must work with stable shards because not every runner exposes reliable
per-test-case coverage.

Vitest 4 already tracks raw coverage internally by test-file groups before
merging reports. The first implementation should prove whether that supported or
semi-supported surface can be captured without launching one process per test
file. If relying on internal Vitest APIs is too version-fragile, use an
Interlinked reporter/provider adapter or deterministic explicit shards instead.

---

## 7. Evidence authority

Hard blocks require authoritative evidence. Static dependency analysis may
select tests, but it may not prove that no other test can cover a source file.
Dynamic imports, plugin loading, CLI entry points, HTTP integration tests, and
indirect runtime registration routinely bypass a simple import graph.

An incremental result is block-authoritative only when all of these hold:

1. A prior authoritative run created a complete shard index for the applicable
   test universe.
2. Every shard that can be invalidated by the edit has been selected for rerun,
   or the runner provides a stronger completeness guarantee.
3. Unchanged shards still match their source/test/config/dependency validity
   hashes.
4. The proposed source and sibling test edits were materialized in one overlay.
5. The coverage engine, include/exclude configuration, test discovery
   configuration, runner version, and relevant environment fingerprint match the
   indexed baseline.
6. The rerun completed and emitted parseable coverage.

If any condition fails:

- Run a full authoritative coverage pass when it fits the synchronous budget.
- Otherwise record a deferred obligation and allow with an explicit warning.
- Never block from a guessed, stale, or known-incomplete percentage.

### 7.1 Shard instability quarantine

Nondeterministic tests produce nondeterministic coverage: a timing-,
ordering-, or environment-dependent test can cover different lines run to
run with no source change. Such a shard would trip the line/branch ratchet
randomly and break the zero-false-block contract (section 17) no matter how
correct the index math is.

The index therefore tracks per-shard stability:

- A rerun whose validity hashes are identical to the stored ones but whose
  contribution (covered-element set) or pass/fail state differs records an
  instability event on that shard.
- A shard with recent instability events is **quarantined**: its
  contribution still participates in aggregates, but a regression whose
  delta is attributable to a quarantined shard downgrades from block to
  warning, with the instability named in the message.
- Quarantine decays: N consecutive stable reruns restore block authority.

Instability detection is also how isolation-boundary violations
(section 5.3) surface in practice; one mechanism covers both.

---

## 8. Proposed architecture

### 8.1 Canonical element-level coverage

Extend the canonical representation beyond summary counts:

```typescript
interface CanonicalCoverageElementSet {
    lines: Map<number, number>;
    branches: Map<string, number>;
    functions: Map<string, number>;
    statements?: Map<string, number>;
}

interface ShardCoverageContribution {
    shardId: string;
    files: Map<string, CanonicalCoverageElementSet>;
}
```

Branch and statement keys must be stable within the same source/config version.
For example, an LCOV branch key can use `line:block:branch`; Istanbul can use a
normalized source location plus branch index.

The index must retain covered element identities, not only percentages.

### 8.2 Persistent coverage index

Store under `.interlinked/coverage-index/`, one subtree per runner:

```text
<runner-id>/manifest.json
<runner-id>/shards/<shard-id>.json.zst
<runner-id>/files/<source-path-hash>.json
<runner-id>/staging/<event-id>/
```

A polyglot repo holds several manifests (vitest, pytest, …); `runnerId`
names the subtree. Each runner is its own consistent test universe
(section 5.1): per-file metrics are evaluated per runner, and a regression
in any runner's view is a regression. The index is machine-local runtime
evidence — like the trigram index it stays inside the existing
`.interlinked/*` gitignore, with no committed carve-out.

The manifest should include:

```typescript
interface CoverageIndexManifest {
    version: number;
    authoritativeAt: string;
    runnerId: string;
    runnerVersion: string;
    coverageEngine: string;
    coverageConfigHash: string;
    testDiscoveryHash: string;
    dependencyGraphVersion: string;
    environmentHash: string;
    /** Isolation boundary shards derive from: "file", "group", or "run" (section 5.3). */
    shardBoundary: string;
    sourceRevision?: string;
    shards: Record<string, ShardManifestEntry>;
}
```

Each shard entry records:

- Stable shard ID and test paths.
- Test content hashes.
- Relevant transitive source/dependency hashes.
- Last execution duration.
- Coverage contribution path and checksum.
- Pass/fail state.
- Instability events and quarantine state (section 7.1).

Each source reverse index records:

- Shards that historically covered the source.
- Shards selected through static dependencies.
- Aggregate line/branch/function element counts.
- Last authoritative source hash.

### 8.3 Test selection

For each edited source file, select the union of:

1. Shards that historically covered the file.
2. Tests found through the reverse dependency graph.
3. Companion tests found through naming conventions.
4. Edited or newly added tests in the same atomic patch.
5. Shards invalidated by changed shared setup, fixtures, configuration, or
   dependency files.

Selection is complete only if the index and dependency graph both pass their
validity checks. An empty selection is not proof of no coverage; it routes to the
full-suite fallback.

The empty-selection rule deliberately reverses the current selector
contract. Today `coverage-test-selector.ts` documents `[]` ("in the graph,
no test depends on it") as the strict-TDD signal and the caller blocks. That
is a static-authority block, and it false-fires when the only coverage is
dynamic (integration tests, CLI entry points, plugin loading) — exactly what
section 7 forbids. Under the index, an empty union (no historical shard, no
static dependent, no companion, no sibling test edit) routes to the full
fallback; genuinely untested code still blocks there via the
uncovered-changed-line rule, now from runtime evidence. Update the
selector's documented three-state contract in the same change.

### 8.4 Overlay execution

The existing apply-before-disk overlay remains the execution substrate:

1. Materialize every section of the proposed patch, including source, tests,
   deletes, and moves.
2. Run selected shards under coverage in the overlay.
3. Parse each shard contribution into the canonical model.
4. Build a proposed aggregate by replacing those shards in a copy-on-write view
   of the accepted index.
5. Compare accepted versus proposed metrics.
6. Block or allow.

PreToolUse must not mutate the accepted index. Passing results are staged by
event/tool-use ID. PostToolUse promotes the staged index only if the actual file
hashes match the proposed overlay hashes. A blocked, failed, cancelled, or
different write discards staging.

### 8.5 CRAP comparison

Cyclomatic analysis runs against both accepted and proposed source text. CRAP is
then calculated from accepted and proposed function coverage.

Function identity should match in this order:

1. Stable AST/symbol identity when available.
2. Qualified function name plus enclosing symbol.
3. Same-name nearest-line fallback with bounded drift.

For each proposed function:

- Matched function: block when `newCrap > oldCrap + tolerance`.
- New function: block when `newCrap >= crap_threshold`.
- Existing function removed: no CRAP regression.
- Rename with stable symbol/body correspondence: compare as the same function.
- Ambiguous match: full-run/reconciliation path or conservative warning, never a
  guessed block.

The default tolerance should account only for floating-point noise, not policy
slack.

### 8.6 One accepted-coverage store

The repository already has two coverage baselines, and they collide:
`coverage-ratchet.ts` (the verify-time per-file high-water ratchet behind
`interlinked coverage`) and `coverage-obligation-ledger.ts` (the per-edit
drop baseline) both read and write `.interlinked/coverage-baseline.json`
with incompatible schemas (`{version, updated_at, files}` versus a flat
path → fraction map). Each reader fails open on the other's shape, so
`interlinked coverage --update-baseline` silently wipes every per-edit drop
baseline. That collision is worth fixing immediately, independent of this
plan.

This plan must not add a third store. The accepted index becomes the single
source of accepted coverage:

- The per-edit drop check reads accepted per-file metrics from the index
  instead of the ledger's baseline map.
- The verify-time ratchet (`interlinked coverage`, `interlinked metrics`)
  reads the same accepted metrics; if the high-water presentation is
  retained, it becomes a derived view over index history, not a second
  store.
- `.interlinked/coverage-baseline.json` is retired in Phase 3 once both
  consumers read the index.

---

## 9. Decision policy

### 9.1 Coverage regressions

Compare both percentage and absolute counts:

```text
line_pct = covered_lines / executable_lines
branch_pct = covered_branches / total_branches
```

Block when either configured dimension decreases beyond its tolerance.

Absolute counts are necessary for diagnostics. A percentage can remain flat
while both numerator and denominator change. The block reason should identify:

- Metric and file.
- Before and proposed percentages.
- Covered/total counts.
- Newly uncovered changed lines or branches when known.
- Tests/shards rerun.

Thresholds never define the block boundary. When `allow_decrease_pct` is
greater than zero, a decrease within tolerance is allowed even when it
crosses a warning threshold; the crossing surfaces as a debt warning
(section 9.3) on this and subsequent edits. Deltas drive blocks; thresholds
drive warnings.

### 9.2 New files

A new source file has no accepted metric to ratchet against. Apply configured
adoption thresholds:

- Block if line or branch coverage is below the new-file threshold.
- Block a new function at/above the CRAP threshold.
- Allow fully non-executable/type-only files.

This prevents "no baseline" from becoming a loophole for new untested code.

A renamed or moved file is not new code. When the atomic patch deletes one
path and adds another with identical content (content-hash match), the
accepted metrics, debt state, and reverse-index entries carry over to the
new path, and the ratchet compares against the carried baseline. Without
this, a pure `git mv` of a legacy 60%-covered file would hard-block under
the new-code bar — a ratchet violation. A move-with-edit may use a
similarity heuristic to find its baseline; an ambiguous match follows the
same rule as ambiguous function identity (section 8.5): conservative
warning or full-run path, never a guessed block.

### 9.3 Existing debt warnings

Before running tests, the accepted index can cheaply determine whether any
touched source file has:

- Line coverage below its warning threshold.
- Branch coverage below its warning threshold.
- One or more functions at/above the CRAP warning threshold.

Emit an allow-time warning even if the proposed edit later remains flat or
improves the metrics. Deduplicate per file per session, re-firing only when
the file's accepted metrics change: repeating an identical warning on every
edit to the same file amplifies a stable signal without adding information.

Example:

```text
[interlinked:coverage] WARNING: src/foo.ts is already below the configured
quality bar (lines 62% < 80%; worst CRAP 44 >= 30). This edit did not worsen
those metrics, so it is allowed.
```

### 9.4 Red shards: newly red versus already red

The red-suite block is subject to the same regression-versus-debt split as
every other metric, and the shard index's stored pass/fail state
(section 8.2) makes the distinction cheap:

- **Newly red:** a selected shard passed in the accepted index and fails in
  the proposed overlay run. The patch introduced the failure. Block.
- **Already red:** the shard was failing in the accepted index too. That is
  debt. Allow with a warning naming the failing shard, and record an
  obligation so the failure cannot be silently inherited forever.

This is a deliberate change from the current `block_on_test_failure`
behavior, which blocks on any red overlay run regardless of prior state.
Without the split, one pre-existing failing test makes every file in its
affected set un-editable — the untouchable-file failure mode section 1
forbids. Environment-divergent tests (failing on this machine for
environmental reasons) make "already red" a recurring state, not a corner
case. The warning should still say that fixing the failing test now is the
preferred move; the gate just does not force it as a precondition for
unrelated work.

### 9.5 Ordering

Decision order:

1. Deterministic cheap source guards, including cyclomatic regression.
2. Existing-debt warning lookup.
3. Incremental/full overlay test execution.
4. Red-suite regression block (newly red only; already-red warns —
   section 9.4).
5. Uncovered changed executable line/branch block.
6. Per-file line/branch coverage regression block.
7. CRAP regression/new-function threshold block.
8. Stage accepted metrics and return allow with any debt warnings.

The most actionable failure should win. A red suite is more fundamental than a
coverage percentage; an uncovered changed line is more actionable than aggregate
CRAP.

---

## 10. Latency model

Target performance:

| Path | Target |
|---|---:|
| Accepted debt lookup | `<20 ms` |
| Comment/type-only/non-executable edit | `<100 ms` |
| Warm small-shard incremental coverage, p50 | `<1 s` |
| Warm incremental coverage, p95 | `<3 s` |
| Index aggregate recomputation | `<100 ms` |
| Unrelated-event daemon latency during an in-flight run | Unchanged (section 10.1) |
| Full fallback | Project-dependent, bounded by configured budget |

The runner process startup and instrumentation often dominate small test
execution. Performance work should therefore prioritize:

- Persistent runner/daemon integration where supported.
- Multiple affected shards in one runner invocation.
- Raw per-shard coverage capture before report aggregation.
- Compact on-disk contribution formats.
- Copy-on-write index updates rather than rebuilding every file aggregate.

The hard synchronous budget remains configurable. Exceeding it creates a
deferred obligation rather than weakening evidence standards.

### 10.1 Daemon availability is a prerequisite

The harness daemon serves every session over one Unix socket, and the
current runner spawns synchronously (`spawnSync` in `coverage-runner.ts`),
blocking the daemon's event loop for the duration of the run. Today that is
rarely visible because the budget gate routes big suites to commit time.
This plan's whole point is to put 1–3 s runs in-band on every edit — with a
synchronous runner, every concurrent session's PreToolUse would
head-of-line block behind whichever agent is being coverage-checked.

Moving overlay execution off the accept loop (async child-process spawn or
a worker) is therefore a prerequisite for Phase 2, not an optimization. The
call path is already async end-to-end (`pre-tool-coverage-gates.ts` awaits
the guard); only the spawn itself is synchronous. Requirement: the daemon
keeps answering unrelated events within its normal latency while a coverage
run is in flight.

### 10.2 Predicting the cost of a selection

The budget decision input changes with the index. Today the deferral gate
uses a rolling whole-suite EWMA (`coverage-runtime-estimate.json`) that
blends scoped-run durations across different selections, so it latches on
whichever file was last edited. Under the index, predict the cost of the
actual selection: the sum of the selected shards' last recorded durations
(section 8.2) plus a measured warm/cold startup constant. The EWMA survives
only as the estimate for full-suite fallback runs.

---

## 11. Invalidation

Invalidate all or part of the index when any coverage-affecting input changes:

- Coverage engine/provider or version.
- Test runner or version.
- Coverage include/exclude configuration.
- Source maps/transpiler configuration.
- Test discovery configuration.
- Runner isolation configuration (e.g. Vitest `isolate` / pool strategy —
  it defines the shard boundary, section 5.3).
- Global setup/teardown.
- Shared fixtures or helpers.
- Environment variables declared coverage-relevant.
- Dependency lockfile or package environment.
- Dependency graph version.
- Source content for a shard's transitive dependencies.
- Shard membership algorithm/version.

Use content hashes where possible. Timestamps alone are not validity proofs.

Invalidation can be scoped:

- Edited source: invalidate dependent and historically covering shards.
- Edited test: invalidate its shard.
- Shared setup/config/lockfile: invalidate the whole runner index.
- New unindexed source: full fallback or defer until initialization.

Mass invalidation (a `git pull`, a branch switch, a lockfile change) is the
problem the trigram index already solves in this codebase. Mirror that
lifecycle rather than inventing one: an explicit initializer command (the
`interlinked index build` precedent), a SessionStart staleness check with
incremental refresh, an in-session dirty layer for the agent's own edits,
and budget-bounded automatic rebuild (Phase 4).

---

## 12. Concurrency and atomicity

Multiple agents or overlapping hooks may evaluate the same repository.

Requirements:

- Accepted manifests are immutable snapshots identified by generation.
- PreToolUse staging records its parent generation.
- PostToolUse promotion uses compare-and-swap semantics.
- If the accepted generation advanced, rebase/recompute the staged shard
  replacements or discard them and schedule reconciliation.
- Writes use temporary files plus atomic rename.
- A process crash may leave staging garbage but must not corrupt the accepted
  index.
- Garbage collection removes abandoned staging generations and unreferenced
  shard blobs.

The actual edit and its coverage-index promotion are not one filesystem
transaction. Hash verification at PostToolUse is therefore mandatory.

---

## 13. Configuration

Extend `per_edit_coverage` conservatively:

```json
{
  "per_edit_coverage": {
    "enabled": true,
    "mode": "block",
    "budget_ms": 25000,
    "languages": ["js", "ts", "python"],
    "incremental": {
      "enabled": true,
      "require_authoritative_index": true,
      "reconcile_on_stop": true
    },
    "ratchet": {
      "lines": true,
      "branches": true,
      "allow_decrease_pct": 0,
      "crap_increase_tolerance": 0
    },
    "threshold_warnings": {
      "lines_pct": 80,
      "branches_pct": 70,
      "crap": 30
    },
    "new_code": {
      "lines_pct": 100,
      "branches_pct": 100,
      "crap": 30
    }
  }
}
```

Exact field names may change to match the repository's config conventions.
Semantics must remain:

- Delta regressions block.
- Existing debt warns.
- New code must establish a baseline at the configured bar.
- Unauthoritative evidence cannot block.

Mapping against the existing config: `budget_ms` keeps its shipped default
(25_000 — the documented PreToolUse sync ceiling). The existing
`block_on_test_failure` flag continues to govern the red-bar lane, narrowed
to newly-red regressions (section 9.4). The existing `block_on_crap`
absolute touched-function gate is replaced by
`ratchet.crap_increase_tolerance` plus `new_code.crap` — the delta and
adoption semantics do not stack with the absolute threshold.

Schema validation, merge behavior, generated docs, default config, and regression
tests must land together.

---

## 14. Implementation phases

### Phase 0: Instrumentation spike

Goal: prove per-shard attribution and measure its cost.

1. Capture Vitest raw coverage grouped by test-file shard before merge.
2. Produce two shard contributions with overlapping covered lines.
3. Replace one shard and prove aggregate coverage remains mathematically correct.
4. Measure cold and warm startup, execution, parse, serialization, and union
   costs — including a persistent-runner / warm-execution path, since cold
   starts alone cannot meet the section 10 p50 target.
5. Prototype pytest dynamic contexts or deterministic test-file shards.
6. Demonstrate the isolation-boundary failure mode and its detection: a
   pytest session-scoped-fixture case and a Vitest `isolate: false` case
   whose single-shard rerun changes its contribution (sections 5.3, 7.1).

Exit criteria:

- Exact overlap replacement demonstrated.
- Stable shard identity demonstrated across runs.
- Isolation-boundary violations detected as instability (contribution churn
  with identical validity hashes), not silently absorbed into metrics.
- No one-process-per-test-file requirement for the preferred Vitest path.
- Measured warm-execution evidence that the section 10 latency targets are
  achievable — this is the go/no-go for the whole plan.
- Written decision on public adapter versus version-pinned internal integration.

Estimated effort: 2–3 engineer days.

### Phase 1: Canonical element model and index

1. Add stable line/branch/function element identities.
2. Implement shard contribution serialization.
3. Implement manifest generations and aggregate unions.
4. Implement validity hashes and whole-index invalidation.
5. Add an explicit full-run initialization command/path.

Estimated effort: 3–4 engineer days.

### Phase 2: Incremental runner and selection

1. Prerequisite: move overlay execution off the daemon accept loop — convert
   the runner's synchronous spawn to async so in-flight runs do not block
   other sessions (section 10.1).
2. Union historical-covering and dependency-selected shards.
3. Run selected shards in the existing overlay.
4. Replace contributions in a proposed index generation.
5. Add persistent runner support where justified by Phase 0 measurements.
6. Fall back to full coverage for incomplete selection.

Estimated effort: 2–3 engineer days.

### Phase 3: Ratchet decisions and debt warnings

1. Replace absolute touched-function CRAP blocking with before/after comparison.
2. Add line and branch ratchet decisions.
3. Split the red-bar block into newly-red (block) versus already-red
   (warn + obligation) using stored shard pass/fail state (section 9.4).
4. Add new-file/new-function policy, including rename baseline carry-over
   (section 9.2).
5. Add cheap accepted-debt warnings.
6. Stage passing generations and promote at PostToolUse.
7. Retire the colliding baseline stores: the per-edit drop check and the
   verify-time ratchet both read the index, and
   `.interlinked/coverage-baseline.json` is deleted (section 8.6).
8. Consolidate or retire the stale-report PostToolUse CRAP riser path once parity
   is proven.

Estimated effort: 3–4 engineer days.

### Phase 4: Reconciliation and obligations

1. Reconcile incremental aggregates with a full authoritative run at Stop,
   commit, explicit coverage execution, or CI.
2. Discharge obligations only from authoritative passing evidence.
3. Detect and record incremental/full discrepancies.
4. Rebuild the index automatically after invalidation when budget allows.

Estimated effort: 2–3 engineer days.

### Phase 5: Rollout

1. Telemetry-only shadow mode.
2. Warning mode for incremental/full discrepancies.
3. Enable coverage-regression blocks after the discrepancy target is met.
4. Enable CRAP-regression blocks after function matching meets its target.
5. Keep absolute debt as warnings.

Total expected effort: approximately 2–3 engineer weeks including tests,
cross-language support, concurrency, and rollout instrumentation.

---

## 15. Files likely to change

Core:

- `src/harness/coverage-canonical.ts`
- `src/harness/coverage-lcov.ts`
- `src/harness/coverage-adapters.ts`
- `src/harness/coverage-final-reader.ts`
- `src/harness/coverage-discharge.ts`
- `src/harness/coverage-runner.ts`
- `src/harness/coverage-test-selector.ts`
- `src/harness/coverage-overlay.ts`
- `src/harness/evaluator/coverage-write-guard.ts`
- `src/harness/evaluator/coverage-write-decision.ts`
- `src/harness/evaluator/coverage-crap-decision.ts`
- `src/harness/coverage-obligation-ledger.ts`
- `src/harness/server/pre-tool-coverage-gates.ts`
- `src/harness/server/post-tool-pipeline.ts`

New modules, likely:

- `src/harness/coverage-index/types.ts`
- `src/harness/coverage-index/store.ts`
- `src/harness/coverage-index/aggregate.ts`
- `src/harness/coverage-index/invalidation.ts`
- `src/harness/coverage-index/staging.ts`
- `src/harness/coverage-index/reconcile.ts`
- `src/harness/coverage-shards/vitest.ts`
- `src/harness/coverage-shards/pytest.ts`

Policy/config:

- `src/harness/types/config.ts`
- `src/harness/rules/default-config.ts`
- `src/harness/rules/merge.ts`
- Config schema validation and generated reference docs.

Consolidation candidates:

- `src/harness/checks/crap-baseline.ts`
- `src/harness/quality-checks/inline-block.ts`
- `src/harness/coverage-ratchet.ts` — verify-time high-water baseline; reads
  the index after section 8.6.
- `src/commands/coverage.ts` / `src/commands/metrics.ts` — the ratchet's CLI
  consumers; `--update-baseline` retires with the store.
- `.interlinked/coverage-baseline.json` — the colliding two-schema store
  (section 8.6); deleted in Phase 3.

---

## 16. Test plan

### 16.1 Coverage union correctness

- Two shards cover the same line; removing one does not uncover it.
- Replacing the last covering shard uncovers the line.
- Branch identities union and replace correctly.
- Duplicate hit counts do not affect covered/not-covered decisions.
- Deleted source elements disappear from the denominator.
- New executable elements enter the denominator.

### 16.2 Selection authority

- Historical covering shard is selected without a static import edge.
- Reverse-dependency test is selected without historical coverage.
- Edited test is selected even when absent from the accepted index.
- Empty/unknown/truncated graph selection forces full fallback — including
  the "in the graph, no test depends on it" state that blocks today
  (section 8.3).
- Shared setup/config changes invalidate all shards.
- Dynamic integration coverage remains represented by historical shards.

### 16.3 Policy

- Coverage decrease blocks.
- Flat low coverage warns but allows.
- Improving low coverage warns but allows.
- Crossing from healthy to below threshold blocks when the decrease exceeds
  tolerance; within tolerance it warns, never blocks (section 9.1).
- Existing high CRAP unchanged warns but allows.
- Existing high CRAP reduced but still high warns but allows.
- Matched-function CRAP increase blocks.
- New over-threshold CRAP function blocks.
- New under-threshold function allows.
- Function deletion allows.
- Ambiguous function identity does not guess-block.
- A shard red at baseline and red in the overlay warns but allows
  (section 9.4).
- A shard green at baseline that fails in the overlay blocks.
- A regression attributable to a quarantined shard downgrades to a warning
  (section 7.1).
- A pure rename (delete + add, identical content) carries its baseline; the
  new-file bar does not apply (section 9.2).

### 16.4 Atomicity and concurrency

- Multi-file source+test patch is evaluated together.
- Blocked edit never advances the accepted index.
- PostToolUse hash mismatch discards staging.
- Two concurrent stages from one generation cannot corrupt the manifest.
- Crash/torn staging data leaves the accepted generation readable.

### 16.5 Reconciliation

- Incremental aggregate equals full-suite aggregate.
- A discrepancy records telemetry and rebuilds the index.
- A full passing run discharges matching obligations.
- A targeted passing run does not falsely discharge an authoritative obligation.

### 16.6 Performance

- Debt lookup benchmark.
- Contribution replacement benchmark.
- Aggregate union benchmark by files, shards, and elements.
- Cold versus warm runner benchmark.
- Serialization size and parse-time benchmark.
- Daemon event-loop availability while an overlay run is in flight
  (section 10.1).

---

## 17. Rollout safety

The zero-false-positive contract applies to hard PreToolUse blocks.

Before default-on blocking:

1. Run incremental decisions in shadow mode.
2. Immediately compare them with full-suite coverage on representative repos.
3. Record:
   - Incremental/full line and branch deltas.
   - Missed covering shards.
   - Invalidations.
   - Shard instability events and quarantine transitions (section 7.1).
   - Function-match confidence.
   - Wall-clock by phase.
4. Require zero false blocks in the evaluation window.
5. Treat an incremental false allow as a selector/invalidation defect to fix,
   even though commit/CI reconciliation remains the final backstop.

Recommended rollout order:

1. Existing-debt warnings.
2. New-code uncovered-line blocks using fresh selected runs.
3. Coverage delta blocks.
4. CRAP delta blocks.
5. Broader language adapters.

---

## 18. Acceptance criteria

The feature is complete when:

- PreToolUse can produce a fresh proposed line and branch coverage result without
  a full-suite run for ordinary indexed edits.
- Overlapping test coverage is updated exactly through replaceable shard
  contributions.
- A coverage decrease blocks before the write.
- A matched function's CRAP increase blocks before the write.
- Existing threshold debt produces warnings but does not block neutral or
  improving edits.
- New files/functions cannot exploit the absence of a baseline.
- Incomplete evidence falls back or defers instead of guess-blocking.
- Proposed index state is promoted only after PostToolUse verifies the actual
  write.
- An already-failing shard warns without blocking; only newly failing shards
  block.
- The daemon keeps serving unrelated events within normal latency while a
  coverage run is in flight.
- The per-edit drop check and the verify-time ratchet read accepted coverage
  from the index; the colliding `.interlinked/coverage-baseline.json` store
  is retired.
- Stop/commit/CI full runs reconcile and repair the incremental index.
- Shadow telemetry shows no false blocks against authoritative full-suite
  coverage.
- Warm p95 incremental latency is at or below the configured target on the
  rollout repositories.

---

## 19. Non-goals

- Proving test assertion quality. Coverage proves execution, not correctness.
- Replacing mutation testing.
- Inferring authoritative coverage without executing tests.
- Requiring every legacy file to meet modern thresholds before it can be edited.
- Hiding an over-budget check behind a misleading cached percentage.
- Making static dependency analysis the sole authority for test completeness.

---

## 20. Durable design principles

Future agents should preserve these decisions:

1. **Runtime evidence is authoritative; static analysis is a selector.**
2. **Coverage contributions must be replaceable by test shard.**
3. **Regressions block; inherited debt warns.**
4. **CRAP is compared per function, not as a repository average.**
5. **Line and branch coverage remain distinct metrics.**
6. **PreToolUse evaluates a whole atomic patch through an overlay.**
7. **PreToolUse stages state; PostToolUse promotes verified state.**
8. **Incomplete evidence falls back or defers. It never guess-blocks.**
9. **Full-suite coverage remains the reconciliation authority.**
10. **Latency improvements must come from incrementality and warm execution, not
    from weakening correctness.**
11. **Shards are replaceable only at the runner's isolation boundary.**
12. **An unstable shard loses block authority until it proves stable again.**
13. **There is one accepted-coverage store; every baseline consumer reads the
    index.**
