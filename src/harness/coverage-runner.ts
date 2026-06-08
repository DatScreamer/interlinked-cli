// ===========================================
// CoverageRunner — run a project's suite WITH coverage, parse to per-file
// ===========================================
// The standalone foundation for per-edit coverage enforcement
// (docs/design/per-edit-coverage-enforcement.md, component 2). A runner does
// exactly three things and nothing else:
//   1. spawn the project's test suite under its native coverage engine in
//      `projectRoot`, writing the engine's report into `coverageDir`;
//   2. wall-clock time that run (`suiteMs`);
//   3. parse the emitted report into `Map<repoRelPath, PerFileCoverage>` using
//      the EXISTING coverage readers — never a new parser here.
//
// The block decision, apply-before-disk overlay, and budget-gate are built ON
// TOP of this module in a later step; this file deliberately wires into nothing
// (no evaluator, no verify). It just answers "what does the suite cover right
// now, and how long did it take?".
//
// Reuse map (no parsing is reimplemented here):
//   JS/TS  → vitest's `json` reporter emits `coverage-final.json`, which
//            `loadCoverageFinal` (coverage-final-reader.ts) already parses into
//            the per-function `PerFileCoverage` shape. We point vitest at
//            `coverageDir` and hand the file straight to that reader.
//   Python → coverage.py's native `coverage.json` is PER-LINE
//            (`files["<path>"].executed_lines` / `missing_lines`), with no
//            per-function ranges. The per-edit coverage BLOCK is itself
//            per-line ("is line N this edit added uncovered?"), so the line
//            data is exactly what it needs. The runner parses `executed_lines`/
//            `missing_lines` straight into `PerFileCoverage.coveredLines` /
//            `uncoveredLines` (the per-line fields the gate prefers when
//            present) — no AST function ranges, no LCOV detour. See
//            PythonCoverageRunner.
//
// Beyond coverage, each runner also reports a `testsPassed` signal derived from
// the suite's EXIT CODE (vitest/pytest both exit 1 on test failure, >1 on a
// runner-level error). `ok` ("a coverage report parsed") and `testsPassed`
// ("the tests passed") are orthogonal — a suite with failing tests can still
// emit a coverage report. The per-edit red-bar gate
// (`evaluator/coverage-write-guard.ts`) blocks on `testsPassed === false`.
//
// Errors never throw: a missing/failed runner, missing report, or unparseable
// output all become `{ ok:false, error }` so a caller can degrade gracefully.

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { loadCoverageFinal, type PerFileCoverage } from "./coverage-final-reader.js";

// ===========================================
// Public types
// ===========================================

/** Languages a runner can be requested for. */
export type CoverageLanguage = "js" | "ts" | "python";

/** What the caller asks a runner to do. */
export interface CoverageRunOpts {
	/** Absolute project root; the suite runs here and report paths resolve here. */
	projectRoot: string;
	/** Absolute directory the coverage engine should write its report into. */
	coverageDir: string;
	/**
	 * Override the suite command (argv form, no shell). When omitted each runner
	 * uses its language default (e.g. JS → `vitest run --coverage …`).
	 */
	testCommand?: string[];
	/** Per-run timeout in ms. Defaults to {@link DEFAULT_RUN_TIMEOUT_MS}. */
	timeoutMs?: number;
}

/** The result of one coverage run. */
export interface CoverageRunResult {
	/** Wall-clock duration of the suite spawn, in milliseconds. */
	suiteMs: number;
	/** Per-file coverage keyed by repo-relative POSIX path. Empty when `!ok`. */
	perFile: Map<string, PerFileCoverage>;
	/** True only when the suite ran and a report parsed. */
	ok: boolean;
	/** Human-readable reason when `ok` is false. Absent on success. */
	error?: string;
	/**
	 * Whether the suite's tests all passed — ORTHOGONAL to {@link ok} (which is
	 * "did the runner produce a coverage report?"). The red-bar block reads this:
	 *   - `true`  — the suite ran and every test passed (exit 0).
	 *   - `false` — the suite ran but one or more tests FAILED (vitest/pytest
	 *               exit 1). This is the RED state the red-bar gate blocks on.
	 *   - `null`  — could not be determined: the runner did not launch (ENOENT),
	 *               threw, or exited with a runner-level error code (vitest >1 /
	 *               pytest >=2 — interrupted / internal error / usage / no tests
	 *               collected). The red-bar gate fail-opens on `null`.
	 * A coverage report can be emitted even when some tests fail, so `ok` may be
	 * true while `testsPassed` is false.
	 */
	testsPassed: boolean | null;
	/**
	 * A few failing test names/ids for the block message, best-effort parsed from
	 * the runner's stdout/stderr. Absent when none were found or `testsPassed` is
	 * not `false`. Never load-bearing — the exit code is the source of truth for
	 * pass/fail; these names are message sugar only.
	 */
	failingTests?: string[];
}

/**
 * Runs a project's test suite with coverage and reports per-file coverage. One
 * implementation per language family; see {@link coverageRunnerFor}.
 */
export interface CoverageRunner {
	run(opts: CoverageRunOpts): Promise<CoverageRunResult>;
}

/**
 * Injectable spawn — same call shape as `node:child_process` `spawnSync` with
 * `encoding: "utf-8"`, so tests pass a stub and never run a real suite.
 */
export type SpawnFn = (
	command: string,
	args: string[],
	options: { cwd: string; timeout: number; encoding: "utf-8" },
) => SpawnSyncReturns<string>;

/** Default per-run timeout (ms). A fast greenfield suite fits comfortably. */
export const DEFAULT_RUN_TIMEOUT_MS = 120_000;

/** istanbul report filename vitest's `json` reporter writes into `coverageDir`. */
export const COVERAGE_FINAL_FILENAME = "coverage-final.json";

/** coverage.py JSON report filename the Python runner writes into `coverageDir`. */
export const COVERAGE_PY_JSON_FILENAME = "coverage.json";

/** Cap on failing-test names captured for a block message (sugar, not data). */
const MAX_FAILING_TEST_NAMES = 5;

// ===========================================
// Shared spawn plumbing
// ===========================================

/** The production spawn: a thin, typed wrapper over `spawnSync`. */
const defaultSpawn: SpawnFn = (command, args, options) =>
	spawnSync(command, args, {
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		...options,
	});

/** Outcome of attempting to run a suite command (before report parsing). */
interface SuiteRunOutcome {
	suiteMs: number;
	/** A reason string when the spawn failed/errored; null when it completed. */
	error: string | null;
	/**
	 * The completed spawn result (exit status + captured stdout/stderr), or null
	 * when the spawn never produced one (launch failure / thrown). Each runner
	 * maps `status` → `testsPassed` per its own exit-code contract.
	 */
	result: SpawnSyncReturns<string> | null;
}

/**
 * Spawn one suite command and time it. Never throws: a launch failure (ENOENT),
 * a thrown spawn error, or an empty command all resolve to an `error` string. A
 * non-zero exit is NOT fatal on its own — coverage can still be emitted by a
 * suite with failing tests — so we only flag a hard launch error here and let
 * the caller decide based on whether a report materialized and what the exit
 * status was (the `result` is returned for that pass/fail interpretation).
 */
function runSuite(spawn: SpawnFn, command: string[], opts: CoverageRunOpts): SuiteRunOutcome {
	const [bin, ...args] = command;
	if (!bin) return { suiteMs: 0, error: "empty test command", result: null };
	const timeout = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
	const start = Date.now();
	let result: SpawnSyncReturns<string>;
	try {
		result = spawn(bin, args, { cwd: opts.projectRoot, timeout, encoding: "utf-8" });
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return { suiteMs: Date.now() - start, error: `spawn threw: ${reason}`, result: null };
	}
	const suiteMs = Date.now() - start;
	if (result.error) {
		const code = (result.error as NodeJS.ErrnoException).code;
		const hint = code === "ENOENT" ? `'${bin}' not found` : result.error.message;
		return { suiteMs, error: `suite did not run: ${hint}`, result: null };
	}
	return { suiteMs, error: null, result };
}

/**
 * Build the `{ ok:false }` result. `testsPassed` is null — a runner that failed
 * to produce a report could not establish a trustworthy pass/fail signal, so the
 * red-bar gate fail-opens (never blocks on an unmeasured suite).
 */
function failure(suiteMs: number, error: string): CoverageRunResult {
	return { suiteMs, perFile: new Map(), ok: false, error, testsPassed: null };
}

/** Concatenate a spawn's stdout + stderr into one searchable text blob. */
function spawnText(result: SpawnSyncReturns<string>): string {
	return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

/**
 * Map a suite exit code to the orthogonal pass/fail signal, given the runner's
 * "tests failed" code (1 for both vitest and pytest). Exit 0 → passed; the
 * `failExit` code → failed; null status or any other non-zero (a runner-level
 * error — vitest >1, pytest >=2) → null (couldn't determine ⇒ fail-open).
 */
function testsPassedFromStatus(status: number | null, failExit: number): boolean | null {
	if (status === 0) return true;
	if (status === failExit) return false;
	return null;
}

/** Trim, de-dupe, and cap a parsed failing-test name list. */
function dedupeCap(names: string[]): string[] {
	const seen = new Set<string>();
	for (const raw of names) {
		const name = raw.trim();
		if (name) seen.add(name);
		if (seen.size >= MAX_FAILING_TEST_NAMES) break;
	}
	return [...seen];
}

/**
 * Attach `failingTests` to a result only when the run is RED and at least one
 * name was parsed. Keeps `failingTests` absent (per exactOptionalPropertyTypes)
 * for green / indeterminate runs and for red runs with no parseable names.
 */
function withFailingTests(result: CoverageRunResult, names: string[]): CoverageRunResult {
	if (result.testsPassed !== false) return result;
	const capped = dedupeCap(names);
	if (capped.length === 0) return result;
	return { ...result, failingTests: capped };
}

// ===========================================
// JavaScript / TypeScript runner
// ===========================================

/**
 * Default JS/TS suite command: vitest under v8 coverage with the `json`
 * reporter pointed at `coverageDir`. The `json` reporter writes
 * `coverage-final.json` — the exact istanbul shape `loadCoverageFinal` parses.
 */
export function defaultJsTestCommand(coverageDir: string): string[] {
	return [
		"vitest",
		"run",
		"--coverage",
		"--coverage.reporter=json",
		`--coverage.reportsDirectory=${coverageDir}`,
	];
}

/**
 * Best-effort parse of failing test names from vitest text output. vitest's
 * default reporter prints failing cases as `FAIL  <file> > <suite> > <test>`
 * (or `❯`/`×`-prefixed rows in some renderers). We take the ` > `-tail when
 * present, else the trailing path/segment — purely message sugar; missing names
 * never affect the pass/fail decision (the exit code owns that).
 */
function parseVitestFailingTests(text: string): string[] {
	const names: string[] = [];
	for (const line of text.split("\n")) {
		const m = /^\s*(?:FAIL|×|✗|❯)\s+(.+?)\s*$/.exec(line);
		if (!m) continue;
		const label = m[1];
		if (!label) continue;
		const arrow = label.lastIndexOf(" > ");
		names.push(arrow >= 0 ? label.slice(arrow + 3).trim() : label.trim());
	}
	return names;
}

/**
 * Runs the suite with `vitest run --coverage` (json reporter) and parses the
 * resulting `coverage-final.json` via the existing istanbul reader. The reader
 * already returns `Map<repoRelPath, PerFileCoverage>`, so no parsing lives here.
 * Pass/fail comes from the exit code: 0 → passed, 1 → tests failed, >1 → a
 * runner error (null ⇒ fail-open downstream).
 */
export class JsCoverageRunner implements CoverageRunner {
	constructor(private readonly spawn: SpawnFn = defaultSpawn) {}

	async run(opts: CoverageRunOpts): Promise<CoverageRunResult> {
		const command = opts.testCommand ?? defaultJsTestCommand(opts.coverageDir);
		const outcome = runSuite(this.spawn, command, opts);
		if (outcome.error || !outcome.result) {
			return failure(outcome.suiteMs, outcome.error ?? "suite did not run");
		}

		const reportPath = join(opts.coverageDir, COVERAGE_FINAL_FILENAME);
		const perFile = loadCoverageFinal(reportPath, opts.projectRoot);
		if (!perFile) {
			return failure(
				outcome.suiteMs,
				`no parseable coverage at ${reportPath} — did the suite emit the json reporter?`,
			);
		}
		const testsPassed = testsPassedFromStatus(outcome.result.status, 1);
		const result: CoverageRunResult = { suiteMs: outcome.suiteMs, perFile, ok: true, testsPassed };
		return withFailingTests(result, parseVitestFailingTests(spawnText(outcome.result)));
	}
}

// ===========================================
// Python runner (coverage.py)
// ===========================================

/**
 * Default Python suite command: pytest under coverage.py's JSON report, written
 * to `<coverageDir>/coverage.json` so the runner can find and parse it. Requires
 * `pytest` + `pytest-cov` in the target environment.
 */
export function defaultPythonTestCommand(coverageDir: string): string[] {
	return ["pytest", "--cov", `--cov-report=json:${join(coverageDir, COVERAGE_PY_JSON_FILENAME)}`];
}

/** The coverage.py per-file entry we read — line lists only, the rest ignored. */
interface CoveragePyFileEntry {
	executed_lines?: unknown;
	missing_lines?: unknown;
}

/** The coverage.py JSON top level — only `files` is read. */
interface CoveragePyJson {
	files?: Record<string, CoveragePyFileEntry>;
}

/** Coerce a coverage.py line array (`number[]`) into a Set, dropping non-ints. */
function toLineSet(raw: unknown): Set<number> {
	const set = new Set<number>();
	if (!Array.isArray(raw)) return set;
	for (const v of raw) {
		if (typeof v === "number" && Number.isInteger(v) && v > 0) set.add(v);
	}
	return set;
}

/**
 * Resolve a coverage.py file key to a repo-relative POSIX path, or null when it
 * resolves outside `projectRoot`. coverage.py keys are usually project-relative
 * but may be absolute; both resolve correctly against the root.
 */
function relForKey(key: string, projectRoot: string): string | null {
	if (!key) return null;
	const abs = isAbsolute(key) ? key : resolve(projectRoot, key);
	const rel = relative(projectRoot, abs).replace(/\\/g, "/");
	if (!rel || rel.startsWith("..")) return null;
	return rel;
}

/**
 * Parse coverage.py's `coverage.json` into `Map<repoRelPath, PerFileCoverage>`.
 * Each entry carries per-line `coveredLines` / `uncoveredLines` (from
 * `executed_lines` / `missing_lines`) and an empty `functions` list — coverage.py
 * has no function ranges, and the per-edit gate reads the per-line fields for
 * these. Returns null when the JSON is absent, unparseable, or has no `files`
 * map — the runner turns that into `ok:false`.
 */
function parseCoveragePyJson(
	reportPath: string,
	projectRoot: string,
): Map<string, PerFileCoverage> | null {
	if (!existsSync(reportPath)) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(reportPath, "utf-8"));
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object") return null;
	const files = (raw as CoveragePyJson).files;
	if (!files || typeof files !== "object") return null;

	const result = new Map<string, PerFileCoverage>();
	for (const [key, entry] of Object.entries(files)) {
		if (!entry || typeof entry !== "object") continue;
		const rel = relForKey(key, projectRoot);
		if (!rel) continue;
		result.set(rel, {
			filePath: rel,
			mtime: 0,
			functions: [],
			coveredLines: toLineSet(entry.executed_lines),
			uncoveredLines: toLineSet(entry.missing_lines),
		});
	}
	return result;
}

/**
 * Best-effort parse of failing test ids from pytest text output. pytest prints
 * each failure as `FAILED <nodeid>[ - <message>]` in its short-test-summary, and
 * `<nodeid> ... FAILED` in default verbosity. We capture the nodeid in either
 * shape — message sugar only; the exit code owns the pass/fail decision.
 */
function parsePytestFailingTests(text: string): string[] {
	const names: string[] = [];
	for (const line of text.split("\n")) {
		const summary = /^FAILED\s+(\S+)/.exec(line);
		if (summary?.[1]) {
			names.push(summary[1]);
			continue;
		}
		const inline = /^(\S+::\S+)\s+FAILED\b/.exec(line);
		if (inline?.[1]) names.push(inline[1]);
	}
	return names;
}

/**
 * Python via `pytest --cov --cov-report=json:<dir>/coverage.json` (coverage.py).
 * Runs the suite (timing it), then parses the per-line `coverage.json` into the
 * `Map<repoRelPath, PerFileCoverage>` the interface returns — `executed_lines` →
 * `coveredLines`, `missing_lines` → `uncoveredLines`. The per-edit gate prefers
 * those per-line fields, so an uncovered added `.py` line blocks exactly as it
 * does for JS. Pass/fail comes from the exit code: 0 → passed, 1 → tests failed,
 * >=2 (interrupted / internal error / usage / no tests) → null (fail-open).
 * Never throws: a launch failure, a missing report, or unparseable JSON all
 * become `{ ok:false, error }`.
 */
export class PythonCoverageRunner implements CoverageRunner {
	constructor(private readonly spawn: SpawnFn = defaultSpawn) {}

	async run(opts: CoverageRunOpts): Promise<CoverageRunResult> {
		const command = opts.testCommand ?? defaultPythonTestCommand(opts.coverageDir);
		const outcome = runSuite(this.spawn, command, opts);
		if (outcome.error || !outcome.result) {
			return failure(outcome.suiteMs, outcome.error ?? "suite did not run");
		}

		const reportPath = join(opts.coverageDir, COVERAGE_PY_JSON_FILENAME);
		const perFile = parseCoveragePyJson(reportPath, opts.projectRoot);
		if (!perFile) {
			return failure(
				outcome.suiteMs,
				`no parseable coverage at ${reportPath} — did pytest run with ` +
					"pytest-cov (--cov --cov-report=json)?",
			);
		}
		const testsPassed = testsPassedFromStatus(outcome.result.status, 1);
		const result: CoverageRunResult = { suiteMs: outcome.suiteMs, perFile, ok: true, testsPassed };
		return withFailingTests(result, parsePytestFailingTests(spawnText(outcome.result)));
	}
}

// ===========================================
// Factory
// ===========================================

/**
 * The runner for a language, or `null` when unsupported. JS and TS share
 * {@link JsCoverageRunner} (vitest covers both). Python returns the real
 * {@link PythonCoverageRunner} (coverage.py JSON → per-line `PerFileCoverage`).
 * `spawn` is forwarded so callers/tests can inject a stub.
 */
export function coverageRunnerFor(
	language: CoverageLanguage,
	spawn?: SpawnFn,
): CoverageRunner | null {
	const inject = spawn ?? defaultSpawn;
	switch (language) {
		case "js":
		case "ts":
			return new JsCoverageRunner(inject);
		case "python":
			return new PythonCoverageRunner(inject);
		default:
			return null;
	}
}
