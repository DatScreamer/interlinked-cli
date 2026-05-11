# Test-File-Only Deterministic Quality Checks

**Status:** Design / not yet implementation. Sibling to A (escalation rules), B (refactor verbs), C (ratchet/quota), D (BoN executor) — this is **E**, the test-file-quality leg of the harness extensions. Companion to F (impl-aware async review), which covers the techniques that fundamentally need impl + runtime.

**Origin.** The harness treats test files like impl files for tsc, biome, structural checks, etc. That catches *some* test issues (unused imports, type errors) but misses the test-specific pathology surface: tautological assertions, vague matchers, snapshot abuse, mock churn, .only left in, async correctness gaps, complexity that's appropriate in impl but a smell in tests. Tests are code with their own failure modes; treating them as undifferentiated code leaves a real signal axis untapped.

**Audience.** Engineers extending `src/harness/checks/`.

**Constraint.** Test-file AST only. No impl read, no runtime, no cross-file analysis beyond the single test file. Every check is deterministic, parallelizable per file, and cacheable per file-content hash.

---

## TL;DR

**16 new checks** organized across three latency tiers:

| Tier | Where it runs | Aggregate budget | Check count |
|---|---|---|---|
| 1 | PostToolUse hot path | ≤100ms total per file | 12 |
| 2 | `interlinked verify` (default) | ≤2s per file | 3 |
| 3 | `interlinked test-mutate` (separate command, per-commit async) | minutes per file | 1 (assertion mutation) |

All AST-walk-cheap except assertion mutation, which is the single heavyweight check and runs out-of-band. New family file `src/harness/checks/test-files.ts`; integrates with the existing `check-registry/` system. Default-gate vs advisory split follows the existing convention from `src/commands/verify/advisory.ts` — zero-FP checks land default, heuristic checks land advisory.

---

## 1. Why test files deserve their own check family

A test file's AST has a different shape from an impl file's AST. The salient nodes are `describe` / `it` / `test` calls, `expect(...)` chains with matcher selection, mock setup (`vi.mock`, `jest.mock`), and lifecycle hooks (`beforeEach`, `afterAll`). Every test-file-only check below operates on these specific shapes, not on generic JS/TS structure.

Three reasons that matters:

1. **Existing checks miss the surface.** tsc catches type errors but not "this `expect` call's matcher is `toBeTruthy()` when `toBe(5)` is knowable." Biome catches unused imports but not "this `it()` block has zero assertions." The test-shape pathology is invisible to general-purpose checks.
2. **Thresholds differ.** Cyclomatic complexity ≥ 5 is fine in impl, suspicious in a test (tests should be linear narratives). A check that's universal-on-files needs a calibration knob the existing checks don't expose.
3. **The output is actionable in a different register.** Test-file findings flow into "tighten this test" work; impl findings flow into "fix this code" work. Different reviewer headspace; useful to surface separately.

The cheap-by-construction property: every check fits the per-file PostToolUse budget by orders of magnitude. There's no architectural reason not to ship the full surface; the only rate-limit is FP discipline (§6).

---

## 2. The check inventory

| # | Check id | What it catches | Tier | Default severity | Default gate |
|---|---|---|---|---|---|
| 1 | `test_tautological_assertion` | `expect(true).toBe(true)`, `expect(x).toBeDefined()` after `const x = 5` | 1 | warning | default |
| 2 | `test_vague_matcher` | `toBeTruthy`, `toBeDefined`, `toEqual(expect.anything())` where a specific value is knowable | 1 | warning | advisory |
| 3 | `test_empty_body` | `it("does X", () => {})` | 1 | warning | default |
| 4 | `test_vague_name` | `it("works")`, `it("test1")`, `it("returns correctly")` | 1 | warning | advisory |
| 5 | `test_imported_unused` | `import {X}` in test file but X never called/asserted on | 1 | warning | default* |
| 6 | `test_zero_assertions` | `it()` block whose body executes but has zero `expect(...)` | 1 | warning | default |
| 7 | `test_redundant_block` | Two `it()` blocks with normalized-identical bodies | 1 | warning | advisory |
| 8 | `test_snapshot_overuse` | Per-file ratio of snapshot-only tests above threshold | 1 | warning | advisory |
| 9 | `test_mock_churn` | Same module re-mocked across many `it()` blocks instead of `beforeEach` | 1 | warning | advisory |
| 10 | `test_async_correctness` | Missing `await`, missing `expect.assertions(N)` for rejection tests, body returns promise but isn't awaited | 1 | error | default |
| 11 | `test_skip_or_only_committed` | `.skip`, `.only`, `xit`, `xdescribe`, `fit`, `fdescribe` left in committed test | 1 | error | default |
| 12 | `test_console_pollution` | `console.log` / `warn` / `error` / `debug` in test body | 1 | warning | default |
| 13 | `test_block_complexity` | Cyclomatic complexity of single `it()` block above threshold (default 5) | 2 | warning | advisory |
| 14 | `test_file_crap_score` | Test-file CRAP analog: `complexity² × (1 − assertion_strength)³ + complexity` per file | 2 | metric | ratchet (Doc C) |
| 15 | `test_setup_leakage` | Module-level state from one test visible in next (requires running tests) | 2 | warning | advisory |
| 16 | `test_assertion_mutation` | Mutate each assertion, rerun test; surviving mutants → finding | 3 | error | separate command |

\* `test_imported_unused` may be partially covered by existing tsc/biome unused-import; verify before shipping. If covered, drop or scope to "imported but used only in mock setup, never asserted on" (a stricter-than-lint variant).

---

## 3. Latency analysis and execution context

Per-check timing breakdown. All measurements assume a typical test file (200–500 lines, 5–30 `it()` blocks). Numbers are estimates from the equivalent AST-walk operations already in `src/harness/checks/`.

### 3.1 Tier 1 — PostToolUse hot path

Each check is one AST walk over the file. The AST is parsed once per PostToolUse event (existing infrastructure in `src/harness/checks/shared.ts`) and shared across all checks via the same context object.

| # | Check | Per-file latency | Scaling |
|---|---|---|---|
| 1 | `test_tautological_assertion` | <1ms | O(assertions) |
| 2 | `test_vague_matcher` | <1ms | O(assertions) |
| 3 | `test_empty_body` | <1ms | O(`it` blocks) |
| 4 | `test_vague_name` | <1ms | O(`it` blocks); regex against blocklist |
| 5 | `test_imported_unused` | 1–5ms | O(imports × body); same shape as biome's unused-import |
| 6 | `test_zero_assertions` | 1–3ms | O(`it` blocks × body) |
| 7 | `test_redundant_block` | 5–20ms | O(`it` blocks²) with body hashing; cap at 50 blocks/file |
| 8 | `test_snapshot_overuse` | <1ms | O(assertions) |
| 9 | `test_mock_churn` | 1–3ms | O(mock calls × `it` blocks) |
| 10 | `test_async_correctness` | 1–5ms | O(async expressions) |
| 11 | `test_skip_or_only_committed` | <1ms | Pattern match on call expressions |
| 12 | `test_console_pollution` | <1ms | Pattern match on calls |
| **Aggregate** | | **~15–50ms per file** | |

The 50ms ceiling sits well inside the existing PostToolUse budget (30s shared across all checks per `agent-memory-architecture.md` §8). Adding the full Tier-1 set adds <0.2% to the budget. No risk of crowding out existing checks.

**Caching:** AST cached per file-content hash via `src/harness/check-engine/`. Re-running checks on an unchanged file is a hash lookup (~10μs). Edit invalidates only that file's entry. The aggregate budget stat above is for first-time-edit cost; warm-cache is microseconds.

**Parallelism:** Checks within a file are sequential (share the AST walk). Files within an edit can be parallelized. Most edits touch 1–3 files; parallelism is rarely the bottleneck.

### 3.2 Tier 2 — `interlinked verify` (default)

Tier 2 checks have either heavier per-file cost or need cross-test analysis that doesn't fit the hot path.

| # | Check | Per-file latency | Why not Tier 1 |
|---|---|---|---|
| 13 | `test_block_complexity` | 1–5ms | Could be Tier 1, but the threshold is judgment-heavy; let `verify` surface it where the user is reviewing aggregates rather than reacting per-edit |
| 14 | `test_file_crap_score` | 1–5ms | Composite metric; needs aggregation across the file; ratchet-style use (Doc C) makes more sense than per-edit warning |
| 15 | `test_setup_leakage` | 100ms–2s per test file | Requires running tests with instrumentation; not AST-only |

**Aggregate `verify` cost** for a typical CLI-sized repo (~150 test files): 13 + 14 are fast (~1s total); 15 dominates (~30s if instrumented test runs are sequential, ~5s parallelized).

**Why 15 lives in `verify`, not the hot path:** instrumented test runs need a process spawn and module-level state tracking. The existing `verify` already runs the test suite; piggybacking instrumentation on those runs is the cheap path. PostToolUse never runs the test suite (it shouldn't — wrong scope, wrong budget) and shouldn't start.

### 3.3 Tier 3 — `interlinked test-mutate` (separate command)

Assertion mutation is the single check expensive enough to justify its own command. It's not async-by-budget (it's not running asynchronously to other things), it's just *long*, so it's invoked deliberately rather than implicitly.

| Operation | Per-assertion cost | Scaling |
|---|---|---|
| Generate mutations for one assertion | <1ms | Fixed mutation set per matcher kind |
| Run the single test against one mutant | ~test runtime (10ms–10s depending on test) | One spawn per mutant; can be amortized via in-process `vi.run` |
| Aggregate per file | (assertions × mutations) × test runtime | For a 30-assertion file with 3 mutations each at 100ms: ~9s |

**Practical numbers** for this repo's test corpus:
- Smallest test files (~5 assertions, fast tests): ~1–2s to mutate
- Median test files (~15 assertions): ~10–30s
- Largest test files (~50 assertions, integration tests): 2–5 minutes

**When it runs:** three modes.

1. **On demand:** `interlinked test-mutate src/harness/__tests__/foo.test.ts` — developer-invoked, blocking.
2. **As part of per-commit background review** (Doc F): runs over test files changed in the commit; results surface via `interlinked review status`.
3. **As a nightly job:** full repo scan, results aggregated into recurrence log; weak tests surface via `interlinked recurrence list --kind test_assertion_mutation_survived`.

**Why not in `verify` default:** `verify` runs sub-minute on this repo. Adding mutation testing pushes it past the inner-loop tolerance threshold (~1 min) into the "I'll go get coffee" range. Better surfaced as a deliberate operation than baked into a routinely-invoked tool.

**FP rate:** very low. The signal "test passed despite this assertion being mutated" is direct evidence the assertion isn't load-bearing. The narrow ambiguity is around vague matchers (a `toBeTruthy()` that survives mutation to `toBeDefined()` is "expected" but also signals the original matcher is over-loose — already caught by check #2 anyway).

### 3.4 Latency summary

| Execution context | What runs | When | Budget |
|---|---|---|---|
| PostToolUse (per edit) | Tier 1 (12 checks) | Every test-file edit | ~50ms total per file |
| `interlinked verify` default | Tier 1 + Tier 2 (13+14) | On-demand or pre-push | ~1–2s for 13+14 across a typical repo |
| `interlinked verify --all-checks` | All Tier 1 + 2 advisory + 15 | Periodic deep audit | ~30s extra for 15 |
| `interlinked test-mutate` | 16 (assertion mutation) | Developer-invoked or per-commit background | Per-file 1s–5min |
| Background per-commit review (Doc F) | 16 over changed tests | After local commit, before push | Bounded by file count × per-file cost |

---

## 4. Architecture

### 4.1 New files

| File | Purpose |
|---|---|
| `src/harness/checks/test-files.ts` | All 12 Tier-1 checks; one exported function per check; shared AST helpers |
| `src/harness/checks/test-block-complexity.ts` | Tier-2 #13 (separated for size + threshold config) |
| `src/harness/checks/test-file-crap-score.ts` | Tier-2 #14 (composes #13 + assertion-strength helper) |
| `src/harness/checks/test-setup-leakage.ts` | Tier-2 #15 (requires test-runner instrumentation) |
| `src/commands/test-mutate.ts` | Tier-3 command for assertion mutation |
| `src/harness/test-mutation/mutators.ts` | Mutation generators per matcher kind |
| `src/harness/test-mutation/runner.ts` | Test-runner shim for executing single tests with one mutant applied |

### 4.2 Test-file detection

A file is a test file iff one of:
- Path matches `**/*.test.{ts,tsx,js,jsx,mjs,cjs}`
- Path matches `**/*.spec.{ts,tsx,js,jsx,mjs,cjs}`
- Path is under `**/__tests__/**`

Detection is centralized in `src/harness/checks/test-files.ts::isTestFile(path)` so all consumers (Tier 1 checks, Tier 2 checks, the test-mutate command, future docs) share one definition. Misclassification (an impl file matching by accident) is the primary FP source for the whole pipeline; the convention above mirrors what tsc/biome/vitest already use.

### 4.3 Test-framework detection

Most checks are framework-agnostic (they look at `it`/`test`/`describe` calls and `expect(...)` chains, which vitest/jest/mocha-with-chai all share). Framework-specific checks (e.g., `vi.mock` vs `jest.mock` for #9 mock churn) detect framework via:

1. File-level `import` statement (presence of `vitest`, `@jest/globals`, `mocha`)
2. Repo-level `package.json` test runner
3. Default to vitest if ambiguous (this repo's choice)

Framework-specific checks gracefully no-op on unrecognized frameworks rather than mis-fire.

### 4.4 Registration

Each check gets:
1. Detector function in `src/harness/checks/test-files.ts` (or the dedicated Tier-2 file)
2. Registry entry in `src/harness/check-registry/entries-warnings.ts` (or `entries-errors.ts` for #10 and #11 default-gate errors)
3. Metadata entry in `src/harness/check-metadata.ts`
4. Verify wiring in `src/commands/verify/file-checks.ts`
5. Advisory list update in `src/commands/verify/advisory.ts` for the heuristic checks (#2, #4, #7, #8, #9, #13, #14, #15)

This mirrors the agent-quality check rollout pattern documented in CLAUDE.md.

---

## 5. False-positive defenses

Per the convention from Doc A and the existing rollout pattern:

### 5.1 Per-check pos/neg corpus

Every check ships with ≥3 positive cases (must fire) and ≥3 negative cases (must NOT fire). The negative corpus is the FP discipline — it documents the legitimate patterns that look superficially like the bug.

Example for #2 `test_vague_matcher`:
- Positive: `expect(getUser()).toBeTruthy()` where return type is `User | null` and a specific assertion is knowable
- Negative: `expect(error).toBeDefined()` for an existence-only check; `expect(events).toEqual(expect.arrayContaining([target]))` for partial-match intent

### 5.2 Shadow mode for new checks

New checks land disabled (`shadow: true`); findings append to `.interlinked/checks-shadow.jsonl`. After ≥30 firings across ≥10 sessions, a maintainer reviews and either flips on or refines. Same machinery as escalation rules (Doc A §6.3).

### 5.3 Suppression directives respected

All checks honor existing inline suppression directives (`// @harness-disable-next-line test_vague_matcher`). Test-file-only checks add no new suppression syntax; the existing one is sufficient.

### 5.4 Severity tied to FP risk

| FP risk | Default severity | Default gate |
|---|---|---|
| Zero (syntactic) | error | default |
| Low (clear semantic) | warning | default |
| Medium (judgment-heavy) | warning | advisory |
| High (composite metric) | metric only (no warning; ratchet-track instead) | n/a |

Checks #14 (CRAP analog) is metric-only by default — emits a number, not a warning, and ratchet/quota (Doc C) handles it.

---

## 6. Severity and gating decisions

| # | Check | Severity | Gate | Rationale |
|---|---|---|---|---|
| 1 | `test_tautological_assertion` | warning | default | Syntactic; no legitimate use case |
| 2 | `test_vague_matcher` | warning | advisory | Sometimes vague is intent; judgment-heavy |
| 3 | `test_empty_body` | warning | default | No legitimate use; zero FP |
| 4 | `test_vague_name` | warning | advisory | Style/judgment |
| 5 | `test_imported_unused` | warning | default | If not already covered by tsc/biome — verify and decide |
| 6 | `test_zero_assertions` | warning | default | Test that asserts nothing is provably broken-as-test |
| 7 | `test_redundant_block` | warning | advisory | Sometimes redundancy is intentional documentation |
| 8 | `test_snapshot_overuse` | metric | ratchet | Per-file ratio; ratchet down rather than per-edit warn |
| 9 | `test_mock_churn` | warning | advisory | Sometimes per-test mock variation is correct |
| 10 | `test_async_correctness` | error | default | Real bug class; missing await is silent test passage |
| 11 | `test_skip_or_only_committed` | error | default | Zero FP; committed `.only` disables all peer tests |
| 12 | `test_console_pollution` | warning | default | Debug leftover; near-zero FP |
| 13 | `test_block_complexity` | warning | advisory | Threshold is judgment-heavy; advisory + ratchet |
| 14 | `test_file_crap_score` | metric | ratchet | Composite, never a warning by itself |
| 15 | `test_setup_leakage` | warning | advisory | Heavy; needs runtime; FP-prone on shared setup |
| 16 | `test_assertion_mutation` | error | separate command | Heavy; deliberate invocation |

`DEFAULT_ADVISORY_SKIPS` updates: add #2, #4, #7, #9, #13, #15. Ship with a one-line rationale per CLAUDE.md convention.

---

## 7. Test corpus

Each check requires:
- ≥3 positive test cases in `src/harness/checks/__tests__/test-files-{checkname}.test.ts`
- ≥3 negative test cases in the same file
- ≥1 "tricky" case (a pattern that looks like the bug but isn't, or vice versa) per check #7's redundant-block convention

The 16-check corpus totals ~100 test cases. Mechanical to write; gates the rollout phases below.

---

## 8. Phased rollout

| Phase | Deliverable | Gate to next |
|---|---|---|
| 1 | Family file scaffolding + 6 zero-FP checks (#1, #3, #6, #10, #11, #12) | All pos/neg + 1 week shadow on this repo |
| 2 | 5 heuristic checks (#2, #4, #5, #7, #9) advisory-only | Pos/neg + shadow data shows <5% FP rate |
| 3 | Snapshot ratio (#8) + complexity (#13) + CRAP analog (#14) wired to ratchet (Doc C) | Doc C Phase 1 in place |
| 4 | Setup leakage (#15) — requires test-runner instrumentation | Tier-2 verify integration |
| 5 | `interlinked test-mutate` command + assertion mutation (#16) | Mutator implementations + test-runner shim |
| 6 | Integration with per-commit background review (Doc F) | Doc F in place |

Phase 1 is the load-bearing first step — proves the architecture and ships immediate value with zero FP risk. Phases 2–4 add the heuristic surface progressively. Phase 5 is the heavyweight standalone. Phase 6 closes the loop with the async per-commit pipeline.

---

## 9. Open questions

1. **Test-framework breadth.** Phase 1 targets vitest + jest (this repo + most consumers). Mocha and other frameworks: gracefully no-op or full support? Provisional: no-op until requested.
2. **Per-team check tuning.** Should `test_vague_name`'s blocklist be configurable? Yes, via `.interlinked/test-checks.json`. Phase 2.
3. **Snapshot ratio threshold.** Default 50%? 30%? Calibrate from shadow data on real repos before fixing.
4. **Mock-churn tolerance.** Sometimes per-test mock variation is the cleanest expression of intent. Threshold: ≥3 redefinitions before flagging? Phase 2 calibration.
5. **`test_imported_unused` overlap with existing lint.** Verify before implementing — if biome/tsc covers it cleanly, drop. If it's covered but the message is generic, our version's specific framing ("test imports X but never asserts on X") might still be worth it.
6. **Test-mutate command UX.** Output format? Per-assertion table with surviving-mutants count? JSON for tooling integration? Both — same `--json` convention as the rest of the CLI.
7. **Caching for assertion mutation.** Mutation results are cacheable per (test-content-hash, assertion-index, mutator-id). Worth building? Phase 5 — yes if the per-commit background review reruns assertion mutation often enough that the cache pays for itself.

---

## 10. Composition with the rest of the system

| Doc | Relationship |
|---|---|
| A (escalation rules) | Test-file findings flow into the same machinery. "Three `test_zero_assertions` this session → reach for `expect.assertions(N)` template at `<path>`" is a natural escalation. |
| C (ratchet/quota system) | #8 (snapshot ratio), #13 (block complexity), #14 (CRAP analog) are first-class ratchet metrics. Quota: `every_test_file_has_assertion_density_above_threshold`. |
| D (BoN executor) | When the executor's `--verify "test:..."` runs the test, the test-file checks audit *the test the user wrote*. A user-written verifier that itself trips `test_tautological_assertion` is a verifier-coverage red flag — surface it. |
| F (impl-aware async review) | F handles the techniques this doc explicitly excludes (real coverage, impl mutation, behavioral coverage, CRAP-formal). This doc is the cheap, sync, per-edit half; F is the expensive, async, per-commit half. Together they form the test-quality stack. |

The narrative across A/B/C/D/E: per-edit warnings (existing + E) → escalation syntheses (A) → ratchet enforcement (C) → recurrence-driven promotion → bounded execution via verbs (B) or free-form-with-verifiers (D), with all of it auditable by deterministic gates.

E is the cheapest and largest lever in the test-quality direction. F adds the impl-aware checks that fundamentally need runtime + impl read.
