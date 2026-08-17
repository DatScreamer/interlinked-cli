# Universal mutation set — deferred cross-language compatibility layer

**Status:** backburner design; do not build in the current local tranche.
Evidence base: the 2026-08-12 survivor campaign (this doc cites it).

## Decision

Use mature language-specific engines (Stryker, cargo-mutants, Mull,
mutmut, PIT, and peers) as the authoritative execution path now. Revisit an
Interlinked-owned token/text mutation layer when the remote parallel product
exists and portability across engines/languages becomes the actual bottleneck.

The eventual layer may reproduce Stryker's operator semantics without a runtime
Stryker dependency, then extend the taxonomy for other languages. It must not
claim parity from similarly named regex rewrites: parity requires a pinned
operator corpus, site enumeration, replacement semantics, stillborn handling,
and differential verdicts against the native engine.

## Why generation appears ownable later (measured, not asserted)

1. The 2026-08-12 campaign ran hundreds of mutants through
   `scratch/probes/mutant-shadow-runner.ts` — pure string `applyReplacement`
   + esbuild build + targeted vitest — with per-mutant kill/equivalence
   verdicts. No Stryker in that loop. Generation + targeted execution of
   textual mutants is proven in-house tech.
2. The manifest already abstracts the engine (`engine`, `engineVersion`
   fields) and keys mutants by content-derived ids, not Stryker internals.
3. The repo hand-rolls its analysis layer by design (single required dep):
   brace/paren scanning (`checks/shared-text-utils-brace-scan.ts`), language
   profiles for 12+ languages (`language-profiles.ts`), regex-walker fallback
   when the TS compiler is absent. A token-level mutator is the same species.

## Candidate architecture (three layers)

1. **Operator taxonomy** (universal classes, ~12–20): negate-condition,
   boundary-swap, string-blank, block-drop, arithmetic-swap, off-by-one,
   guard-delete, arg-swap, regex-weaken, return-default, chain-shorten,
   literal-perturb. Engine-specific operators map into classes; unmappable
   ones stay namespaced (`stryker:MethodExpression`). MORE extensive than
   Stryker where our data says it matters.
2. **Low-dependency generator**: per-language token rules + the brace scanner
   → site enumeration → textual mutants with stable identity (reuse the
   existing site hashing). Optional precision upgrade per language when a
   compiler API is present (TS today), degrading gracefully — same pattern as
   the cyclomatic gate's AST-vs-regex fallback.
3. **Execution adapters**: the project's own test command (vitest / cargo test
   / pytest / go test) behind the existing runner + scope + receipts
   machinery. Invalid/unparseable mutants are compile-checked out (or recorded
   as `stillborn`, never counted as kills).

## Calibration asset nobody else has

The manifest holds a large Stryker-generated calibration corpus with real
verdicts. Before relying on a custom generator, freeze a qualified corpus,
enumerate the same files, diff site/operator coverage against the pinned
Stryker version, and reproduce verdicts on a representative sample. Ship only
when agreement, disagreements, and coverage deltas are measured and published.

For future per-tool-call mutation, enumerate sites only in changed symbols or
diff ranges, then fan out one mutant per isolated worker within the available
30–90 second hook window. The gate must distinguish `clean`, `survivor`,
`still_running`, `not_measurable`, and infrastructure failure. A partial shard
set is never a clean result. Keep this deferred until native-engine sharding,
selection, receipts, and invalidation are reliable.

## Evidence from the campaign that shapes the operator set

- TCE (compile-and-compare) confirmed 1/330 empirically-equivalent candidates
  (0.3%) — compiler-visible deadness is nearly absent here; equivalence lives
  in semantic guards (`ConditionalExpression` 142/330). The set should bias
  toward operators whose survivors are INFORMATIVE (guard-delete,
  boundary-swap) over noise generators.
- StringLiteral→"" on CLI help text produced 149 survivors in one file
  (unobserved-output class, not dead code). Class-level priors like this
  transfer across languages only through the taxonomy.

## N=1 discipline (unchanged)

Do not finalize the taxonomy until a SECOND language/engine validates it
(cargo-mutants or mull head-to-head on a real repo). Same rule CLAUDE.md
applies to the check registry.

## Open questions before any build

- Per-test coverage mapping (Stryker's perf moat) vs our affected-test
  selection: same problem, one solution — minimal test scope (defects #7/#16).
- Mutation-latency budget ratchet (per-edit-cloud-mutation-testing.md §13b)
  gets cheaper if generation is ours (no tree-copy sandboxes).
- SQLite/C spike depends on exactly this layer (mull-free C mutation).
