// ===========================================
// Per-File Coverage Ratchet
// ===========================================
// Maintains a per-file coverage baseline in `.interlinked/coverage-baseline.json`
// and compares the current run's coverage against it. Drops beyond the
// configured tolerance surface as findings; flat or rising coverage silently
// updates the baseline.
//
// Input: the JSON summary produced by vitest / c8 / istanbul
//   (`coverage/coverage-summary.json` by convention).
// Output: CoverageRatchetFinding[], shaped for the verify output formatter.
//
// Why per-file, not global: global coverage hides regressions — a hot module
// can subsidize a cold one. Ratcheting per-file forces the conversation
// when any specific file's coverage slips.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { CoverageRatchetConfig } from "./check-policy.js";

// ===========================================
// Types
// ===========================================

/** The shape we care about from vitest/c8/istanbul JSON summary. */
export interface CoverageSummary {
	/** Per-file entries keyed by absolute or repo-relative path. */
	[filePath: string]: FileCoverageEntry | undefined;
}

export interface FileCoverageEntry {
	lines: CoverageMetric;
	statements?: CoverageMetric;
	functions?: CoverageMetric;
	branches: CoverageMetric;
}

export interface CoverageMetric {
	/** Percentage (0–100). */
	pct: number;
	/** Absolute covered / total counts, if the reporter emits them. */
	covered?: number;
	total?: number;
}

/** Baseline stored on disk between runs. */
export interface CoverageBaseline {
	version: 1;
	/** ISO timestamp of last successful ratchet. */
	updated_at: string;
	/** Per-repo-relative-path snapshot of { lines.pct, branches.pct }. */
	files: Record<string, { lines_pct: number; branches_pct: number }>;
}

export interface CoverageRatchetFinding {
	name: "coverage_decrease";
	severity: "warning" | "error";
	file: string;
	metric: "lines" | "branches";
	baseline_pct: number;
	current_pct: number;
	delta_pct: number;
	message: string;
}

export interface CoverageRatchetResult {
	findings: CoverageRatchetFinding[];
	/** Summary stats surfaced in verify output / harness status. */
	stats: {
		files_checked: number;
		files_new: number;
		files_decreased: number;
		files_improved: number;
	};
	/** Updated baseline — caller decides whether to persist. */
	nextBaseline: CoverageBaseline;
}

// ===========================================
// Defaults and paths
// ===========================================

export function baselinePath(interlinkedDir: string): string {
	return join(interlinkedDir, "coverage-baseline.json");
}

export function emptyBaseline(): CoverageBaseline {
	return {
		version: 1,
		updated_at: new Date(0).toISOString(),
		files: {},
	};
}

// ===========================================
// I/O
// ===========================================

export function loadBaseline(interlinkedDir: string): CoverageBaseline {
	const path = baselinePath(interlinkedDir);
	if (!existsSync(path)) return emptyBaseline();
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		if (!raw || typeof raw !== "object" || raw.version !== 1 || !raw.files) {
			return emptyBaseline();
		}
		return raw as CoverageBaseline;
	} catch {
		return emptyBaseline();
	}
}

export function saveBaseline(interlinkedDir: string, baseline: CoverageBaseline): void {
	const path = baselinePath(interlinkedDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, "utf-8");
}

export function loadCoverageSummary(summaryPath: string): CoverageSummary | null {
	if (!existsSync(summaryPath)) return null;
	try {
		const raw = JSON.parse(readFileSync(summaryPath, "utf-8"));
		if (!raw || typeof raw !== "object") return null;
		return raw as CoverageSummary;
	} catch {
		return null;
	}
}

// ===========================================
// Core compare
// ===========================================

export interface CompareOptions {
	config: CoverageRatchetConfig;
	/** Repo root — used to normalize absolute paths in the summary. */
	repoRoot: string;
	/**
	 * Files the current session has touched. When provided, ratchet only
	 * fires for these paths. Omit to evaluate every file in the summary.
	 */
	changedFiles?: string[];
}

export function compareCoverage(
	summary: CoverageSummary,
	baseline: CoverageBaseline,
	options: CompareOptions,
): CoverageRatchetResult {
	const { config, repoRoot, changedFiles } = options;
	const findings: CoverageRatchetFinding[] = [];
	const nextFiles: Record<string, { lines_pct: number; branches_pct: number }> = {
		...baseline.files,
	};
	const changedSet = changedFiles ? new Set(changedFiles) : null;

	let filesChecked = 0;
	let filesNew = 0;
	let filesDecreased = 0;
	let filesImproved = 0;

	for (const [rawPath, entry] of Object.entries(summary)) {
		if (!entry || rawPath === "total") continue;
		const relPath = normalizePath(rawPath, repoRoot);
		if (!relPath) continue;
		if (changedSet && !changedSet.has(relPath)) continue;

		filesChecked++;
		const linesPct = entry.lines?.pct ?? 0;
		const branchesPct = entry.branches?.pct ?? 0;
		const prior = baseline.files[relPath];

		if (!prior) {
			filesNew++;
			nextFiles[relPath] = { lines_pct: linesPct, branches_pct: branchesPct };
			continue;
		}

		const linesDelta = linesPct - prior.lines_pct;
		const branchesDelta = branchesPct - prior.branches_pct;

		if (linesDelta < -config.allow_decrease_pct) {
			findings.push(buildFinding("lines", relPath, prior.lines_pct, linesPct, linesDelta));
			filesDecreased++;
		}
		if (branchesDelta < -config.allow_decrease_pct) {
			findings.push(
				buildFinding("branches", relPath, prior.branches_pct, branchesPct, branchesDelta),
			);
			// Don't double-count the decrease.
			if (linesDelta >= -config.allow_decrease_pct) filesDecreased++;
		}

		// Only advance the baseline for metrics that are flat or rising.
		// A decreased metric stays at its prior value so the next run still
		// compares against the high-water mark.
		const nextLines = linesDelta >= 0 ? linesPct : prior.lines_pct;
		const nextBranches = branchesDelta >= 0 ? branchesPct : prior.branches_pct;
		nextFiles[relPath] = { lines_pct: nextLines, branches_pct: nextBranches };

		if (linesDelta > 0 || branchesDelta > 0) filesImproved++;
	}

	return {
		findings,
		stats: {
			files_checked: filesChecked,
			files_new: filesNew,
			files_decreased: filesDecreased,
			files_improved: filesImproved,
		},
		nextBaseline: {
			version: 1,
			updated_at: new Date().toISOString(),
			files: nextFiles,
		},
	};
}

function buildFinding(
	metric: "lines" | "branches",
	file: string,
	baseline: number,
	current: number,
	delta: number,
): CoverageRatchetFinding {
	const roundedBaseline = Math.round(baseline * 10) / 10;
	const roundedCurrent = Math.round(current * 10) / 10;
	const roundedDelta = Math.round(delta * 10) / 10;
	return {
		name: "coverage_decrease",
		severity: "warning",
		file,
		metric,
		baseline_pct: roundedBaseline,
		current_pct: roundedCurrent,
		delta_pct: roundedDelta,
		message: `${metric} coverage for ${file} dropped from ${roundedBaseline}% to ${roundedCurrent}% (${roundedDelta}%). Add tests before committing.`,
	};
}

/**
 * Normalize a coverage-summary key to a repo-relative POSIX path.
 * Skips synthetic buckets (the `total` aggregate, empty strings).
 */
function normalizePath(rawPath: string, repoRoot: string): string | null {
	if (!rawPath || rawPath === "total") return null;
	const absolute = resolve(repoRoot, rawPath);
	const rel = relative(repoRoot, absolute).replace(/\\/g, "/");
	if (rel.startsWith("..") || rel === "") return null;
	return rel;
}
