// ===========================================
// interlinked sync — Push unsynced local events to the server
// ===========================================

import { resolveAuthToken } from "../lib/auth.js";
import { resolveConfig } from "../lib/config.js";
import { c, header, kvLine } from "../lib/formatter.js";
import type { JsonObject } from "../lib/json-types.js";
import type { LastSyncSummary, LocalActivityEvent } from "../lib/local-activity.js";
import {
	appendSyncError,
	getLocalStats,
	getUnsyncedEvents,
	readSyncState,
	updateSyncState,
} from "../lib/local-activity.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { loadScrubConfig, recordScrub, scrubEgressPayload } from "../lib/secrets.js";
import {
	buildBatchBody,
	buildBatchHeaders,
	buildEventPayload,
	type PayloadDefaults,
} from "./sync-payload.js";
import {
	buildBatchSummary,
	fmtTime,
	formatUpToDate,
	renderCountSection,
	renderTopToolsSection,
} from "./sync-format.js";

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

		// Resolve server URL + auth + workspace targeting (dev-guard inside).
		const ctx = resolveSyncContext(mode);
		if (!ctx) return;
		const { serverUrl, isLocalDev, payloadDefaults, token, workspaceId } = ctx;

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
				const payload = buildEventPayload(e, payloadDefaults);
				// Redact at the cloud boundary via the single shared egress scrubber
				// (lib/secrets.ts): secrets on every string field + PII on
				// prompt/thinking — identical contract to the hook egress paths, so
				// `interlinked sync` can no longer leak PII the hook would have caught.
				const scrub = scrubEgressPayload(payload, scrubConfig);
				if (scrub.found > 0) {
					totalScrubbed += scrub.found;
					recordScrub(scrub.types);
				}
				return payload;
			});

			const headers = buildBatchHeaders(token, isLocalDev);
			const body = buildBatchBody(payloadDefaults, batchPayload, workspaceId);
			const batchNum = Math.floor(i / BATCH_SIZE) + 1;

			const outcome = await sendOneBatch({
				serverUrl,
				headers,
				body,
				batchNum,
				batchSize: batch.length,
				mode,
			});
			if (outcome.kind === "auth_failed") {
				outputError(
					mode,
					"Authentication failed. Run 'interlinked login' to re-authenticate.",
				);
				return;
			}
			totalAccepted += outcome.accepted;
			totalSkipped += outcome.skipped;
			totalErrors += outcome.errors;
			batchesSent += outcome.batchesSent;
			retriesUsed += outcome.retriesUsed;
		}

		// Build summary breakdown from the events we just synced
		const { byType, byAgent, byTool, topTools, sessions, earliest, latest } =
			buildBatchSummary(events);

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
					lines.push(
						...renderCountSection("Event Types", typeEntries, (t) => t.replace(/_/g, " ")),
					);

					// Agent breakdown
					const agentEntries = Object.entries(byAgent).sort((a, b) => b[1] - a[1]);
					lines.push(...renderCountSection("Agents", agentEntries));

					// Top tools
					lines.push(...renderTopToolsSection(topTools, byTool));

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

/** Resolved server/auth context for a sync run. */
interface SyncContext {
	serverUrl: string;
	isLocalDev: boolean;
	payloadDefaults: PayloadDefaults;
	token: string | null;
	workspaceId: string | undefined;
}

/**
 * Resolve server URL + auth + workspace targeting. Returns null (after emitting
 * the dev-mode error) when local-dev sync is missing the required workspace_id.
 * resolveConfig() pairs server_url with workspace_id via active_server, so there
 * is no risk of crossing a local workspace_id into production or vice versa.
 */
function resolveSyncContext(mode: Parameters<typeof outputError>[0]): SyncContext | null {
	const config = resolveConfig();
	const serverUrl = config.server_url;
	const isLocalDev = serverUrl.includes("localhost") || serverUrl.includes("127.0.0.1");
	const payloadDefaults: PayloadDefaults = {
		workspaceKey: config.default_workspace_key || "main",
		projectKey: config.default_project || "main",
	};
	// Full token chain (CLI token → Claude Code creds).
	const token = resolveAuthToken();
	// workspace_uuid is required in dev (no OAuth identity to auto-resolve) and
	// recommended in prod (explicit targeting instead of auto-select).
	const workspaceId = config.workspace_id;

	if (isLocalDev && !workspaceId) {
		outputError(
			mode,
			"workspace_id required for local dev sync. Set it in .interlinked/config.local.json under the active server entry.",
		);
		return null;
	}

	return { serverUrl, isLocalDev, payloadDefaults, token, workspaceId };
}

/** Per-batch accumulator deltas, summed into the run totals by the caller. */
interface BatchDelta {
	accepted: number;
	skipped: number;
	errors: number;
	batchesSent: number;
	retriesUsed: number;
}

type BatchSendOutcome = ({ kind: "done" } & BatchDelta) | { kind: "auth_failed" };

interface SendBatchArgs {
	serverUrl: string;
	headers: Record<string, string>;
	body: JsonObject;
	batchNum: number;
	batchSize: number;
	mode: string;
}

interface AttemptContext {
	batchNum: number;
	attempt: number;
	batchSize: number;
	mode: string;
}

type AttemptResult = "retry" | "fail" | "auth_failed";

/**
 * Handle a non-2xx response inside the retry loop. 401 → "auth_failed";
 * transient (429/5xx) with attempts left → "retry"; otherwise terminal "fail"
 * (deltas + stderr updated for the terminal case). Mirrors the original loop.
 */
async function handleNonOkResponse(
	res: Response,
	ctx: AttemptContext,
	delta: BatchDelta,
): Promise<AttemptResult> {
	const { batchNum, attempt, batchSize, mode } = ctx;
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
		return "auth_failed";
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
		delta.retriesUsed++;
		await sleep(RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)]);
		return "retry";
	}

	delta.errors += batchSize;
	if (mode !== "json") {
		process.stderr.write(
			c.dim(`  Batch ${batchNum} failed (${res.status}): ${errBody.slice(0, 100)}\n`),
		);
	}
	return "fail";
}

/**
 * Handle a thrown fetch error (network / AbortError timeout). "retry" if an
 * attempt remains, else terminal "fail" (deltas + stderr updated).
 */
async function handleBatchError(
	err: unknown,
	ctx: AttemptContext,
	delta: BatchDelta,
): Promise<"retry" | "fail"> {
	const { batchNum, attempt, batchSize, mode } = ctx;
	const isTimeout = err instanceof Error && err.name === "AbortError";
	appendSyncError({
		stage: isTimeout ? "manual_sync_timeout" : "manual_sync_network",
		message: err instanceof Error ? err.message : String(err),
		batch: batchNum,
		attempt,
		transient: true,
	});

	if (attempt < MAX_BATCH_RETRIES) {
		delta.retriesUsed++;
		await sleep(RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)]);
		return "retry";
	}

	delta.errors += batchSize;
	if (isTimeout && mode !== "json") {
		process.stderr.write(c.dim("  Batch timed out (10s)\n"));
	}
	return "fail";
}

/**
 * Send one batch with bounded retry/backoff. Returns the accumulator deltas
 * for the run totals, or `auth_failed` so the caller can surface the 401
 * message and abort. Mirrors the original inline retry loop exactly.
 */
async function sendOneBatch(args: SendBatchArgs): Promise<BatchSendOutcome> {
	const { serverUrl, headers, body, batchNum, batchSize, mode } = args;
	const delta: BatchDelta = { accepted: 0, skipped: 0, errors: 0, batchesSent: 0, retriesUsed: 0 };
	let batchSucceeded = false;
	let batchFailureCounted = false;

	for (let attempt = 1; attempt <= MAX_BATCH_RETRIES; attempt++) {
		const ctx: AttemptContext = { batchNum, attempt, batchSize, mode };
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), BATCH_SYNC_REQUEST_TIMEOUT_MS);
			const res = await fetch(`${serverUrl}/api/hooks/activity/batch`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			}).finally(() => clearTimeout(timeout));

			if (res.ok) {
				const result = (await res.json()) as {
					accepted?: number;
					skipped?: number;
					errors?: number;
				};
				delta.accepted += result?.accepted || 0;
				delta.skipped += result?.skipped || 0;
				delta.errors += result?.errors || 0;
				delta.batchesSent++;
				if (attempt > 1) delta.retriesUsed += attempt - 1;
				batchSucceeded = true;
				break;
			}

			const outcome = await handleNonOkResponse(res, ctx, delta);
			if (outcome === "auth_failed") return { kind: "auth_failed" };
			if (outcome === "retry") continue;
			batchFailureCounted = true;
			break;
		} catch (err) {
			const outcome = await handleBatchError(err, ctx, delta);
			if (outcome === "retry") continue;
			batchFailureCounted = true;
			break;
		}
	}

	if (!batchSucceeded && !batchFailureCounted) {
		delta.errors += batchSize;
	}
	return { kind: "done", ...delta };
}
