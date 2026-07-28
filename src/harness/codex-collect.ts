// ===========================================
// Codex session collector — sync ~/.codex/sessions/ rollouts into the unified
// .interlinked/timeline.jsonl store (parity with the Claude live/backfill path).
// ===========================================
// Codex keeps its transcripts in a global, prunable dir; this folds them into
// the repo's normalized `timeline.v1` store so every model's input+output lives
// in ONE place (project ask 2026-07-18). Idempotent: dedup key `${uuid}#${seq}`
// means re-running only appends genuinely new records, so it is safe to call on
// a timer or after every `codex exec` review.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseCodexRolloutText } from "./codex-rollout.js";
import { appendTimelineRecords, existingTimelineKeys, recordKey, sortTimeline } from "./timeline-writer.js";
import type { TimelineRecord } from "./transcript-record.js";

/** Default Codex session root (`~/.codex/sessions`). */
export function codexSessionsDir(): string {
	return join(homedir(), ".codex", "sessions");
}

/** All `rollout-*.jsonl` files under `dir` (recursive), optionally only those
 *  modified at/after `sinceMs`. Bounded, depth-first, never throws on a missing
 *  or unreadable subtree. */
export function findCodexRollouts(dir: string, sinceMs?: number): string[] {
	const out: string[] = [];
	const walk = (d: string, depth: number): void => {
		if (depth > 6) return; // .../YYYY/MM/DD/file — 4 is enough; 6 is slack
		let entries: string[];
		try {
			entries = readdirSync(d);
		} catch {
			return;
		}
		for (const name of entries) {
			const full = join(d, name);
			let st: ReturnType<typeof statSync>;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				walk(full, depth + 1);
			} else if (/^rollout-.*\.jsonl$/.test(name)) {
				if (sinceMs === undefined || st.mtimeMs >= sinceMs) out.push(full);
			}
		}
	};
	walk(dir, 0);
	return out;
}

export interface CollectResult {
	/** Rollout files scanned. */
	files: number;
	/** Records parsed across all files (before dedup). */
	parsed: number;
	/** Genuinely-new records appended to the timeline. */
	added: number;
	/** Distinct Codex sessions represented in the appended records. */
	sessions: number;
}

/**
 * Sync Codex rollouts into `<cwd>/.interlinked/timeline.jsonl`. Only records
 * whose `${uuid}#${seq}` key is not already present are appended (dedup against
 * both the existing file and within this batch). `dryRun` reports counts
 * without writing. Never throws — a bad file is skipped.
 */
export function collectCodexSessions(opts: {
	cwd: string;
	dir?: string;
	sinceMs?: number;
	dryRun?: boolean;
}): CollectResult {
	const dir = opts.dir ?? codexSessionsDir();
	const files = findCodexRollouts(dir, opts.sinceMs);
	const existing = existingTimelineKeys(opts.cwd);
	const toAppend: TimelineRecord[] = [];
	const sessions = new Set<string>();
	let parsed = 0;
	for (const f of files) {
		let recs: TimelineRecord[];
		try {
			recs = parseCodexRolloutText(readFileSync(f, "utf8"));
		} catch {
			continue; // unreadable/corrupt rollout — skip
		}
		parsed += recs.length;
		for (const r of recs) {
			const k = recordKey(r);
			if (existing.has(k)) continue;
			existing.add(k); // dedup within this batch too
			toAppend.push(r);
			sessions.add(r.session);
		}
	}
	if (!opts.dryRun && toAppend.length > 0) {
		appendTimelineRecords(sortTimeline(toAppend), opts.cwd);
	}
	return { files: files.length, parsed, added: toAppend.length, sessions: sessions.size };
}
