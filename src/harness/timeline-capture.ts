// ===========================================
// Live timeline capture — daemon-side transcript drain
// ===========================================
// On every daemon event the agent's transcript is drained from the last cursor
// to EOF, parsed into categorized records (transcript-record.ts), and appended
// to .interlinked/timeline.jsonl (timeline-writer.ts). Call this on tool events
// AND on Stop/SessionEnd: the Stop call is what captures a turn's FINAL message
// (an assistant turn that ends in text with no following tool call never fires
// a PreToolUse, so without the Stop drain it would only land at the next turn).
//
// Idempotent against the backfill: a daemon-lifetime per-cwd set of the keys
// already in timeline.jsonl is seeded once from disk, so a fresh cursor
// re-reading a session the backfill already captured does not duplicate it.
//
// Best-effort and fail-open (feedback_safety_continuity): a capture hiccup must
// never break the guard pipeline. The byte-cursor can rarely miss a line caught
// mid-write; the backfill (timeline-backfill.ts) is the completeness backstop.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveTranscriptPath } from "./thinking-capture.js";
import { appendTimelineRecords, existingTimelineKeys, recordKey } from "./timeline-writer.js";
import { parseTranscriptText, type TimelineRecord } from "./transcript-record.js";
import type { HarnessEvent } from "./types.js";

interface Cursor {
	path: string;
	offset: number;
}

function readCursor(cursorPath: string): Cursor {
	try {
		// SAFETY: our own cursor JSON; both fields are guarded before use.
		const c = JSON.parse(readFileSync(cursorPath, "utf-8")) as { path?: string; offset?: number };
		if (typeof c.path === "string" && typeof c.offset === "number") return { path: c.path, offset: c.offset };
	} catch (err) {
		void err; // missing/corrupt cursor → start fresh
	}
	return { path: "", offset: 0 };
}

/** New timeline records appended to `transcriptPath` since the cursor; advances
 *  the cursor to EOF. A path change (new session) re-reads from the start. */
function readNewRecords(transcriptPath: string, cursorPath: string): TimelineRecord[] {
	const size = statSync(transcriptPath).size;
	let cursor = readCursor(cursorPath);
	if (cursor.path !== transcriptPath) cursor = { path: transcriptPath, offset: 0 };
	if (cursor.offset >= size) return [];
	const fd = openSync(transcriptPath, "r");
	const buf = Buffer.alloc(size - cursor.offset);
	readSync(fd, buf, 0, buf.length, cursor.offset);
	closeSync(fd);
	mkdirSync(dirname(cursorPath), { recursive: true });
	writeFileSync(cursorPath, JSON.stringify({ path: transcriptPath, offset: size }));
	return parseTranscriptText(buf.toString("utf-8"));
}

// Daemon-lifetime dedup: the record keys already in timeline.jsonl, per cwd.
// Seeded once from disk on first use, then grown as the live path appends — so
// a cursor-reset (first sight of a session the backfill already captured)
// re-reads its records but appends none of them twice. Bounds the per-event
// cost to a single seed read. Mirrors activity-writer.ts's per-cwd `keyCache`.
const seenKeysByCwd = new Map<string, Set<string>>();

// Cap the per-cwd dedup set so a long-lived daemon can't grow it without bound
// (it otherwise accretes one key per content block ever captured). Sets iterate
// in insertion order, so evicting from the front drops the OLDEST keys — least
// likely to be re-read by a cursor reset — keeping the most recent for correct
// in-session dedup. (The backfill stays the completeness backstop for the rare
// evicted-then-re-read case.)
export const MAX_SEEN_KEYS_PER_CWD = 20_000;

export function boundKeySet(set: Set<string>, max = MAX_SEEN_KEYS_PER_CWD): void {
	const over = set.size - max;
	if (over <= 0) return;
	let removed = 0;
	for (const key of set) {
		set.delete(key);
		if (++removed >= over) break;
	}
}

function seenKeys(cwd: string): Set<string> {
	let set = seenKeysByCwd.get(cwd);
	if (!set) {
		set = existingTimelineKeys(cwd);
		boundKeySet(set); // a huge pre-existing timeline must not seed an unbounded set
		seenKeysByCwd.set(cwd, set);
	}
	return set;
}

/** Records not already in the timeline; records the new keys into `seen`. */
function filterFresh(records: TimelineRecord[], seen: Set<string>): TimelineRecord[] {
	const fresh: TimelineRecord[] = [];
	for (const r of records) {
		const key = recordKey(r);
		if (seen.has(key)) continue;
		seen.add(key);
		fresh.push(r);
	}
	boundKeySet(seen); // hold the daemon-lifetime dedup memory to a bound
	return fresh;
}

/**
 * Drain the event's transcript and append any new records to timeline.jsonl.
 * Best-effort / fail-open. Resolves the transcript from the payload (or the
 * standard `~/.claude/projects/...` layout), reads from the per-cwd cursor at
 * `.interlinked/timeline-cursor.json`, dedups against the timeline, and appends.
 * No-op when the transcript can't be resolved.
 */
export function captureTimeline(event: HarnessEvent, fallbackCwd: string): void {
	try {
		const cwd = event.cwd ?? fallbackCwd;
		const transcriptPath = resolveTranscriptPath(event.transcript_path, event.session_id, cwd, homedir());
		if (!transcriptPath || !existsSync(transcriptPath)) return;
		const cursorPath = join(cwd, ".interlinked", "timeline-cursor.json");
		const fresh = filterFresh(readNewRecords(transcriptPath, cursorPath), seenKeys(cwd));
		if (fresh.length > 0) appendTimelineRecords(fresh, cwd);
	} catch (err) {
		void err; // best-effort capture — never break the daemon pipeline
	}
}

/** Read cap for a one-shot transcript drain. A subagent transcript is
 *  typically well under 1MB; anything past this cap reads only the TAIL
 *  (newest entries win — the final result message is what capture exists
 *  for). Keeps a pathological transcript from stalling the daemon. */
export const MAX_ONESHOT_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

/**
 * One-shot drain of a SUBAGENT transcript into timeline.jsonl. Unlike
 * `captureTimeline` this does NOT touch the per-cwd cursor — the cursor
 * tracks the MAIN session transcript, and pointing it at an agent file
 * would force a full re-read of the main transcript on the next event.
 * Subagent transcripts are separate files (`<session>/subagents/agent-*.jsonl`)
 * that the main cursor never visits, so a full-file read + the daemon-lifetime
 * dedup set gives idempotency without cursor state. Fires on SubagentStop —
 * once per agent (a re-fire after agent resume re-reads and appends only the
 * new records). Best-effort / fail-open. Returns the number of records
 * appended (0 on any failure).
 */
export function captureAgentTranscript(agentTranscriptPath: string | undefined, cwd: string): number {
	try {
		if (!agentTranscriptPath || !existsSync(agentTranscriptPath)) return 0;
		const size = statSync(agentTranscriptPath).size;
		const offset = Math.max(0, size - MAX_ONESHOT_TRANSCRIPT_BYTES);
		const fd = openSync(agentTranscriptPath, "r");
		const buf = Buffer.alloc(size - offset);
		readSync(fd, buf, 0, buf.length, offset);
		closeSync(fd);
		let text = buf.toString("utf-8");
		// A tail read may start mid-line; drop the partial first line.
		if (offset > 0) text = text.slice(text.indexOf("\n") + 1);
		const fresh = filterFresh(parseTranscriptText(text), seenKeys(cwd));
		if (fresh.length > 0) appendTimelineRecords(fresh, cwd);
		return fresh.length;
	} catch (err) {
		void err; // best-effort capture — never break the daemon pipeline
		return 0;
	}
}
