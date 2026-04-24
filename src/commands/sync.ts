// ===========================================
// interlinked sync — Push unsynced local events to the server
// ===========================================

import { resolveAuthToken } from "../lib/auth.js";
import { resolveConfig } from "../lib/config.js";
import { c, header, kvLine } from "../lib/formatter.js";
import type { JsonObject } from "../lib/json-types.js";
import type { LastSyncSummary } from "../lib/local-activity.js";
import {
	appendSyncError,
	getLocalStats,
	getUnsyncedEvents,
	readSyncState,
	updateSyncState,
} from "../lib/local-activity.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { loadScrubConfig, recordScrub, scrubSecrets } from "../lib/secrets.js";

const BATCH_SIZE = 100;
const MAX_BATCH_RETRIES = 3;
const RETRY_BACKOFF_MS = [250, 750];
/** Abort the batch-sync `fetch` if the server doesn't respond within this window. */
const BATCH_SYNC_REQUEST_TIMEOUT_MS = 10_000;

export async function syncCommand(opts: {
	json?: boolean;
	dryRun?: boolean;
	limit?: string;
}): Promise<void> {
	const mode = getOutputMode(opts);
	const maxEvents = opts.limit ? Number.parseInt(opts.limit, 10) : undefined;

	try {
		const stats = getLocalStats();
		if (stats.pending_sync === 0) {
			output(
				mode,
				{},
				{
					json: () => ({ synced: 0, pending: 0, message: "Already up to date" }),
					normal: () => formatUpToDate(),
				},
			);
			return;
		}

		const { events, newOffset } = getUnsyncedEvents(maxEvents);

		if (events.length === 0) {
			output(
				mode,
				{},
				{
					json: () => ({ synced: 0, pending: 0, message: "Already up to date" }),
					normal: () => formatUpToDate(),
				},
			);
			return;
		}

		if (opts.dryRun) {
			output(mode, events, {
				json: () => ({
					dry_run: true,
					pending_events: events.length,
					batches: Math.ceil(events.length / BATCH_SIZE),
					sync_state: readSyncState(),
				}),
				normal: () => {
					const lines: string[] = [];
					lines.push(header("Sync (dry-run)"));
					lines.push(kvLine("Pending events", String(events.length)));
					lines.push(
						kvLine("Batches needed", String(Math.ceil(events.length / BATCH_SIZE))),
					);
					lines.push(kvLine("New offset", `${newOffset} bytes`));
					lines.push("");
					lines.push(c.dim("  Run 'interlinked sync' (without --dry-run) to push."));
					return lines.join("\n");
				},
			});
			return;
		}

		// Resolve server URL and auth for the batch POST.
		// resolveConfig() uses active_server to pair server_url with workspace_id,
		// so there's no risk of sending a local workspace_id to production or vice versa.
		const config = resolveConfig();
		const serverUrl = config.server_url;
		const isLocalDev = serverUrl.includes("localhost") || serverUrl.includes("127.0.0.1");
		const defaultWorkspaceKey = config.default_workspace_key || "main";
		const defaultProjectKey = config.default_project || "main";

		// Resolve auth: use the full token chain (CLI token → Claude Code creds)
		const token = resolveAuthToken();

		// workspace_uuid is required for dev mode (no OAuth identity to auto-resolve),
		// and recommended for production (explicit targeting instead of auto-select).
		const workspaceId = config.workspace_id;

		if (isLocalDev && !workspaceId) {
			outputError(
				mode,
				"workspace_id required for local dev sync. Set it in .interlinked/config.local.json under the active server entry.",
			);
			return;
		}

		// Apply secret scrubbing before sync
		const scrubConfig = loadScrubConfig();
		let totalScrubbed = 0;

		// Push in batches via direct HTTP POST to /api/hooks/activity/batch
		let totalAccepted = 0;
		let totalSkipped = 0;
		let totalErrors = 0;
		let batchesSent = 0;
		let retriesUsed = 0;

		for (let i = 0; i < events.length; i += BATCH_SIZE) {
			const batch = events.slice(i, i + BATCH_SIZE);
			const batchPayload = batch.map((e) => {
				const payload: JsonObject = {
					agent_name: e.agent || "unknown",
					workspace_key: e.workspace_key || defaultWorkspaceKey,
					project_key: e.project_key || defaultProjectKey,
					event_type: e.type,
					tool_name: e.tool || undefined,
					tool_input_summary: e.summary || undefined,
					occurred_at: e.ts,
				};
				// v2 fields
				if (e.duration_ms) payload.duration_ms = e.duration_ms;
				if (e.tokens?.input) payload.tokens_input = e.tokens.input;
				if (e.tokens?.output) payload.tokens_output = e.tokens.output;
				if (e.tokens?.cache_read) payload.tokens_cache_read = e.tokens.cache_read;
				if (e.tokens?.cache_creation)
					payload.tokens_cache_creation = e.tokens.cache_creation;
				if (e.parent_agent) payload.parent_agent = e.parent_agent;
				if (e.subagent_id) payload.subagent_id = e.subagent_id;
				if (e.files_modified) payload.files_modified = e.files_modified;
				// v3 fields
				if (e.hook) payload.hook_event = e.hook;
				if (e.error)
					payload.error_message =
						typeof e.error === "string" ? e.error : JSON.stringify(e.error);
				if (e.error)
					payload.error_detail =
						typeof e.error === "string" ? e.error : JSON.stringify(e.error);
				// v4 full-capture fields
				if (e.tool_input !== undefined)
					payload.tool_input_json =
						typeof e.tool_input === "string"
							? e.tool_input
							: JSON.stringify(e.tool_input);
				if (e.tool_response !== undefined)
					payload.tool_response_json =
						typeof e.tool_response === "string"
							? e.tool_response
							: JSON.stringify(e.tool_response);
				if (e.prompt !== undefined) payload.prompt = e.prompt;
				if (e.last_assistant_message !== undefined)
					payload.last_assistant_message = e.last_assistant_message;
				if (e.cwd) payload.cwd = e.cwd;
				if (e.model) payload.model = e.model;
				if (e.source) payload.source = e.source;
				if (e.agent_type) payload.agent_type_hook = e.agent_type;
				if (e.tool_use_id) payload.tool_use_id = e.tool_use_id;
				if (e.session) payload.session_id = e.session;
				if (e.is_interrupt !== undefined) payload.is_interrupt = e.is_interrupt;
				if (e.notification_type) payload.notification_type = e.notification_type;
				if (e.notification_title) payload.notification_title = e.notification_title;
				if (e.task_subject) payload.task_subject = e.task_subject;
				if (e.task_id) payload.task_id_hook = e.task_id;
				if (e.task_description) payload.task_description_hook = e.task_description;
				if (e.trigger) payload.trigger = e.trigger;
				if (e.reason) payload.reason = e.reason;
				if (e.permission_mode) payload.permission_mode = e.permission_mode;
				if (e.transcript_path) payload.transcript_path = e.transcript_path;
				if (e.teammate_name) payload.teammate_name = e.teammate_name;
				if (e.team_name) payload.team_name = e.team_name;
				if (e.custom_instructions) payload.custom_instructions = e.custom_instructions;
				if (e.stop_hook_active !== undefined) payload.stop_hook_active = e.stop_hook_active;
				if (e.permission_suggestions !== undefined)
					payload.permission_suggestions =
						typeof e.permission_suggestions === "string"
							? e.permission_suggestions
							: JSON.stringify(e.permission_suggestions);
				if (e.agent_transcript_path)
					payload.agent_transcript_path = e.agent_transcript_path;
				// Scrub secrets from text fields
				const scrubFields = [
					"tool_input_summary",
					"tool_input_json",
					"tool_response_json",
					"prompt",
					"last_assistant_message",
					"error_detail",
				] as const;
				for (const field of scrubFields) {
					if (payload[field] && typeof payload[field] === "string") {
						const result = scrubSecrets(payload[field] as string, scrubConfig);
						if (result.found > 0) {
							payload[field] = result.text;
							totalScrubbed++;
							recordScrub(result.types);
						}
					}
				}
				return payload;
			});

			const headers: Record<string, string> = {
				"Content-Type": "application/json",
			};
			// Send Bearer auth for production; skip for localhost (dev mode bypass)
			if (token && !isLocalDev) {
				headers.Authorization = `Bearer ${token}`;
			}

			const body: JsonObject = {
				workspace_key: defaultWorkspaceKey,
				project_key: defaultProjectKey,
				events: batchPayload,
			};
			// Include workspace_uuid for routing (required in dev, helpful in prod
			// for explicit workspace targeting instead of auto-select)
			if (workspaceId) {
				body.workspace_uuid = workspaceId;
			}

			let batchSucceeded = false;
			let batchFailureCounted = false;
			const batchNum = Math.floor(i / BATCH_SIZE) + 1;

			for (let attempt = 1; attempt <= MAX_BATCH_RETRIES; attempt++) {
				try {
					const controller = new AbortController();
					const timeout = setTimeout(
						() => controller.abort(),
						BATCH_SYNC_REQUEST_TIMEOUT_MS,
					);

					const res = await fetch(`${serverUrl}/api/hooks/activity/batch`, {
						method: "POST",
						headers,
						body: JSON.stringify(body),
						signal: controller.signal,
					});

					clearTimeout(timeout);

					if (res.ok) {
						const result = (await res.json()) as {
							accepted?: number;
							skipped?: number;
							errors?: number;
						};
						totalAccepted += result?.accepted || 0;
						totalSkipped += result?.skipped || 0;
						totalErrors += result?.errors || 0;
						batchesSent++;
						batchSucceeded = true;
						if (attempt > 1) {
							retriesUsed += attempt - 1;
						}
						break;
					}

					const errBody = await res.text().catch(() => "");
					if (res.status === 401) {
						appendSyncError({
							stage: "manual_sync_auth",
							message: "Authentication failed (401) during sync",
							status: 401,
							batch: batchNum,
							attempt,
							transient: false,
						});
						outputError(
							mode,
							"Authentication failed. Run 'interlinked login' to re-authenticate.",
						);
						return;
					}

					const transient = res.status === 429 || res.status >= 500;
					appendSyncError({
						stage: "manual_sync_http",
						message: `Batch ${batchNum} failed with status ${res.status}: ${errBody.slice(0, 200)}`,
						status: res.status,
						batch: batchNum,
						attempt,
						transient,
					});

					if (transient && attempt < MAX_BATCH_RETRIES) {
						retriesUsed++;
						await sleep(
							RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)],
						);
						continue;
					}

					if (!batchFailureCounted) {
						totalErrors += batch.length;
						batchFailureCounted = true;
					}
					if (mode !== "json") {
						process.stderr.write(
							c.dim(
								`  Batch ${batchNum} failed (${res.status}): ${errBody.slice(0, 100)}\n`,
							),
						);
					}
					break;
				} catch (err) {
					const isTimeout = err instanceof Error && err.name === "AbortError";
					appendSyncError({
						stage: isTimeout ? "manual_sync_timeout" : "manual_sync_network",
						message: err instanceof Error ? err.message : String(err),
						batch: batchNum,
						attempt,
						transient: true,
					});

					if (attempt < MAX_BATCH_RETRIES) {
						retriesUsed++;
						await sleep(
							RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)],
						);
						continue;
					}

					if (!batchFailureCounted) {
						totalErrors += batch.length;
						batchFailureCounted = true;
					}
					if (isTimeout && mode !== "json") {
						process.stderr.write(c.dim("  Batch timed out (10s)\n"));
					}
					break;
				}
			}

			if (!batchSucceeded && !batchFailureCounted) {
				totalErrors += batch.length;
			}
		}

		// Build summary breakdown from the events we just synced
		const byType: Record<string, number> = {};
		const byAgent: Record<string, number> = {};
		const byTool: Record<string, number> = {};
		const sessions = new Set<string>();
		let earliest = "";
		let latest = "";

		for (const e of events) {
			byType[e.type] = (byType[e.type] || 0) + 1;
			if (e.agent && e.agent !== "unknown") {
				byAgent[e.agent] = (byAgent[e.agent] || 0) + 1;
			}
			if (e.tool) {
				byTool[e.tool] = (byTool[e.tool] || 0) + 1;
			}
			if (e.session) sessions.add(e.session);
			if (!earliest || e.ts < earliest) earliest = e.ts;
			if (!latest || e.ts > latest) latest = e.ts;
		}

		const topTools = Object.entries(byTool)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5) as [string, number][];

		// Advance sync cursor on success, saving summary for "already up to date" display
		if (totalErrors === 0) {
			const summary: LastSyncSummary = {
				server_url: serverUrl,
				workspace_id: workspaceId || null,
				events_total: events.length,
				accepted: totalAccepted,
				skipped: totalSkipped,
				scrubbed: totalScrubbed,
				batches: batchesSent,
				by_type: byType,
				by_agent: byAgent,
				top_tools: topTools,
				sessions: sessions.size,
				time_range: { earliest, latest },
			};
			updateSyncState(newOffset, summary);
		}

		output(
			mode,
			{},
			{
				json: () => ({
					server_url: serverUrl,
					workspace_id: workspaceId || null,
					accepted: totalAccepted,
					skipped: totalSkipped,
					errors: totalErrors,
					scrubbed: totalScrubbed,
					batches_sent: batchesSent,
					retries: retriesUsed,
					new_offset:
						totalErrors === 0 ? newOffset : readSyncState().synced_through_bytes,
					breakdown: {
						by_type: byType,
						by_agent: byAgent,
						top_tools: topTools,
						sessions: sessions.size,
					},
					time_range: { earliest, latest },
				}),
				normal: () => {
					const lines: string[] = [];
					lines.push(header("Sync Complete"));
					lines.push(kvLine("Server", c.cyan(serverUrl)));
					if (workspaceId) {
						lines.push(kvLine("Workspace", c.cyan(workspaceId)));
					}
					lines.push(
						kvLine(
							"Events",
							`${events.length} total (${c.green(String(totalAccepted))} new, ${totalSkipped} dedup)`,
						),
					);
					if (totalScrubbed > 0) {
						lines.push(
							kvLine(
								"Scrubbed",
								c.yellow(`${totalScrubbed} events had secrets redacted`),
							),
						);
					}
					if (totalErrors > 0) {
						lines.push(kvLine("Errors", c.red(String(totalErrors))));
					}
					lines.push(kvLine("Batches", String(batchesSent)));
					if (retriesUsed > 0) {
						lines.push(kvLine("Retries", String(retriesUsed)));
					}

					// Time range
					if (earliest && latest) {
						lines.push("");
						lines.push(c.bold("  Time Range"));
						lines.push(`    ${c.dim(fmtTime(earliest))} → ${c.dim(fmtTime(latest))}`);
					}

					// Event type breakdown
					const typeEntries = Object.entries(byType).sort((a, b) => b[1] - a[1]);
					if (typeEntries.length > 0) {
						lines.push("");
						lines.push(c.bold("  Event Types"));
						for (const [type, count] of typeEntries) {
							const label = type.replace(/_/g, " ");
							lines.push(`    ${c.cyan(String(count).padStart(4))}  ${label}`);
						}
					}

					// Agent breakdown
					const agentEntries = Object.entries(byAgent).sort((a, b) => b[1] - a[1]);
					if (agentEntries.length > 0) {
						lines.push("");
						lines.push(c.bold("  Agents"));
						for (const [agent, count] of agentEntries) {
							lines.push(`    ${c.cyan(String(count).padStart(4))}  ${agent}`);
						}
					}

					// Top tools
					if (topTools.length > 0) {
						lines.push("");
						lines.push(c.bold("  Top Tools"));
						for (const [tool, count] of topTools) {
							lines.push(`    ${c.cyan(String(count).padStart(4))}  ${tool}`);
						}
						const otherToolCount = Object.keys(byTool).length - topTools.length;
						if (otherToolCount > 0) {
							lines.push(c.dim(`    ... +${otherToolCount} more`));
						}
					}

					// Sessions
					if (sessions.size > 0) {
						lines.push("");
						lines.push(kvLine("Sessions", String(sessions.size)));
					}

					if (totalErrors > 0) {
						lines.push("");
						lines.push(
							c.yellow("  Cursor not advanced due to errors. Re-run to retry."),
						);
					}
					return lines.join("\n");
				},
			},
		);
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function fmtTime(iso: string): string {
	const d = new Date(iso);
	return d.toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	});
}

function formatUpToDate(): string {
	const state = readSyncState();
	const lines: string[] = [];
	lines.push(`${c.green("Already up to date.")} No unsynced events.`);

	if (state.last_summary && state.last_sync_at) {
		const s = state.last_summary;
		lines.push("");
		lines.push(c.dim(`  Last sync: ${fmtTime(state.last_sync_at)}`));
		lines.push(c.dim(`  Server:    ${s.server_url}`));
		if (s.workspace_id) {
			lines.push(c.dim(`  Workspace: ${s.workspace_id}`));
		}
		lines.push(
			c.dim(
				`  ${s.events_total} events (${s.accepted} new, ${s.skipped} dedup) across ${s.sessions} session${s.sessions !== 1 ? "s" : ""}`,
			),
		);

		if (s.time_range.earliest && s.time_range.latest) {
			lines.push(
				c.dim(
					`  Covering: ${fmtTime(s.time_range.earliest)} → ${fmtTime(s.time_range.latest)}`,
				),
			);
		}

		const agentNames = Object.keys(s.by_agent);
		if (agentNames.length > 0) {
			lines.push(c.dim(`  Agents: ${agentNames.join(", ")}`));
		}

		const typeEntries = Object.entries(s.by_type)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 4);
		if (typeEntries.length > 0) {
			const typeSummary = typeEntries
				.map(([t, n]) => `${n} ${t.replace(/_/g, " ")}`)
				.join(", ");
			lines.push(c.dim(`  Events: ${typeSummary}`));
		}
	}

	return lines.join("\n");
}
