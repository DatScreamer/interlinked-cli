// interlinked-tdd: exempt
// ===========================================
// interlinked status — full-mode render helpers
// ===========================================
// Leaf rendering helpers extracted from status.ts (per-session detail blocks,
// token aggregation, full-mode activity/session sections). No module-private
// state; depends only on formatter/activity-utils + injected data.

import { formatActivitySummary } from "../lib/activity-utils.js";
import {
	badge,
	c,
	estimateCost,
	formatTokens,
	header,
	kvLine,
	relativeTime,
	shortTimestamp,
	table,
} from "../lib/formatter.js";
import {
	type LocalActivityEvent,
	readLocalActivity,
	type SessionState,
} from "../lib/local-activity.js";
import type { StatusData } from "./status.js";

/**
 * Recent Activity event list. `withToolDetail` appends a `[tool]` suffix and
 * leaves the summary un-dimmed (full mode); otherwise the summary is dimmed
 * with no suffix (normal mode).
 */
export function renderActivityEvents(
	events: LocalActivityEvent[],
	withToolDetail: boolean,
): string[] {
	const lines: string[] = [];
	for (const e of events) {
		const ts = shortTimestamp(e.ts);
		const agent = e.agent || c.dim("-");
		const summary = formatActivitySummary({
			event_type: e.type,
			tool_name: e.tool ?? null,
			tool_input_summary: e.summary ?? null,
		});
		if (withToolDetail) {
			const detail = e.tool ? c.dim(` [${e.tool}]`) : "";
			lines.push(`  ${c.dim(ts)}  ${agent.padEnd(16)} ${summary}${detail}`);
		} else {
			lines.push(`  ${c.dim(ts)}  ${agent.padEnd(16)} ${c.dim(summary)}`);
		}
	}
	return lines;
}

/** Running token-total accumulator shape used by `sumSessionTokens`. */
interface TokenTotals {
	input: number;
	output: number;
	cache_read: number;
	cache_creation: number;
}

/** Per-session "Files touched" block (full mode), with 20-row truncation. */
function renderSessionFiles(s: SessionState): string[] {
	if (s.files_touched.length === 0) return [];
	const lines: string[] = [];
	lines.push(`    Files touched (${s.files_touched.length}):`);
	for (const f of s.files_touched.slice(0, 20)) {
		lines.push(`      ${c.dim(f)}`);
	}
	if (s.files_touched.length > 20) {
		lines.push(c.dim(`      ... and ${s.files_touched.length - 20} more`));
	}
	return lines;
}

/** Per-session "Tools used" breakdown (full mode), sorted by descending count. */
function renderSessionTools(s: SessionState): string[] {
	const toolEntries = Object.entries(s.tools_used).sort((a, b) => b[1] - a[1]);
	if (toolEntries.length === 0) return [];
	const lines: string[] = ["    Tools used:"];
	for (const [tool, count] of toolEntries) {
		lines.push(`      ${tool}: ${count}`);
	}
	return lines;
}

/** Per-session token-usage line (full mode, v2). */
function renderSessionTokens(s: SessionState): string[] {
	if (!s.tokens_total || !(s.tokens_total.input || s.tokens_total.output)) return [];
	const evtSuffix = s.token_events ? ` across ${s.token_events} events` : "";
	return [
		`    Token usage: ${formatTokens(s.tokens_total)} (${estimateCost(s.tokens_total)})${evtSuffix}`,
	];
}

/** Per-session subagent breakdown (full mode, v2). */
function renderSessionSubagents(s: SessionState): string[] {
	if (!s.subagents || Object.keys(s.subagents).length === 0) return [];
	const lines: string[] = ["    Subagents:"];
	for (const [name, sa] of Object.entries(s.subagents)) {
		const tokStr = sa.tokens
			? ` (${sa.tokens.input || 0} in / ${sa.tokens.output || 0} out)`
			: "";
		lines.push(
			`      ${name}: ${sa.tool_count} tools, ${sa.files_touched.length} files${tokStr}`,
		);
	}
	return lines;
}

/** Per-session code-activity breakdown (full mode, v3). */
function renderSessionCodeActivity(s: SessionState): string[] {
	if (!s.by_agent || Object.keys(s.by_agent).length === 0) return [];
	const lines: string[] = ["    Code activity:"];
	for (const [name, contrib] of Object.entries(s.by_agent)) {
		lines.push(
			`      ${name}: +${contrib.total_added}/-${contrib.total_removed} (${contrib.edit_count} edits, ${contrib.files_touched.length} files)`,
		);
	}
	return lines;
}

/** Per-session attributed-commit list (full mode, v3), with 5-row truncation. */
function renderSessionCommits(s: SessionState): string[] {
	if (!s.commits || s.commits.length === 0) return [];
	const lines: string[] = [`    Commits attributed: ${s.commits.length}`];
	for (const cm of s.commits.slice(0, 5)) {
		lines.push(`      ${cm.commit_hash.slice(0, 7)}: ${cm.message || "(no message)"}`);
	}
	if (s.commits.length > 5) {
		lines.push(c.dim(`      ... and ${s.commits.length - 5} more`));
	}
	return lines;
}

/** Full per-session detail block: header line, files, tools, tokens, subagents, code activity, commits. */
function renderSessionDetail(s: SessionState): string[] {
	const lines: string[] = [];
	lines.push("");
	lines.push(`  ${c.bold(s.agent)} (${s.session_id})`);
	lines.push(`    Started: ${s.started_at}`);
	lines.push(...renderSessionFiles(s));
	lines.push(...renderSessionTools(s));
	lines.push(...renderSessionTokens(s));
	lines.push(...renderSessionSubagents(s));
	lines.push(...renderSessionCodeActivity(s));
	lines.push(...renderSessionCommits(s));
	return lines;
}

/** Sum token totals across all sessions (full-mode aggregate summary). */
function sumSessionTokens(sessions: SessionState[]): TokenTotals {
	return sessions.reduce<TokenTotals>(
		(acc, s) => {
			if (s.tokens_total) {
				acc.input += s.tokens_total.input || 0;
				acc.output += s.tokens_total.output || 0;
				acc.cache_read += s.tokens_total.cache_read || 0;
				acc.cache_creation += s.tokens_total.cache_creation || 0;
			}
			return acc;
		},
		{ input: 0, output: 0, cache_read: 0, cache_creation: 0 },
	);
}

/** Full-mode Sessions section: summary table plus one detail block per session. */
export function renderFullSessions(data: StatusData): string[] {
	const lines: string[] = [header("Sessions")];
	if (data.localSessions.length === 0) {
		lines.push(c.dim("  No sessions recorded"));
		return lines;
	}
	const sessionRows = data.localSessions.map((s) => [
		s.agent,
		badge(s.phase === "ACTIVE" ? "active" : "offline"),
		String(s.tool_count),
		String(s.error_count),
		relativeTime(s.last_event_at),
	]);
	lines.push(table(["Agent", "Phase", "Tools", "Errors", "Last Event"], sessionRows));
	for (const s of data.localSessions) {
		lines.push(...renderSessionDetail(s));
	}
	return lines;
}

/** Full-mode aggregate Token Usage summary across all sessions (omitted when zero). */
export function renderTokenSummary(data: StatusData): string[] {
	const allTokens = sumSessionTokens(data.localSessions);
	if (!(allTokens.input > 0 || allTokens.output > 0)) return [];
	return [
		header("Token Usage"),
		kvLine("Total", formatTokens(allTokens)),
		kvLine("Est. cost", estimateCost(allTokens)),
	];
}

/** Full-mode Recent Activity section (up to 50 events, with per-event tool detail). */
export function renderFullActivity(): string[] {
	const lines: string[] = [header("Recent Activity")];
	const allActivity = readLocalActivity({ limit: 50 });
	if (allActivity.length === 0) {
		lines.push(c.dim("  No recent activity"));
		return lines;
	}
	lines.push(...renderActivityEvents(allActivity, true));
	return lines;
}
