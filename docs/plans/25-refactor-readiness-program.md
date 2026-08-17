# Plan 25 — Refactor-Readiness Program

Status: ACTIVE (local lanes building 2026-08-17). Owner: operator.
Origin: operator directive 2026-08-17 — "make it easier for future agents to
refactor codebases (or port into a new language)"; multi-language extensibility
TS/JS/Python first, then C/C++, Java, PHP, Go, Ruby, Rust.

## Principle

A refactor or a port is safe only when behavior lives in explicit, executable
artifacts. Mutation hardening is one such artifact (the test suite provably
pins behavior). Every lane below makes one more kind of implicit knowledge
explicit — which is why each is also plain good engineering for a codebase
that never refactors. Enforcement reuses the shapes this harness already has:
tighten-only ratchets, adopt-seeded baselines (brownfield never bricks),
advisory → default → block promotion via recurrence, and mode laddering
(strict/balanced/lenient carry the posture).

## Division of labor

**The local harness judges and refuses; the cloud service measures, generates,
and proves.** Cloud jobs write results into committed baselines/receipts; the
local gates enforce those baselines per tool call; `baseline_integrity_gate`
protects the seam (same shape as coverage baselines today).

## Local lanes (this program builds these)

| # | Lane | Shape | Gate | Status |
|---|------|-------|------|--------|
| L1 | Characterize-before-touch | PreToolUse evaluator gate: editing a file on the untested list requires a companion/characterization test on disk or written this session. Mode-laddered: strict=block, balanced=warn, lenient=off. Honors `// interlinked-tdd: exempt`. | `characterize_before_touch` | BUILT |
| L2 | Seam ratchet | Ratchet-family dimension (`ratchet-comparison.ts`): ambient-seam count (argless `new Date()`/`Date.now`, `Math.random`, `process.env` outside config) must not rise vs the pre-edit baseline. Complements the always-on advisory detectors (`untestable_time_in_source`, `process_env_outside_config`) that cover diff scope. | `seam_ratchet` warning | BUILT |
| L3 | Export ratchet | `checkPublicApiSurfaceRatchet` — public-symbol count must not rise vs pre-edit baseline. | existing | ALREADY SHIPPED (pre-program) |
| L4 | Assertion-strength ratchet | Ratchet-family dimension: fires only when an edit strictly increases WEAK matcher count (toContain/toMatch/toBeTruthy/toBeDefined) while adding no EXACT matcher (toBe/toEqual/toStrictEqual). Test files only. | `assertion_strength_ratchet` warning | BUILT |
| L5 | Cycle-delta check | Structural post check: the edit's new import set closes a module cycle that did not exist before → warning naming the cycle path. Existing `circular_imports` stays the advisory whole-state view; this is the delta moment. | `new_import_cycle` warning | BUILT |
| L6 | Portability lint | New `checks/portability.ts` family, all advisory: `dynamic_code_execution` (eval / new Function / non-literal require/import), `builtin_prototype_mutation`, `float_equality_comparison`. Constructs neither a static tool nor a porting agent can follow. | 3 advisory checks | BUILT |
| L7 | test-contract annotation | Adoption-triggered: when a test file already uses `// test-contract:` markers, a newly added `it()/test()` without one warns. Zero-FP for repos that never opted in. | `test_contract_annotation` advisory | BUILT |
| L8 | Unparsed-boundary detection | Extends the boundary family: `fetch(...).json()` result used without schema-parse; direct `process.argv[n]` indexing in logic. Complements `unvalidated_json_boundary`. | `unvalidated_input_boundary` advisory | BUILT |

Calibration rule (Check Evidence Contract): every new check ships labeled
MUST-FIRE / MUST-NOT-FIRE cases; advisory tier minimum 1/1, target 2/2.
Calibrate against the tree, never against fixtures alone.

## Class-2 knobs (engine budgets exposed to config — BUILT 2026-08-17)

Operator rule of thumb: quality bars are user-owned (caps/mode), engine
budgets are config with measured defaults, measured invariants (slew
tolerances, Sonar 15, daemon timings) are deliberately NOT knobs.

| Knob | Key | Default |
|------|-----|---------|
| Mutation test-scope ceiling | `per_edit_mutation.max_test_scope` | 150 (`MAX_MUTATION_TEST_SCOPE`, calibrated on this repo's largest hub) |
| Coverage %-drop backstop tolerance | `per_edit_coverage.drop_epsilon` | 0.005 (`COVERAGE_DROP_EPSILON`) |
| Runner admission thresholds | `RUNNER_MIN_RAM_PCT` / `RUNNER_SWAP_REFUSE_RATIO` / `RUNNER_SWAP_REFUSE_MIN_TOTAL_MB` env | 15 / 0.9 / 4096 |
| Runner sandbox purge age | `RUNNER_SANDBOX_MAX_AGE_H` env | 6 |

The runner knobs are env-based because the broker lives in gitignored
`scratch/two-box-runner/` (operator infra, not shipped); they graduate to real
config when the plan-24 cloud runner ships.

## Cloud lanes (deferred to the remote offering; see plan 24 for the substrate)

| Lane | Why cloud | Consumes / produces |
|------|-----------|---------------------|
| Mutation runs + census | ~250 s wall local; fan-out is plan 24's product | produces mutation baselines the commit gate reads |
| Adoption sweeps (schema %, seam census, purity %, coupling/arch) | full-tree scans on a schedule | refresh baselines local ratchets compare against |
| Characterization/property-test generation for the legacy backlog | fleet-agent work (kill-fleet shape) | produces the tests L1 demands; local gate only checks existence |
| Fuzzing + differential fuzz | long-running by nature | disposition evidence |
| Conformance runs against a second implementation | two toolchains, parallel, long wall | `interlinked conform --against <impl>` verdicts |
| Equivalent-mutant / dead-code adjudication | judgment + human approval | disposition ledger records |

The ~25 s synchronous cloud window (standing latency decision) remains reserved
for security-class per-edit checks and commit-time mutation once the runner is
remote; everything else above is asynchronous.

## Language-neutral conformance vectors (the port bridge — design next, build cloud-side)

The mutation-hardened suite is engine-bound (vitest). For ports, express pinned
behaviors as neutral vectors: JSON input/output pairs per public boundary,
golden files for serialized output, property definitions. Then
`interlinked conform` runs the same vectors against both implementations, and
mutation score transfers (mutate the new implementation, kill with shared
vectors). Local enforcement hook once built: public boundaries must carry
vectors (adoption score, ratcheted). Design memo owed before build.

## Decisions logged

- Export ratchet discovered already shipped (`countPublicApiSurface` +
  `checkPublicApiSurfaceRatchet`) — recorded, not rebuilt.
- Ratchet-family dimensions (L2/L4) inherit the family's activation guard
  (diff-aware OFF). In diff scope the always-on advisory detectors cover the
  same seams content-wise; the ratchet adds the hold-the-line semantics in
  whole-file scope. Revisit only with fire-rate data, not by argument.
- The characterize gate (lane 1) defaults to warn (balanced); strict blocks.
  Blocking by default would brick every legacy edit on day one, which violates
  the adopt contract.
- The portability, test-contract, and boundary checks (lanes 6–8) land
  advisory. Promotion path is recurrence data, per
  `reference_advisory_does_not_mean_silent`: refine detectors, then promote.
