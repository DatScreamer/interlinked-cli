// ===========================================
// Timeline backfill — reconstruct timeline.jsonl from existing transcripts
// ===========================================
// The daemon only began capturing agent messages going forward; everything
// before that (and everything from sessions the live path never saw) still
// lives in Claude Code's per-session transcripts at
// ~/.claude/projects/<slug>/<session>.jsonl. This module walks all of them,
// parses every entry via the shared parser, and rebuilds the unified
// timeline.jsonl time-sorted "as if it had been appended in real time."
//
// Idempotent: dedup is by `${uuid}#${seq}` inside writeTimeline, so re-running
// the backfill — or backfilling a session the live path already captured —
// reproduces the same file rather than duplicating rows.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { timelinePath, writeTimeline } from "./timeline-writer.js";
import { parseTranscriptText, type TimelineRecord } from "./transcript-record.js";

/** Resolve the Claude Code transcript directory for a project cwd:
 *  `~/.claude/projects/<cwd-with-slashes-as-dashes>/`. */
export function transcriptDir(cwd: string, homeDir: string): string {
	const slug = cwd.replace(/\//g, "-");
	return join(homeDir, ".claude", "projects", slug);
}

/** The `.jsonl` transcript file names in a directory (empty if it's missing). */
function transcriptFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
}

/** Every timeline record from all transcripts of a project, in per-file order.
 *  Skips unreadable transcripts. Never throws. */
export function collectTranscriptRecords(cwd: string, homeDir: string): TimelineRecord[] {
	const dir = transcriptDir(cwd, homeDir);
	const out: TimelineRecord[] = [];
	for (const name of transcriptFiles(dir)) {
		try {
			out.push(...parseTranscriptText(readFileSync(join(dir, name), "utf-8")));
		} catch (err) {
			void err; // unreadable transcript — skip
		}
	}
	return out;
}

/** Summary of a backfill run. */
export interface BackfillResult {
	dir: string;
	transcripts: number;
	records: number;
	path: string;
}

/** Rebuild `.interlinked/timeline.jsonl` from every project transcript,
 *  time-sorted + deduped. Returns a run summary. */
export function backfillTimeline(cwd: string, homeDir: string): BackfillResult {
	const dir = transcriptDir(cwd, homeDir);
	const transcripts = transcriptFiles(dir).length;
	const records = writeTimeline(collectTranscriptRecords(cwd, homeDir), cwd);
	return { dir, transcripts, records, path: timelinePath(cwd) };
}
