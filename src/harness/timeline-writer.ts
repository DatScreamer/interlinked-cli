// ===========================================
// Timeline writer — append / rebuild .interlinked/timeline.jsonl
// ===========================================
// The unified, append-only, time-sorted record of everything an agent did,
// one categorized `TimelineRecord` per line (see transcript-record.ts). Two
// write paths share this module:
//   - LIVE   — `appendTimelineRecords` appends new records as the daemon drains
//              the transcript on each event (timeline-capture.ts). Fail-open.
//   - BACKFILL — `writeTimeline` rebuilds the whole file, time-sorted + deduped,
//              from every transcript (timeline-backfill.ts). Idempotent.
//
// Dedup key is `${uuid}#${seq}` (entry uuid + block index): stable across
// re-runs, so backfilling twice — or backfilling a session the live path
// already captured — reproduces the same file rather than duplicating rows.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject } from "../lib/json-types.js";
import { readRecentLines } from "../lib/local-activity-collection.js";
import type { TimelineRecord } from "./transcript-record.js";

export const TIMELINE_FILENAME = "timeline.jsonl";
/** Live-capture seed bound. Backfill keeps the full reader below; the daemon
 * only needs the same recent key window it retains in memory. */
export const RECENT_TIMELINE_KEY_BYTES = 4 * 1024 * 1024;

// Unicode line/paragraph separators, derived by code point so they never appear
// as literal line terminators in this source file. `JSON.stringify` leaves them
// UNescaped (valid in a JSON string, but editors — VS Code's
// `unusualLineTerminators` — and some JS parsers treat them as line breaks, so a
// record appears to span multiple physical lines). See `serializeRecord`.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** Absolute path to the timeline log for a working dir. */
export function timelinePath(cwd: string): string {
	return join(cwd, ".interlinked", TIMELINE_FILENAME);
}

/** The stable dedup key for a record: `${uuid}#${seq}`. */
export function recordKey(r: TimelineRecord): string {
	return `${r.uuid}#${r.seq}`;
}

/** Serialize a record to one JSONL line, escaping the Unicode line/paragraph
 *  separators `JSON.stringify` leaves raw — so every record stays on one
 *  physical line. `JSON.parse` decodes the escapes back to the original
 *  characters, so the captured text round-trips identically. */
export function serializeRecord(r: TimelineRecord): string {
	return JSON.stringify(r).replaceAll(LINE_SEPARATOR, "\\u2028").replaceAll(PARAGRAPH_SEPARATOR, "\\u2029");
}

/** Append records as JSONL to the timeline log (live path). Creates the dir if
 *  missing. Best-effort: never throws (fail-open, like the rest of capture).
 *  Returns whether every record was appended so callers can commit cursors and
 *  in-memory dedup state only after durable-enough filesystem success. */
export function appendTimelineRecords(records: TimelineRecord[], cwd: string): boolean {
	if (records.length === 0) return true;
	try {
		const path = timelinePath(cwd);
		mkdirSync(dirname(path), { recursive: true });
		const body = records.map(serializeRecord).join("\n");
		appendFileSync(path, `${body}\n`);
		return true;
	} catch (err) {
		void err; // best-effort capture — a write hiccup must never break the pipeline
		return false;
	}
}

/** One JSONL line's dedup key (`uuid#seq`), or null when the line is corrupt
 *  or its `uuid`/`seq` fields are missing or the wrong type. Never throws. */
function parseTimelineDedupKey(line: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (!isJsonObject(parsed)) return null;
	const { uuid, seq } = parsed;
	if (typeof uuid !== "string" || typeof seq !== "number") return null;
	return `${uuid}#${seq}`;
}

/** The dedup keys already present in the timeline log, for idempotent
 *  append/rebuild. Empty set if the log is missing/unreadable. Never throws. */
export function existingTimelineKeys(cwd: string): Set<string> {
	const keys = new Set<string>();
	const path = timelinePath(cwd);
	if (!existsSync(path)) return keys;
	try {
		for (const line of readFileSync(path, "utf-8").split("\n")) {
			if (!line.trim()) continue;
			const key = parseTimelineDedupKey(line);
			if (key !== null) keys.add(key);
		}
	} catch (err) {
		void err;
	}
	return keys;
}

/** Recent dedup keys for the daemon's bounded live-capture cache. Reads from
 * the file tail directly; unlike {@link existingTimelineKeys}, it never
 * materializes the full append-only timeline. Newest rows win. */
export function recentTimelineKeys(
	cwd: string,
	maxKeys: number,
	maxBytes: number = RECENT_TIMELINE_KEY_BYTES,
): Set<string> {
	const keys = new Set<string>();
	if (maxKeys <= 0 || maxBytes <= 0) return keys;
	try {
		for (const line of readRecentLines(timelinePath(cwd), maxKeys, maxBytes)) {
			const key = parseTimelineDedupKey(line);
			if (key !== null) keys.add(key);
		}
	} catch (err) {
		void err;
	}
	return keys;
}

/** Sort records into real-time order: by timestamp, then session, then block
 *  index. Stable, so equal-timestamp records keep input (file) order. ISO-8601
 *  timestamps compare chronologically as strings. */
export function sortTimeline(records: TimelineRecord[]): TimelineRecord[] {
	return [...records].sort((a, b) => {
		if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
		if (a.session !== b.session) return a.session < b.session ? -1 : 1;
		return a.seq - b.seq;
	});
}

/** Dedup by `${uuid}#${seq}`, preserving first occurrence. */
export function dedupeTimeline(records: TimelineRecord[]): TimelineRecord[] {
	const seen = new Set<string>();
	const out: TimelineRecord[] = [];
	for (const r of records) {
		const k = recordKey(r);
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(r);
	}
	return out;
}

/** Write the full, sorted, deduped record set to the timeline log (backfill /
 *  rebuild path — REPLACES the file). Creates the dir if missing. Returns the
 *  count written. */
export function writeTimeline(records: TimelineRecord[], cwd: string): number {
	const ordered = dedupeTimeline(sortTimeline(records));
	const path = timelinePath(cwd);
	mkdirSync(dirname(path), { recursive: true });
	const body = ordered.map(serializeRecord).join("\n");
	writeFileSync(path, ordered.length > 0 ? `${body}\n` : "");
	return ordered.length;
}
