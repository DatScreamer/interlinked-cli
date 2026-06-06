// Pre-edit CRAP baseline snapshot + post-edit riser filter.
//
// Mirrors the `complexFunctions` baseline pattern used by the existing
// complexity check (`quality-checks.ts` and `server.ts`): the harness
// takes a snapshot of the file's CRAP scores BEFORE an edit, and then
// at PostToolUse the current scores are compared against that snapshot.
// Only findings where the edit *raised* the score (or introduced a new
// function) are surfaced. Pre-existing high CRAP is ignored — the agent
// shouldn't be penalised for the state of a file it's only touching, in
// the same way the existing complexity check only flags newly-introduced
// complexity.

import { statSync } from "node:fs";
import { join, relative } from "node:path";
import {
	coverageForFile,
	loadCoverageFinal,
	type PerFileCoverage,
} from "../coverage-final-reader.js";
import { type CrapFinding, computeCrap, computeCrapForFile } from "./crap.js";
import { computeCyclomaticComplexity } from "./cyclomatic.js";

// ==================================================================
// Public types
// ==================================================================

/**
 * Keyed by repo-relative file path → inner map keyed by `name@line` →
 * crap score at snapshot time. Stored on `PreEditBaseline` alongside
 * the existing `complexFunctions` set.
 */
export type CrapBaseline = Map<string, Map<string, number>>;

/** Input bundle for {@link snapshotCrap}. */
export interface SnapshotCrapInput {
	preContent: string;
	filePath: string;
	/** `undefined` when coverage is absent — snapshot is empty (nothing to compare later). */
	coverage: PerFileCoverage | undefined;
	fileMtime: number;
	/**
	 * Threshold used when the snapshot was captured. Must match the threshold
	 * used post-edit so the comparison is apples-to-apples; the caller passes
	 * its configured CRAP threshold through from both sides.
	 */
	threshold: number;
}

// ==================================================================
// Public API
// ==================================================================

/**
 * Capture a pre-edit CRAP snapshot for a single file.
 * Public API — consumed by the harness PreToolUse baseline block in
 * `server.ts`.
 *
 * Stores scores keyed by `"name@line"` so that small line drifts still
 * match during the post-edit comparison. An empty map is returned when
 * coverage is unavailable — there is nothing meaningful to baseline.
 */
export function snapshotCrap(input: SnapshotCrapInput): CrapBaseline {
	const baseline: CrapBaseline = new Map();
	if (input.coverage === undefined) return baseline;

	const complexities = computeCyclomaticComplexity(input.preContent, input.filePath);
	const findings = computeCrap({
		complexities,
		coverage: input.coverage.functions,
		filePath: input.filePath,
		fileMtime: input.fileMtime,
		coverageMtime: input.coverage.mtime,
		// Baseline captures ALL functions, not just those above threshold —
		// otherwise a low-score baseline entry would be missing and a tiny
		// post-edit score bump would look like a brand-new high-risk function.
		threshold: 0,
		staleTolerance: "include",
	});

	const fileMap = new Map<string, number>();
	for (const f of findings) {
		fileMap.set(baselineKey(f.function, f.line), f.crap_score);
	}
	baseline.set(input.filePath, fileMap);

	// Threshold is tracked solely for diagnostic clarity; the comparator
	// doesn't depend on it directly.
	void input.threshold;
	return baseline;
}

/**
 * Filter a set of CRAP findings to just those that represent a regression
 * relative to the pre-edit baseline: either new functions, or existing
 * functions whose CRAP score rose.
 *
 * Public API — consumed by `quality-checks.ts` PostToolUse CRAP block.
 */
export function filterToRisers(
	current: CrapFinding[],
	baseline: CrapBaseline,
): CrapFinding[] {
	if (baseline.size === 0) return current;

	return current.filter((finding) => {
		const fileMap = baseline.get(finding.file);
		if (!fileMap) return true; // no baseline for this file → keep (new file)
		const prior = priorScoreFor(fileMap, finding.function, finding.line);
		if (prior === undefined) return true; // genuinely new function → keep
		return finding.crap_score > prior; // risen score → keep
	});
}

/**
 * Look up a function's pre-edit score with LINE-DRIFT tolerance. Exact
 * `name@line` first (fast path, no drift); otherwise the same-named baseline
 * entry at the NEAREST line — inserting or deleting lines above a function
 * shifts its line but not its identity, so an exact-line key would mis-classify
 * an unchanged function as "new" and fire a false riser. Only when the name is
 * absent from the baseline entirely is it a genuinely new function (`undefined`).
 * Same-named functions (overloads, nested defs) are disambiguated by proximity.
 */
function priorScoreFor(
	fileMap: Map<string, number>,
	fnName: string,
	line: number,
): number | undefined {
	const exact = fileMap.get(baselineKey(fnName, line));
	if (exact !== undefined) return exact;
	let bestScore: number | undefined;
	let bestDelta = Number.POSITIVE_INFINITY;
	for (const [key, score] of fileMap) {
		const parsed = parseBaselineKey(key);
		if (parsed.name !== fnName) continue;
		const delta = Math.abs(parsed.line - line);
		if (delta < bestDelta) {
			bestDelta = delta;
			bestScore = score;
		}
	}
	return bestScore;
}

/** Input bundle for {@link computeCrapRisers}. */
export interface CrapRisersInput {
	/** Post-edit file content. */
	content: string;
	/** Absolute path of the edited file. */
	absFilePath: string;
	/** Repo root. */
	cwd: string;
	/** The pre-edit CRAP snapshot (`PreEditBaseline.crapScores`). */
	baseline: CrapBaseline;
}

/**
 * PostToolUse "coverage-hole alarm": per-function CRAP that is high AND
 * attributable to THIS edit relative to the pre-edit snapshot. Loads the
 * last-known coverage (the static `coverage-final.json` — NOT re-measured here;
 * a per-edit coverage run is deliberately too expensive), scores the post-edit
 * content with the SAME complexity function the snapshot used, and returns only
 * the risers (new functions, or functions whose CRAP rose vs the snapshot).
 *
 * IMPORTANT — what this can and cannot observe: the pre-edit snapshot and this
 * post-edit pass BOTH read the same coverage file, so a true coverage DROP (a
 * test that stopped exercising a branch) is INVISIBLE here until coverage is
 * re-run. Combined with the PreToolUse complexity block (#15), the observable
 * signal is a NEW or freshly-added complex function whose last-known coverage is
 * low — a coverage HOLE on newly-written complexity, not a coverage drop. (The
 * fail-open complexity paths — apply_patch, the missing-AST fallback — can also
 * let a genuine rise through; those are the other way a riser appears.) A real
 * coverage drop on existing code surfaces later via `interlinked metrics` after
 * the next coverage run.
 *
 * Returns `[]` (fail-open) when coverage is unavailable — CRAP needs coverage.
 * Present-not-prescribe: the caller surfaces it as advice.
 */
export function computeCrapRisers(input: CrapRisersInput): CrapFinding[] {
	const covCache = loadCoverageFinal(join(input.cwd, "coverage", "coverage-final.json"), input.cwd);
	if (!covCache) return [];
	const rel = relative(input.cwd, input.absFilePath).replace(/\\/g, "/");
	const perFile = coverageForFile(covCache, rel);
	if (!perFile) return [];

	let fileMtime = 0;
	try {
		fileMtime = statSync(input.absFilePath).mtimeMs;
	} catch {
		/* best-effort — staleTolerance:"include" doesn't depend on it */
	}
	const current = computeCrapForFile({
		complexities: computeCyclomaticComplexity(input.content, input.absFilePath),
		perFile,
		filePath: rel,
		fileMtime,
		threshold: 30,
		staleTolerance: "include",
	});
	return filterToRisers(current, input.baseline);
}

// ==================================================================
// Internal
// ==================================================================

/**
 * Snapshot key — combines function name and 1-based line. Must be used
 * on both sides of the comparison. The line is part of the key so that
 * two same-named functions at different positions (method overrides,
 * nested defs) don't collide.
 */
function baselineKey(fnName: string, line: number): string {
	return `${fnName}@${line}`;
}

/** Inverse of {@link baselineKey} — split on the LAST "@" so a function name
 *  that itself contains "@" (rare) still round-trips. */
function parseBaselineKey(key: string): { name: string; line: number } {
	const at = key.lastIndexOf("@");
	if (at < 0) return { name: key, line: 0 };
	return { name: key.slice(0, at), line: Number(key.slice(at + 1)) || 0 };
}
