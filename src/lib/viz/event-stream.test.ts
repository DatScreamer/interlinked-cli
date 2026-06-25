// Tests for the live activity event-stream: parsing v5 activity records into
// compact viz events, the SSE wire format, the byte-offset delta reader, the
// seed read, and the polling tailer.

import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createActivityTailer,
	createChecksTailer,
	formatSse,
	mapActivityLine,
	mapCheckLine,
	readAppendedLines,
	seedRecentChecks,
	seedRecentEvents,
} from "./event-stream.js";

const guardLine = JSON.stringify({
	schema_version: 5, ts: "2026-06-23T12:00:00Z", agent: "claude", type: "guard_block",
	tool: null, summary: "BLOCKED: raw sql", guard_decision: "block",
	guard_rule_id: "raw_sql_concat", guard_severity: "high", tool_use_id: "t1",
});
const editLine = JSON.stringify({
	schema_version: 5, ts: "2026-06-23T12:00:01Z", type: "tool_use_start",
	tool: "Edit", tool_input: { file_path: "/repo/src/db.ts" }, summary: "Edit db.ts",
});
const writeLine = JSON.stringify({
	schema_version: 5, ts: "2026-06-23T12:00:02Z", type: "tool_use",
	tool: "Write", files_modified: ["src/x.ts"],
});

// check-results.jsonl rows, exactly the writer's schema.
const blockCheck = JSON.stringify({
	ts: "2026-06-23T12:00:00Z", tool_use_id: "c1", tool: "Edit", file: "src/db.ts",
	decision: "block", ran: 3,
	checks: [{ id: "raw_sql_concat", severity: "high", determinism: "proven", phase: "pre_block" }],
});
const allowCheck = JSON.stringify({
	ts: "2026-06-23T12:00:01Z", tool_use_id: "c2", decision: "allow", ran: 0, checks: [],
});

describe("mapActivityLine", () => {
	it("maps a guard decision row", () => {
		const ev = mapActivityLine(guardLine);
		expect(ev).toMatchObject({ type: "guard_block", decision: "block", rule_id: "raw_sql_concat", severity: "high" });
		expect(ev?.tool).toBeUndefined(); // tool was null
	});

	it("extracts the file from tool_input", () => {
		expect(mapActivityLine(editLine)).toMatchObject({ type: "tool_use_start", tool: "Edit", file: "/repo/src/db.ts" });
	});

	it("extracts the file from files_modified[]", () => {
		expect(mapActivityLine(writeLine)).toMatchObject({ tool: "Write", file: "src/x.ts" });
	});

	it("returns null on malformed json", () => {
		expect(mapActivityLine("not json{")).toBeNull();
	});

	it("returns null when ts or type is missing", () => {
		expect(mapActivityLine(JSON.stringify({ type: "x" }))).toBeNull();
		expect(mapActivityLine(JSON.stringify({ ts: "now" }))).toBeNull();
		expect(mapActivityLine(JSON.stringify("a string"))).toBeNull();
	});
});

describe("formatSse", () => {
	it("frames an event as an SSE data line", () => {
		const out = formatSse({ ts: "t", type: "guard_warn" });
		expect(out.startsWith("data: ")).toBe(true);
		expect(out.endsWith("\n\n")).toBe(true);
		expect(JSON.parse(out.slice(6).trim())).toEqual({ ts: "t", type: "guard_warn" });
	});
});

describe("readAppendedLines", () => {
	let dir: string;
	beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "viz-tail-")); });
	afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

	it("reads only the bytes appended since the offset", () => {
		const f = join(dir, "a.log");
		writeFileSync(f, "l1\nl2\n");
		const first = readAppendedLines(f, 0);
		expect(first.lines).toEqual(["l1", "l2"]);
		expect(first.offset).toBe(6);

		appendFileSync(f, "l3\n");
		const next = readAppendedLines(f, first.offset);
		expect(next.lines).toEqual(["l3"]);

		expect(readAppendedLines(f, next.offset).lines).toEqual([]); // no change
	});

	it("resets to EOF when the file shrank (rotation)", () => {
		const f = join(dir, "b.log");
		writeFileSync(f, "x\n");
		expect(readAppendedLines(f, 9999)).toEqual({ lines: [], offset: 2 });
	});

	it("is a no-op for a missing file", () => {
		expect(readAppendedLines(join(dir, "missing.log"), 5)).toEqual({ lines: [], offset: 5 });
	});
});

describe("seedRecentEvents", () => {
	let dir: string;
	beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "viz-seed-")); });
	afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

	it("returns recent events in chronological order", () => {
		const f = join(dir, "activity.jsonl");
		writeFileSync(f, `${guardLine}\n${editLine}\n${writeLine}\n`);
		const events = seedRecentEvents(f, 10);
		expect(events.map((e) => e.type)).toEqual(["guard_block", "tool_use_start", "tool_use"]);
	});

	it("returns nothing for a missing file", () => {
		expect(seedRecentEvents(join(dir, "nope.jsonl"), 10)).toEqual([]);
	});
});

describe("createActivityTailer", () => {
	let dir: string;
	beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "viz-tailer-")); });
	afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

	it("emits events appended after it starts", async () => {
		const f = join(dir, "live.jsonl");
		writeFileSync(f, `${editLine}\n`); // pre-existing line — should NOT be emitted
		const received: string[] = [];
		const tailer = createActivityTailer(f, (ev) => received.push(ev.type), 20);
		appendFileSync(f, `${guardLine}\n`);
		await vi.waitFor(() => expect(received).toContain("guard_block"), { timeout: 1000, interval: 20 });
		tailer.stop();
		expect(received).not.toContain("tool_use_start"); // the pre-existing line was skipped
	});

	it("returns a valid handle on a not-yet-existing file", () => {
		const tailer = createActivityTailer(join(dir, "later.jsonl"), () => undefined, 1000);
		expect(tailer.stop).toBeInstanceOf(Function);
		tailer.stop();
	});
});

describe("mapCheckLine", () => {
	it("maps a block decision row with a typed check and optional fields", () => {
		const ev = mapCheckLine(blockCheck);
		expect(ev).toMatchObject({
			ts: "2026-06-23T12:00:00Z", tool_use_id: "c1", tool: "Edit", file: "src/db.ts",
			decision: "block", ran: 3,
		});
		expect(ev?.checks).toEqual([
			{ id: "raw_sql_concat", severity: "high", determinism: "proven", phase: "pre_block" },
		]);
	});

	it("maps an allow decision row with no optional fields and an empty checks array", () => {
		const ev = mapCheckLine(allowCheck);
		expect(ev).toMatchObject({ tool_use_id: "c2", decision: "allow", ran: 0, checks: [] });
		expect(ev?.tool).toBeUndefined();
		expect(ev?.file).toBeUndefined();
	});

	it("omits ran when it is absent or non-numeric", () => {
		const noRan = mapCheckLine(JSON.stringify({ ts: "t", tool_use_id: "c", decision: "allow" }));
		expect(noRan?.ran).toBeUndefined();
		expect(noRan?.checks).toEqual([]); // absent checks default to []
		const badRan = mapCheckLine(JSON.stringify({ ts: "t", tool_use_id: "c", decision: "allow", ran: "3" }));
		expect(badRan?.ran).toBeUndefined();
	});

	it("drops a check entry that is malformed or has an unknown determinism", () => {
		const row = JSON.stringify({
			ts: "t", tool_use_id: "c", decision: "block",
			checks: [
				{ id: "ok", severity: "low", determinism: "heuristic" }, // kept (no phase)
				{ id: "x", severity: "low", determinism: "guesswork" }, // bad determinism → dropped
				{ id: "y", severity: "low" }, // missing determinism → dropped
				{ severity: "low", determinism: "proven" }, // missing id → dropped
				"not-an-object", // non-record → dropped
			],
		});
		const ev = mapCheckLine(row);
		expect(ev?.checks).toEqual([{ id: "ok", severity: "low", determinism: "heuristic" }]);
	});

	it("coerces a non-array checks field to an empty array", () => {
		const ev = mapCheckLine(JSON.stringify({ ts: "t", tool_use_id: "c", decision: "block", checks: "nope" }));
		expect(ev?.checks).toEqual([]);
	});

	it("returns null on malformed json", () => {
		expect(mapCheckLine("not json{")).toBeNull();
	});

	it("returns null on a non-object row", () => {
		expect(mapCheckLine(JSON.stringify("a string"))).toBeNull();
	});

	it("returns null when ts, tool_use_id, or a valid decision is missing", () => {
		expect(mapCheckLine(JSON.stringify({ tool_use_id: "c", decision: "allow" }))).toBeNull(); // no ts
		expect(mapCheckLine(JSON.stringify({ ts: "t", decision: "allow" }))).toBeNull(); // no tool_use_id
		expect(mapCheckLine(JSON.stringify({ ts: "t", tool_use_id: "c" }))).toBeNull(); // no decision
		expect(mapCheckLine(JSON.stringify({ ts: "t", tool_use_id: "c", decision: "maybe" }))).toBeNull(); // bad decision
	});
});

describe("seedRecentChecks", () => {
	let dir: string;
	beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "viz-checkseed-")); });
	afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

	it("returns recent check rows in chronological order", () => {
		const f = join(dir, "check-results.jsonl");
		writeFileSync(f, `${blockCheck}\n${allowCheck}\n`);
		const events = seedRecentChecks(f, 10);
		expect(events.map((e) => e.tool_use_id)).toEqual(["c1", "c2"]);
	});

	it("returns nothing for a missing file", () => {
		expect(seedRecentChecks(join(dir, "nope.jsonl"), 10)).toEqual([]);
	});
});

describe("createChecksTailer", () => {
	let dir: string;
	beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "viz-checktailer-")); });
	afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

	it("emits check rows appended after it starts", async () => {
		const f = join(dir, "live-checks.jsonl");
		writeFileSync(f, `${allowCheck}\n`); // pre-existing — should NOT be emitted
		const received: string[] = [];
		const tailer = createChecksTailer(f, (ev) => received.push(ev.tool_use_id), 20);
		appendFileSync(f, `${blockCheck}\n`);
		await vi.waitFor(() => expect(received).toContain("c1"), { timeout: 1000, interval: 20 });
		tailer.stop();
		expect(received).not.toContain("c2"); // the pre-existing line was skipped
	});

	it("returns a valid handle on a not-yet-existing file", () => {
		const tailer = createChecksTailer(join(dir, "later.jsonl"), () => undefined, 1000);
		expect(tailer.stop).toBeInstanceOf(Function);
		tailer.stop();
	});
});
