// Per-function coverage reader for istanbul `coverage-final.json`.
//
// Parallel to `coverage-ratchet.ts` (which reads `coverage-summary.json`,
// per-file only). CRAP needs per-function coverage, which only
// `coverage-final.json` provides — it contains the `fnMap` with declaration
// line ranges and the `s` (statement hit counts) keyed by statement id.
//
// The cache key is the absolute path of `coverage-final.json` and its
// mtime. Typical file sizes are 10–50MB on real repos, so we re-parse only
// when the file actually changes.
//
// Scope: JS/TS only. istanbul is the de facto coverage reporter for that
// ecosystem. Python / Go / Rust coverage formats are handled by separate
// readers (not present in phase 0 — CRAP gracefully degrades to
// complexity-only warnings when no reader matches the file).

import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

// Type-tag constants used in the narrow guards below. Extracted so the
// runtime checks read as intent ("is this shaped like an object?") rather
// than comparisons against bare string literals.
const TYPE_OBJECT = "object";
const TYPE_STRING = "string";

// ==================================================================
// Public types
// ==================================================================

export interface FunctionCoverage {
	/** Function name from istanbul `fnMap[id].name`. */
	name: string;
	/** 1-based declaration start line. */
	line: number;
	/** 1-based declaration end line (usually the closing brace). */
	endLine: number;
	/** Raw hit count from `f[id]`. */
	hits: number;
	/**
	 * Percent of statements INSIDE the function's line range that executed.
	 * Derived from `statementMap` + `s` — more faithful to "is this function
	 * actually exercised" than the raw hit count, which counts only the
	 * function's own entry.
	 */
	statement_pct: number;
}

export interface PerFileCoverage {
	/** Repo-relative POSIX path. */
	filePath: string;
	/** mtime of `coverage-final.json` when this entry was parsed. */
	mtime: number;
	functions: FunctionCoverage[];
	/**
	 * 1-based line numbers that executed at least once. Optional, and present
	 * only for engines whose report is natively PER-LINE (coverage.py's
	 * `executed_lines`). istanbul-derived JS coverage leaves this `undefined`
	 * and is read through `functions` instead. When present, the per-edit
	 * coverage gate prefers it because its decision ("is line N uncovered?")
	 * is inherently per-line; see `evaluator/coverage-write-guard.ts`.
	 */
	coveredLines?: ReadonlySet<number>;
	/**
	 * 1-based line numbers that are executable but never executed (coverage.py's
	 * `missing_lines`). Optional; populated alongside {@link coveredLines} by
	 * per-line engines only. The presence of either field signals the per-line
	 * decision path to the coverage gate.
	 */
	uncoveredLines?: ReadonlySet<number>;
}

// ==================================================================
// istanbul source types (minimal — we only read a handful of fields)
// ==================================================================

interface IstanbulLoc {
	line: number;
	column?: number;
}

interface IstanbulRange {
	start: IstanbulLoc;
	end: IstanbulLoc;
}

interface IstanbulFnMapEntry {
	name: string;
	decl?: IstanbulRange;
	loc?: IstanbulRange;
	line?: number;
}

interface IstanbulFileEntry {
	path?: string;
	fnMap?: Record<string, IstanbulFnMapEntry>;
	f?: Record<string, number>;
	statementMap?: Record<string, IstanbulRange>;
	s?: Record<string, number>;
}

type IstanbulFinalJson = Record<string, IstanbulFileEntry>;

// ==================================================================
// mtime-keyed cache
// ==================================================================

interface CachedCoverage {
	mtime: number;
	data: Map<string, PerFileCoverage>;
}

const CACHE = new Map<string /*abs path*/, CachedCoverage>();

/**
 * Reset the in-memory cache. Exposed for tests only.
 */
export function __resetCoverageFinalCache(): void {
	CACHE.clear();
}

// ==================================================================
// Public API
// ==================================================================

/**
 * Load and parse `coverage-final.json`, returning a Map keyed by repo-relative
 * file path. Subsequent calls with an unchanged mtime return the cached Map.
 *
 * Returns `null` when the file is missing or unparseable — fail-open is
 * intentional: a CRAP check without coverage data degrades to complexity-only.
 */
export function loadCoverageFinal(
	coveragePath: string,
	repoRoot: string,
): Map<string, PerFileCoverage> | null {
	if (!existsSync(coveragePath)) return null;

	let mtime: number;
	try {
		mtime = statSync(coveragePath).mtimeMs;
	} catch {
		return null;
	}

	const cached = CACHE.get(coveragePath);
	if (cached && cached.mtime === mtime) {
		return cached.data;
	}

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(coveragePath, "utf-8"));
	} catch {
		return null;
	}
	if (!raw || typeof raw !== TYPE_OBJECT) return null;

	const data = buildPerFileCoverage(raw as IstanbulFinalJson, repoRoot, mtime);
	CACHE.set(coveragePath, { mtime, data });
	return data;
}

/**
 * Look up a file in a previously-loaded coverage map. Thin wrapper kept as
 * public API so callers don't need to know the key convention.
 */
export function coverageForFile(
	cache: Map<string, PerFileCoverage>,
	repoRelPath: string,
): PerFileCoverage | undefined {
	return cache.get(normalizeRelPath(repoRelPath));
}

// ==================================================================
// Internal parsing
// ==================================================================

function buildPerFileCoverage(
	raw: IstanbulFinalJson,
	repoRoot: string,
	mtime: number,
): Map<string, PerFileCoverage> {
	const result = new Map<string, PerFileCoverage>();

	for (const [key, entry] of Object.entries(raw)) {
		if (!entry || typeof entry !== TYPE_OBJECT) continue;
		const absolute = resolveFileKey(entry.path ?? key, repoRoot);
		if (!absolute) continue;
		const rel = normalizeRelPath(relative(repoRoot, absolute));
		if (!rel || rel.startsWith("..")) continue;

		const functions = extractFunctionCoverage(entry);
		// Per-LINE coverage from the statement map (finding 5): per-FUNCTION coverage
		// marks a function covered when ANY statement runs, missing an uncovered branch
		// inside it AND top-level statements (which live in no function). Populating
		// coveredLines/uncoveredLines makes `hasPerLineData` true for JS too, so the
		// gate checks each EDITED line — restoring the added-line guarantee.
		const { covered, uncovered } = extractLineCoverage(entry);
		result.set(rel, {
			filePath: rel,
			mtime,
			functions,
			...(covered.size > 0 || uncovered.size > 0
				? { coveredLines: covered, uncoveredLines: uncovered }
				: {}),
		});
	}

	return result;
}

function extractFunctionCoverage(entry: IstanbulFileEntry): FunctionCoverage[] {
	const fnMap = entry.fnMap ?? {};
	const hits = entry.f ?? {};
	const statementMap = entry.statementMap ?? {};
	const statementHits = entry.s ?? {};

	const functions: FunctionCoverage[] = [];
	for (const [id, fnEntry] of Object.entries(fnMap)) {
		const decl = fnEntry.decl ?? fnEntry.loc;
		const startLine = decl?.start?.line ?? fnEntry.line ?? 0;
		if (startLine <= 0) continue;
		// Prefer `loc.end` (closing brace) when present — that's the full body
		// range. Fall back to `decl.end` when istanbul only emitted `decl`.
		const locEnd =
			fnEntry.loc?.end?.line ?? fnEntry.decl?.end?.line ?? startLine;

		functions.push({
			name: fnEntry.name || `anon@${startLine}`,
			line: startLine,
			endLine: locEnd,
			hits: hits[id] ?? 0,
			statement_pct: computeStatementPct({
				fnStartLine: startLine,
				fnEndLine: locEnd,
				statementMap,
				statementHits,
			}),
		});
	}

	return functions.sort((a, b) => a.line - b.line);
}

/**
 * Per-LINE coverage from Istanbul's statement map. Catches top-level statements (in
 * no function) and an uncovered branch body inside an otherwise-covered function
 * (finding 5). Range handling is deliberately ASYMMETRIC (finding 2026-06):
 *   - a ZERO-hit statement never executed, so EVERY line it spans is uncovered —
 *     record its full start..end range (a multi-line call's continuation lines were
 *     previously in neither set, so an edit touching one slipped the added-line check);
 *   - a COVERED statement records only its START line: a covered declaration like
 *     `const f = () => {…}` SPANS its whole body, and since a line with any covered
 *     statement wins, marking its full range would mask genuinely uncovered inner
 *     statements.
 */
function extractLineCoverage(entry: IstanbulFileEntry): { covered: Set<number>; uncovered: Set<number> } {
	const covered = new Set<number>();
	const uncovered = new Set<number>();
	const statementMap = entry.statementMap ?? {};
	const statementHits = entry.s ?? {};
	for (const [id, range] of Object.entries(statementMap)) {
		const start = range?.start?.line;
		if (start == null || start <= 0) continue;
		if ((statementHits[id] ?? 0) > 0) {
			covered.add(start);
		} else {
			const end = Math.max(range?.end?.line ?? start, start);
			for (let ln = start; ln <= end; ln++) uncovered.add(ln);
		}
	}
	// A line is covered if ANY statement starting on it executed.
	for (const ln of covered) uncovered.delete(ln);
	return { covered, uncovered };
}

interface StatementPctInput {
	fnStartLine: number;
	fnEndLine: number;
	statementMap: Record<string, IstanbulRange>;
	statementHits: Record<string, number>;
}

/**
 * Compute the percent of statements whose start line falls inside
 * [fnStartLine, fnEndLine] and which executed at least once.
 * Returns 0 when the function has no statements in its range.
 */
function computeStatementPct(input: StatementPctInput): number {
	const { fnStartLine, fnEndLine, statementMap, statementHits } = input;
	let total = 0;
	let covered = 0;
	for (const [id, range] of Object.entries(statementMap)) {
		const line = range?.start?.line;
		if (line == null) continue;
		if (line < fnStartLine || line > fnEndLine) continue;
		total++;
		if ((statementHits[id] ?? 0) > 0) covered++;
	}
	if (total === 0) return 0;
	return (covered / total) * 100;
}

function resolveFileKey(pathKey: string, repoRoot: string): string | null {
	if (!pathKey || typeof pathKey !== TYPE_STRING) return null;
	try {
		return resolve(repoRoot, pathKey);
	} catch {
		return null;
	}
}

function normalizeRelPath(p: string): string {
	return p.replace(/\\/g, "/");
}
