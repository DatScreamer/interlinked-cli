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
import type { CollectionAction, CollectionRecord } from "./collection/types.js";
import { appendCollection, getCollectionPath } from "./collection/writer.js";
import { getDataDir } from "./config.js";
import type { JsonObject } from "./json-types.js";

// ===========================================
// Types
// ===========================================
// All type/interface definitions live in `local-activity-types.ts` (extracted to
// keep this module under the per-file line cap). The ones used in this module's
// own signatures are imported here; every previously-exported type is re-exported
// so existing `import { ... } from "./local-activity.js"` call sites are unchanged.
import type {
	LastSyncSummary,
	LocalActivityEvent,
	LocalStats,
	SessionState,
	SyncDiagnostics,
	SyncState,
} from "./local-activity-types.js";

export type {
	AgentContribution,
	CodeEdit,
	CommitAttribution,
	EventAttribution,
	LastSyncSummary,
	LocalActivityEvent,
	LocalStats,
	SessionState,
	SubagentState,
	SyncDiagnostics,
	TokenUsage,
} from "./local-activity-types.js";

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
/**
 * Append a single activity event to activity.jsonl ONLY — no collection.jsonl
 * mirror. Used by the daemon's legacy-stream dual-write, which writes the
 * canonical collection.jsonl via its own path (server/collection-writer.ts) and
 * must not double-write it here.
 */
export function appendActivityRecordOnly(event: LocalActivityEvent, cwd?: string): void {
	const resolvedCwd = cwd || process.cwd();
	const activityPath = getActivityPath(resolvedCwd);
	const dir = dirname(activityPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	appendFileSync(activityPath, `${JSON.stringify(event)}\n`);
}

export function appendLocalActivity(event: LocalActivityEvent, cwd?: string): void {
	const resolvedCwd = cwd || process.cwd();
	appendActivityRecordOnly(event, resolvedCwd);

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
	since?: number | undefined; // ms cutoff timestamp
	agent?: string | undefined;
	limit?: number | undefined;
	type?: string | undefined;
	cwd?: string | undefined;
}): LocalActivityEvent[] {
	// Canonical source is collection.jsonl; fall back to the legacy activity.jsonl
	// only when it is absent (older installs / the daemon never ran).
	if (existsSync(getCollectionPath(opts?.cwd ?? process.cwd()))) {
		return readCollectionActivity(opts);
	}
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
// Collection-stream reader (canonical source)
// ===========================================
// Projects collection.v1 records onto the legacy v5 display shape so the CLI
// reader commands consume the canonical collection.jsonl directly. Inverse of
// the daemon's activity-writer mapping (server/activity-writer.ts).

/** Best human label for a collection action: command / path / pattern / url. */
function summarizeAction(action: CollectionAction | null): string | null {
	if (!action) return null;
	const a = action as {
		command?: unknown;
		path?: unknown;
		pattern?: unknown;
		url?: unknown;
		task?: unknown;
		tool?: unknown;
	};
	const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
	return (
		str(a.command) ??
		str(a.path) ??
		str(a.pattern) ??
		str(a.url) ??
		str(a.task) ??
		str(a.tool) ??
		null
	);
}

/** Project one collection.v1 record to a v5 LocalActivityEvent. */
function collectionToActivity(rec: CollectionRecord): LocalActivityEvent {
	const isPre = rec.phase === "pre";
	// Reconstruct the failed-tool discriminator from the record's `outcome` so a
	// `logs --type tool_use_error` query still surfaces failures once collection.jsonl
	// is canonical (finding 5). A post record with `outcome: "error"` → `tool_use_error`;
	// everything else (including legacy records with no `outcome`) reads as `tool_use`.
	const postType = rec.outcome === "error" ? "tool_use_error" : "tool_use";
	const ev: LocalActivityEvent = {
		schema_version: 5,
		ts: rec.ts,
		agent: rec.agent_name ?? rec.provider ?? "unknown",
		type: isPre ? "tool_use_start" : postType,
		tool: rec.provider_tool,
		summary: summarizeAction(rec.action),
		session: rec.session_id,
		hook: isPre ? "PreToolUse" : "PostToolUse",
	};
	if (rec.cwd) ev.cwd = rec.cwd;
	if (rec.tool_use_id) ev.tool_use_id = rec.tool_use_id;
	return ev;
}

/** Read recent tool activity from collection.jsonl, projected to the v5 display
 *  shape, applying the same since/agent/type/limit filters as readLocalActivity.
 *  Newest-first (mirrors readRecentLines order). */
function readCollectionActivity(opts?: {
	since?: number | undefined;
	agent?: string | undefined;
	limit?: number | undefined;
	type?: string | undefined;
	cwd?: string | undefined;
}): LocalActivityEvent[] {
	const path = getCollectionPath(opts?.cwd ?? process.cwd());
	if (!existsSync(path)) return [];
	const limit = opts?.limit && opts.limit > 0 ? opts.limit : undefined;
	const scanLineBudget = limit ? Math.max(limit * 20, 500) : 10000;
	const events: LocalActivityEvent[] = [];
	for (const line of readRecentLines(path, scanLineBudget)) {
		try {
			const ev = collectionToActivity(JSON.parse(line) as CollectionRecord);
			if (opts?.since && new Date(ev.ts).getTime() < opts.since) break;
			if (opts?.agent && ev.agent !== opts.agent) continue;
			if (opts?.type && ev.type !== opts.type) continue;
			events.push(ev);
			if (limit && events.length >= limit) break;
		} catch {
			continue;
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
