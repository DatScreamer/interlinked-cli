import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendLocalActivity,
	getLocalStats,
	getUnsyncedEvents,
	mergeAndDedup,
	readLocalActivity,
	readSyncState,
	updateSyncState,
} from "../local-activity.js";

// Tests run in isolated tmpdirs; we point the module's data directory
// there by setting INTERLINKED_DATA_DIR before calling getDataDir-sensitive
// APIs. appendLocalActivity + readLocalActivity accept an explicit cwd.

describe("appendLocalActivity / readLocalActivity", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("appends a JSONL line and reads it back", () => {
		appendLocalActivity(
			{
				ts: "2026-04-22T10:00:00.000Z",
				agent: "alice",
				type: "tool_use",
				tool: "Read",
			},
			tmp,
		);
		const events = readLocalActivity({ cwd: tmp });
		expect(events.length).toBe(1);
		expect(events[0].agent).toBe("alice");
	});

	it("supports multiple appends; readLocalActivity returns newest-first", () => {
		appendLocalActivity({ ts: "2026-04-22T10:00:00Z", agent: "a", type: "tool_use" }, tmp);
		appendLocalActivity({ ts: "2026-04-22T10:00:01Z", agent: "b", type: "tool_use" }, tmp);
		const events = readLocalActivity({ cwd: tmp });
		// Read order is newest → oldest (tail-style scan).
		expect(events.map((e) => e.agent)).toEqual(["b", "a"]);
	});

	it("readLocalActivity returns [] on a fresh tmpdir", () => {
		expect(readLocalActivity({ cwd: tmp })).toEqual([]);
	});

	it("activity.jsonl is an append-only file", () => {
		appendLocalActivity({ ts: "2026-04-22T10:00:00Z", agent: "a", type: "x" }, tmp);
		appendLocalActivity({ ts: "2026-04-22T10:00:01Z", agent: "b", type: "y" }, tmp);
		const raw = readFileSync(join(tmp, ".interlinked", "activity.jsonl"), "utf-8");
		expect(raw.trim().split("\n").length).toBe(2);
	});
});

describe("sync state", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("readSyncState returns defaults when no state file exists", () => {
		const state = readSyncState(tmp);
		expect(state.synced_through_bytes).toBe(0);
		expect(state.last_sync_at).toBe("");
	});

	it("updateSyncState persists the byte cursor", () => {
		updateSyncState(42, undefined, tmp);
		expect(readSyncState(tmp).synced_through_bytes).toBe(42);
	});

	it("getUnsyncedEvents returns events beyond the cursor", () => {
		appendLocalActivity({ ts: "t1", agent: "a", type: "x" }, tmp);
		const before = getUnsyncedEvents(undefined, tmp);
		expect(before.events.length).toBe(1);

		updateSyncState(before.newOffset, undefined, tmp);
		appendLocalActivity({ ts: "t2", agent: "b", type: "y" }, tmp);
		const after = getUnsyncedEvents(undefined, tmp);
		expect(after.events.length).toBe(1);
		expect(after.events[0].agent).toBe("b");
	});
});

describe("getLocalStats", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-test-"));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("reports zero events on a fresh tmpdir", () => {
		const stats = getLocalStats(tmp);
		expect(stats.total_events).toBe(0);
	});

	it("counts appended events", () => {
		for (let i = 0; i < 5; i++) {
			appendLocalActivity({ ts: `t${i}`, agent: "a", type: "x" }, tmp);
		}
		expect(getLocalStats(tmp).total_events).toBe(5);
	});
});

describe("mergeAndDedup", () => {
	it("dedups by agent|type|tool within a 2s bucket; server wins collisions", () => {
		const local = [
			{
				ts: "2026-04-22T10:00:00Z",
				agent: "a",
				type: "tool_use",
				tool: "Read",
				from: "local",
			},
			{
				ts: "2026-04-22T10:00:30Z",
				agent: "a",
				type: "tool_use",
				tool: "Edit",
				from: "local",
			},
		];
		const server = [
			{
				ts: "2026-04-22T10:00:00Z",
				agent: "a",
				type: "tool_use",
				tool: "Read",
				from: "server",
			},
			{
				ts: "2026-04-22T11:00:00Z",
				agent: "b",
				type: "tool_use",
				tool: "Write",
				from: "server",
			},
		];
		const merged = mergeAndDedup(local, server);
		// 2 server + 1 unique local (Edit) = 3
		expect(merged.length).toBe(3);
		// Server event wins on the Read collision
		const read = merged.find((e) => e.tool === "Read");
		expect(read?.from).toBe("server");
	});

	it("handles empty inputs", () => {
		expect(mergeAndDedup([], [])).toEqual([]);
	});

	it("sorts merged output newest-first", () => {
		const merged = mergeAndDedup(
			[{ ts: "2026-04-22T10:00:00Z", agent: "a", type: "x", tool: "T1" }],
			[{ ts: "2026-04-22T11:00:00Z", agent: "b", type: "y", tool: "T2" }],
		);
		expect(merged[0].agent).toBe("b");
		expect(merged[1].agent).toBe("a");
	});
});
