import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendTimelineRecords,
	dedupeTimeline,
	existingTimelineKeys,
	recordKey,
	sortTimeline,
	timelinePath,
	writeTimeline,
} from "./timeline-writer.js";
import type { TimelineRecord } from "./transcript-record.js";

function rec(over: Partial<TimelineRecord> & Pick<TimelineRecord, "ts" | "uuid" | "seq">): TimelineRecord {
	return { schema: "timeline.v1", session: "s1", category: "agent_message", role: "assistant", ...over };
}

describe("timeline-writer ordering + dedup", () => {
	it("recordKey is uuid#seq", () => {
		expect(recordKey(rec({ ts: "t", uuid: "u", seq: 3 }))).toBe("u#3");
	});

	it("sortTimeline orders by ts, then session, then seq (stable)", () => {
		const sorted = sortTimeline([
			rec({ ts: "2026-06-28T10:00:02.000Z", uuid: "c", seq: 0 }),
			rec({ ts: "2026-06-28T10:00:00.000Z", uuid: "a", seq: 1, session: "s2" }),
			rec({ ts: "2026-06-28T10:00:00.000Z", uuid: "a", seq: 0, session: "s2" }),
		]);
		expect(sorted.map((r) => `${r.uuid}${r.seq}`)).toEqual(["a0", "a1", "c0"]);
	});

	it("dedupeTimeline keeps the first occurrence of each uuid#seq", () => {
		const out = dedupeTimeline([
			rec({ ts: "t", uuid: "u", seq: 0, text: "first" }),
			rec({ ts: "t", uuid: "u", seq: 0, text: "dup" }),
			rec({ ts: "t", uuid: "u", seq: 1, text: "other" }),
		]);
		expect(out).toHaveLength(2);
		expect(out[0]?.text).toBe("first");
	});
});

describe("timeline-writer file I/O", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "tlw-"));
	});
	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("writeTimeline writes sorted + deduped JSONL and returns the count", () => {
		const n = writeTimeline(
			[
				rec({ ts: "2026-06-28T10:00:01.000Z", uuid: "b", seq: 0, text: "second" }),
				rec({ ts: "2026-06-28T10:00:00.000Z", uuid: "a", seq: 0, text: "first" }),
				rec({ ts: "2026-06-28T10:00:00.000Z", uuid: "a", seq: 0, text: "first-dup" }),
			],
			cwd,
		);
		expect(n).toBe(2);
		const texts = readFileSync(timelinePath(cwd), "utf-8")
			.trim()
			.split("\n")
			.map((l) => {
				const p: { text?: string } = JSON.parse(l);
				return p.text;
			});
		expect(texts).toEqual(["first", "second"]);
	});

	it("writeTimeline with no records writes an empty file", () => {
		expect(writeTimeline([], cwd)).toBe(0);
		expect(readFileSync(timelinePath(cwd), "utf-8")).toBe("");
	});

	it("appendTimelineRecords appends; existingTimelineKeys reads the keys back", () => {
		appendTimelineRecords([rec({ ts: "t", uuid: "x", seq: 0 }), rec({ ts: "t", uuid: "x", seq: 1 })], cwd);
		appendTimelineRecords([rec({ ts: "t", uuid: "y", seq: 0 })], cwd);
		expect(existingTimelineKeys(cwd)).toEqual(new Set(["x#0", "x#1", "y#0"]));
	});

	it("appendTimelineRecords with an empty list is a no-op", () => {
		appendTimelineRecords([], cwd);
		expect(existingTimelineKeys(cwd).size).toBe(0);
	});

	describe("existingTimelineKeys — malformed rows (parseTimelineDedupKey)", () => {
		function seedRawLines(lines: string[]): void {
			mkdirSync(join(cwd, ".interlinked"), { recursive: true });
			appendFileSync(timelinePath(cwd), `${lines.join("\n")}\n`);
		}

		it("P1: keeps a row whose uuid is a string and seq is a number", () => {
			seedRawLines([JSON.stringify({ uuid: "u1", seq: 0 })]);
			expect(existingTimelineKeys(cwd)).toEqual(new Set(["u1#0"]));
		});

		it("N1: drops rows whose parsed value is not a JSON object", () => {
			seedRawLines(["[1,2,3]", "42", "null", '"str"']);
			expect(existingTimelineKeys(cwd).size).toBe(0);
		});

		it("N2: drops rows whose uuid/seq fields carry the wrong type or are missing", () => {
			seedRawLines([
				JSON.stringify({ uuid: 7, seq: 0 }),
				JSON.stringify({ uuid: "u2", seq: "0" }),
				JSON.stringify({ uuid: "u3" }),
			]);
			expect(existingTimelineKeys(cwd).size).toBe(0);
		});
	});

	it("escapes U+2028/U+2029 so the JSONL has no literal line separators", () => {
		const ls = String.fromCharCode(0x2028);
		const ps = String.fromCharCode(0x2029);
		const text = `line one${ls}line two${ps}end`;
		writeTimeline([rec({ ts: "t", uuid: "u", seq: 0, text })], cwd);
		const raw = readFileSync(timelinePath(cwd), "utf-8");
		expect(raw.includes(ls)).toBe(false);
		expect(raw.includes(ps)).toBe(false);
		expect(raw).toContain("\\u2028");
		const parsed: { text?: string } = JSON.parse(raw.trim());
		expect(parsed.text).toBe(text); // round-trips back to the real characters
	});
});
