// ===========================================
// interlinked mutation sweep — work the survivor list, one file at a time
// ===========================================
// `mutation survivors` says WHAT to measure; this drives it. The sweep walks a
// ranked slice of the work-list through the same single-file pipeline
// `mutation measure` uses (`measureOneFile`), recording each clean result into
// the manifest the per-edit gate enforces against.
//
// Sequential on purpose: a runner box holds ONE worktree and answers 503 while
// busy, so a parallel sweep against one endpoint would spend its budget being
// refused. Parallelism belongs BETWEEN machines — `--shard i/n` deals the list
// so each box sweeps a disjoint slice, and the ranked order is deterministic,
// so no coordinator is needed to keep them from colliding.

import { resolve } from "node:path";
import { summarizeSurvivors } from "../harness/mutation/survivors.js";
import { getConfigDir } from "../lib/config.js";
import { c, header } from "../lib/formatter.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import type { MeasureOneResult } from "./mutation-measure-support.js";
import { measureOneFile } from "./mutation-measure-support.js";
import { parseShard, type Shard, shardOf } from "./mutation-survivors.js";

export interface MutationSweepOptions {
	file?: string;
	limit?: string;
	shard?: string;
	/** Repeatable: one entry per runner. Each becomes a worker lane. */
	runnerUrl?: string[];
	budgetMs?: string;
	skipPreflight?: boolean;
	unqualifiedOnly?: boolean;
	dryRun?: boolean;
	cwd?: string;
	json?: boolean;
	short?: boolean;
}

/** One file to measure, with the debt that put it on the list. */
export interface SweepTarget {
	file: string;
	open: number;
	uncovered: number;
	/** True when the file's records already carry measurement provenance — it
	 *  has been measured under the current regime, so a re-sweep would re-pay
	 *  for an answer already held. */
	qualified: boolean;
}

/**
 * Drop files already measured under the current regime.
 *
 * This is what makes a long sweep restartable. A full-repo sweep runs for
 * hours; if it is interrupted, every file it already finished still has open
 * survivors (that is normal — real debt survives re-measurement), so the plain
 * work-list would hand them back and the restart would redo hours of work.
 * Provenance is the difference between "still has survivors" and "not yet
 * asked".
 */
export function unqualifiedOnly(targets: readonly SweepTarget[]): SweepTarget[] {
	return targets.filter((t) => !t.qualified);
}

export interface SweepSelection {
	limit?: number | undefined;
	shard?: Shard | undefined;
	/** Skip files that already carry provenance (restart-friendly). */
	unqualifiedOnly?: boolean | undefined;
}

/**
 * Pick this machine's slice of the ranked work-list.
 *
 * Shard BEFORE limit, deliberately: `--shard 2/2 --limit 10` must mean "this
 * machine measures ten files", not "take ten files, then throw half of them
 * away" — the latter halves the fleet's throughput while looking identical in
 * the output.
 */
export function selectSweepTargets(targets: readonly SweepTarget[], selection: SweepSelection): SweepTarget[] {
	const pool = selection.unqualifiedOnly === true ? unqualifiedOnly(targets) : targets;
	const sharded = selection.shard ? shardOf(pool, selection.shard) : [...pool];
	const limit = selection.limit;
	return limit !== undefined && limit > 0 ? sharded.slice(0, limit) : sharded;
}

export interface SweepSummary {
	files: number;
	measured: number;
	busy: number;
	notMeasurable: number;
	errors: number;
	/** Survivor counts before/after, summed over files that actually recorded. */
	survivorsBefore: number;
	survivorsAfter: number;
}

/**
 * `busy` and `not_measurable` are NOT errors and not successes.
 *
 * A contended runner never attempted the file, and "no test exercises this
 * file" is a definitive verdict about the repo rather than a failed sweep.
 * Folding either into `errors` would make a loaded fleet look broken; folding
 * either into `measured` would let unmeasured files count as swept.
 */
export function summarizeSweep(results: readonly MeasureOneResult[]): SweepSummary {
	const summary: SweepSummary = {
		files: results.length,
		measured: 0,
		busy: 0,
		notMeasurable: 0,
		errors: 0,
		survivorsBefore: 0,
		survivorsAfter: 0,
	};
	for (const r of results) {
		if (r.status === "measured") summary.measured += 1;
		else if (r.status === "busy") summary.busy += 1;
		else if (r.status === "not_measurable") summary.notMeasurable += 1;
		else summary.errors += 1;
		const record = r.record;
		if (record?.before && record.after) {
			summary.survivorsBefore += record.before.survivors;
			summary.survivorsAfter += record.after.survivors;
		}
	}
	return summary;
}

function movement(result: MeasureOneResult): string {
	const record = result.record;
	if (record?.before && record.after) {
		return `${record.before.survivors} → ${record.after.survivors} survivors`;
	}
	return `${result.survivors} survivor(s) of ${result.mutants}`;
}

/** One line per file, written as the sweep goes — a multi-hour run that prints
 *  only at the end is indistinguishable from a hung one. */
export function renderSweepLine(result: MeasureOneResult): string {
	if (result.status === "measured") return `  ${c.green("✓")} ${result.file}  ${movement(result)}`;
	if (result.status === "busy") return `  ${c.yellow("·")} ${result.file}  runner busy — not measured`;
	if (result.status === "not_measurable") {
		return `  ${c.yellow("·")} ${result.file}  not measurable (${result.reason ?? "unknown"})`;
	}
	return `  ${c.red("✗")} ${result.file}  ${result.status}: ${result.reason ?? "unknown"}`;
}

export function renderSweepSummary(summary: SweepSummary, selection: SweepSelection): string {
	const shard = selection.shard ? ` (shard ${selection.shard.index + 1}/${selection.shard.count})` : "";
	const lines = [
		"",
		c.bold(`  Swept ${summary.files} file(s)${shard}`),
		`  ${summary.measured} measured · ${summary.busy} busy · ${summary.notMeasurable} not measurable · ${summary.errors} failed`,
	];
	if (summary.measured === 0) {
		lines.push(c.yellow("  0 measured — nothing in this sweep reached the manifest."));
		return lines.join("\n");
	}
	const delta = summary.survivorsBefore - summary.survivorsAfter;
	lines.push(`  survivors ${summary.survivorsBefore} → ${summary.survivorsAfter} (${delta >= 0 ? "-" : "+"}${Math.abs(delta)})`);
	return lines.join("\n");
}

/** The manifest's open-survivor files, ranked, excluding deleted paths — the
 *  same ordering `mutation survivors` prints, so the two never disagree. */
async function loadTargets(cwd: string, configDir: string, fileFilter: string | undefined): Promise<SweepTarget[] | null> {
	const { loadManifest } = await import("../harness/mutation/manifest.js");
	const { existsSync } = await import("node:fs");
	const manifest = loadManifest(configDir);
	if (!manifest) return null;
	const summary = summarizeSurvivors(manifest, {
		file: fileFilter,
		exists: (file: string) => existsSync(resolve(cwd, file)),
	});
	return summary.files
		.filter((f) => f.open > 0 && !f.stale)
		.map((f) => ({ file: f.file, open: f.open, uncovered: f.uncovered, qualified: f.provenance !== null }));
}

/**
 * The runners this sweep may use, one worker lane each.
 *
 * An explicit `--runner-url` (repeatable, or comma-separated) wins; otherwise
 * the repo's configured endpoints. Order is preserved so lane 1 is always the
 * same machine across runs, which keeps a progress log comparable.
 */
async function resolveSweepEndpoints(opts: MutationSweepOptions, cwd: string): Promise<string[]> {
	const explicit = (opts.runnerUrl ?? [])
		.flatMap((entry) => entry.split(","))
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
	if (explicit.length > 0) return explicit;
	const { configuredRunnerEndpoints, readDiskSafe } = await import("../harness/mutation/measure.js");
	return configuredRunnerEndpoints(cwd, readDiskSafe).endpoints;
}

function parseSelection(opts: MutationSweepOptions): SweepSelection | { error: string } {
	const shard = opts.shard ? parseShard(opts.shard) : undefined;
	if (opts.shard && !shard) {
		return { error: `--shard must be "i/n" with 1 <= i <= n (e.g. --shard 1/2). Got "${opts.shard}".` };
	}
	const parsed = Number.parseInt(opts.limit ?? "", 10);
	const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
	return {
		...(shard ? { shard } : {}),
		...(limit !== undefined ? { limit } : {}),
		...(opts.unqualifiedOnly === true ? { unqualifiedOnly: true } : {}),
	};
}

/**
 * Run `items` across `lanes` concurrent workers that PULL from one shared queue.
 *
 * Pull, not partition. A pre-assigned split finishes as slowly as its unluckiest
 * half: mutation runs vary from 25s to 500s per file, so any static division
 * leaves one worker idle while the other still has a queue. A worker that takes
 * the next unclaimed index whenever it frees up needs no coordinator, no
 * rebalancing, and no knowledge of how long anything takes.
 *
 * This is the same shape a cloud fan-out has — N sandboxes pulling from one
 * work list — so the two-machine case is the N=2 test of the real thing rather
 * than a special case that gets thrown away later.
 *
 * Results keep the INPUT order regardless of completion order, so a caller can
 * still pair result[i] with items[i].
 */
export async function runPool<T, R>(
	items: readonly T[],
	lanes: number,
	work: (item: T, lane: number, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const claim = (): number => next++;
	const worker = async (lane: number): Promise<void> => {
		for (let i = claim(); i < items.length; i = claim()) {
			// SAFETY: `i < items.length` is the loop guard, so the index is in range.
			results[i] = await work(items[i] as T, lane, i);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(lanes, items.length)) }, (_, l) => worker(l)));
	return results;
}

interface SweepRunArgs {
	targets: SweepTarget[];
	cwd: string;
	configDir: string;
	opts: MutationSweepOptions;
	quiet: boolean;
	measureOne: typeof measureOneFile;
	/** One entry per worker lane. A lane PREFERS its own endpoint so two lanes
	 *  do not contend for one single-slot runner, but carries the others as
	 *  fallbacks — see {@link laneEndpoints}. */
	endpoints: string[];
}

async function runSweep(args: SweepRunArgs): Promise<MeasureOneResult[]> {
	const budgetMs = args.opts.budgetMs ? Number.parseInt(args.opts.budgetMs, 10) : undefined;
	let done = 0;
	return runPool(args.targets, args.endpoints.length, async (target, lane) => {
		const result = await args.measureOne({
			file: target.file,
			cwd: args.cwd,
			configDir: args.configDir,
			// A sweep that does not record is a sweep that changes nothing: the
			// point is to move the manifest the per-edit gate reads.
			record: true,
			surface: "sweep",
			skipPreflight: args.opts.skipPreflight,
			// Own endpoint first, the rest as fallbacks: a lane whose runner has
			// disconnected keeps working instead of stalling on it.
			runnerUrls: laneEndpoints(args.endpoints, lane),
			budgetMs,
			quiet: true,
		});
		done += 1;
		if (!args.quiet) {
			process.stderr.write(`${renderSweepLine(result)}${laneTag(args.endpoints, lane, done, args.targets.length)}\n`);
		}
		return result;
	});
}

/**
 * This lane's endpoint list: its own first, then every other as a fallback.
 *
 * Pinning a lane to exactly one runner was the obvious design and the wrong
 * one: when a runner goes away — a closed laptop, a dropped VPN — its lane kept
 * posting into the void for its whole per-file budget while a perfectly healthy
 * runner sat idle beside it. Preference preserves the anti-contention property
 * (two lanes never open with the same runner), and the fallbacks mean a lost
 * machine costs one retry round per file instead of the entire budget.
 */
export function laneEndpoints(endpoints: readonly string[], lane: number): string[] {
	if (endpoints.length <= 1) return [...endpoints];
	return [...endpoints.slice(lane), ...endpoints.slice(0, lane)];
}

/** Which runner did this, and how far along the queue is — only worth printing
 *  when more than one lane is running, since with one lane it is noise. */
function laneTag(endpoints: string[], lane: number, done: number, total: number): string {
	if (endpoints.length < 2) return "";
	return c.dim(`   [runner ${lane + 1}/${endpoints.length} · ${done}/${total}]`);
}

export async function mutationSweepCommand(
	opts: MutationSweepOptions,
	measureOne: typeof measureOneFile = measureOneFile,
): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = resolve(opts.cwd || process.cwd());
	const configDir = getConfigDir(cwd);

	const selection = parseSelection(opts);
	if ("error" in selection) {
		outputError(mode, selection.error);
		process.exitCode = 1;
		return;
	}

	const all = await loadTargets(cwd, configDir, opts.file);
	if (all === null) {
		outputError(mode, "No mutation manifest — measure a file first: `interlinked mutation measure <file> --record`.");
		process.exitCode = 1;
		return;
	}
	const targets = selectSweepTargets(all, selection);

	if (opts.dryRun) {
		const payload = { dryRun: true, selected: targets, total: all.length };
		output(mode, payload, {
			json: () => payload,
			normal: () =>
				[
					header("Mutation sweep — dry run"),
					`  ${targets.length} of ${all.length} file(s) selected`,
					...targets.map((t) => `   ${String(t.open).padStart(4)} open  ${t.file}`),
				].join("\n"),
		});
		return;
	}

	const endpoints = await resolveSweepEndpoints(opts, cwd);
	if (endpoints.length === 0) {
		outputError(
			mode,
			"No mutation runner configured. Pass --runner-url <url> (repeatable), or set per_edit_mutation.runner_url / .runner_urls in .interlinked/guard-rules.local.json.",
		);
		process.exitCode = 1;
		return;
	}
	if (mode !== "json") {
		process.stderr.write(
			`sweeping ${targets.length} of ${all.length} file(s) across ${endpoints.length} runner(s)…\n`,
		);
	}
	const results = await runSweep({
		targets,
		cwd,
		configDir,
		opts,
		quiet: mode === "json",
		measureOne,
		endpoints,
	});
	const summary = summarizeSweep(results);
	const payload = { summary, results };

	output(mode, payload, {
		json: () => payload,
		short: () => `${summary.measured}/${summary.files} measured, survivors ${summary.survivorsBefore} → ${summary.survivorsAfter}`,
		normal: () => renderSweepSummary(summary, selection),
	});

	// A sweep that measured nothing, or that hit a hard failure, must not exit 0
	// — a CI or cron caller would read silence as progress.
	if (summary.errors > 0 || (summary.files > 0 && summary.measured === 0)) process.exitCode = 1;
}
