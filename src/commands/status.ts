// ===========================================
// interlinked status — Local-first dashboard
// ===========================================
// Displays sessions, recent activity, sync status, and optional Interlinked MCP Server health.
// Works fully offline — MCP Server checks are optional with graceful degradation.

import { formatActivitySummary } from "../lib/activity-utils.js";
import { getClient } from "../lib/api-client.js";
import { type ResolvedConfig, resolveConfig } from "../lib/config.js";
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
	truncate,
} from "../lib/formatter.js";
import {
	getLocalStats,
	getSyncDiagnostics,
	type LocalActivityEvent,
	type LocalStats,
	readLocalActivity,
	readLocalSessions,
	type SessionState,
	type SyncDiagnostics,
} from "../lib/local-activity.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

/** Max time (ms) to wait for server health check before falling back to offline status. */
const SERVER_HEALTH_CHECK_TIMEOUT_MS = 3000;

// ===========================================
// Types
// ===========================================

interface ServerStatus {
	reachable: boolean;
	authenticated: boolean;
	workspaceName: string | null;
	error?: string;
}

interface StatusData {
	config: ResolvedConfig;
	isLocalServer: boolean;
	localSessions: SessionState[];
	localStats: LocalStats;
	syncDiagnostics: SyncDiagnostics;
	recentActivity: LocalActivityEvent[];
	unknownRecentCount: number;
	unknownSessionCount: number;
	serverStatus: ServerStatus;
}

// ===========================================
// Data Fetching
// ===========================================

async function fetchStatusData(): Promise<StatusData> {
	const config = resolveConfig();
	const isLocalServer =
		config.server_url.includes("localhost") || config.server_url.includes("127.0.0.1");

	// Local data — sync, always works
	const localSessions = readLocalSessions();
	const localStats = getLocalStats();
	const syncDiagnostics = getSyncDiagnostics();
	const recentActivity = readLocalActivity({ limit: 10 });
	const unknownRecentCount = recentActivity.filter(
		(e) => !e.agent || e.agent === "unknown",
	).length;
	const unknownSessionCount = localSessions.filter(
		(s) => !s.agent || s.agent === "unknown",
	).length;

	// Server health — async, optional, 3s timeout
	let serverStatus: ServerStatus = {
		reachable: false,
		authenticated: false,
		workspaceName: null,
	};

	try {
		const client = getClient();
		const health = await Promise.race([
			client.healthCheck(),
			new Promise<null>((resolve) =>
				setTimeout(() => resolve(null), SERVER_HEALTH_CHECK_TIMEOUT_MS),
			),
		]);

		if (health) {
			serverStatus = {
				reachable: health.serverReachable,
				authenticated: health.authenticated,
				workspaceName: config.workspace_id || null,
				error: health.error,
			};
		} else {
			serverStatus = {
				reachable: false,
				authenticated: false,
				workspaceName: null,
				error: `Timeout (${SERVER_HEALTH_CHECK_TIMEOUT_MS / 1000}s)`,
			};
		}
	} catch {
		serverStatus = {
			reachable: false,
			authenticated: false,
			workspaceName: null,
			error: "Not configured or unreachable",
		};
	}

	return {
		config,
		isLocalServer,
		localSessions,
		localStats,
		syncDiagnostics,
		recentActivity,
		unknownRecentCount,
		unknownSessionCount,
		serverStatus,
	};
}

// ===========================================
// Renderers
// ===========================================

function renderShort(data: StatusData): string {
	const activeSessions = data.localSessions.filter((s) => s.phase === "ACTIVE").length;
	const totalEvents = data.localStats.total_events;
	const unsynced = data.localStats.pending_sync;
	const serverLabel = data.serverStatus.reachable
		? data.serverStatus.authenticated
			? "ok"
			: "unauth"
		: "offline";

	const parts: string[] = [];
	parts.push(`${activeSessions} session${activeSessions !== 1 ? "s" : ""}`);
	parts.push(`${totalEvents} event${totalEvents !== 1 ? "s" : ""}`);
	if (unsynced > 0) {
		parts.push(`${unsynced} unsynced`);
	}
	if (data.syncDiagnostics.pending_realtime_retry > 0) {
		parts.push(`${data.syncDiagnostics.pending_realtime_retry} retry-buffered`);
	}
	if (data.syncDiagnostics.sync_error_count > 0) {
		parts.push(`${data.syncDiagnostics.sync_error_count} sync-errors`);
	}
	parts.push(`mcp-server: ${serverLabel}`);

	return parts.join(", ");
}

function renderGuidance(data: StatusData): string[] {
	const lines: string[] = [];

	if (!data.config.agent_name) {
		lines.push(c.yellow("  Agent name is not configured."));
		lines.push(c.dim("  Project-level capture is active with session-scoped agent IDs."));
		lines.push(c.dim("  Set stable identity: interlinked attach --agent <name>"));
	}

	if (data.unknownSessionCount > 0 || data.unknownRecentCount >= 3) {
		lines.push(c.yellow("  Activity is being attributed to 'unknown'."));
		lines.push(
			c.dim(
				"  Regenerate hooks (`interlinked enable`) and/or set a stable identity (`interlinked attach --agent <name>`).",
			),
		);
		lines.push(c.dim("  Optional cleanup: interlinked clean --dry-run"));
	}

	if (data.isLocalServer && data.serverStatus.reachable && !data.serverStatus.authenticated) {
		lines.push(
			c.dim("  Local Interlinked MCP Server detected: auth is optional on localhost."),
		);
		lines.push(c.dim("  If you still see auth issues, run: interlinked doctor --fix"));
	}

	if (!data.serverStatus.reachable && data.isLocalServer) {
		lines.push(c.yellow("  Local Interlinked MCP Server is not reachable."));
		lines.push(c.dim("  Start it with: npm run dev"));
	}

	if (!data.isLocalServer && data.serverStatus.reachable && !data.serverStatus.authenticated) {
		lines.push(c.yellow("  Interlinked MCP Server reachable but not authenticated."));
		lines.push(c.dim("  Run: interlinked login"));
		lines.push(
			c.dim(
				"  Local-only commands still work: interlinked status, activity, explain, doctor.",
			),
		);
	}

	if (!data.serverStatus.reachable && !data.isLocalServer) {
		lines.push(
			c.dim(
				"  Remote unavailable: local capture, status, and diagnostics still work offline.",
			),
		);
	}

	return lines;
}

function renderNormal(data: StatusData): string {
	const lines: string[] = [];

	// Sessions section
	lines.push(header("Sessions"));
	const activeSessions = data.localSessions.filter((s) => s.phase === "ACTIVE");
	const endedSessions = data.localSessions.filter((s) => s.phase === "ENDED");

	if (activeSessions.length === 0 && endedSessions.length === 0) {
		lines.push(c.dim("  No sessions recorded"));
	} else if (activeSessions.length > 0) {
		const sessionRows = activeSessions.map((s) => [
			s.agent,
			badge("active"),
			String(s.tool_count),
			relativeTime(s.last_event_at),
		]);
		lines.push(table(["Agent", "Phase", "Tools", "Last Event"], sessionRows));
		if (endedSessions.length > 0) {
			lines.push(
				c.dim(
					`  + ${endedSessions.length} ended session${endedSessions.length !== 1 ? "s" : ""}`,
				),
			);
		}
	} else {
		lines.push(
			c.dim(
				`  ${endedSessions.length} ended session${endedSessions.length !== 1 ? "s" : ""} (no active)`,
			),
		);
	}

	// Recent Activity section
	lines.push(header("Recent Activity"));
	if (data.recentActivity.length === 0) {
		lines.push(c.dim("  No recent activity"));
	} else {
		for (const e of data.recentActivity) {
			const ts = shortTimestamp(e.ts);
			const agent = e.agent || c.dim("-");
			const summary = formatActivitySummary({
				event_type: e.type,
				tool_name: e.tool,
				tool_input_summary: e.summary,
			});
			lines.push(`  ${c.dim(ts)}  ${agent.padEnd(16)} ${c.dim(summary)}`);
		}
	}

	// Sync Status section
	lines.push(header("Sync Status"));
	lines.push(kvLine("Total events", String(data.localStats.total_events)));
	lines.push(kvLine("Log size", formatBytes(data.localStats.file_size_bytes)));
	if (data.localStats.pending_sync > 0) {
		lines.push(kvLine("Unsynced", c.yellow(`${data.localStats.pending_sync} events`)));
	} else {
		lines.push(kvLine("Unsynced", c.green("0")));
	}
	lines.push(
		kvLine("Realtime retry buffer", String(data.syncDiagnostics.pending_realtime_retry)),
	);
	lines.push(kvLine("Sync errors", String(data.syncDiagnostics.sync_error_count)));
	if (data.syncDiagnostics.last_sync_success_at) {
		lines.push(kvLine("Last sync success", data.syncDiagnostics.last_sync_success_at));
	}
	if (data.syncDiagnostics.last_sync_error_at) {
		lines.push(kvLine("Last sync error", data.syncDiagnostics.last_sync_error_at));
	}
	if (data.syncDiagnostics.last_sync_error) {
		lines.push(
			kvLine("Last sync error msg", truncate(data.syncDiagnostics.last_sync_error, 120)),
		);
	}

	// Server section
	lines.push(header("Interlinked MCP Server"));
	lines.push(kvLine("URL", data.config.server_url));
	if (data.serverStatus.reachable) {
		lines.push(kvLine("Status", c.green("reachable")));
		lines.push(
			kvLine(
				"Auth",
				data.serverStatus.authenticated
					? c.green("authenticated")
					: c.yellow("not authenticated"),
			),
		);
		if (data.serverStatus.workspaceName) {
			lines.push(kvLine("Workspace", data.serverStatus.workspaceName));
		}
		lines.push(kvLine("workspace_key", data.config.default_workspace_key || "main"));
		lines.push(kvLine("project_key", data.config.default_project || "main"));
	} else {
		lines.push(kvLine("Status", c.dim("unreachable")));
		if (data.serverStatus.error) {
			lines.push(kvLine("Error", c.dim(data.serverStatus.error)));
		}
	}

	const guidance = renderGuidance(data);
	if (guidance.length > 0) {
		lines.push(header("Guidance"));
		lines.push(...guidance);
	}

	return lines.join("\n");
}

function renderFull(data: StatusData): string {
	const lines: string[] = [];

	// Sessions section — full detail with files and tools
	lines.push(header("Sessions"));
	if (data.localSessions.length === 0) {
		lines.push(c.dim("  No sessions recorded"));
	} else {
		const sessionRows = data.localSessions.map((s) => [
			s.agent,
			badge(s.phase === "ACTIVE" ? "active" : "offline"),
			String(s.tool_count),
			String(s.error_count),
			relativeTime(s.last_event_at),
		]);
		lines.push(table(["Agent", "Phase", "Tools", "Errors", "Last Event"], sessionRows));

		// Per-session detail
		for (const s of data.localSessions) {
			lines.push("");
			lines.push(`  ${c.bold(s.agent)} (${s.session_id})`);
			lines.push(`    Started: ${s.started_at}`);

			// Files touched
			if (s.files_touched.length > 0) {
				lines.push(`    Files touched (${s.files_touched.length}):`);
				for (const f of s.files_touched.slice(0, 20)) {
					lines.push(`      ${c.dim(f)}`);
				}
				if (s.files_touched.length > 20) {
					lines.push(c.dim(`      ... and ${s.files_touched.length - 20} more`));
				}
			}

			// Tools used breakdown
			const toolEntries = Object.entries(s.tools_used).sort((a, b) => b[1] - a[1]);
			if (toolEntries.length > 0) {
				lines.push("    Tools used:");
				for (const [tool, count] of toolEntries) {
					lines.push(`      ${tool}: ${count}`);
				}
			}

			// Token usage (v2)
			if (s.tokens_total && (s.tokens_total.input || s.tokens_total.output)) {
				const evtSuffix = s.token_events ? ` across ${s.token_events} events` : "";
				lines.push(
					`    Token usage: ${formatTokens(s.tokens_total)} (${estimateCost(s.tokens_total)})${evtSuffix}`,
				);
			}

			// Subagent breakdown (v2)
			if (s.subagents && Object.keys(s.subagents).length > 0) {
				lines.push("    Subagents:");
				for (const [name, sa] of Object.entries(s.subagents)) {
					const tokStr = sa.tokens
						? ` (${sa.tokens.input || 0} in / ${sa.tokens.output || 0} out)`
						: "";
					lines.push(
						`      ${name}: ${sa.tool_count} tools, ${sa.files_touched.length} files${tokStr}`,
					);
				}
			}

			// Code activity (v3)
			if (s.by_agent && Object.keys(s.by_agent).length > 0) {
				lines.push("    Code activity:");
				for (const [name, contrib] of Object.entries(s.by_agent)) {
					lines.push(
						`      ${name}: +${contrib.total_added}/-${contrib.total_removed} (${contrib.edit_count} edits, ${contrib.files_touched.length} files)`,
					);
				}
			}
			if (s.commits && s.commits.length > 0) {
				lines.push(`    Commits attributed: ${s.commits.length}`);
				for (const cm of s.commits.slice(0, 5)) {
					lines.push(
						`      ${cm.commit_hash.slice(0, 7)}: ${cm.message || "(no message)"}`,
					);
				}
				if (s.commits.length > 5) {
					lines.push(c.dim(`      ... and ${s.commits.length - 5} more`));
				}
			}
		}
	}

	// Token Usage summary across all sessions
	const allTokens = data.localSessions.reduce(
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
	if (allTokens.input > 0 || allTokens.output > 0) {
		lines.push(header("Token Usage"));
		lines.push(kvLine("Total", formatTokens(allTokens)));
		lines.push(kvLine("Est. cost", estimateCost(allTokens)));
	}

	// Full activity (all recent, not just 10)
	lines.push(header("Recent Activity"));
	const allActivity = readLocalActivity({ limit: 50 });
	if (allActivity.length === 0) {
		lines.push(c.dim("  No recent activity"));
	} else {
		for (const e of allActivity) {
			const ts = shortTimestamp(e.ts);
			const agent = e.agent || c.dim("-");
			const summary = formatActivitySummary({
				event_type: e.type,
				tool_name: e.tool,
				tool_input_summary: e.summary,
			});
			const detail = e.tool ? c.dim(` [${e.tool}]`) : "";
			lines.push(`  ${c.dim(ts)}  ${agent.padEnd(16)} ${summary}${detail}`);
		}
	}

	// Sync Status section
	lines.push(header("Sync Status"));
	lines.push(kvLine("Total events", String(data.localStats.total_events)));
	lines.push(kvLine("Log size", formatBytes(data.localStats.file_size_bytes)));
	if (data.localStats.pending_sync > 0) {
		lines.push(kvLine("Unsynced", c.yellow(`${data.localStats.pending_sync} events`)));
	} else {
		lines.push(kvLine("Unsynced", c.green("0")));
	}
	lines.push(
		kvLine("Realtime retry buffer", String(data.syncDiagnostics.pending_realtime_retry)),
	);
	lines.push(kvLine("Sync errors", String(data.syncDiagnostics.sync_error_count)));
	if (data.syncDiagnostics.last_sync_success_at) {
		lines.push(kvLine("Last sync success", data.syncDiagnostics.last_sync_success_at));
	}
	if (data.syncDiagnostics.last_sync_error_at) {
		lines.push(kvLine("Last sync error", data.syncDiagnostics.last_sync_error_at));
	}
	if (data.syncDiagnostics.last_sync_error) {
		lines.push(
			kvLine("Last sync error msg", truncate(data.syncDiagnostics.last_sync_error, 120)),
		);
	}
	if (data.localStats.oldest_event) {
		lines.push(kvLine("Oldest event", data.localStats.oldest_event));
	}
	if (data.localStats.newest_event) {
		lines.push(kvLine("Newest event", data.localStats.newest_event));
	}

	// Server section
	lines.push(header("Interlinked MCP Server"));
	lines.push(kvLine("URL", data.config.server_url));
	if (data.serverStatus.reachable) {
		lines.push(kvLine("Status", c.green("reachable")));
		lines.push(
			kvLine(
				"Auth",
				data.serverStatus.authenticated
					? c.green("authenticated")
					: c.yellow("not authenticated"),
			),
		);
		if (data.serverStatus.workspaceName) {
			lines.push(kvLine("Workspace", data.serverStatus.workspaceName));
		}
		lines.push(kvLine("workspace_key", data.config.default_workspace_key || "main"));
		lines.push(kvLine("project_key", data.config.default_project || "main"));
	} else {
		lines.push(kvLine("Status", c.dim("unreachable")));
		if (data.serverStatus.error) {
			lines.push(kvLine("Error", c.dim(data.serverStatus.error)));
		}
	}

	const guidance = renderGuidance(data);
	if (guidance.length > 0) {
		lines.push(header("Guidance"));
		lines.push(...guidance);
	}

	return lines.join("\n");
}

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;

function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	if (bytes < BYTES_PER_KB) return `${bytes} B`;
	if (bytes < BYTES_PER_MB) return `${(bytes / BYTES_PER_KB).toFixed(1)} KB`;
	return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

// ===========================================
// Command Entry Point
// ===========================================

export async function statusCommand(opts: {
	short?: boolean;
	full?: boolean;
	json?: boolean;
	watch?: string | boolean;
}): Promise<void> {
	const mode = getOutputMode(opts);
	const DEFAULT_WATCH_SEC = 10;
	const MIN_WATCH_SEC = 2;

	const runOnce = async () => {
		try {
			const data = await fetchStatusData();

			output(mode, data, {
				json: () => ({
					sessions: data.localSessions,
					stats: data.localStats,
					sync_diagnostics: data.syncDiagnostics,
					recent_activity: data.recentActivity,
					config: {
						server_url: data.config.server_url,
						workspace_id: data.config.workspace_id || null,
						default_workspace_key: data.config.default_workspace_key || "main",
						default_project: data.config.default_project || "main",
						agent_name: data.config.agent_name || null,
						sync_mode: data.config.sync_mode,
					},
					server: data.serverStatus,
				}),
				short: () => renderShort(data),
				normal: () => renderNormal(data),
				full: () => renderFull(data),
			});
		} catch (err) {
			outputError(mode, err instanceof Error ? err.message : String(err));
		}
	};

	if (opts.watch !== undefined && opts.watch !== false) {
		const parsedWatch =
			typeof opts.watch === "string" ? Number.parseInt(opts.watch, 10) : DEFAULT_WATCH_SEC;
		const normalizedWatch =
			Number.isFinite(parsedWatch) && parsedWatch >= MIN_WATCH_SEC
				? parsedWatch
				: DEFAULT_WATCH_SEC;
		const intervalMs = normalizedWatch * 1000;

		if (mode !== "json" && normalizedWatch !== parsedWatch) {
			console.log(
				c.yellow(
					`Watch interval must be >= ${MIN_WATCH_SEC}s. Using ${DEFAULT_WATCH_SEC}s.`,
				),
			);
		}

		// Initial render
		await runOnce();

		// Recurring refresh (serialized to avoid piling up overlapping requests)
		const tick = async () => {
			process.stdout.write("\x1B[2J\x1B[0f");
			console.log(c.dim(`Refreshing every ${normalizedWatch}s... (Ctrl+C to stop)\n`));
			await runOnce();
			setTimeout(tick, intervalMs);
		};

		setTimeout(tick, intervalMs);
	} else {
		await runOnce();
	}
}
