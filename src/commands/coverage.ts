// ===========================================
// interlinked coverage — per-file coverage ratchet CLI
// ===========================================
// Thin wrapper around harness/coverage-ratchet.ts. Locates a coverage report,
// preferring `coverage/lcov.info` (the language-agnostic interchange path:
// LCOV → canonical model → ratchet shape) and falling back to the istanbul/v8
// `coverage-summary.json`. Loads the baseline from
// .interlinked/coverage-baseline.json, runs compareCoverage, and renders
// results. `--update-baseline` explicitly persists the new state; without it,
// any per-file drop surfaces as a finding and exits non-zero.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadCheckPolicy } from "../harness/check-policy.js";
import { CANONICAL_LCOV_PATH, coverageSetupGuidance } from "../harness/coverage-adapters.js";
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

const DEFAULT_REPORT_PATHS = [
	// The canonical interchange path every coverage adapter emits to
	// (coverage-adapters.ts); kept first so every language flows the one
	// LCOV → canonical → ratchet path. The json-summary/final entries are the
	// istanbul/v8 fallbacks for a JS run that hasn't emitted lcov.
	CANONICAL_LCOV_PATH,
	"coverage/coverage-summary.json",
	"coverage/coverage-final.json",
];

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
		const reportPath = resolveReportPath(cwd, opts.report);
		if (!reportPath) {
			outputError(
				mode,
				`No coverage report found. Expected one of:\n  ${DEFAULT_REPORT_PATHS.map((p) => `- ${p}`).join("\n  ")}\n\n` +
					`Generate one — each command emits LCOV at the canonical path the ratchet reads:\n${coverageSetupGuidance(cwd)}`,
			);
			process.exitCode = 1;
			return;
		}

		const summary = loadReport(reportPath, cwd);
		if (!summary) {
			outputError(mode, `Failed to parse coverage report at ${reportPath}`);
			process.exitCode = 1;
			return;
		}

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

function resolveReportPath(cwd: string, explicit?: string): string | null {
	if (explicit) {
		const resolved = resolve(cwd, explicit);
		return existsSync(resolved) ? resolved : null;
	}
	for (const candidate of DEFAULT_REPORT_PATHS) {
		const resolved = join(cwd, candidate);
		if (existsSync(resolved)) return resolved;
	}
	return null;
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
