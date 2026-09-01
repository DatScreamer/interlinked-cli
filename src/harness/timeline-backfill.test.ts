import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backfillTimeline, collectTranscriptRecords, transcriptDir } from "./timeline-backfill.js";
import {
	MAX_TIMELINE_REWRITE_BYTES,
	TimelineRewriteConflictError,
} from "./timeline-writer.js";

function line(obj: Record<string, unknown>): string {
	return JSON.stringify(obj);
}

describe("timeline-backfill", () => {
	let cwd: string;
	let home: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "tl-cwd-"));
		home = mkdtempSync(join(tmpdir(), "tl-home-"));
		const dir = transcriptDir(cwd, home);
		mkdirSync(dir, { recursive: true });
		// Two sessions, deliberately out of timestamp order across files.
		writeFileSync(
			join(dir, "sess-b.jsonl"),
			line({
				type: "assistant",
				uuid: "b1",
				timestamp: "2026-06-28T10:00:02.000Z",
				sessionId: "B",
				message: { model: "claude-test-5", content: [{ type: "text", text: "later message" }] },
			}),
		);
		writeFileSync(
			join(dir, "sess-a.jsonl"),
			[
				line({ type: "user", uuid: "a1", timestamp: "2026-06-28T10:00:00.000Z", sessionId: "A", message: { content: "first prompt" } }),
				line({
					type: "assistant",
					uuid: "a2",
					timestamp: "2026-06-28T10:00:01.000Z",
					sessionId: "A",
					message: { model: "claude-test-5", content: [{ type: "text", text: "middle reply" }] },
				}),
			].join("\n"),
		);
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});

	it("collects records from every transcript in the project dir", () => {
		const recs = collectTranscriptRecords(cwd, home);
		expect(recs).toHaveLength(3);
		expect(recs.map((r) => r.category).sort()).toEqual(["agent_message", "agent_message", "user_prompt"]);
	});

	it("rebuilds timeline.jsonl time-sorted across sessions, as if appended in real time", () => {
		const result = backfillTimeline(cwd, home);
		expect(result.transcripts).toBe(2);
		expect(result.records).toBe(3);
		const texts = readFileSync(result.path, "utf-8")
			.trim()
			.split("\n")
			.map((l) => {
				const p: { text?: string } = JSON.parse(l);
				return p.text;
			});
		expect(texts).toEqual(["first prompt", "middle reply", "later message"]);
	});

	it("is idempotent: re-running reproduces the same file", () => {
		const first = readFileSync(backfillTimeline(cwd, home).path, "utf-8");
		const second = readFileSync(backfillTimeline(cwd, home).path, "utf-8");
		expect(second).toBe(first);
	});

	it("returns an empty result when the project has no transcript dir", () => {
		const empty = mkdtempSync(join(tmpdir(), "tl-empty-"));
		const result = backfillTimeline(empty, join(empty, "nohome"));
		expect(result.transcripts).toBe(0);
		expect(result.records).toBe(0);
		rmSync(empty, { recursive: true, force: true });
	});

	it("refuses an over-limit sparse transcript before reading it into memory", () => {
		const dir = transcriptDir(cwd, home);
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		const huge = join(dir, "sess-huge.jsonl");
		writeFileSync(huge, "{}\n");
		truncateSync(huge, MAX_TIMELINE_REWRITE_BYTES + 1);

		expect(() => collectTranscriptRecords(cwd, home)).toThrow(
			TimelineRewriteConflictError,
		);
	});
});
