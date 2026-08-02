// ===========================================
// `interlinked harness latency` — read latency.jsonl, surface percentiles
// ===========================================
// Reads the daemon-emitted `.interlinked/logs/latency.jsonl` (see
// `src/harness/latency-log.ts`), aggregates hook-decision records, and
// prints per-event-class p50/p90/p99 plus the top-N slowest sessions.
//
// Companion to Task #10. Output mirrors the shape proposed in
// docs/plans/free-cli-adoption/_phase1-phase-matrix.md §"Telemetry hook".

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface ToolBreakdownRecord {
	tool: string;
	ms: number;
	finding_count: number;
}

interface LatencyRecord {
	schema?: string;
	kind?: string;
	ts?: string;
	hook_event?: string | null;
	tool_name?: string | null;
	session_id?: string | null;
	agent_source?: string | null;
	decision?: string;
	checks_ran?: string[] | null;
	checks_timing_ms?: number | null;
	tool_breakdown?: ToolBreakdownRecord[] | null;
}

export interface LatencyPercentiles {
	timing_count: number;
	p50: number | null;
	p90: number | null;
	p99: number | null;
	max: number | null;
}

export interface SlowestSession {
	session_id: string;
	max_timing_ms: number;
	event_count: number;
}

/** Per-tool stats (when --by-tool is requested). The `when_present` numbers
 *  are the percentiles of `checks_timing_ms` across events where this tool
 *  appeared in `checks_ran` — an approximation of per-tool contribution
 *  until Phase A.7 lands real per-tool elapsed times. The `events` count is
 *  exact. */
export interface ByToolStats {
	tool: string;
	events: number;
	when_present: LatencyPercentiles;
}

export interface LatencyReport {
	total_events: number;
	by_hook_event: Record<string, number>;
	post_tool_use: LatencyPercentiles;
	slowest_sessions: SlowestSession[];
	/** Populated only when `compute_by_tool: true`. */
	by_tool?: ByToolStats[];
}

interface ComputeLatencyOptions {
	log_path?: string;
	top_sessions?: number;
	/** Compute per-tool occurrence + when-present percentiles. Default false
	 *  to keep the basic report cheap — `--by-tool` flips it on. */
	compute_by_tool?: boolean;
}

const DEFAULT_TOP_SESSIONS = 10;

export function computeLatencyReport(
	cwd: string,
	opts: ComputeLatencyOptions = {},
): LatencyReport {
	const path = opts.log_path ?? join(cwd, ".interlinked", "logs", "latency.jsonl");
	const topN = opts.top_sessions ?? DEFAULT_TOP_SESSIONS;
	const empty: LatencyReport = {
		total_events: 0,
		by_hook_event: {},
		post_tool_use: { timing_count: 0, p50: null, p90: null, p99: null, max: null },
		slowest_sessions: [],
	};
	if (!existsSync(path)) return empty;

	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (e) {
		// fs error reading the log — return empty rather than crashing
		// `interlinked harness latency`. The user gets `Total events: 0`
		// which is correct for a missing/unreadable log.
		void e;
		return empty;
	}

	const records: LatencyRecord[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			records.push(JSON.parse(trimmed) as LatencyRecord);
		} catch (e) {
			// Malformed line — skip silently. Latency log is append-only and
			// occasionally contains a partial trailing line if the daemon was
			// killed mid-write; we should not crash the report on it.
			void e;
		}
	}

	const byHookEvent: Record<string, number> = {};
	const postTimings: number[] = [];
	const sessionMax = new Map<string, { max: number; count: number }>();

	for (const r of records) {
		const evt = r.hook_event ?? "unknown";
		byHookEvent[evt] = (byHookEvent[evt] ?? 0) + 1;
		if (r.hook_event === "PostToolUse" && typeof r.checks_timing_ms === "number") {
			postTimings.push(r.checks_timing_ms);
		}
		if (r.session_id && typeof r.checks_timing_ms === "number") {
			const entry = sessionMax.get(r.session_id) ?? { max: 0, count: 0 };
			if (r.checks_timing_ms > entry.max) entry.max = r.checks_timing_ms;
			entry.count += 1;
			sessionMax.set(r.session_id, entry);
		}
	}

	postTimings.sort((a, b) => a - b);
	const slowestSessions: SlowestSession[] = Array.from(sessionMax.entries())
		.map(([session_id, e]) => ({
			session_id,
			max_timing_ms: e.max,
			event_count: e.count,
		}))
		.sort((a, b) => b.max_timing_ms - a.max_timing_ms)
		.slice(0, topN);

	const byTool = opts.compute_by_tool ? computeByToolStats(records) : undefined;

	return {
		total_events: records.length,
		by_hook_event: byHookEvent,
		post_tool_use: {
			timing_count: postTimings.length,
			p50: percentile(postTimings, 0.5),
			p90: percentile(postTimings, 0.9),
			p99: percentile(postTimings, 0.99),
			max: postTimings.length > 0 ? (postTimings[postTimings.length - 1] ?? null) : null,
		},
		slowest_sessions: slowestSessions,
		...(byTool ? { by_tool: byTool } : {}),
	};
}

/**
 * Bucket one record's REAL per-tool timings from Phase A.7's `tool_breakdown`
 * field — each subprocess (tsc, biome, eslint, etc.) reports its own
 * elapsedMs. No-op when the record predates A.7 (no `tool_breakdown`).
 */
function addBreakdownTimings(buckets: Map<string, number[]>, r: LatencyRecord): void {
	if (!Array.isArray(r.tool_breakdown)) return;
	for (const entry of r.tool_breakdown) {
		if (!entry || typeof entry.tool !== "string" || typeof entry.ms !== "number") continue;
		const arr = buckets.get(entry.tool) ?? [];
		arr.push(entry.ms);
		buckets.set(entry.tool, arr);
	}
}

/**
 * Fallback for legacy log lines without `tool_breakdown`: bucket the
 * record's total `checks_timing_ms` against every tool present in
 * `checks_ran`. Overstates individual cost but preserves the ordering
 * signal for archived (pre-A.7) logs.
 */
function addChecksRanTimings(buckets: Map<string, number[]>, r: LatencyRecord): void {
	if (!Array.isArray(r.checks_ran)) return;
	const t = r.checks_timing_ms;
	for (const tool of r.checks_ran) {
		if (typeof tool !== "string") continue;
		const arr = buckets.get(tool) ?? [];
		if (typeof t === "number") arr.push(t);
		buckets.set(tool, arr);
	}
}

/**
 * Compute per-tool stats. Two data sources — see `addBreakdownTimings` (real
 * per-tool elapsed times) and `addChecksRanTimings` (when-present
 * approximation for legacy logs).
 *
 * When at least one record carries `tool_breakdown`, we prefer the real
 * timings exclusively — mixing apples and oranges across the two would skew
 * the percentiles. When no record carries it (pre-A.7 log), we fall through
 * to the approximation so the command still works on archived logs.
 */
function computeByToolStats(records: LatencyRecord[]): ByToolStats[] {
	const hasBreakdown = records.some((r) => Array.isArray(r.tool_breakdown) && r.tool_breakdown.length > 0);
	const buckets = new Map<string, number[]>();
	if (hasBreakdown) {
		for (const r of records) addBreakdownTimings(buckets, r);
	} else {
		for (const r of records) addChecksRanTimings(buckets, r);
	}
	const stats: ByToolStats[] = [];
	for (const [tool, timings] of buckets.entries()) {
		timings.sort((a, b) => a - b);
		stats.push({
			tool,
			events: timings.length,
			when_present: {
				timing_count: timings.length,
				p50: percentile(timings, 0.5),
				p90: percentile(timings, 0.9),
				p99: percentile(timings, 0.99),
				max: timings.length > 0 ? (timings[timings.length - 1] ?? null) : null,
			},
		});
	}
	stats.sort((a, b) => b.events - a.events); // most-frequent first
	return stats;
}

function percentile(sortedAsc: number[], q: number): number | null {
	if (sortedAsc.length === 0) return null;
	const idx = Math.min(
		sortedAsc.length - 1,
		Math.max(0, Math.ceil(q * sortedAsc.length) - 1),
	);
	return sortedAsc[idx] ?? null;
}

export interface HarnessLatencyCommandOptions {
	json?: boolean;
	byTool?: boolean;
}

export async function harnessLatencyCommand(
	opts: HarnessLatencyCommandOptions = {},
): Promise<void> {
	const report = computeLatencyReport(process.cwd(), {
		compute_by_tool: opts.byTool === true,
	});
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return;
	}
	const lines: string[] = [];
	lines.push("Harness latency report");
	lines.push("──────────────────────");
	lines.push(`  Total events:        ${report.total_events}`);
	lines.push("");
	lines.push("  By hook_event:");
	for (const [evt, count] of Object.entries(report.by_hook_event).sort(
		(a, b) => b[1] - a[1],
	)) {
		lines.push(`    ${evt.padEnd(20)} ${count}`);
	}
	lines.push("");
	const p = report.post_tool_use;
	lines.push("  PostToolUse check timing:");
	lines.push(`    samples              ${p.timing_count}`);
	lines.push(`    p50                  ${formatMs(p.p50)}`);
	lines.push(`    p90                  ${formatMs(p.p90)}`);
	lines.push(`    p99                  ${formatMs(p.p99)}`);
	lines.push(`    max                  ${formatMs(p.max)}`);
	lines.push("");
	lines.push("  Top slowest sessions (by max event timing):");
	if (report.slowest_sessions.length === 0) {
		lines.push("    (none)");
	} else {
		for (const s of report.slowest_sessions) {
			lines.push(
				`    ${s.session_id.slice(0, 36).padEnd(38)} ${formatMs(s.max_timing_ms)}  (${s.event_count} events)`,
			);
		}
	}
	if (report.by_tool && report.by_tool.length > 0) {
		lines.push("");
		lines.push("  Per-tool stats:");
		lines.push(
			`    ${"tool".padEnd(24)} ${"events".padEnd(8)} ${"p50".padEnd(10)} ${"p99".padEnd(10)} ${"max"}`,
		);
		for (const t of report.by_tool) {
			lines.push(
				`    ${t.tool.padEnd(24)} ${String(t.events).padEnd(8)} ${formatMs(t.when_present.p50).padEnd(10)} ${formatMs(t.when_present.p99).padEnd(10)} ${formatMs(t.when_present.max)}`,
			);
		}
	}
	process.stdout.write(`${lines.join("\n")}\n`);
}

function formatMs(ms: number | null): string {
	if (ms === null) return "—";
	if (ms < 1000) return `${ms} ms`;
	return `${(ms / 1000).toFixed(2)} s`;
}
