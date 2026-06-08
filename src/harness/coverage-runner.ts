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
}

/**
 * Spawn one suite command and time it. Never throws: a launch failure (ENOENT),
 * a thrown spawn error, or an empty command all resolve to an `error` string. A
 * non-zero exit is NOT fatal on its own — coverage can still be emitted by a
 * suite with failing tests — so we only flag a hard launch error here and let
 * the caller decide based on whether a report materialized.
 */
function runSuite(spawn: SpawnFn, command: string[], opts: CoverageRunOpts): SuiteRunOutcome {
	const [bin, ...args] = command;
	if (!bin) return { suiteMs: 0, error: "empty test command" };
	const timeout = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
	const start = Date.now();
	let result: SpawnSyncReturns<string>;
	try {
		result = spawn(bin, args, { cwd: opts.projectRoot, timeout, encoding: "utf-8" });
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return { suiteMs: Date.now() - start, error: `spawn threw: ${reason}` };
	}
	const suiteMs = Date.now() - start;
	if (result.error) {
		const code = (result.error as NodeJS.ErrnoException).code;
		const hint = code === "ENOENT" ? `'${bin}' not found` : result.error.message;
		return { suiteMs, error: `suite did not run: ${hint}` };
	}
	return { suiteMs, error: null };
}

/** Build the `{ ok:false }` result, attaching `error` only when present. */
function failure(suiteMs: number, error: string): CoverageRunResult {
	return { suiteMs, perFile: new Map(), ok: false, error };
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
 * Runs the suite with `vitest run --coverage` (json reporter) and parses the
 * resulting `coverage-final.json` via the existing istanbul reader. The reader
 * already returns `Map<repoRelPath, PerFileCoverage>`, so no parsing lives here.
 */
export class JsCoverageRunner implements CoverageRunner {
	constructor(private readonly spawn: SpawnFn = defaultSpawn) {}

	async run(opts: CoverageRunOpts): Promise<CoverageRunResult> {
		const command = opts.testCommand ?? defaultJsTestCommand(opts.coverageDir);
		const outcome = runSuite(this.spawn, command, opts);
		if (outcome.error) return failure(outcome.suiteMs, outcome.error);

		const reportPath = join(opts.coverageDir, COVERAGE_FINAL_FILENAME);
		const perFile = loadCoverageFinal(reportPath, opts.projectRoot);
		if (!perFile) {
			return failure(
				outcome.suiteMs,
				`no parseable coverage at ${reportPath} — did the suite emit the json reporter?`,
			);
		}
		return { suiteMs: outcome.suiteMs, perFile, ok: true };
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
 * Python via `pytest --cov --cov-report=json:<dir>/coverage.json` (coverage.py).
 * Runs the suite (timing it), then parses the per-line `coverage.json` into the
 * `Map<repoRelPath, PerFileCoverage>` the interface returns — `executed_lines` →
 * `coveredLines`, `missing_lines` → `uncoveredLines`. The per-edit gate prefers
 * those per-line fields, so an uncovered added `.py` line blocks exactly as it
 * does for JS. Never throws: a launch failure, a missing report, or unparseable
 * JSON all become `{ ok:false, error }`.
 */
export class PythonCoverageRunner implements CoverageRunner {
	constructor(private readonly spawn: SpawnFn = defaultSpawn) {}

	async run(opts: CoverageRunOpts): Promise<CoverageRunResult> {
		const command = opts.testCommand ?? defaultPythonTestCommand(opts.coverageDir);
		const outcome = runSuite(this.spawn, command, opts);
		if (outcome.error) return failure(outcome.suiteMs, outcome.error);

		const reportPath = join(opts.coverageDir, COVERAGE_PY_JSON_FILENAME);
		const perFile = parseCoveragePyJson(reportPath, opts.projectRoot);
		if (!perFile) {
			return failure(
				outcome.suiteMs,
				`no parseable coverage at ${reportPath} — did pytest run with ` +
					"pytest-cov (--cov --cov-report=json)?",
			);
		}
		return { suiteMs: outcome.suiteMs, perFile, ok: true };
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
