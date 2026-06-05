# Test-Quality Suite — Implementation Plan & Session Handoff

**Status:** Living plan. Consolidates the 2026-06-05 design session into ONE sequenced
implementation path: **coverage → CRAP → ratchet → red-green → property/fuzz → mutation →
cloud fan-out**. Per-topic design detail lives in the docs cited inline; this is the spine,
the current state, and the load-bearing decisions. Read this first when resuming.

**The arc, one line:** local-first, *language-agnostic* test-quality enforcement that drives
toward ~100% **verified** coverage (coverage + mutation), gated per-edit where cheap and at
Stop/commit where it's a bundle, with a cloud fan-out tier for the heavy parts — three trust
axes, two shared substrate unlocks.

---

## 0. Load-bearing decisions (read before touching anything)

1. **Coverage is language-agnostic; build-vs-buy is split.** WRAP native engines
   (v8/istanbul, coverage.py, cargo-llvm-cov, JaCoCo, gcov); BUILD the thin layer (LCOV
   normalizer, per-language adapters, per-test map, ratchet/CRAP). **Normalize on LCOV** —
   one parser, not N. Never build an instrumentation engine. → `harness-system-diagrams.md`
   §4b, `cross-language-check-coverage.md`, memory `coverage-100-is-the-north-star`.
2. **~100% coverage is the standing north star, made meaningful by mutation** (coverage
   measures *executed*, mutation measures *verified*). The denominator must be honest
   (exclude data/glue/codegen) before chasing tests.
3. **Three trust axes (tripod), routed by concern × deferrability:** comprehension
   (graph-prediction, local, per-edit advisory) · security (safeguard/trajectory, cloud,
   per-edit **blocking**) · correctness (tests/coverage/CRAP/mutation). → `harness-system-diagrams.md` §4b.
4. **Mutation is a per-plan OBLIGATION, not a per-edit block** — it tests the *(source,test)
   pair* (four-way fix: test / source / both / annotate-equivalent), survivors are normal
   mid-dev, and a Pre-block fires no Post. Per-edit = report+track; **hard-gate at commit**
   (synchronous in-band cloud, ~25s, ∃-survivor early-exit). Stryker `--incremental` +
   bundle-debounce. → `open-obligation-ledger.md` §"Mutation", `harness-system-diagrams.md` §4a.
5. **Security cloud checks ARE per-edit + blocking** — local is not a trust boundary against
   the local agent (`proof-of-enforcement.md` §4). Do NOT defer them to Stop. Only
   quality-bundle work (mutation, multi-file coherence) defers to Stop.
6. **PostToolUse does NOT fire on a Pre-block** (verified: Claude/Codex/Copilot) → the block
   *reason* carries the payload; the "post window" is the allow-path only.
7. **Per-edit diff-scoped, Stop whole-file.** Diff-awareness is execution-*scoping* (cost),
   NOT finding-suppression; the Stop whole-file sweep is the soundness backstop. `scope = f(phase)`.
8. **Two shared substrate unlocks** — build these and all three axes get teeth:
   the **validation join** (`predictive-gate-validation-join.md`, predictive→gating) and the
   **state-substrate decision** (`state-substrate-decision.md`, durable joinable logs).
9. **Supermodel is being retired** → re-anchor the graph oracle behind an `OracleGraph`
   interface fed by a TS-toolchain / our-own producer. → memory
   `supermodel-deprecation-graph-oracle-reanchor`, `harness-system-diagrams.md` §3.

Legend: ✅ done · 🟡 partial · ⬜ designed-not-built · ☁️ cloud-future.

---

## 1. Phase C — Coverage (language-agnostic)

- **C0 · Canonical LCOV spine — ✅ DONE this session.** `coverage-canonical.ts` (engine-agnostic
  schema) + `coverage-lcov.ts` (pure parser + `canonicalToCoverageSummary` bridge) + JS wired
  through LCOV (`vitest.config.ts` lcov reporter; `coverage.ts` prefers `lcov.info` via the
  canonical path, json-summary fallback). Validated on real data: lines/branches **exact** vs
  istanbul (max 0.01%); functions ≤2.84% on 2 files (inherent LCOV name-keying, doesn't reach
  ratchet/CRAP). Baseline re-cut through LCOV (621 files). Tests 50/50, typecheck/biome clean.
- **C1 · Denominator fix — ⬜ NEXT (highest leverage, zero tests).** Add coverage `exclude`
  globs: data `.json` (`checks/data/**`, `**/sidecars/**`), CLI glue (`commands/*.ts`),
  codegen-data (`@codegen-data` / `hook-template-chunks` / `*.graph.ts`), pure `types.ts`,
  re-export barrels, `src/index.ts` → re-cut baseline. The 72.93% is mostly non-logic in scope.
- **C2 · Engine precision — ⬜ optional.** Evaluate `@vitest/coverage-istanbul` for the
  authoritative run if branch precision is the blocker (v8 branches are approximate; also fixes
  the v8 `PARSE_ERROR` on a data file).
- **C3 · Coverage ratchet → `verify` gate — ⬜.** It's a standalone command today. Wire as a
  *project-level* verify section (advisory first, fail-open if no report): bucket+key in
  `verify/tool-results-types.ts`, a project-level runner, section in `section-table-core.ts`,
  `output-json.ts`, `advisory.ts`, + parity/advisory regression tests. → roadmap #3.
- **C4 · Per-language adapters — 🟡 Python landed this session.** `coverage-adapters.ts`
  (pure: `CoverageAdapter` = detect markers + the LCOV-emitting command + report path; registry;
  `detectCoverageAdapter(s)` / `coverageAdapterById` / `coverageSetupGuidance`). **Python**
  adapter wraps coverage.py (`coverage run -m pytest && coverage lcov -o coverage/lcov.info`)
  with the native per-test map via pytest-cov `--cov-context=test` (the P2 keystone, forward-wired);
  **JS/TS** adapter formalizes the existing vitest/v8 path. Wired into `coverage.ts`: the canonical
  path is single-sourced (`CANONICAL_LCOV_PATH`) and the no-report message now prints
  *language-detected* setup commands (Python-aware in a Python project). **The C4 proof is shipped:**
  a coverage.py-shaped LCOV (`.py` `SF` paths, FN/FNDA/BRDA/DA) flows through the *same*
  `parseLcov → canonical → compareCoverage` spine as the `.ts` path and fires a per-file regression —
  two languages, one parser. 20 new adapter tests + 1 command test; typecheck/biome/tests green.
  The adapter is a *reader/guidance* layer — it describes the command, doesn't yet *run* it
  (generate-on-demand is the follow-up). **Next: Rust** (`cargo llvm-cov --lcov`), then Go/Java.
  *(Note: `cross-language-check-coverage.md` covers inline regex *check* detectors — a different
  concept from coverage *analysis* adapters; this work has no doc dependency on it.)*

## 2. Phase R — CRAP → gate

- **R1 · CRAP audit — ⬜ (unblocked now: coverage data exists).** Run `verify --all-checks` for
  the real CRAP hotspot list; fix/justify hotspots (dogfood). CRAP is canonical already
  (`crap.ts:131`), currently advisory (`DEFAULT_ADVISORY_SKIPS`). → roadmap #2.
- **R2 · CRAP → default gate — ⬜.** Promote out of `DEFAULT_ADVISORY_SKIPS` once the harness
  passes it; update the advisory regression test + `AGGREGATED_IN_JSON`. → roadmap #2.

## 3. Phase T — Red-green TDD

- **T1 · Observed-red gate — ⬜ (buildable now, no coverage dep).** New public symbol's
  companion test observed red→green before "done"; refactor/backfill exempt via
  `behavioral-diff-checks.ts`. Ship as Stop-nudge → promote to block after FP-rate known.
  Cycle tracking already exists (`behavioral-checks-tdd.ts`). → roadmap #5.

## 4. Phase P — Property / fuzz / the per-test map

- **P1 · Property tests on pure primitives — ⬜.** fast-check on trigram round-trip, detector
  never-throws, CRAP monotonicity; fixed-seed + bounded-N; kept **out of** mutation's covering
  set. → roadmap #6.
- **P2 · Per-test → line map — ⬜ KEYSTONE.** "Which tests cover which line." coverage.py
  contexts (Python, native) / V8 test-lifecycle (JS) / file-level dependency-graph fallback
  elsewhere. Unblocks scoped selection + mutation scoping + diff-coverage. It's a *cost*
  optimization with a whole-suite backstop, so unevenness across languages is acceptable. →
  `harness-system-diagrams.md` §3 (❌ today), `test-quality-harness-local-first.md` §13.
- **P3 · Generative/multi-suite fuzz campaigns — ⬜/☁️.** Periodic/cloud, not per-edit.
  `scaffold-fuzz.ts` generates scaffolds today. → roadmap (Tier 5).

## 5. Phase M — Mutation (the obligation)

- **M0 · Install Stryker + wire `mutation-gate.ts` — ⬜.** It's a dormant report-reader today;
  Stryker not installed. `coverageAnalysis:"perTest"` (perTest IS the mutation coverage map) +
  `--incremental`. → roadmap #9, `docs/plans/10-mutation-testing.md`.
- **M1 · Per-edit obligation — ⬜.** PostToolUse reports survivors (present-not-prescribe,
  four-way) + records/refreshes the (source+tests) cluster obligation; debounced to the bundle;
  bridged Pre→Post. → `open-obligation-ledger.md` §"Mutation".
- **M2 · Commit gate — ⬜.** `git commit` PreToolUse runs touched clusters' mutation
  synchronously in-band (~25s, fanned out, ∃-survivor early-exit) → block if any obligation
  open; full survivor list in the block reason. → `harness-system-diagrams.md` §4a.
- **M3 · Cloud fan-out — ☁️.** Mode A (local box) / B (one Sandbox) / C (fan-out: one
  Sandbox per mutant, constant wall-clock). Sandbox SDK + Artifacts overlay + Workflow
  orchestration. **Measure `sandbox_warmup` first** (the one unvalidated term). →
  `harness-system-diagrams.md` §4a, `10-mutation-testing.md` Phase 2,
  `pre-post-pipelined-cloud-checks-and-failure-recovery.md`.

## 6. Phase X — Cloud + cross-cutting (parallel track)

- **Security per-edit cloud gate** (Tier 2 safeguard, can block) + **proof-of-enforcement**
  R0 (keyless receipt) → R1 (cloud-refereed attestation). → `proof-of-enforcement.md`,
  `tier-2-llm-policy-gate.md`.
- **Comprehension axis:** graph-prediction (shadow today) → promote via the validation join;
  re-anchor the oracle post-Supermodel. → `graph-prediction-protocol.md`,
  `predictive-gate-validation-join.md`.
- **The two shared unlocks** (build once, several phases depend on them): validation join +
  state-substrate decision.

---

## 7. Doc index — where the detail lives

| Topic | Doc |
|---|---|
| **The sequenced local roadmap (#2–#9)** | `docs/design/maximal-local-enforcement-roadmap.md` |
| Local-first kernel (Phases 0–3.7, lanes, §13 selection) | `docs/design/test-quality-harness-local-first.md` |
| Configurability / latency framing | `docs/test-quality-harness-plan.md` |
| System map + mutation modes (§4a) + trust tripod (§4b) | `docs/design/harness-system-diagrams.md` |
| Mutation-as-obligation | `docs/design/open-obligation-ledger.md` |
| Mutation specifics (Phase 2, cost model) | `docs/plans/10-mutation-testing.md` |
| Cross-language coverage | `docs/design/cross-language-check-coverage.md` |
| Cloud pre/post pipelining | `docs/design/pre-post-pipelined-cloud-checks-and-failure-recovery.md` |
| Security / attestation | `docs/design/proof-of-enforcement.md` |
| Comprehension gate | `docs/design/graph-prediction-protocol.md` |
| Shared unlock — predictive→gating | `docs/design/predictive-gate-validation-join.md` |
| Shared unlock — durable joinable state | `docs/design/state-substrate-decision.md` |

## 8. Current working-tree state (uncommitted, 2026-06-05)

- **Coverage spine (Phase C0): done + green.** `coverage-canonical.ts`, `coverage-lcov.ts`,
  `__tests__/coverage-lcov.test.ts` (new); `coverage.ts`, `vitest.config.ts` (modified);
  `.interlinked/coverage-baseline.json` re-cut (621 files).
- **Per-language adapters (Phase C4): Python landed + green.** `coverage-adapters.ts`,
  `__tests__/coverage-adapters.test.ts` (new); `coverage.ts` (adapter-aware no-report guidance +
  `CANONICAL_LCOV_PATH`), `coverage.test.ts` (guidance assertion) (modified). 21 new tests; the
  Python-LCOV-through-one-parser proof is the headline case.
- **Design edits:** `harness-system-diagrams.md` (§3/§4a/§4b), `open-obligation-ledger.md` (#8 + Mutation §).
- **Nothing committed.** Two self-contained green commit boundaries: the C0 coverage spine, and
  the C4 Python adapter (each ships with its plan-doc update — bundle docs with code).
- **Immediate next step:** Phase **C1** (denominator fix → re-cut), or extend C4 to **Rust**
  (`cargo llvm-cov --lcov`) for a third language through the one parser. Both pick up from here.
