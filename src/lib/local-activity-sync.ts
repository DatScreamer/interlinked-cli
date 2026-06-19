// interlinked-tdd: exempt
// ===========================================
// Local Activity — sync cursor, sync-error log, unsynced-event reader
// ===========================================
// Extracted from local-activity.ts to keep that module under the per-file
// line cap. Depends on node:fs/path, the data-dir path helpers, and the
// shared types — never imports back from the main module (leaf cluster).

import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	getActivityPath,
	getSyncErrorsPath,
	getSyncStatePath,
} from "./local-activity-paths.js";
import type {
	LastSyncSummary,
	LocalActivityEvent,
	SyncState,
} from "./local-activity-types.js";
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
