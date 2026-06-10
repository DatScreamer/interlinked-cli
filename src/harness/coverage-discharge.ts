// ===========================================
// Coverage discharge — the observed-green-run relief path
// ===========================================
// The Stop nudge (`verification-stop-checks.ts::formatDeferredCoverageWarning`)
// tells the user: "Run the suite + coverage to check these now, or commit". The
// commit half was real (the commit gate discharges on a clean pass), but the
// run half was a promise nothing recorded — `recordCoverageDischarge` had no
// caller outside the commit gate, so a user who followed the instruction kept
// receiving the same warning every Stop (finding 2026-06).
//
// This module closes the loop. The PostToolUse pipeline calls
// {@link dischargeObligationsAfterGreenRun} when it observes a coverage-suite
// Bash command complete GREEN; every open obligation whose file the fresh
// report actually MEASURED is discharged. Two honesty guards keep the standard
// measured, not claimed:
//   - per-file: a scoped run that never loaded the obligated file leaves its
//     obligation open (the report's file set is the evidence);
//   - freshness: a report OLDER than the obligation is not evidence — the
//     deferred edit post-dates it.
// The Stop nudge stays the reflective surface and the commit gate stays the
// enforcement surface; this only makes the documented relief path true.
//
// Deterministic throughout (regex + report parse + mtime compare — no
// inference), total / never throws: discharge bookkeeping must never crash the
// PostToolUse pipeline.

import { statSync } from "node:fs";
import { join } from "node:path";
import { lcovReportPaths } from "./coverage-adapters.js";
import { loadCoverageFinal } from "./coverage-final-reader.js";
import { loadLcovFile } from "./coverage-lcov.js";
import {
	readOpenCoverageObligations,
	recordCoverageDischarge,
} from "./coverage-obligation-ledger.js";

/** Engines that run the suite under coverage as one verb (no separate flag).
 *  REPORT-ONLY subcommands are excluded (finding 2026-06): `c8 report`,
 *  `nyc report|merge|instrument|check-coverage`, and `cargo llvm-cov
 *  report|show-env|clean` re-emit or manage EXISTING data without running a
 *  single test — they can refresh a report's mtime and would discharge
 *  obligations on stale execution evidence. */
const COVERAGE_WRAPPER_RE =
	/\bcoverage\s+run\b|\bcargo\s+llvm-cov\b(?!\s+(?:report|show-env|clean)\b)|\b(?:nyc|c8)\s+(?!(?:report|merge|instrument|check-coverage)\b)\S/;

/** Test runners whose run the coverage FLAG below turns into a coverage run. */
const TEST_RUNNER_RE =
	/\b(?:vitest|jest|pytest|mocha|node\s+--test|(?:npm|pnpm|yarn)\s+(?:run\s+)?test|bun\s+test)\b/;

/** Coverage flags across the gated ecosystems (`--coverage`, vitest's dotted
 *  `--coverage.*`, pytest-cov's `--cov`/`--cov=…`/`--cov-report…`). */
const COVERAGE_FLAG_RE = /(?:^|\s)--coverage(?:\b|\.)|(?:^|\s)--cov(?:\b|=)|--cov-report/;

/**
 * True when a Bash command runs a TEST SUITE under coverage — the deterministic
 * trigger for the discharge pass. A test run without coverage, or a coverage
 * EXPORT without a run (`coverage lcov -o …`), is not one.
 */
export function isCoverageSuiteCommand(command: string): boolean {
	if (!command) return false;
	if (COVERAGE_WRAPPER_RE.test(command)) return true;
	return TEST_RUNNER_RE.test(command) && COVERAGE_FLAG_RE.test(command);
}

/** One parsed coverage report: the repo-relative files it measured + its mtime. */
export interface MeasuredReport {
	files: ReadonlySet<string>;
	mtimeMs: number;
}

/** A report file's mtime, or 0 when unreadable (fails the freshness guard). */
function mtimeOf(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * Every existing coverage report's measured-file set: the istanbul
 * `coverage-final.json` plus each LCOV report (canonical + per-language —
 * the same candidate list the metrics/ratchet readers merge). Reports are kept
 * separate (not unioned) so each file's evidence carries ITS report's mtime.
 */
export function measuredCoverageFiles(projectRoot: string): MeasuredReport[] {
	const reports: MeasuredReport[] = [];
	const finalPath = join(projectRoot, "coverage", "coverage-final.json");
	const finalCov = loadCoverageFinal(finalPath, projectRoot);
	if (finalCov) reports.push({ files: new Set(finalCov.keys()), mtimeMs: mtimeOf(finalPath) });
	for (const rel of lcovReportPaths()) {
		const path = join(projectRoot, rel);
		const lcov = loadLcovFile(path, { cwd: projectRoot });
		if (lcov) reports.push({ files: new Set(lcov.files.keys()), mtimeMs: mtimeOf(path) });
	}
	return reports;
}

/**
 * Discharge every open obligation of `sessionId` whose file a fresh-enough
 * report measured (report mtime at/after the obligation's timestamp — an
 * unparseable obligation timestamp degrades to "any report counts" rather than
 * blocking the relief). Returns the discharged files. Call AFTER observing a
 * GREEN coverage-suite run — green-ness is the caller's evidence; measurement
 * and freshness are checked here. Never throws.
 */
export function dischargeObligationsAfterGreenRun(
	projectRoot: string,
	sessionId: string,
	timestamp: string,
): string[] {
	try {
		const open = readOpenCoverageObligations(projectRoot, sessionId);
		if (open.length === 0) return [];
		const reports = measuredCoverageFiles(projectRoot);
		if (reports.length === 0) return [];
		const discharged: string[] = [];
		for (const obligation of open) {
			const openedAt = Date.parse(obligation.timestamp);
			const measured = reports.some(
				(r) => r.files.has(obligation.file) && (!Number.isFinite(openedAt) || r.mtimeMs >= openedAt),
			);
			if (!measured) continue;
			recordCoverageDischarge(projectRoot, obligation.file, sessionId, timestamp);
			discharged.push(obligation.file);
		}
		return discharged;
	} catch {
		return []; // bookkeeping must never crash the PostToolUse pipeline
	}
}
