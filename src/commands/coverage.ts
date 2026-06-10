// ===========================================
// interlinked coverage — per-file coverage ratchet CLI
// ===========================================
// Thin wrapper around harness/coverage-ratchet.ts. Locates the coverage
// reports, preferring the LCOV family (the language-agnostic interchange path:
// LCOV → canonical model → ratchet shape) — EVERY existing LCOV report is
// loaded and MERGED, because the per-language adapters each emit their own file
// (finding 2026-06: one shared output path made each language's run clobber the
// previous one's report, so the ratchet silently lost a language) — and falling
// back to the istanbul/v8 `coverage-summary.json`. Loads the baseline from
// .interlinked/coverage-baseline.json, runs compareCoverage, and renders
// results. `--update-baseline` explicitly persists the new state; without it,
// any per-file drop surfaces as a finding and exits non-zero.

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadCheckPolicy } from "../harness/check-policy.js";
import { coverageSetupGuidance, lcovReportPaths } from "../harness/coverage-adapters.js";
import { canonicalToCoverageSummary, loadLcovFile } from "../harness/coverage-lcov.js";
import {
	type CoverageRatchetFinding,
	type CoverageRatchetResult,
	type CoverageSummary,
	compareCoverage,
	loadBaseline,
	loadCoverageSummary,
	saveBaseline,
} from "../harness/coverage-ratchet.js";
import { getConfigDir } from "../lib/config.js";
import { c, header, kvLine } from "../lib/formatter.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

/** The istanbul/v8 fallbacks for a JS run that hasn't emitted lcov. The LCOV
 *  candidates come from `lcovReportPaths()` (canonical + per-language). */
const ISTANBUL_REPORT_PATHS = ["coverage/coverage-summary.json", "coverage/coverage-final.json"];

/** Every default report location, for the "no report found" guidance. */
function defaultReportPaths(): string[] {
	return [...lcovReportPaths(), ...ISTANBUL_REPORT_PATHS];
}

interface CoverageCheckOptions {
	report?: string;
	updateBaseline?: boolean;
	changedFiles?: string;
	strict?: boolean;
	cwd?: string;
	json?: boolean;
}

export async function coverageCheckCommand(opts: CoverageCheckOptions): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = resolve(opts.cwd || process.cwd());
	const configDir = getConfigDir(cwd);

	try {
		const reportPaths = resolveReportPaths(cwd, opts.report);
		if (reportPaths.length === 0) {
			outputError(
				mode,
				`No coverage report found. Expected one of:\n  ${defaultReportPaths()
					.map((p) => `- ${p}`)
					.join("\n  ")}\n\n` +
					`Generate one — each command emits LCOV at a per-language path the ratchet merges:\n${coverageSetupGuidance(cwd)}`,
			);
			process.exitCode = 1;
			return;
		}

		const loaded = loadMergedReport(reportPaths, cwd);
		if (loaded.failedPath !== null) {
			outputError(mode, `Failed to parse coverage report at ${loaded.failedPath}`);
			process.exitCode = 1;
			return;
		}
		const summary = loaded.summary;
		const reportPath = reportPaths.join(" + ");

		const policy = loadCheckPolicy(cwd);
		const baseline = loadBaseline(configDir);
		const changedFiles = parseChangedFiles(opts.changedFiles);
		const result = compareCoverage(summary, baseline, {
			config: policy.coverage_ratchet,
			repoRoot: cwd,
			...(changedFiles !== undefined ? { changedFiles } : {}),
		});

		output(mode, buildJsonPayload(reportPath, result), {
			json: () => buildJsonPayload(reportPath, result),
			normal: () => renderNormal(reportPath, result),
		});

		if (opts.updateBaseline) {
			saveBaseline(configDir, result.nextBaseline);
			if (mode !== "json") {
				process.stderr.write(
					`\n  ${c.green("✓")} Baseline updated at ${join(".interlinked", "coverage-baseline.json")}\n`,
				);
			}
		}

		const hasErrors = result.findings.some((f) => f.severity === "error");
		const hasWarnings = result.findings.length > 0;
		if (hasErrors || (opts.strict && hasWarnings)) {
			process.exitCode = 1;
		}
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
	}
}

/**
 * Show the current baseline so users can see what's being ratcheted
 * against, and spot files with lower-than-expected baselines.
 */
export function coverageBaselineCommand(opts: { cwd?: string; json?: boolean }): void {
	const mode = getOutputMode(opts);
	const cwd = resolve(opts.cwd || process.cwd());
	const configDir = getConfigDir(cwd);
	const baseline = loadBaseline(configDir);

	output(mode, baseline, {
		json: () => baseline,
		normal: () => {
			const lines: string[] = [];
			lines.push(header("Coverage Baseline"));
			lines.push(kvLine("Updated", baseline.updated_at));
			lines.push(kvLine("Files", String(Object.keys(baseline.files).length)));
			const rows = Object.entries(baseline.files)
				.sort(([a], [b]) => a.localeCompare(b))
				.slice(0, 25);
			if (rows.length === 0) {
				lines.push("");
				lines.push(
					c.dim(
						"  (no baseline yet — run `interlinked coverage check --update-baseline`)",
					),
				);
			} else {
				lines.push("");
				for (const [file, metrics] of rows) {
					lines.push(
						`  ${file} ${c.dim(`lines=${metrics.lines_pct.toFixed(1)}% branches=${metrics.branches_pct.toFixed(1)}%`)}`,
					);
				}
				if (Object.keys(baseline.files).length > rows.length) {
					lines.push(
						c.dim(`  … and ${Object.keys(baseline.files).length - rows.length} more`),
					);
				}
			}
			return lines.join("\n");
		},
	});
}

// ===========================================
// Helpers
// ===========================================

/**
 * Load a coverage report into the ratchet's `CoverageSummary` shape, dispatching
 * by format: `.info` → LCOV (the language-agnostic interchange path, via the
 * canonical model); otherwise the istanbul/v8 json-summary. LCOV is preferred
 * (see `DEFAULT_REPORT_PATHS`) so every language's coverage flows one path.
 */
function loadReport(reportPath: string, cwd: string): CoverageSummary | null {
	if (reportPath.endsWith(".info")) {
		const cov = loadLcovFile(reportPath, { cwd });
		return cov ? canonicalToCoverageSummary(cov) : null;
	}
	return loadCoverageSummary(reportPath);
}

/**
 * The report files the check reads: an explicit `--report` path alone (the user
 * override); otherwise EVERY existing LCOV report (canonical + per-language —
 * all merged, finding 2026-06); otherwise the first existing istanbul fallback.
 * Empty ⇒ no report anywhere.
 */
function resolveReportPaths(cwd: string, explicit?: string): string[] {
	if (explicit) {
		const resolved = resolve(cwd, explicit);
		return existsSync(resolved) ? [resolved] : [];
	}
	const lcov = lcovReportPaths()
		.map((p) => join(cwd, p))
		.filter((p) => existsSync(p));
	if (lcov.length > 0) return lcov;
	for (const candidate of ISTANBUL_REPORT_PATHS) {
		const resolved = join(cwd, candidate);
		if (existsSync(resolved)) return [resolved];
	}
	return [];
}

/** A report file's mtime, or 0 when unreadable (sorts oldest — least trusted). */
function reportMtimeMs(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * Load and MERGE the resolved reports. Files merge oldest-first so a FRESHER
 * report's per-file entries win any overlap (per-language reports are normally
 * disjoint; on a shared file the newest run is the honest number). Any existing
 * report that fails to parse aborts the merge LOUDLY (`failedPath`) — a
 * silent-partial merge would misreport exactly like the clobbering this fixes.
 */
function loadMergedReport(
	reportPaths: string[],
	cwd: string,
): { summary: CoverageSummary; failedPath: string | null } {
	const ordered = [...reportPaths].sort((a, b) => reportMtimeMs(a) - reportMtimeMs(b));
	const merged: CoverageSummary = {};
	for (const path of ordered) {
		const summary = loadReport(path, cwd);
		if (!summary) return { summary: merged, failedPath: path };
		for (const [key, entry] of Object.entries(summary)) {
			merged[key] = entry;
		}
	}
	return { summary: merged, failedPath: null };
}

function parseChangedFiles(raw?: string): string[] | undefined {
	if (!raw) return undefined;
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

interface CoverageCheckJson {
	report: string;
	findings: CoverageRatchetFinding[];
	stats: CoverageRatchetResult["stats"];
}

function buildJsonPayload(reportPath: string, result: CoverageRatchetResult): CoverageCheckJson {
	return {
		report: reportPath,
		findings: result.findings,
		stats: result.stats,
	};
}

function renderNormal(reportPath: string, result: CoverageRatchetResult): string {
	const lines: string[] = [];
	lines.push(header("Coverage Ratchet"));
	lines.push(kvLine("Report", reportPath));
	lines.push(kvLine("Files checked", String(result.stats.files_checked)));
	lines.push(
		kvLine(
			"New / Improved / Decreased",
			`${result.stats.files_new} / ${result.stats.files_improved} / ${result.stats.files_decreased}`,
		),
	);
	if (result.findings.length === 0) {
		lines.push("");
		lines.push(c.green("  ✓ No per-file coverage regressions."));
		return lines.join("\n");
	}
	lines.push("");
	lines.push(c.red(`  ${result.findings.length} regression(s):`));
	for (const f of result.findings) {
		lines.push(
			`    ${c.red("✗")} ${f.file} ${c.dim(`[${f.metric}]`)} ${f.baseline_pct}% → ${f.current_pct}% ${c.dim(`(${f.delta_pct.toFixed(1)}%)`)}`,
		);
	}
	lines.push("");
	lines.push(c.dim("  Add tests to restore coverage, or run with --update-baseline to accept."));
	return lines.join("\n");
}
