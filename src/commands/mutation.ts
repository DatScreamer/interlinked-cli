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
import {
	maybeRecordMeasurement,
	preflightScopedSuite,
	renderMeasureCommand,
	testScopeNote,
} from "./mutation-measure-support.js";
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
// interlinked mutation accept — no longer a write path (plan 16 §7)
// ===========================================
// This verb used to flip a named survivor in the LIVE gate's
// mutation-manifest.json to status "equivalent", carrying the human's prose as
// the WHY. Typed dispositions ended that: `acceptMutant` now admits only a
// `proved_equivalent` disposition whose method carries its own mechanism and
// whose certificate binds to the mutant's current symbol hash, environment and
// dependency-graph version. Prose satisfies none of that, and a certificate this
// command minted for itself would be self-certifying — so the command validates
// the target and then explains the refusal instead of writing anything. It stays
// wired because the gate's block message points here: the answer a human needs
// is "kill it, or fix the code", and that is what it now says.

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
			"Usage: interlinked mutation accept --file <repo-relative-path> --id <mutantId> --reason <why no test can kill it>. State the reason first — writing it down is usually where an 'equivalent' turns out to be a missing test or dead code.",
		);
		process.exitCode = 1;
		return;
	}

	const { loadManifest } = await import("../harness/mutation/manifest.js");
	const { findMutantRecord } = await import("../harness/mutation/accept.js");

	const base = loadManifest(configDir);
	if (!base) {
		outputError(
			mode,
			`No live mutation manifest at ${join(configDir, "mutation-manifest.json")} — the per-edit gate creates it on the first measured run.`,
		);
		process.exitCode = 1;
		return;
	}

	if (!findMutantRecord(base, file, mutantId)) {
		outputError(
			mode,
			`Mutant "${mutantId}" not found under "${file}" in the manifest. List the file's survivors before accepting.`,
		);
		process.exitCode = 1;
		return;
	}

	// The mutant exists — and the manifest still does not change. Since plan 16 §7
	// (typed dispositions) a mutant reaches status "equivalent" only through a
	// `proved_equivalent` disposition whose method carries its own mechanism and
	// whose certificate binds to this mutant's current symbol hash. A reason
	// string is not a mechanism, and a certificate this command minted for itself
	// would prove nothing — so there is deliberately no prose path left.
	outputError(
		mode,
		`Refused: a reason is not a mechanism. "${mutantId}" (${file}) stays a survivor. Since typed dispositions (plan 16 §7) the manifest only records an equivalence from a verifier-issued certificate bound to the mutant's current symbol hash; this command cannot mint one. Kill the mutant with a test, or fix/delete the code if the mutant is unkillable because the code should not exist.`,
	);
	process.exitCode = 1;
}

// ===========================================
// interlinked mutation measure — out-of-band single-file measurement,
// with an explicit --record path into the SAME manifest the per-edit gate
// enforces against (docs/design/per-edit-cloud-mutation-testing.md).
// ===========================================
// Closes the campaign feedback-loop gap: re-measuring a file after hardening
// used to mean running `scratch/measure-file.mts`, which prints survivors and
// writes nothing — so hardening work never reached the manifest the ratchet
// reads. This command is the first-class replacement. Measuring is always
// safe (read-only); recording is opt-in via `--record` and goes ONLY through
// `recordMeasurement` (harness/mutation/measure.ts), which itself goes ONLY
// through `seedFileBaseline` / `applyMeasuredRun` — never a hand-built
// manifest record. See measure.ts's module docstring for why this path talks
// to exactly one runner endpoint per attempt (no sharding, no partial writes).

export interface MutationMeasureOptions {
	record?: boolean;
	runnerUrl?: string;
	budgetMs?: string;
	cwd?: string;
	json?: boolean;
	/** Skip the local green-suite pre-flight. For repos where the local test
	 *  runner cannot run the scoped suite at all — NOT a way to measure past a
	 *  known-failing suite, which produces a meaningless score. */
	skipPreflight?: boolean;
}

// Render + record helpers live in mutation-measure-support.ts (extracted to
// stay under the per-file line cap; no behavior change).

export async function mutationMeasureCommand(file: string, opts: MutationMeasureOptions): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = resolve(opts.cwd || process.cwd());
	const configDir = getConfigDir(cwd);

	const { buildScopedMeasureOverlays, configuredRunnerEndpoints, measureFile, readDiskSafe } = await import(
		"../harness/mutation/measure.js"
	);
	const { normalizeManifestKey } = await import("../harness/mutation/manifest.js");

	const key = normalizeManifestKey(file, cwd);
	const content = readDiskSafe(resolve(cwd, key));
	if (content === null) {
		outputError(mode, `Cannot read "${key}" (resolved from "${file}").`);
		process.exitCode = 1;
		return;
	}

	const endpointCfg = opts.runnerUrl
		? { endpoints: [opts.runnerUrl] }
		: configuredRunnerEndpoints(cwd, readDiskSafe);
	if (endpointCfg.endpoints.length === 0) {
		outputError(
			mode,
			"No mutation runner configured. Pass --runner-url <url>, or set per_edit_mutation.runner_url (or .runner_urls) in .interlinked/guard-rules.local.json.",
		);
		process.exitCode = 1;
		return;
	}

	// Reverse-import-graph test selection (test-scope.ts), not the runner's own
	// filename-glob guess — a hub file's real tests often aren't named after it.
	// Computed BEFORE the overlay set so the overlay set can ship a COMPLETE
	// CLOSURE over the selected scope: every test file the runner will load,
	// plus their transitive deps, must travel as overlay content — the
	// runner's worktree resets to HEAD before each run, so anything not
	// overlaid comes from the runner's own (possibly stale) commit.
	const { computeMutationTestScopeForRepo } = await import("../harness/mutation/test-scope.js");
	const scope = computeMutationTestScopeForRepo({ editedRelPath: key, projectRoot: cwd });

	const scopeTests = scope.tests ?? [];
	const scoped = buildScopedMeasureOverlays(key, content, (p) => readDiskSafe(resolve(cwd, p)), scopeTests);
	const overlays = scoped.overlays;

	if (mode !== "json") {
		process.stderr.write(
			`measuring ${key} (${overlays.length} overlay(s)) via ${endpointCfg.endpoints.length} runner(s)…\n${testScopeNote(scope)}`,
		);
		if (scoped.unreadable.length > 0) {
			process.stderr.write(
				`WARNING: ${scoped.unreadable.length} file(s) in the closure could not be read and are MISSING from the overlay set: ${scoped.unreadable.join(", ")}\n`,
			);
		}
		if (scoped.capped) {
			process.stderr.write(
				`WARNING: overlay closure had ${scoped.capped.candidateCount} candidates, capped to ${scoped.capped.limit}; dropped ${scoped.capped.dropped.length} dependency file(s): ${scoped.capped.dropped.join(", ")}\n`,
			);
		}
	}

	// Pre-flight: a mutation run against a RED suite reports every mutant it
	// touches as KILLED, so the score is a forged pass — see baseline-suite.ts's
	// docstring for the measured incident (~155 mutants falsely killed). The
	// probe costs seconds against a run that costs minutes, and unlike the
	// engine's own dry run it names the failing tests.
	const redSuite = opts.skipPreflight
		? null
		: await preflightScopedSuite({ tests: scopeTests, cwd, quiet: mode === "json" });
	if (redSuite !== null) {
		outputError(mode, redSuite);
		process.exitCode = 1;
		return;
	}

	const budgetMs = opts.budgetMs ? Number.parseInt(opts.budgetMs, 10) : undefined;
	const outcome = await measureFile({
		file: key,
		content,
		overlays,
		endpoints: endpointCfg.endpoints,
		fetchImpl: (url, init) => fetch(url, init),
		...(endpointCfg.token !== undefined ? { token: endpointCfg.token } : {}),
		...(budgetMs !== undefined && Number.isFinite(budgetMs) ? { deadlineMs: budgetMs } : {}),
		...(scope.tests ? { testScope: scope.tests } : {}),
	});

	const record = await maybeRecordMeasurement({ record: opts.record, outcome, configDir, key, content, cwd });

	const payload = {
		file: key,
		status: outcome.status,
		reason: outcome.reason,
		mutants: outcome.mutantCount,
		survivors: outcome.survivorCount,
		survivorList: outcome.survivors,
		record,
	};

	output(mode, payload, {
		json: () => payload,
		normal: () => renderMeasureCommand(key, outcome, record),
	});

	// "busy" is nonzero too (a sweep script must not treat it as success), but
	// stays a DISTINCT status in the payload/render above — never coerced into
	// "error" or "not_measurable" text a caller might grep for.
	if (outcome.status === "error" || outcome.status === "busy") process.exitCode = 1;
}
