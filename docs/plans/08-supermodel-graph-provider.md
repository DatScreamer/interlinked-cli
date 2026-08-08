# Supermodel Graph Provider — deepening the `.graph.*` integration

> **SUPERSEDED 2026-08-07 — Supermodel is being RETIRED.** The phase table below shows
> work as "pending" against a component that has since been decided for removal; do not
> pick that work up. See `docs/plans/13-test-quality-suite-implementation-plan.md` §43
> for the reversal and the `OracleGraph` abstraction that replaces it.

Plan 07 shipped a read-only, one-warning consumer of Supermodel `.graph.*`
shards. This plan deepens it: the harness's own dependency-aware checks
consume the shard when one is present and fresh, and the function-level call
graph the reader already parses gets surfaced and used.

## Status

| Phase | Scope | State |
|---|---|---|
| 3a | `[calls]` PreToolUse context line | **DONE** (commit 12a29ac) |
| 3b | `DependencyView` provider seam | **DONE** (commit 12a29ac) |
| 3c | Stop-event dead-on-arrival check | **DONE** (commit 054d615) |
| 3d | Supermodel `dead-code` analysis consumer | **module DONE**; verify-wiring pending |

## Context — what plan 07 left on the table

`src/harness/supermodel-graph.ts` parses all three shard sections —
`[deps]`, `[calls]`, `[impact]`. But only `[impact]` is consumed: one
PreToolUse warning (`getSupermodelGraphWarnings` in `evaluator/pre-tool.ts`),
plus the prediction reconciler reading `[calls]`/`[impact]` purely to *grade*
agent predictions. The harness's own structural checks and
`impact-analysis.ts` run entirely on the internal regex graph
(`project-graph.ts`) — file-level, no call graph — even when a richer
AST-derived Supermodel shard is sitting on disk next to the file.

Plan 07 §"Out of scope" deliberately deferred this ("keep them
independent"). This plan reverses that decision **for the
dependents / blast-radius / callers query set specifically** — see the seam
design for why that set and not the whole graph.

The integration stays a read-only consumer throughout: no API calls, no
shard generation, no auth surface. The shard file is the API.

## The `DependencyView` seam (3b)

`project-graph.ts` is a whole-repo in-memory graph; Supermodel shards are
per-file sidecars. The APIs do not align 1:1 — `findCyclesThrough` and
`findDuplicateExports` need a whole-repo view a per-file shard cannot
provide. So the seam is **narrow**: it covers only the queries Supermodel
answers better per-file.

```ts
interface DependencyView {
  /** Files that import or call into this file. */
  getDependents(file: string): string[];
  classifyModule(file: string): ModuleRole;
  /** Blast radius — direct + transitive dependent counts + domains. */
  getBlastRadius(file: string): { direct: number; transitive: number; domains: string[] } | null;
  /** Function-level callers — Supermodel only; [] for the internal graph. */
  getCallers(file: string): Array<{ fn: string; caller: string; file: string; line: number }>;
  /** Provenance — which backend answered. Flows into warning wording. */
  readonly source: "supermodel" | "internal";
}
```

Two implementations:

- `InternalDependencyView` — wraps `ProjectGraph`. `getCallers` → `[]` (no
  call graph). `getBlastRadius.transitive` → `direct` for v1 (no internal
  BFS), or a bounded reverse-graph BFS as an optional follow-on.
- `SupermodelDependencyView` — wraps a loaded `SupermodelGraph`.
  `getDependents` → `deps.importedBy ∪ impact.affects`; `classifyModule` →
  derived from `impact` (`HIGH` or `direct ≥ 5` → hub; `direct ≥ 1` →
  internal; `0` → leaf); `getBlastRadius` → `impact`; `getCallers` →
  `calls.callers`.

**Resolver.** `resolveDependencyView(file, cwd, graph)` calls the existing
`classifyCase(file, cwd)` from `graph-prediction-classifier.ts`. `E-fresh`
→ `SupermodelDependencyView`; everything else (`A`/`B`/`C`/`D`/`E-stale`) →
`InternalDependencyView`. This reuses the prediction protocol's freshness
gate verbatim — one definition of "is the shard trustworthy," no second
staleness heuristic to drift.

**Wiring.** `runImpactAnalysis` and the `structural-checks.ts` blast-radius
context block (`getPreToolUseContext`, ~lines 297-312) take a
`DependencyView` instead of a bare `ProjectGraph`. `view.source` flows into
the warning wording ("per Supermodel `.graph` shard" vs "per internal import
graph") so the agent — and the determinism tag — know the provenance.

**What stays on `ProjectGraph`.** Cycles, duplicate symbols, import
resolution, hallucinated/dead imports. The per-file shard cannot answer
them; Supermodel's repo-wide `circular-dependencies` analysis is 3d, not the
sidecar. Keeping these on the internal graph is what makes 3b bounded and
safe — the seam is additive, not a rip-and-replace.

**Fallback guarantee.** Every `DependencyView` consumer must behave
correctly when `source === "internal"`. The harness works identically on
repos with no Supermodel; Supermodel is a precision upgrade, never a
dependency.

## 3a — `[calls]` PreToolUse context (DONE)

`getSupermodelGraphWarnings` (renamed from `getSupermodelGraphWarning`,
`evaluator/pre-tool.ts`) loads the shard once per edited file and emits up
to two lines: the existing `[impact]` blast-radius line, and — when that
line fires — a `[calls]` line summarizing which functions defined in the
file have external callers, ranked by caller count.

- Gated to `≥ 2` caller sites (`SUPERMODEL_CALL_MIN_CALLERS`): a
  single-caller function is under the noise floor.
- Gated *behind* the impact line: when the impact line stays silent
  (LOW / absent), so does the call-graph line. This preserves plan 07's
  "LOW edits are silent" guarantee — no new noise surface on routine edits.
- Informational only — never blocks.

Both the threshold and the impact-coupling are deliberate v1 conservatism.
Decoupling the call-graph line from the impact tier (so a LOW-impact file
with one hot function still surfaces it) is a candidate refinement once
shadow telemetry shows whether the decoupled form is useful or noisy.

## 3c — Stop-event dead-on-arrival

A new formatter in the `verification-stop-checks.ts` family. At Stop, for
each file written this session:

1. Derive the shard path (`shardPathFor`); `stat` source and shard.
2. **Freshness gate** — only proceed if shard mtime ≥ source mtime (the
   daemon regenerated the shard *after* this session's edit). A stale shard
   describes pre-edit structure; skip it rather than guess. This is why
   plan 07 scoped PostToolUse out — but at Stop, enough wall-clock has
   usually passed for the daemon to have run, and the freshness gate makes
   a miss silent rather than wrong.
3. If the fresh shard reports `impact.direct === 0` and `[calls].callers`
   is empty/absent → flag: "file edited this session, nothing imports it or
   calls into it — new entry point, or dead on arrival?"

File-level only. Function-level dead-on-arrival needs the parse graph (the
list of *defined* symbols), which the `[deps]`/`[calls]`/`[impact]` sidecar
does not enumerate — that is 3d territory. Warning, never blocks; zero
false positives by construction (stale shards are skipped, not guessed).

## 3d — Supermodel `dead-code` analysis consumer

`supermodel dead-code` is the CLI's repo-wide unreachable-function
analysis (call-graph reachability + entry-point detection + transitive
propagation, with confidence levels). Verified against the CLI source
(`reference-repos/supermodel-cli/cmd/deadcode.go` and
`internal/api/types.go`): it is a **cloud API call** — it uploads the
repository archive, requires an API key, and the CLI's own default
timeout is 7200s. It exposes a machine-readable `--output json` mode
returning `{ metadata: { totalDeclarations }, deadCodeCandidates: [{
file, name, line, confidence, reason }] }`.

**Decision resolved — invoke-CLI.** The plan-07-style "parse-artifact"
route is not available: `dead-code` writes nothing to disk (unlike the
`.graph.*` sidecars). Because it is cloud-backed, slow, and key-gated,
this is **not a harness check** — it is a `verify`-tier, on-demand,
opt-in integration that runs only when the `supermodel` CLI is installed
and degrades silently otherwise.

**Shipped:** `src/harness/supermodel-analyses.ts` — `parseDeadCodeJson`
(tolerant parser), `isSupermodelCliAvailable`, `runSupermodelDeadCode`
(argv-array `execFileSync`, no shell; graceful `null` on absence / error
/ timeout), `formatDeadCodeFindings` (confidence-ranked, capped, tagged
`[interlinked:supermodel-dead-code]`). 15 tests.

**Connector (pending):** surface it through `interlinked verify` as an
opt-in tool — gate on `isSupermodelCliAvailable()`, run on demand, fold
`formatDeadCodeFindings` output into the report. This touches the
`src/commands/verify/` pipeline (TOOL_IDS, advisory list, formatters)
and is best done as its own focused change. The ranking is Supermodel's,
consumed verbatim — the playbook lesson is "don't re-derive a precise
analysis with a less-precise one."

## Files to add / change

| File | Phase | Status | Purpose |
|---|---|---|---|
| `evaluator/pre-tool.ts` | 3a | edit (done) | `getSupermodelGraphWarnings`, `formatSupermodelImpactLine`, `formatSupermodelCallLine` |
| `__tests__/supermodel-graph.test.ts` | 3a | edit (done) | `[calls]`-line tests; multi-file count updated |
| `harness/dependency-view.ts` | 3b | new | `DependencyView` interface + both implementations + `resolveDependencyView` |
| `harness/__tests__/dependency-view.test.ts` | 3b | new | resolver freshness gate, both views, fallback |
| `impact-analysis.ts` | 3b | edit | accept `DependencyView` |
| `structural-checks.ts` | 3b | edit | blast-radius context via `DependencyView` |
| `verification-stop-checks.ts` (or sibling) | 3c | new fn | dead-on-arrival formatter |
| `server.ts` | 3b/3c | edit | resolve the view; wire the Stop formatter |

## Risks

| Risk | Mitigation |
|---|---|
| Seam over-reaches into whole-repo queries | Interface is deliberately the 4-method dependents/blast-radius/callers set; cycles & duplicate-symbols explicitly stay on `ProjectGraph`. |
| Stale shard drives a check to a wrong result | `resolveDependencyView` gates on `E-fresh`; stale → internal graph. 3c additionally skips non-fresh shards entirely. |
| Check behavior diverges by whether Supermodel is installed | `view.source` is surfaced in wording; both views satisfy the same interface; the internal path is the tested default. |
| `[calls]` line noise on every edit | Gated `≥ 2` callers AND behind the impact line; shadow telemetry before decoupling. |

## Acceptance criteria

- [x] 3a: `[calls]` line fires on HIGH/MEDIUM shards with ≥ 2 caller sites,
      stays silent otherwise; existing plan-07 tests still pass (multi-file
      count updated, not weakened).
- [ ] 3b: `resolveDependencyView` returns the Supermodel view only for
      `E-fresh`; `impact-analysis` + blast-radius context produce identical
      output to today when `source === "internal"`.
- [ ] 3c: dead-on-arrival fires only on fresh shards; no warning on a stale
      or absent shard.
- [ ] All existing tests pass (`npx vitest run`).
- [ ] No new runtime dependencies; no network; no shard generation.

## Open questions

1. **3a impact-coupling** — decouple the `[calls]` line from the impact
   tier after telemetry, or keep coupled? Default: keep coupled until
   shadow data exists.
2. **Internal transitive BFS** — does `InternalDependencyView.getBlastRadius`
   compute a real transitive count, or report `direct` and let Supermodel
   be the only source of `transitive`? Default: `direct` for v1; BFS is a
   cheap follow-on (memoized reverse-graph walk).
3. **3d** — RESOLVED: invoke-CLI. `dead-code` writes no artifact (it is a
   cloud call), so parse-artifact was not an option. The module is
   shipped; the `interlinked verify` connector remains.
