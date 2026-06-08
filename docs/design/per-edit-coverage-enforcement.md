# Per-edit coverage + cyclomatic enforcement (cross-language)

**Status:** design, 2026-06-07. Settled with the user. Targets wardotapp (Python
greenfield) and any repo; built in the interlinked harness so consumers inherit
it on a rebuild + `interlinked harness restart`.

## Why
The per-edit test-quality gates are TypeScript-first: cyclomatic is a PreToolUse
block but `cyclomatic-ast.ts` only parses `.ts/.tsx/.js/.jsx`; coverage runs only
in `interlinked verify` / at Stop. On a greenfield repo whose suite runs in
~1–2s there is no reason not to enforce both per edit. The per-edit **sync budget
is ~25s** (PreToolUse can block in-band, even cloud-fanned — see
`feedback_pretooluse_cloud_synchronous_block`), so a fast suite+coverage fits
comfortably. "Coverage isn't per-edit" was the *big-suite default*, not a law.

## Policy ("maximal enforcement", stated precisely)
Per-edit runs everything that fits the ~25s budget:
- **Cyclomatic: always per-edit, every language** (cheap single-file parse).
- **Coverage: per-edit BLOCK via an apply-before-disk overlay while the suite
  fits the budget; DEFER the block to commit-time once it exceeds it**
  (budget-gated). Honest **full-suite** coverage only — scoped under-counts (a
  file covered by integration tests looks uncovered) and would FALSE-BLOCK.
- **Mutation: commit-time obligation** (unchanged — the one that can't fit per-edit).
- **Strictness = BLOCK (strict TDD):** an edit that adds an uncovered executable
  line (or drops a file's coverage) is refused *before the real write*. Agents
  satisfy it by writing test+code together in one **MultiEdit** (the overlay sees
  both → covered → allowed); a bare "add code now, test next edit" is blocked.

## Components
**1. Cyclomatic — Python adapter (bounded, immediate)**
- New `src/harness/checks/cyclomatic-python.ts`: per-function cyclomatic for `.py`.
  Impl: shell to `radon cc --json <file>` when available; else a conservative
  py-AST/regex walker that degrades loudly (mirror `astComplexityAvailable()`).
- `evaluator/complexity-write-guard.ts` dispatches by extension:
  `.ts/.tsx/.js/.jsx` → `computeCyclomaticAst`; `.py` → `cyclomatic-python`;
  extensible. Same block contract (`DEFAULT_MAX_CYCLOMATIC = 25`).

**2. Coverage — per-edit block (apply-before-disk overlay)**
- `CoverageRunner` interface: `run(projectRoot, editedRelPath, overlayContent)
  → { suiteMs, fileCoverage: PerFileCoverage, ok }`.
- Impls: **JS** (`vitest run --coverage`), **Python** (`pytest` + `coverage.py`
  → `coverage.json`). Reuse the canonical LCOV spine + JS/Python adapters
  already in `coverage-adapters.ts`.
- **Overlay:** reuse the tsc/biome apply-to-temp pattern — write the proposed
  content to an overlay **rooted under projectRoot** (the biome overlay filters
  findings by `relative(projectRoot, file)`, so an `os.tmpdir()` overlay drops
  to a `../`-path and yields zero findings — same gotcha the parallel-safety fix
  hit). Run suite+coverage against the overlay.
- **Block decision** (`evaluator/coverage-write-guard.ts`, PreToolUse): if the
  edited file gains uncovered executable lines, or per-file coverage drops below
  the prior baseline → BLOCK with an actionable reason ("line N you added is
  uncovered — add its test in this edit, e.g. via MultiEdit").
- **Budget-gate:** measure `suiteMs`; keep a rolling estimate in `.interlinked/`;
  if estimate < `budget_ms` (default 25_000, configurable) → block per-edit; else
  record a coverage **obligation** (open-obligation-ledger) enforced at commit.

**3. Config** (guard config): `per_edit_coverage: { enabled, mode: "block"|"warn",
budget_ms, languages: [...] }`. Cyclomatic per-edit on by default (cheap);
coverage per-edit opt-in (wardotapp: on, block, budget 25s). Honors a measured
"no runner / no tests" → skip-loudly, never silently pass.

## Commit-time defer path
When the budget is exceeded the coverage block becomes a **commit-time gate**
(pre-commit / proof-of-enforcement obligation) with the same honest full-suite
coverage — the invariant holds, only the cadence relaxes at scale.

## Honest denominator
Full-suite coverage only for the BLOCK; scoped is rejected (false-blocks). This
is why the block is correct: it never refuses an edit over a line that the full
suite actually covers.

## Build order
1. Python cyclomatic adapter + dispatch (immediate value on wardotapp). ✅ done
2. `CoverageRunner` abstraction + JS impl (dogfood on this TS repo). ✅ done
3. Apply-before-disk coverage overlay + block decision + budget-gate. ✅ **done**
   — `src/harness/coverage-overlay.ts` (mirror-under-projectRoot overlay;
   realpath-resolves the overlay root so the coverage engine's symlink-resolved
   paths key correctly — the macOS `/var`→`/private/var` gotcha would otherwise
   drop every finding as out-of-tree), `src/harness/evaluator/coverage-write-guard.ts`
   (`checkCoverageWrite`: gate → budget-gate → overlay+suite → block on an
   uncovered added line or a per-file coverage drop vs the rolling baseline;
   fail-open / loud-degrade on any runner/overlay error), and
   `src/harness/coverage-obligation-ledger.ts` (rolling suite-runtime estimate +
   per-file coverage baseline + `coverage-obligations.jsonl`). Wired into
   `server/pre-tool-pipeline.ts` after the cheap checks, behind the config flag.
   **Config-gated, DEFAULT OFF** (`per_edit_coverage` in `types/config.ts` +
   `rules/default-config.ts`); a repo that does not opt in pays zero cost. The
   block reason is strict-TDD ("line N uncovered — add its test in this edit via
   MultiEdit"). Over-budget → record a deferred obligation + allow (commit-time
   enforcement is step 5b).
4. Python `coverage.py` runner impl.
5. Commit-time defer: (a) the obligation-RECORD half landed with step 3 (the
   budget-gate appends to `coverage-obligations.jsonl`); (b) the commit-time
   ENFORCEMENT that consumes those obligations is still pending.
6. Config + docs + tests (≥3 positive / ≥3 negative per component) — landed with
   step 3 for the coverage lane.

This is the "apply-before-disk dual-lane PreToolUse" from
`docs/design/test-category-adoption-from-the-wild.md` made concrete for the
coverage lane.
