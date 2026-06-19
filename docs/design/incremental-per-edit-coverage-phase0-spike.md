# Phase 0 Spike Results — Per-Shard Coverage Attribution

**Status:** complete, 2026-06-11. **Verdict: GO.** 17/17 assertions passed.

Phase 0 of `incremental-per-edit-coverage-crap-ratchet.md` (section 14).
Probe: `.interlinked/spike-coverage-shards.mjs` — self-contained, builds and
cleans its own tmp fixtures, rerunnable after any vitest upgrade. Environment:
vitest 4.1.8 + `@vitest/coverage-v8` 4.1.8, Node v22.22.0, macOS (darwin).

## What was proven

1. **Per-test-file attribution without per-file processes.** One `vitest run`
   invocation with `coverage.provider: "custom"` pointing at a capture module
   that wraps the official `@vitest/coverage-v8` provider and taps
   `onAfterSuiteRun`. With default isolation, exactly one event fires per test
   file, each carrying `testFiles: [<one file>]` plus the raw V8 payload for
   that file's run. Shard identity = test file path: deterministic, stable
   across runs (the replacement comparison below depended on it across four
   separate invocations).

2. **Replacement math is exact (section 5.2, live).** Shard A's test was
   edited to stop exercising `shared()`; only shard A was rerun;
   `union(newA, retainedB)` equaled a fresh full-run ground truth on BOTH the
   covered set and the denominator. The counter-assertion held too: the
   targeted run alone (naive substitution) does NOT match ground truth —
   retained-shard evidence is what makes the aggregate honest.

3. **`isolate: false` breaks contribution independence, detectably
   (sections 5.3, 7.1).** Per-file events are still emitted under
   `isolate: false, maxWorkers: 1`, but the second test file's batch
   contribution differs from its solo-rerun contribution (module state leaked
   across files: the first file executed the init branch, the second skipped
   it). The divergence — same shard, same hashes, different covered set — is
   precisely the contribution-churn signal the instability quarantine keys on.

4. **pytest per-test attribution works (section 14 item 5).**
   `.coveragerc` `[run] dynamic_context = test_function` +
   `coverage run -m pytest`, read back via `CoverageData.set_query_context()`
   / `.lines()`: shared lines attributed to both test contexts, exclusive
   lines to exactly one. No pytest-cov plugin required.

## Timings (tiny 2-file fixture; this machine)

| Path | Wall |
|---|---:|
| Full run, cold | 482 ms |
| Full run, warm | 397 ms |
| Selected single shard | 399 ms |
| isolate:false batch | 402 ms |
| pytest contexts run | 266 ms |

Runner startup dominates at this scale (~0.4 s floor) — consistent with the
section 10 targets (warm p50 < 1 s for small shards) WITHOUT a persistent
runner on a fixture-sized project. Caveats: a real repo's transform pipeline
raises the floor; the representative-repo measurement lands in Phase 2 after
the async-runner prerequisite, and the persistent-runner lever stays on the
table for p50 at scale. Exit criterion "warm-execution evidence" is met at
fixture scale; re-measure on this repo before enabling blocks (Phase 5 gate).

## Decision: public adapter, not version-pinned internals

**Chosen:** an Interlinked capture provider passed through the public
`coverage.customProviderModule` option, spreading the official
`@vitest/coverage-v8` module (worker-side `startCoverage` / `takeCoverage` /
`stopCoverage` untouched) and wrapping only the provider's
`onAfterSuiteRun(meta)`.

Pinned surfaces, both typed and exported by vitest:

- `CoverageProviderModule` (`vitest/node`) — the custom-provider contract.
- `AfterSuiteRunMeta` (`vitest` exports: `{ coverage, environment,
  projectName, testFiles }`) — the per-suite payload.

Corroboration we deliberately do NOT depend on: vitest 4's own
`BaseCoverageProvider.coverageFiles` (`vitest/dist/coverage.d.ts`) already
stores raw coverage keyed by individual test filename — per-test-file
attribution is load-bearing inside vitest itself, so the granularity is
unlikely to regress silently.

Fallback if the surface drifts in a future vitest major: deterministic
explicit shards (N filtered invocations — rejected today on startup-cost
grounds) or vendoring the provider. Rejection of internals-pinning recorded:
nothing in the chosen path imports from `vitest/dist/*` or private modules.

### Addendum (2026-06-11, post-spike): one runtime-checked private call for line remap

Producing LINE/BRANCH identities (not raw V8 byte offsets) requires
`ast-v8-to-istanbul`, and its inputs — the TRANSFORMED code, its source map,
and a parsed AST per file — exist only inside the vitest process (the
provider obtains them via its live vite transform pipeline:
`transformFile → parseAstAsync → astV8ToIstanbul`, see
`@vitest/coverage-v8/dist/provider.js::remapCoverage`). Reproducing
transforms outside the process is infeasible; one-invocation-per-shard is
rejected on startup cost.

Therefore the capture module converts each stashed raw shard payload
in-process by calling the provider's own `convertCoverage(raw, project,
environment)` — which is `private` on `V8CoverageProvider`'s typed surface.
Amended decision: the pinned surfaces are `CoverageProviderModule` +
`AfterSuiteRunMeta` (typed, public) PLUS exactly one runtime-checked private
method. The generated capture module is plain JS; it probes
`typeof provider.convertCoverage === "function"` and on a miss writes a
loud capture-degraded marker instead of converting — capture disappears,
the gate falls back to the full-run path, nothing blocks on absent evidence.
Per-shard conversion re-remaps files covered by multiple shards; whether the
provider's internal transform cache absorbs that is a Phase 2 measurement
point. Conversion output is per-shard ISTANBUL data, which the harness
canonicalizes with real line/branch identities (statementMap/branchMap/fnMap
— the same shapes `coverage-final-reader.ts` already understands).

## Production notes carried into Phase 1/2

- Shard boundary rule: read the resolved `isolate` / pool configuration; only
  `isolate: true` grants `shardBoundary: "file"`. Weaker isolation degrades to
  `"run"` (manifest field already present in `coverage-index/types.ts`).
- The capture module must be generated with an absolute resolved URL for
  `@vitest/coverage-v8` (fixture/overlay roots have no `node_modules`).
- Raw V8 payloads are large; production capture should reduce to canonical
  element sets at write time (`coverage-index/aggregate.ts` shapes), not
  persist raw payloads. Remapping to line/branch identities reuses the same
  ast-v8-to-istanbul path vitest applies at report time.
- pytest shards: dynamic contexts give per-TEST granularity for free; shard =
  test file (aggregate contexts by file prefix) keeps the two runners on one
  contract.

## Exit criteria → status

| Criterion | Status |
|---|---|
| Exact overlap replacement demonstrated | ✅ |
| Stable shard identity across runs | ✅ (test file path) |
| Isolation violations detected as instability, not absorbed | ✅ |
| No one-process-per-test-file requirement | ✅ |
| Warm-execution evidence for section 10 targets | ✅ at fixture scale; re-measure in Phase 2 |
| Written adapter-vs-internals decision | ✅ (this document) |
