import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("readLocalActivity — canonical collection.jsonl source", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "la-coll-"));
	});
	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	function writeCollection(records: object[]): void {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "collection.jsonl"),
			`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
		);
	}

	function rec(over: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			schema: "collection.v1",
			kind: "tool_event",
			ts: "2026-06-06T10:00:00.000Z",
			session_id: "s1",
			agent_name: "alice",
			provider: "claude-code",
			phase: "post",
			provider_tool: "Bash",
			cwd: "/repo",
			action: { command: "ls -la" },
			...over,
		};
	}

	it("projects a collection.v1 record onto the v5 display shape", () => {
		writeCollection([rec()]);
		const events = readLocalActivity({ cwd: tmp });
		expect(events.length).toBe(1);
		expect(events[0].agent).toBe("alice");
		expect(events[0].type).toBe("tool_use");
		expect(events[0].tool).toBe("Bash");
		expect(events[0].summary).toBe("ls -la");
		expect(events[0].session).toBe("s1");
	});

	it("falls back to provider when agent_name is null and maps pre-phase to tool_use_start", () => {
		writeCollection([
			rec({ agent_name: null, provider: "codex", phase: "pre", provider_tool: "Read", action: { path: "/a.ts" } }),
		]);
		const events = readLocalActivity({ cwd: tmp });
		expect(events[0].agent).toBe("codex");
		expect(events[0].type).toBe("tool_use_start");
		expect(events[0].summary).toBe("/a.ts");
	});

	it("collection.jsonl takes precedence over a legacy activity.jsonl", () => {
		mkdirSync(join(tmp, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmp, ".interlinked", "activity.jsonl"),
			`${JSON.stringify({ ts: "2026-06-06T09:00:00.000Z", agent: "from-activity", type: "tool_use" })}\n`,
		);
		writeCollection([rec({ agent_name: "from-collection" })]);
		expect(readLocalActivity({ cwd: tmp }).map((e) => e.agent)).toEqual(["from-collection"]);
	});

	it("applies agent / type / limit filters on the collection source", () => {
		writeCollection([
			rec({ ts: "2026-06-06T10:00:00.000Z", agent_name: "a", phase: "post", provider_tool: "Bash" }),
			rec({ ts: "2026-06-06T10:00:01.000Z", agent_name: "b", phase: "pre", provider_tool: "Read", action: { path: "p" } }),
		]);
		expect(readLocalActivity({ cwd: tmp, agent: "a" }).map((e) => e.agent)).toEqual(["a"]);
		expect(readLocalActivity({ cwd: tmp, type: "tool_use_start" }).map((e) => e.tool)).toEqual([
			"Read",
		]);
		expect(readLocalActivity({ cwd: tmp, limit: 1 }).length).toBe(1);
	});
});
