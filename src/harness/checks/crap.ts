// CRAP — Change Risk Anti-Patterns metric.
//
//   CRAP(fn) = comp(fn)² · (1 − cov(fn)/100)³ + comp(fn)
//
// Composite risk score combining cyclomatic complexity and per-function
// statement coverage. A 10-branch function with 0% coverage scores 110;
// the same function at 100% coverage scores 10 — so CRAP specifically
// rewards tests for complex functions.
//
// This module is pure. The caller is responsible for I/O (reading the
// source file, loading coverage, writing telemetry). Keeping I/O out
// here means the same `computeCrap` fires at PostToolUse (diff-aware),
// at PreToolUse (budget line), and at `verify --all-checks` (hotspot list)
// without language-specific coupling.
//
// Matching strategy: line-slack of ±3 between the complexity entry's start
// line and the coverage entry's start line. Absorbs minor whitespace drift
// since the last coverage run. If the file has changed significantly
// (post-edit mtime > coverage mtime), the `stale` flag is set so callers
// can choose whether to surface, tag, or skip the finding.

import type { FunctionCoverage, PerFileCoverage } from "../coverage-final-reader.js";
import type { FunctionComplexityEntry } from "./cyclomatic.js";

// ==================================================================
// Public types
// ==================================================================

export interface CrapFinding {
	file: string;
	function: string;
	line: number;
	complexity: number;
	coverage_pct: number;
	crap_score: number;
	stale: boolean;
}

/**
 * How to treat findings when the source file is newer than the coverage snapshot.
 * - "include": report, no annotation.
 * - "tag":     report with `stale: true` so callers can surface a marker.
 * - "skip":    drop the finding entirely.
 */
export type StaleTolerance = "include" | "tag" | "skip";

/** Stale-tolerance sentinel used in conditionals below. */
const STALE_SKIP: StaleTolerance = "skip";

/** Input bundle for {@link computeCrap} — collapses per-file context + config. */
export interface ComputeCrapInput {
	complexities: FunctionComplexityEntry[];
	/** `undefined` for languages without a coverage reader — callers get `[]` back. */
	coverage: FunctionCoverage[] | undefined;
	filePath: string;
	fileMtime: number;
	/** `null` when coverage is absent. */
	coverageMtime: number | null;
	/** Score at/above which a function is reported (McCabe/Sonar cutoff ≈ 30). */
	threshold: number;
	staleTolerance: StaleTolerance;
	/** Hook paths pass `3`; verify passes `undefined` for the full hotspot list. */
	maxFindings?: number | undefined;
}

// ==================================================================
// Constants
// ==================================================================

/** Slack in lines between complexity-entry start-line and coverage-entry start-line. */
const LINE_MATCH_SLACK = 3;

// ==================================================================
// Public API
// ==================================================================

/**
 * Compute CRAP findings for a single file.
 * Public API — consumed by:
 *  - `crap-baseline.ts` (pre-edit snapshot + filterToRisers)
 *  - `quality-checks.ts` PostToolUse CRAP block (phase-0 wiring)
 *  - `verify/file-checks.ts` `r.crap.push(...)` loop
 */
export function computeCrap(input: ComputeCrapInput): CrapFinding[] {
	const {
		complexities,
		coverage,
		filePath,
		fileMtime,
		coverageMtime,
		threshold,
		staleTolerance,
		maxFindings,
	} = input;

	if (coverage === undefined) return [];

	const stale = coverageMtime !== null && fileMtime > coverageMtime;
	if (stale && staleTolerance === STALE_SKIP) return [];

	const findings: CrapFinding[] = [];
	for (const fn of complexities) {
		const match = findCoverageMatch(fn, coverage);
		const covPct = match?.statement_pct ?? 0;
		const score = crapScore(fn.cyclomatic, covPct);
		if (score < threshold) continue;

		findings.push({
			file: filePath,
			function: fn.name,
			line: fn.line,
			complexity: fn.cyclomatic,
			coverage_pct: covPct,
			crap_score: score,
			stale,
		});
	}

	findings.sort((a, b) => b.crap_score - a.crap_score);

	if (maxFindings !== undefined && findings.length > maxFindings) {
		return findings.slice(0, maxFindings);
	}
	return findings;
}

/**
 * CRAP formula. Public API — exposed so callers can compute scores outside
 * the finding pipeline (e.g. to render a single PreToolUse budget line).
 */
export function crapScore(complexity: number, coverage_pct: number): number {
	const fractionUncovered = 1 - coverage_pct / 100;
	return complexity * complexity * fractionUncovered ** 3 + complexity;
}

/** Input bundle for {@link computeCrapForFile} — per-file convenience wrapper. */
export interface ComputeCrapForFileInput {
	complexities: FunctionComplexityEntry[];
	perFile: PerFileCoverage | undefined;
	filePath: string;
	fileMtime: number;
	threshold: number;
	staleTolerance: StaleTolerance;
	maxFindings?: number;
}

/**
 * Convenience wrapper for callers that already hold a `PerFileCoverage`.
 * Public API — thin pass-through so call sites don't unpack `.functions` /
 * `.mtime` themselves.
 */
export function computeCrapForFile(input: ComputeCrapForFileInput): CrapFinding[] {
	return computeCrap({
		complexities: input.complexities,
		coverage: input.perFile?.functions,
		filePath: input.filePath,
		fileMtime: input.fileMtime,
		coverageMtime: input.perFile?.mtime ?? null,
		threshold: input.threshold,
		staleTolerance: input.staleTolerance,
		maxFindings: input.maxFindings,
	});
}

// ==================================================================
// Internal
// ==================================================================

function findCoverageMatch(
	fn: FunctionComplexityEntry,
	coverage: FunctionCoverage[],
): FunctionCoverage | undefined {
	// Exact name + line-slack match first.
	for (const cov of coverage) {
		if (cov.name !== fn.name) continue;
		if (Math.abs(cov.line - fn.line) <= LINE_MATCH_SLACK) return cov;
	}
	// Fallback: line-slack match ignoring name (covers renames / anon fns).
	// Only applied when no name-match exists so we don't shadow a correct
	// match with a nearby sibling.
	for (const cov of coverage) {
		if (Math.abs(cov.line - fn.line) <= LINE_MATCH_SLACK) return cov;
	}
	return undefined;
}
