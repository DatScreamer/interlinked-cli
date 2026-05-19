// ===========================================
// Local Activity — JSONL log, session state, sync
// ===========================================
// Zero external dependencies. Provides local-first activity storage
// so CLI commands work offline and can sync later.

import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { buildCollectionRecord } from "./collection/builder.js";
import { appendCollection } from "./collection/writer.js";
import { getDataDir } from "./config.js";
import type { JsonObject } from "./json-types.js";

// ===========================================
// Types
// ===========================================

export interface TokenUsage {
	input?: number;
	output?: number;
	cache_read?: number;
	cache_creation?: number;
}

export interface EventAttribution {
	agent_lines?: number;
	human_lines?: number;
}

export interface LocalActivityEvent {
	ts: string;
	agent: string;
	workspace_key?: string | null;
	project_key?: string | null;
	type: string;
	tool?: string | null;
	summary?: string | null;
	session?: string | null;
	hook?: string | null;

	// v2 additions
	schema_version?: 2 | 3;
	trace_id?: string;
	parent_agent?: string;
	subagent_id?: string;
	tokens?: TokenUsage;
	duration_ms?: number;
	files_modified?: string[];
	attribution?: EventAttribution;
	checkpoint_id?: string;
	scrubbed?: boolean;

	// v3/v4 full-capture fields
	tool_input?: unknown;
	tool_response?: unknown;
	tool_use_id?: string;
	error?: unknown;
	is_interrupt?: boolean;
	cwd?: string;
	permission_mode?: string;
	transcript_path?: string;
	model?: string;
	source?: string;
	agent_type?: string;
	last_assistant_message?: string;
	agent_transcript_path?: string;
	prompt?: string;
	notification_type?: string;
	notification_title?: string;
	notification_message?: string;
	task_id?: string;
	task_subject?: string;
	task_description?: string;
	teammate_name?: string;
	team_name?: string;
	trigger?: string;
	custom_instructions?: string;
	reason?: string;
	stop_hook_active?: boolean;
	permission_suggestions?: unknown;

	// v4 capture fields — error annotation, payload sizes, git context.
	// Written by the hook's appendLocal; see hook-template-chunks/.
	error_message?: string;
	error_category?: string;
	tool_input_bytes?: number;
	tool_output_bytes?: number;
	git_head?: string;
	git_branch?: string;
}

export interface SubagentState {
	files_touched: string[];
	tools_used: Record<string, number>;
	tool_count: number;
	tokens?: { input: number; output: number };
}

export interface SessionState {
	session_id: string;
	agent: string;
	phase: "ACTIVE" | "ENDED";
	started_at: string;
	last_event_at: string;
	tool_count: number;
	error_count: number;
	files_touched: string[];
	tools_used: Record<string, number>;

	// v2 additions
	tokens_total?: TokenUsage;
	token_events?: number;
	subagents?: Record<string, SubagentState>;

	// v3 additions: code activity tracking
	session_start_head?: string;
	edits?: CodeEdit[];
	by_agent?: Record<string, AgentContribution>;
	commits?: CommitAttribution[];
}

/** A single code edit captured from a PostToolUse event. Append-only. */
export interface CodeEdit {
	timestamp: string;
	session_id: string;
	agent_name: string;
	file: string;
	tool: "Edit" | "Write";
	lines_added: number;
	lines_removed: number;
	old_string?: string;
	new_string?: string;
	full_write?: boolean;
}

/** Per-agent aggregation within a session. Computed from CodeEdit array. */
export interface AgentContribution {
	agent_name: string;
	session_id: string;
	files_touched: string[];
	total_added: number;
	total_removed: number;
	edit_count: number;
}

/** Attribution reconciled against an actual git commit. */
export interface CommitAttribution {
	commit_hash: string;
	timestamp: string;
	message?: string;
	files: {
		file: string;
		net_added: number;
		net_removed: number;
		agents: {
			agent_name: string;
			added: number;
			removed: number;
			percentage: number;
		}[];
	}[];
	human_email?: string;
}

export interface LastSyncSummary {
	server_url: string;
	workspace_id: string | null;
	events_total: number;
	accepted: number;
	skipped: number;
	scrubbed: number;
	batches: number;
	by_type: Record<string, number>;
	by_agent: Record<string, number>;
	top_tools: [string, number][];
	sessions: number;
	time_range: { earliest: string; latest: string };
}

interface SyncState {
	synced_through_bytes: number;
	last_sync_at: string;
	last_summary?: LastSyncSummary;
}

export interface SyncDiagnostics {
	pending_realtime_retry: number;
	sync_error_count: number;
	last_sync_success_at?: string;
	last_sync_error_at?: string;
	last_sync_error?: string;
}

export interface LocalStats {
	total_events: number;
	file_size_bytes: number;
	pending_sync: number;
	oldest_event?: string;
	newest_event?: string;
}

// ===========================================
// Path Helpers
// ===========================================

function getActivityPath(cwd: string = process.cwd()): string {
	return join(getDataDir(cwd), "activity.jsonl");
}

function getSessionsDir(cwd: string = process.cwd()): string {
	return join(getDataDir(cwd), "sessions");
}

function getSyncStatePath(cwd: string = process.cwd()): string {
	return join(getDataDir(cwd), "sync-state.json");
}

function getRealtimeRetryPath(cwd: string = process.cwd()): string {
	return join(getDataDir(cwd), "realtime-retry.jsonl");
}

function getSyncErrorsPath(cwd: string = process.cwd()): string {
	return join(getDataDir(cwd), "sync-errors.jsonl");
}

// ===========================================
// JSONL Write
// ===========================================

/**
 * Append a single activity event to the local JSONL log.
 * Synchronous (~0.1ms) — safe to call from hook scripts.
 */
export function appendLocalActivity(event: LocalActivityEvent, cwd?: string): void {
	const resolvedCwd = cwd || process.cwd();
	const activityPath = getActivityPath(resolvedCwd);
	const dir = dirname(activityPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	appendFileSync(activityPath, `${JSON.stringify(event)}\n`);

	const collectionRecord = buildCollectionRecord({ ...event });
	if (collectionRecord) {
		appendCollection(collectionRecord, resolvedCwd);
	}
}

// ===========================================
// JSONL Read
// ===========================================

/**
 * Read and filter local activity events from the JSONL log.
 */
export function readLocalActivity(opts?: {
	since?: number; // ms cutoff timestamp
	agent?: string;
	limit?: number;
	type?: string;
	cwd?: string;
}): LocalActivityEvent[] {
	const path = getActivityPath(opts?.cwd);
	if (!existsSync(path)) return [];

	const limit = opts?.limit && opts.limit > 0 ? opts.limit : undefined;
	const scanLineBudget = limit ? Math.max(limit * 20, 500) : 10000;
	const lines = readRecentLines(path, scanLineBudget);
	const events: LocalActivityEvent[] = [];

	for (const line of lines) {
		try {
			const event = JSON.parse(line) as LocalActivityEvent;
			if (opts?.since && new Date(event.ts).getTime() < opts.since) {
				// We read newest -> oldest, so older lines won't match either.
				break;
			}
			if (opts?.agent && event.agent !== opts.agent) {
				continue;
			}
			if (opts?.type && event.type !== opts.type) {
				continue;
			}
			events.push(event);
			if (limit && events.length >= limit) {
				break;
			}
		} catch (_err) {
			/* intentional: skip malformed JSONL lines to keep log readable */
		}
	}

	return events;
}

// ===========================================
// Session State
// ===========================================

/**
 * Read all session state files.
 */
export function readLocalSessions(cwd?: string): SessionState[] {
	const dir = getSessionsDir(cwd);
	if (!existsSync(dir)) return [];

	const sessions: SessionState[] = [];
	try {
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".json")) continue;
			try {
				const data = JSON.parse(readFileSync(join(dir, file), "utf-8"));
				sessions.push(data);
			} catch (_err) {
				/* intentional: skip unreadable or malformed session files */
			}
		}
	} catch (_err) {
		/* intentional: sessions directory not readable — return whatever we have so far */
	}
	return sessions;
}

// ===========================================
// Sync State
// ===========================================

/**
 * Read the sync cursor (byte offset into activity.jsonl).
 */
export function readSyncState(cwd?: string): SyncState {
	const path = getSyncStatePath(cwd);
	if (!existsSync(path)) {
		return { synced_through_bytes: 0, last_sync_at: "" };
	}
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (_err) {
		/* intentional: malformed sync-state JSON — reset to "never synced" */
		return { synced_through_bytes: 0, last_sync_at: "" };
	}
}

/**
 * Advance the sync cursor and optionally store last sync summary.
 */
export function updateSyncState(
	syncedBytes: number,
	summary?: LastSyncSummary,
	cwd?: string,
): void {
	const path = getSyncStatePath(cwd);
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const state: SyncState = {
		synced_through_bytes: syncedBytes,
		last_sync_at: new Date().toISOString(),
	};
	if (summary) {
		state.last_summary = summary;
	}
	writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** Cap for sync-errors.jsonl before rotation. 10 MB is enough to keep
 *  a few thousand recent failures while preventing the multi-GB bloat
 *  observed in production (a single workspace grew this file to 3 GB
 *  with one identical "fetch failed" message per realtime POST). */
const SYNC_ERRORS_MAX_BYTES = 10 * 1024 * 1024;

function rotateSyncErrorsIfNeeded(path: string): void {
	try {
		if (!existsSync(path)) return;
		const size = statSync(path).size;
		if (size < SYNC_ERRORS_MAX_BYTES) return;
		// Single-generation retention: rename to .1 (overwriting any
		// existing .1) and start fresh. A real-world flapping network
		// can fill 10 MB in seconds; deeper retention is wasted bytes.
		const archived = `${path}.1`;
		if (existsSync(archived)) {
			try {
				unlinkSync(archived);
			} catch (_err) {
				/* intentional: stale archive — rename will overwrite on POSIX */
			}
		}
		renameSync(path, archived);
	} catch (_err) {
		/* intentional: rotation is best-effort. If it fails, the next
		   appendSyncError call will continue past the cap until rotation
		   eventually succeeds — no data loss, just delayed cleanup. */
	}
}

/**
 * Persist sync diagnostics for failed pushes and retry outcomes.
 */
export function appendSyncError(
	entry: {
		stage: string;
		message: string;
		status?: number;
		batch?: number;
		attempt?: number;
		transient?: boolean;
	},
	cwd?: string,
): void {
	const path = getSyncErrorsPath(cwd);
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	rotateSyncErrorsIfNeeded(path);
	appendFileSync(
		path,
		`${JSON.stringify({
			ts: new Date().toISOString(),
			stage: entry.stage,
			message: entry.message,
			status: entry.status,
			batch: entry.batch,
			attempt: entry.attempt,
			transient: entry.transient ?? false,
		})}\n`,
	);
}

export interface UnsyncedEvents {
	events: LocalActivityEvent[];
	newOffset: number;
}

/**
 * Read unsynced events from the JSONL log (from byte offset to EOF).
 */
export function getUnsyncedEvents(limit?: number, cwd?: string): UnsyncedEvents {
	const activityPath = getActivityPath(cwd);
	if (!existsSync(activityPath)) {
		return { events: [], newOffset: 0 };
	}

	const syncState = readSyncState(cwd);
	const fileSize = statSync(activityPath).size;

	if (syncState.synced_through_bytes >= fileSize) {
		return { events: [], newOffset: fileSize };
	}

	// Read from offset to EOF using low-level fs
	const bytesToRead = fileSize - syncState.synced_through_bytes;
	const fd = openSync(activityPath, "r");
	const buffer = Buffer.alloc(bytesToRead);
	readSync(fd, buffer, 0, bytesToRead, syncState.synced_through_bytes);
	closeSync(fd);

	const chunk = buffer.toString("utf-8");
	const lines = chunk.split("\n").filter(Boolean);

	const events: LocalActivityEvent[] = [];
	for (const line of lines) {
		try {
			events.push(JSON.parse(line));
		} catch (_err) {
			/* intentional: malformed JSONL — skip so sync can proceed */
		}
	}

	if (limit && events.length > limit) {
		// Calculate byte offset for partial sync
		let partialBytes = 0;
		const partialEvents: LocalActivityEvent[] = [];
		for (const line of lines) {
			if (partialEvents.length >= limit) break;
			try {
				partialEvents.push(JSON.parse(line));
				partialBytes += Buffer.byteLength(`${line}\n`, "utf-8");
			} catch (_err) {
				/* intentional: still advance offset past the malformed line to avoid infinite retry */
				partialBytes += Buffer.byteLength(`${line}\n`, "utf-8");
			}
		}
		return {
			events: partialEvents,
			newOffset: syncState.synced_through_bytes + partialBytes,
		};
	}

	return { events, newOffset: fileSize };
}

// ===========================================
// Stats
// ===========================================

/**
 * Get summary stats about local activity.
 */
export function getLocalStats(cwd?: string): LocalStats {
	const path = getActivityPath(cwd);
	if (!existsSync(path)) {
		return { total_events: 0, file_size_bytes: 0, pending_sync: 0 };
	}

	const fileSize = statSync(path).size;
	const syncState = readSyncState(cwd);
	const pendingBytes = Math.max(0, fileSize - syncState.synced_through_bytes);

	// Read first and last lines for timestamp range
	let lines: string[];
	try {
		lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
	} catch (_err) {
		/* intentional: activity.jsonl unreadable — report empty stats */
		return { total_events: 0, file_size_bytes: fileSize, pending_sync: 0 };
	}

	let oldest: string | undefined;
	let newest: string | undefined;
	if (lines.length > 0) {
		try {
			oldest = JSON.parse(lines[0]).ts;
		} catch (_err) {
			/* intentional: first line unparseable — leave oldest undefined */
		}
		try {
			newest = JSON.parse(lines[lines.length - 1]).ts;
		} catch (_err) {
			/* intentional: last line unparseable — leave newest undefined */
		}
	}

	// Estimate pending event count from pending bytes ratio
	const pendingSyncEstimate =
		lines.length > 0 ? Math.round((pendingBytes / fileSize) * lines.length) : 0;

	return {
		total_events: lines.length,
		file_size_bytes: fileSize,
		pending_sync: pendingSyncEstimate,
		oldest_event: oldest,
		newest_event: newest,
	};
}

/**
 * Return sync health details for status/reporting.
 */
export function getSyncDiagnostics(cwd?: string): SyncDiagnostics {
	const syncState = readSyncState(cwd);
	const pendingRealtimeRetry = countJsonlLines(getRealtimeRetryPath(cwd));

	const errorPath = getSyncErrorsPath(cwd);
	const errorLines = existsSync(errorPath) ? readRecentLines(errorPath, 5000) : [];
	const syncErrorCount = errorLines.length;

	let lastSyncErrorAt: string | undefined;
	let lastSyncError: string | undefined;
	if (syncErrorCount > 0) {
		try {
			const parsed = JSON.parse(errorLines[0]) as { ts?: string; message?: string };
			lastSyncErrorAt = parsed.ts;
			lastSyncError = parsed.message;
		} catch (_err) {
			/* intentional: malformed sync-error line — keep diagnostics best-effort */
		}
	}

	return {
		pending_realtime_retry: pendingRealtimeRetry,
		sync_error_count: syncErrorCount,
		last_sync_success_at: syncState.last_sync_at || undefined,
		last_sync_error_at: lastSyncErrorAt,
		last_sync_error: lastSyncError,
	};
}

// ===========================================
// Merge & Dedup
// ===========================================

/**
 * Merge local and server events, deduplicating within a 2-second bucket.
 * Server events are authoritative (kept over local on collision).
 * Accepts any object with optional timestamp/agent/type/tool fields.
 */
export function mergeAndDedup<T extends JsonObject>(local: T[], server: T[]): T[] {
	// Build dedup keys for server events (authoritative)
	const serverKeys = new Set<string>();
	for (const e of server) {
		serverKeys.add(dedupKey(e));
	}

	// Filter local events that don't collide with server
	const uniqueLocal = local.filter((e) => !serverKeys.has(dedupKey(e)));

	// Combine and sort by timestamp (newest first)
	const merged = [...server, ...uniqueLocal];
	merged.sort((a, b) => {
		const tsA = getTimestamp(a);
		const tsB = getTimestamp(b);
		return new Date(tsB).getTime() - new Date(tsA).getTime();
	});

	return merged;
}

function dedupKey(e: JsonObject): string {
	const ts = getTimestamp(e);
	const agent = (e.agent || e.agent_name || "") as string;
	const type = (e.type || e.event_type || "") as string;
	const tool = (e.tool || e.tool_name || "") as string;
	// Bucket to 2-second window
	const bucket = ts ? Math.floor(new Date(ts).getTime() / 2000) : 0;
	return `${agent}|${type}|${tool}|${bucket}`;
}

function getTimestamp(e: JsonObject): string {
	return (e.ts || e.occurred_at || e.timestamp || e.created_at || "") as string;
}

// ===========================================
// Helpers
// ===========================================

function readRecentLines(path: string, maxLines: number): string[] {
	if (maxLines <= 0) {
		return [];
	}

	const fileSize = statSync(path).size;
	if (fileSize <= 0) {
		return [];
	}

	const fd = openSync(path, "r");
	const chunkSize = 64 * 1024;
	let position = fileSize;
	let carry = "";
	const lines: string[] = [];

	try {
		while (position > 0 && lines.length < maxLines) {
			const readSize = Math.min(chunkSize, position);
			position -= readSize;

			const buffer = Buffer.alloc(readSize);
			readSync(fd, buffer, 0, readSize, position);

			const chunk = buffer.toString("utf-8") + carry;
			const parts = chunk.split("\n");
			carry = parts.shift() || "";

			for (let i = parts.length - 1; i >= 0 && lines.length < maxLines; i--) {
				const line = parts[i].trim();
				if (line) {
					lines.push(line);
				}
			}
		}

		if (carry.trim() && lines.length < maxLines) {
			lines.push(carry.trim());
		}

		return lines;
	} finally {
		closeSync(fd);
	}
}

function countJsonlLines(path: string): number {
	if (!existsSync(path)) {
		return 0;
	}
	try {
		return readFileSync(path, "utf-8")
			.split("\n")
			.filter((line) => line.trim().length > 0).length;
	} catch (_err) {
		/* intentional: unreadable jsonl — report 0 lines rather than surface the error */
		return 0;
	}
}
