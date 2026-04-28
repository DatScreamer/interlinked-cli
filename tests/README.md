# Test taxonomy

Tests live next to the code they exercise, in `src/**/__tests__/*.test.ts`. There is no top-level `tests/` source tree — this README is the only file in `tests/`. It documents the categories so authors (and coordinator-driven subagents) know where each new test belongs.

## Categories

| Category | Where | Purpose | Examples |
|---|---|---|---|
| **unit** | `src/<module>/__tests__/<name>.test.ts` | Pure function / class behavior on synthetic inputs | `evaluator.test.ts`, `rules-loader.test.ts`, `feature-flags.test.ts` |
| **golden** | `src/harness/__tests__/fixtures/` consumed by a sibling test | Snapshot the expected output of a deterministic check on a fixed input. Diff against the snapshot on every run. | `cc-patterns.test.ts`, `c-checks.test.ts` |
| **parity** | `*-parity.test.ts` | Assert two implementations of the same contract stay in sync (e.g., daemon-routed rule and inline fallback) | `command-guard-parity.test.ts`, `check-pipeline-parity.test.ts` |
| **regression** | `cli-bugs.test.ts`, `*-regressions.test.ts` | One test per closed bug; prevents recurrence | `cli-bugs.test.ts`, `activity-workspace-regressions.test.ts` |
| **integration** | `src/harness/__tests__/integration/` | Cross-module flows; spawn real subprocesses (npx biome, tsc) | `diff-overlay.test.ts`, `docs-freshness.test.ts` |
| **bench** | `bench/*.bench.ts` (top-level, not under `src/`) | Latency p50/p99 measurement of the evaluator hot path | `evaluator-hot-path.bench.ts` |

## Per-Plan test requirements (Phase 1)

Subagents and PR authors must produce these per their owned rows in `docs/plans/free-cli-adoption/_phase1-phase-matrix.md`.

### Plans 02 + 03 (guard rules)

For each new rule (rows 1–20), 5 cases in `src/harness/__tests__/evaluator.test.ts` (or a co-located file if the file size threshold is reached):

1. **Positive** — canonical command form fires the rule.
2. **FP guard** — superficially-similar form does not fire.
3. **Wrapped** — `sudo`/`env`-prefixed form fires after wrapper-normalization.
4. **Quoted** — pattern inside `'single quotes'` does not fire (post Plan 01 spans).
5. **Commented** — pattern after `#` does not fire (post Plan 01 spans).

Plus: the rule must appear in `command-guard-parity.test.ts`'s rule-set assertion (verifies an inline-fallback case exists).

### Plan 04 (UBS quality checks)

For each new check (rows 21–30), one dedicated file `src/harness/__tests__/<id>.test.ts` with at least 3 cases:

1. **Positive** — known buggy pattern fires the detector.
2. **Negative** — correct usage does not fire.
3. **FP guard** — borderline case from the plan doc's FP-cases section does not fire.

Plus: the check id must appear in `AGGREGATED_IN_JSON` in `check-pipeline-parity.test.ts`. Advisory checks must also appear in `DEFAULT_ADVISORY_SKIPS` in `verify.ts`.

### Plan 01 (evaluator architectural upgrades)

Per sub-feature:

- `wrapper-normalization.test.ts` — `sudo`/`env`/`\cmd`/`command -p` chain idempotence.
- `spans.test.ts` — quoted/commented/heredoc span boundaries on representative shell commands.
- `keyword-quick-reject.test.ts` — assertion that a Python-only command never evaluates kubernetes rules.
- `dual-engine-regex.test.ts` — pathological lookaround pattern bounded under N ms.
- `allowlist-expiry.test.ts` — `expires_at` past-now drops; future stays.

## Conventions

- Test file names mirror their target file: `evaluator.test.ts` → `evaluator.ts`. Detectors/rules with their own dedicated test files use the rule/check id verbatim (`ubs-nan-comparison.test.ts`).
- Per `vitest.config.ts`: `testTimeout: 10_000`, `retry: 2`. Tests that need longer (npx-cold-start) tolerate retry; tests that genuinely take longer should set per-test `timeout`.
- Mocking: `vi.mock` at module top is fine for FS / network. Avoid mocking the harness itself — use `evaluatePreToolUse` directly with synthesized state.
- Fixtures over inline strings when a test grows past ~30 lines of input. Place under `src/harness/__tests__/fixtures/`.
- Bench files (`*.bench.ts`) live in `bench/` and are not run by `vitest run`. Run via `npm run bench`.

## Running

```bash
npm test                         # all unit + parity + regression + integration tests
npx vitest run path/to/file      # one test file
npm run bench                    # bench suite (separate from npm test)
npm run docs                     # regenerate auto-docs (must produce no diff)
npm run typecheck                # tsgo --noEmit (fast, native preview)
npm run typecheck:stable         # tsc --noEmit (slower, stable check)
```

CI runs the `prepublishOnly` script (`typecheck:stable && test`) plus `bench` once thresholds are locked. See `bench/RESULTS.md` for threshold-locking workflow.
