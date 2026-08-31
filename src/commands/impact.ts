// ===========================================
// interlinked impact — evidence-classed facts
// ===========================================

import {
	buildImpactEvidence,
	type ImpactEvidenceReport,
	type SimplificationImpactAggregate,
} from "../lib/impact-evidence.js";
import { getOutputMode, output } from "../lib/output.js";

export interface ImpactCommandOptions {
	cwd?: string | undefined;
	base?: string | undefined;
	experimentManifest?: string | undefined;
	json?: boolean;
	short?: boolean;
	full?: boolean;
}

function availabilityLabel(value: string): string {
	return value === "available" ? "recorded" : value;
}

function signed(value: number): string {
	return value > 0 ? `+${value}` : String(value);
}

function aggregateLine(
	label: "potential" | "sandbox-validated",
	aggregate: SimplificationImpactAggregate,
): string {
	const loc = !aggregate.available
		? "LOC delta unavailable"
		: aggregate.loc_delta === null
		? `LOC delta unavailable (${aggregate.loc_unknown_findings} representative(s) unknown)`
		: `LOC delta ${signed(aggregate.loc_delta)}`;
	const dependencies = !aggregate.available
		? "dependency delta unavailable"
		: aggregate.dependencies_removed.length === 0
		? "no dependency removals recorded"
		: `dependencies removed: ${aggregate.dependencies_removed.join(", ")}`;
	return `[${label}:${availabilityLabel(aggregate.availability)}] ${aggregate.representative_findings} representative finding(s), ${loc}; ${dependencies}`;
}

function renderObserved(report: ImpactEvidenceReport): string[] {
	const sources = report.evidence.observed.sources;
	const git = sources.git_worktree;
	const dependencies = sources.dependencies;
	const folds = sources.baseline_folds;
	const activity = sources.activity;
	const findings = sources.findings;
	const manualDebt = sources.manual_debt;
	return [
		`[observed:${availabilityLabel(git.availability)}] git ${report.base}..worktree: ${git.files_changed} tracked file(s), +${git.lines_added}/-${git.lines_removed}; ${git.untracked_files} untracked`,
		`[observed:${availabilityLabel(dependencies.availability)}] dependencies: +${dependencies.added.length}/-${dependencies.removed.length}, ${dependencies.changed.length} version change(s)`,
		`[observed:${availabilityLabel(folds.availability)}] baseline folds: ${folds.events} event(s) across ${Object.keys(folds.by_kind).length} kind(s)`,
		`[observed:${availabilityLabel(activity.availability)}] activity: ${activity.sessions} session(s), ${activity.tool_calls} tool call(s), ${activity.edit_events} edit event(s), +${activity.lines_added}/-${activity.lines_removed} gross lines`,
		`[observed:${availabilityLabel(findings.availability)}] review findings: ${findings.review_findings} total — ${findings.reconciliation.open} open, ${findings.reconciliation.touched} touched, ${findings.reconciliation.acked} acked`,
		`[observed:${availabilityLabel(findings.availability)}] simplification corpus: ${findings.simplification.findings} total — ${findings.simplification.reconciliation.open} open, ${findings.simplification.reconciliation.touched} touched, ${findings.simplification.reconciliation.acked} acked (lifecycle only)`,
		`[observed:${availabilityLabel(manualDebt.availability)}] manual debt: ${manualDebt.snapshot_count} snapshot(s), ${manualDebt.current_markers} current marker(s), ${manualDebt.transitions.opened} opened/${manualDebt.transitions.changed} changed/${manualDebt.transitions.closed} closed`,
	];
}

function receiptLine(report: ImpactEvidenceReport): string {
	const receipts = report.simplification_receipts;
	return `[receipts:${availabilityLabel(receipts.availability)}] ${receipts.run_count} valid run(s), ${receipts.finding_observations} finding observation(s), ${receipts.latest_finding_count} latest finding(s), ${receipts.malformed_receipts} malformed row(s)`;
}

function availableCausalLine(report: ImpactEvidenceReport): string {
	const causal = report.evidence.causal;
	const regressions = causal.safety?.protected_behavior_regressions ?? "unknown";
	const scored = causal.completeness?.scored_runs ?? "unknown";
	const planned = causal.completeness?.planned_runs ?? "unknown";
	return `[causal:available] ${causal.experiment_id}: ${causal.claim_statement}; artifacts verified, ${regressions} protected-behavior regression(s), ${scored}/${planned} run(s) scored`;
}

function causalLine(report: ImpactEvidenceReport): string {
	const causal = report.evidence.causal;
	return causal.available
		? availableCausalLine(report)
		: `[causal:${availabilityLabel(causal.availability)}] ${causal.note}`;
}

function renderNormal(report: ImpactEvidenceReport): string {
	return [
		"Impact evidence",
		report.claim_boundary,
		"",
		receiptLine(report),
		aggregateLine("potential", report.evidence.potential),
		aggregateLine("sandbox-validated", report.evidence.sandbox_validated),
		causalLine(report),
		"",
		...renderObserved(report),
	].join("\n");
}

function renderFull(report: ImpactEvidenceReport): string {
	const sources = report.evidence.observed.sources;
	return [
		renderNormal(report),
		"",
		`Simplification receipt path: ${report.simplification_receipts.path}`,
		`Simplification run scopes: ${JSON.stringify(report.simplification_receipts.scopes)}`,
		`Potential scope: ${report.evidence.potential.scope}`,
		`Sandbox-validated scope: ${report.evidence.sandbox_validated.scope}`,
		`Causal scope: ${report.evidence.causal.scope}`,
		`Git scope: ${sources.git_worktree.scope}`,
		`Dependency scope: ${sources.dependencies.scope}`,
		`Baseline fold scope: ${sources.baseline_folds.scope}`,
		`Activity scope: ${sources.activity.scope}`,
		`Finding scope: ${sources.findings.scope}`,
		`Manual debt scope: ${sources.manual_debt.scope}`,
		`Manual debt latest source scope: ${JSON.stringify(sources.manual_debt.latest_scope)}`,
		`Baseline fold kinds: ${JSON.stringify(sources.baseline_folds.by_kind)}`,
		`Finding lifecycle: ${JSON.stringify(sources.findings.lifecycle)}`,
	].join("\n");
}

function renderError(opts: ImpactCommandOptions, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	if (opts.json === true) {
		console.log(JSON.stringify({ schema_version: 1, error: message }, null, 2));
		return;
	}
	process.stderr.write(`Impact evidence unavailable: ${message}\n`);
}

export async function impactCommand(opts: ImpactCommandOptions): Promise<number> {
	try {
		const report = buildImpactEvidence(opts.cwd ?? process.cwd(), {
			base: opts.base ?? "HEAD",
			...(opts.experimentManifest ? { experimentManifest: opts.experimentManifest } : {}),
		});
		output(getOutputMode(opts), report, {
			json: () => report,
			short: () => [
				receiptLine(report),
				aggregateLine("potential", report.evidence.potential),
				aggregateLine("sandbox-validated", report.evidence.sandbox_validated),
				causalLine(report),
				...renderObserved(report),
			].join(" · "),
			normal: () => renderNormal(report),
			full: () => renderFull(report),
		});
		return 0;
	} catch (error) {
		renderError(opts, error);
		return 1;
	}
}
