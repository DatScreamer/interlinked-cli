// interlinked-tdd: exempt
// ===========================================
// CoverageRunner — report filenames + default suite commands
// ===========================================
// Pure, leaf helpers extracted from coverage-runner.ts: the report filenames
// each engine writes into `coverageDir`, and the language-default suite commands
// (argv form, no shell) that point the engine at that directory. No module state,
// no back-dependency on the runner — the runners import these.

import { join } from "node:path";

/** istanbul report filename vitest's `json` reporter writes into `coverageDir`. */
export const COVERAGE_FINAL_FILENAME = "coverage-final.json";

/** coverage.py JSON report filename the Python runner writes into `coverageDir`. */
export const COVERAGE_PY_JSON_FILENAME = "coverage.json";

/**
 * Default JS/TS suite command: vitest under v8 coverage with the `json`
 * reporter pointed at `coverageDir`. The `json` reporter writes
 * `coverage-final.json` — the exact istanbul shape `loadCoverageFinal` parses.
 *
 * When `selectedTests` is non-empty the suite is SCOPED to those files —
 * `vitest run <paths…> --coverage …` — so a per-edit overlay run touches only the
 * affected tests and fits the budget. Empty/omitted ⇒ the full suite.
 */
export function defaultJsTestCommand(coverageDir: string, selectedTests?: string[]): string[] {
	return [
		"vitest",
		"run",
		...(selectedTests ?? []),
		"--coverage",
		"--coverage.reporter=json",
		// Emit coverage even when tests FAIL — otherwise a red suite produces no
		// report (ok:false) and the red-bar gate never sees testsPassed===false.
		"--coverage.reportOnFailure=true",
		`--coverage.reportsDirectory=${coverageDir}`,
	];
}

/**
 * Default Python suite command: pytest under coverage.py's JSON report, written
 * to `<coverageDir>/coverage.json` so the runner can find and parse it. Requires
 * `pytest` + `pytest-cov` in the target environment.
 *
 * When `selectedTests` is non-empty the suite is SCOPED to those files —
 * `pytest <paths…> --cov …` — the fast per-edit path. Empty/omitted ⇒ the full
 * suite.
 */
export function defaultPythonTestCommand(coverageDir: string, selectedTests?: string[]): string[] {
	return [
		"pytest",
		...(selectedTests ?? []),
		"--cov",
		`--cov-report=json:${join(coverageDir, COVERAGE_PY_JSON_FILENAME)}`,
	];
}
