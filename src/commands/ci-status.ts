// `interlinked ci-status` — surface CI failure-rate patterns from GitHub Actions.
//
// Pain point: "this step has failed 7 of the last 10 pushes" is exactly
// the signal you want before you push. Without it, you push, CI fails on
// the same step it failed on yesterday, and you didn't know.
//
// Implementation: shell out to `gh run list --json ...`, aggregate by
// workflow, surface failure rates. The fetcher is injectable so tests
// can stub the gh subprocess without touching the network.

import { execFileSync } from "node:child_process";
import type { Command } from "commander";
import { c } from "../lib/formatter.js";
import type { JsonObject } from "../lib/json-types.js";
import { getOutputMode, output } from "../lib/output.js";

export interface CiRun {
	databaseId: number;
	workflowName: string;
	status: string;
	conclusion: string | null;
	name: string;
	headBranch?: string;
	createdAt: string;
	url?: string;
}

export interface CiStatusFetcher {
	available(): boolean;
	listRuns(opts: { limit: number; branch?: string | undefined }): CiRun[];
}

const RUNS_FIELDS = [
	"databaseId",
	"workflowName",
	"status",
	"conclusion",
	"name",
	"headBranch",
	"createdAt",
	"url",
] as const;

export class GhCliFetcher implements CiStatusFetcher {
	available(): boolean {
		try {
			execFileSync("gh", ["--version"], { stdio: "ignore", timeout: 3000 });
			return true;
		} catch {
			return false;
		}
	}

	listRuns(opts: { limit: number; branch?: string | undefined }): CiRun[] {
		const args = [
			"run",
			"list",
			"--json",
			RUNS_FIELDS.join(","),
			"--limit",
			String(opts.limit),
		];
		if (opts.branch) {
			args.push("--branch", opts.branch);
		}
		try {
			const raw = execFileSync("gh", args, {
				encoding: "utf-8",
				timeout: 15_000,
			});
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			return parsed.filter(isCiRun);
		} catch {
			return [];
		}
	}
}

function isCiRun(value: unknown): value is CiRun {
	if (!value || typeof value !== "object") return false;
	const v = value as JsonObject;
	return (
		typeof v.databaseId === "number" &&
		typeof v.workflowName === "string" &&
		typeof v.status === "string" &&
		typeof v.name === "string" &&
		typeof v.createdAt === "string"
	);
}

export interface WorkflowStats {
	workflowName: string;
	total: number;
	failures: number;
	failureRate: number;
}

export interface CiAggregation {
	total: number;
	completed: number;
	failures: number;
	byWorkflow: WorkflowStats[];
	recentFailures: CiRun[];
}

const FAILED_CONCLUSIONS = new Set([
	"failure",
	"cancelled",
	"timed_out",
	"action_required",
]);

const RECENT_FAILURES_LIMIT = 5;

export function aggregateRuns(runs: CiRun[]): CiAggregation {
	const completed = runs.filter((r) => r.status === "completed");
	const failures = completed.filter(
		(r) => r.conclusion !== null && FAILED_CONCLUSIONS.has(r.conclusion),
	);

	const groups = new Map<string, { total: number; failures: number }>();
	for (const r of completed) {
		const g = groups.get(r.workflowName) || { total: 0, failures: 0 };
		g.total += 1;
		if (r.conclusion !== null && FAILED_CONCLUSIONS.has(r.conclusion)) {
			g.failures += 1;
		}
		groups.set(r.workflowName, g);
	}

	const byWorkflow: WorkflowStats[] = Array.from(groups.entries())
		.map(([workflowName, { total, failures: f }]) => ({
			workflowName,
			total,
			failures: f,
			failureRate: total === 0 ? 0 : f / total,
		}))
		.sort((a, b) => b.failureRate - a.failureRate || b.failures - a.failures);

	const recentFailures = failures
		.slice()
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
		.slice(0, RECENT_FAILURES_LIMIT);

	return {
		total: runs.length,
		completed: completed.length,
		failures: failures.length,
		byWorkflow,
		recentFailures,
	};
}

interface CiStatusOptions {
	limit?: number;
	branch?: string;
	json?: boolean;
	short?: boolean;
	full?: boolean;
}

const MIN_LIMIT = 1;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 30;

export async function ciStatusCommand(
	opts: CiStatusOptions,
	fetcher: CiStatusFetcher = new GhCliFetcher(),
): Promise<void> {
	const mode = getOutputMode(opts);
	const limit = Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, opts.limit ?? DEFAULT_LIMIT));

	if (!fetcher.available()) {
		output(mode, { error: "gh CLI not available" }, {
			json: () => ({ error: "gh CLI not available" }),
			short: () => "gh: not installed",
			normal: () =>
				`${c.red("gh CLI not found.")} Install GitHub CLI (https://cli.github.com) and run \`gh auth login\`.`,
		});
		process.exitCode = 1;
		return;
	}

	const runs = fetcher.listRuns({ limit, branch: opts.branch });
	const agg = aggregateRuns(runs);

	output(mode, agg, {
		json: () => agg,
		short: () => formatShort(agg),
		normal: () => formatNormal(agg, limit, opts.branch),
		full: () => formatFull(agg, runs, limit, opts.branch),
	});
}

function formatShort(agg: CiAggregation): string {
	if (agg.completed === 0) return "no completed runs";
	const top = agg.byWorkflow[0];
	if (!top || top.failures === 0) {
		return `${agg.completed} runs, all green`;
	}
	return `${top.workflowName}: ${top.failures}/${top.total} failed`;
}

function formatNormal(agg: CiAggregation, limit: number, branch: string | undefined): string {
	const lines: string[] = [];
	const scope = branch ? `branch ${branch}` : "all branches";
	lines.push(c.bold(`GitHub Actions — last ${limit} runs (${scope})`));

	if (agg.completed === 0) {
		lines.push("No completed runs found.");
		return lines.join("\n");
	}

	lines.push("");
	lines.push(c.bold("Failure rate by workflow:"));
	for (const w of agg.byWorkflow) {
		const pct = (w.failureRate * 100).toFixed(0);
		const summary =
			w.failures === 0
				? c.green(" ok")
				: c.red(` ${w.failures}/${w.total} fail (${pct}%)`);
		lines.push(`  ${w.workflowName.padEnd(28)}${summary}`);
	}

	if (agg.recentFailures.length > 0) {
		lines.push("");
		lines.push(c.bold("Recent failures:"));
		for (const r of agg.recentFailures) {
			const when = r.createdAt.slice(0, 16).replace("T", " ");
			lines.push(`  ${when}  ${r.workflowName} — ${r.name.slice(0, 60)}`);
		}
	}

	return lines.join("\n");
}

function formatFull(
	agg: CiAggregation,
	runs: CiRun[],
	limit: number,
	branch: string | undefined,
): string {
	const lines: string[] = [formatNormal(agg, limit, branch), ""];
	lines.push(c.bold("All runs:"));
	for (const r of runs) {
		const when = r.createdAt.slice(0, 16).replace("T", " ");
		const status = r.status === "completed" ? r.conclusion ?? "?" : r.status;
		const colored =
			r.conclusion === "success"
				? c.green(status)
				: r.conclusion !== null && FAILED_CONCLUSIONS.has(r.conclusion)
					? c.red(status)
					: status;
		lines.push(
			`  ${when}  ${r.workflowName.padEnd(20)}  ${colored.padEnd(12)}  ${r.name.slice(0, 60)}`,
		);
	}
	return lines.join("\n");
}

export function registerCiCommand(program: Command): void {
	program
		.command("ci-status")
		.description("Surface CI failure-rate patterns from GitHub Actions (uses gh CLI)")
		.option("--limit <n>", "Number of recent runs to fetch (default 30, max 100)", (v) =>
			Number.parseInt(v, 10),
		)
		.option("--branch <name>", "Restrict to a specific branch (default: all branches)")
		.option("--json", "Output JSON")
		.option("--short", "One-line summary")
		.option("--full", "Show every run, not just failures")
		.action(async (opts: CiStatusOptions) => {
			await ciStatusCommand(opts);
		});
}
