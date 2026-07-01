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
import type { TimelineRecord } from "./transcript-record.js";

export const TIMELINE_FILENAME = "timeline.jsonl";

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
 *  missing. Best-effort: never throws (fail-open, like the rest of capture). */
export function appendTimelineRecords(records: TimelineRecord[], cwd: string): void {
	if (records.length === 0) return;
	try {
		const path = timelinePath(cwd);
		mkdirSync(dirname(path), { recursive: true });
		const body = records.map(serializeRecord).join("\n");
		appendFileSync(path, `${body}\n`);
	} catch (err) {
		void err; // best-effort capture — a write hiccup must never break the pipeline
	}
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
			try {
				// SAFETY: a timeline line is our own JSONL; we read only the two
				// dedup-key fields and guard their presence below.
				const r = JSON.parse(line) as { uuid?: string; seq?: number };
				if (typeof r.uuid === "string" && typeof r.seq === "number") keys.add(`${r.uuid}#${r.seq}`);
			} catch (err) {
				void err; // skip a corrupt line
			}
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
