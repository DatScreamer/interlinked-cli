// ===========================================
// interlinked mutation — per-file mutation score ratchet CLI
// ===========================================
// Thin wrapper around harness/mutation-gate.ts. Locates the Stryker report
// (default: `reports/mutation/mutation.json`), compares against the
// baseline in .interlinked/mutation-baseline.json, and renders results.
// `--update-baseline` persists the new high-water mark; otherwise any
// per-file score drop is an error and exits non-zero.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadCheckPolicy } from "../harness/check-policy.js";
import {
	compareMutation,
	emptyMutationBaseline,
	loadMutationBaseline,
	loadMutationReport,
	type MutationFinding,
	type MutationGateResult,
	mutationBaselinePath,
	saveMutationBaseline,
} from "../harness/mutation-gate.js";
import { getConfigDir } from "../lib/config.js";
import { c, header, kvLine } from "../lib/formatter.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

const DEFAULT_REPORT_PATHS = [
	"reports/mutation/mutation.json",
	"reports/mutation/mutation-report.json",
	".stryker-tmp/reports/mutation.json",
];

interface MutationCheckOptions {
	report?: string;
	updateBaseline?: boolean;
	minScore?: string;
	changedFiles?: string;
	cwd?: string;
	json?: boolean;
}

export async function mutationCheckCommand(opts: MutationCheckOptions): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = resolve(opts.cwd || process.cwd());
	const configDir = getConfigDir(cwd);

	try {
		const reportPath = resolveReportPath(cwd, opts.report);
		if (!reportPath) {
			outputError(
				mode,
				`No mutation report found. Expected one of:\n  ${DEFAULT_REPORT_PATHS.map((p) => `- ${p}`).join("\n  ")}\nRun \`npx stryker run\` (or equivalent) first, or pass --report <path>.`,
			);
			process.exitCode = 1;
			return;
		}

		const report = loadMutationReport(reportPath);
		if (!report) {
			outputError(mode, `Failed to parse mutation report at ${reportPath}`);
			process.exitCode = 1;
			return;
		}

		const policy = loadCheckPolicy(cwd);
		const minScore = opts.minScore
			? clampScore(Number.parseFloat(opts.minScore))
			: policy.mutation_gate.min_score;
		const baseline = loadMutationBaseline(configDir);
		const changedFiles = parseChangedFiles(opts.changedFiles);
		const result = compareMutation(report, baseline, {
			config: { ...policy.mutation_gate, min_score: minScore },
			repoRoot: cwd,
			...(changedFiles !== undefined ? { changedFiles } : {}),
		});

		output(mode, buildJsonPayload(reportPath, result, minScore), {
			json: () => buildJsonPayload(reportPath, result, minScore),
			normal: () => renderNormal(reportPath, result, minScore),
		});

		if (opts.updateBaseline) {
			saveMutationBaseline(configDir, result.nextBaseline);
			if (mode !== "json") {
				process.stderr.write(
					`\n  ${c.green("✓")} Mutation baseline updated at ${join(".interlinked", "mutation-baseline.json")}\n`,
				);
			}
		}

		const hasErrors = result.findings.some((f) => f.severity === "error");
		if (hasErrors) process.exitCode = 1;
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
	}
}

/** Show current mutation baseline. */
export function mutationBaselineCommand(opts: { cwd?: string; json?: boolean }): void {
	const mode = getOutputMode(opts);
	const cwd = resolve(opts.cwd || process.cwd());
	const configDir = getConfigDir(cwd);
	const path = mutationBaselinePath(configDir);
	const baseline = existsSync(path) ? loadMutationBaseline(configDir) : emptyMutationBaseline();

	output(mode, baseline, {
		json: () => baseline,
		normal: () => {
			const lines: string[] = [];
			lines.push(header("Mutation Baseline"));
			lines.push(kvLine("Updated", baseline.updated_at));
			lines.push(kvLine("Files", String(Object.keys(baseline.files).length)));
			const rows = Object.entries(baseline.files)
				.sort(([, a], [, b]) => a.score - b.score)
				.slice(0, 25);
			if (rows.length === 0) {
				lines.push("");
				lines.push(
					c.dim(
						"  (no baseline yet — run `interlinked mutation check --update-baseline`)",
					),
				);
			} else {
				lines.push("");
				for (const [file, entry] of rows) {
					lines.push(
						`  ${file} ${c.dim(`score=${(entry.score * 100).toFixed(1)}% killed=${entry.killed}`)}`,
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

function clampScore(raw: number): number {
	if (!Number.isFinite(raw)) return 0.6;
	if (raw < 0) return 0;
	if (raw > 1) return 1;
	return raw;
}

interface MutationCheckJson {
	report: string;
	min_score: number;
	findings: MutationFinding[];
	stats: MutationGateResult["stats"];
}

function buildJsonPayload(
	reportPath: string,
	result: MutationGateResult,
	minScore: number,
): MutationCheckJson {
	return {
		report: reportPath,
		min_score: minScore,
		findings: result.findings,
		stats: result.stats,
	};
}

function renderNormal(reportPath: string, result: MutationGateResult, minScore: number): string {
	const lines: string[] = [];
	lines.push(header("Mutation Gate"));
	lines.push(kvLine("Report", reportPath));
	lines.push(kvLine("Min score", `${(minScore * 100).toFixed(0)}%`));
	lines.push(kvLine("Files checked", String(result.stats.files_checked)));
	lines.push(
		kvLine(
			"New / Improved / Below floor / Decreased",
			`${result.stats.files_new} / ${result.stats.files_improved} / ${result.stats.files_below_floor} / ${result.stats.files_decreased}`,
		),
	);
	if (result.findings.length === 0) {
		lines.push("");
		lines.push(c.green("  ✓ No mutation regressions."));
		return lines.join("\n");
	}
	lines.push("");
	const errors = result.findings.filter((f) => f.severity === "error");
	const warnings = result.findings.filter((f) => f.severity === "warning");
	if (errors.length > 0) {
		lines.push(c.red(`  ${errors.length} regression(s):`));
		for (const f of errors) {
			lines.push(
				`    ${c.red("✗")} ${f.file} ${c.dim(`${(f.baseline_score * 100).toFixed(1)}% → ${(f.current_score * 100).toFixed(1)}%`)}`,
			);
		}
	}
	if (warnings.length > 0) {
		lines.push(c.yellow(`  ${warnings.length} below floor:`));
		for (const f of warnings) {
			lines.push(
				`    ${c.yellow("!")} ${f.file} ${c.dim(`${(f.current_score * 100).toFixed(1)}%`)}`,
			);
		}
	}
	lines.push("");
	lines.push(c.dim("  Add tests that kill surviving mutants, or --update-baseline to accept."));
	return lines.join("\n");
}

// ===========================================
// interlinked mutation accept — audited equivalent-mutant annotation
// ===========================================
// The LIVE per-edit gate's block message has always promised "or annotating
// an equivalent mutant"; this is that verb. Operates on the live gate's
// mutation-manifest.json (NOT the report ratchet's mutation-baseline.json):
// flips one named survivor to status "equivalent" with the human judgment of
// WHY no test can kill it recorded in-band, so the accepted floor stays
// auditable. Human-invoked fs write — the sanctioned path past the
// baseline-integrity gate, same carve-out as `interlinked adopt`.

interface MutationAcceptOptions {
	file?: string;
	id?: string;
	reason?: string;
	cwd?: string;
	json?: boolean;
}

export async function mutationAcceptCommand(opts: MutationAcceptOptions): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = resolve(opts.cwd || process.cwd());
	const configDir = getConfigDir(cwd);

	const file = opts.file?.trim() ?? "";
	const mutantId = opts.id?.trim() ?? "";
	const reason = opts.reason ?? "";
	if (file === "" || mutantId === "" || reason.trim() === "") {
		outputError(
			mode,
			"Usage: interlinked mutation accept --file <repo-relative-path> --id <mutantId> --reason <why no test can kill it>. A blank reason is refused — an unauditable floor entry is how ratchets rot.",
		);
		process.exitCode = 1;
		return;
	}

	const { loadManifest, saveManifest } = await import("../harness/mutation/manifest.js");
	const { acceptMutant } = await import("../harness/mutation/accept.js");

	const base = loadManifest(configDir);
	if (!base) {
		outputError(
			mode,
			`No live mutation manifest at ${join(configDir, "mutation-manifest.json")} — the per-edit gate creates it on the first measured run.`,
		);
		process.exitCode = 1;
		return;
	}

	const next = acceptMutant({ base, file, mutantId, reason });
	if (!next) {
		outputError(
			mode,
			`Mutant "${mutantId}" not found under "${file}" in the manifest. List the file's survivors before accepting.`,
		);
		process.exitCode = 1;
		return;
	}

	saveManifest(configDir, next);
	const trimmed = reason.trim();
	output(
		mode,
		{ accepted: { file, mutantId, reason: trimmed } },
		{
			json: () => JSON.stringify({ accepted: { file, mutant_id: mutantId, reason: trimmed } }),
			short: () => `accepted ${mutantId} (${file}) as equivalent`,
			normal: () =>
				[
					header("Mutation — equivalent mutant accepted"),
					kvLine("File", file),
					kvLine("Mutant", mutantId),
					kvLine("Reason", trimmed),
					c.dim("  Recorded in mutation-manifest.json; the gate stops charging this mutant."),
				].join("\n"),
			full: () => "",
		},
	);
}
