// Tests for the daemon's legacy-stream dual-write: HarnessEvent → v5
// LocalActivityEvent → activity.jsonl, so the CLI reader commands keep working
// after the collection.jsonl migration. The round-trip cases drive the actual
// reader (readLocalActivity) to prove the mirror is consumable, not just written.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLocalActivity } from "../../../lib/local-activity.js";
import type { HarnessEvent } from "../../types.js";
import { mapEventToActivityRecord, writeActivityRecord } from "../activity-writer.js";

function harnessEvent(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		timestamp: "2026-06-06T12:00:00.000Z",
		...partial,
	};
}

describe("mapEventToActivityRecord — v5 mapping", () => {
	it("maps PreToolUse to a tool_use_start record with the core fields", () => {
		const rec = mapEventToActivityRecord(
			harnessEvent({
				hook_event: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: "ls -la" },
			}),
			"/repo",
		);
		expect(rec).not.toBeNull();
		expect(rec?.type).toBe("tool_use_start");
		expect(rec?.tool).toBe("Bash");
		expect(rec?.summary).toBe("ls -la");
		expect(rec?.hook).toBe("PreToolUse");
		expect(rec?.session).toBe("sess-1");
		expect(rec?.schema_version).toBe(5);
	});

	it("maps PostToolUse → tool_use and PostToolUseFailure → tool_use_error", () => {
		expect(mapEventToActivityRecord(harnessEvent({ hook_event: "PostToolUse" }), "/r")?.type).toBe(
			"tool_use",
		);
		expect(
			mapEventToActivityRecord(harnessEvent({ hook_event: "PostToolUseFailure" }), "/r")?.type,
		).toBe("tool_use_error");
	});

	it("maps Gemini BeforeTool/AfterTool", () => {
		expect(mapEventToActivityRecord(harnessEvent({ hook_event: "BeforeTool" }), "/r")?.type).toBe(
			"tool_use_start",
		);
		expect(mapEventToActivityRecord(harnessEvent({ hook_event: "AfterTool" }), "/r")?.type).toBe(
			"tool_use",
		);
	});

	it("returns null for non-tool (lifecycle) events", () => {
		expect(mapEventToActivityRecord(harnessEvent({ hook_event: "SessionStart" }), "/r")).toBeNull();
		expect(mapEventToActivityRecord(harnessEvent({ hook_event: "Stop" }), "/r")).toBeNull();
	});

	it("derives the summary: command, then file path, then pattern, then tool name", () => {
		expect(
			mapEventToActivityRecord(
				harnessEvent({ tool_name: "Bash", tool_input: { command: "npm test" } }),
				"/r",
			)?.summary,
		).toBe("npm test");
		expect(
			mapEventToActivityRecord(
				harnessEvent({ tool_name: "Read", tool_input: { file_path: "/a.ts" } }),
				"/r",
			)?.summary,
		).toBe("/a.ts");
		expect(
			mapEventToActivityRecord(
				harnessEvent({ tool_name: "Grep", tool_input: { pattern: "foo" } }),
				"/r",
			)?.summary,
		).toBe("foo");
		expect(
			mapEventToActivityRecord(harnessEvent({ tool_name: "SomeTool", tool_input: {} }), "/r")
				?.summary,
		).toBe("SomeTool");
	});

	it("prefers event.cwd over the fallback and carries tool_use_id when present", () => {
		const rec = mapEventToActivityRecord(
			harnessEvent({ cwd: "/explicit", tool_use_id: "tu_9" }),
			"/fallback",
		);
		expect(rec?.cwd).toBe("/explicit");
		expect(rec?.tool_use_id).toBe("tu_9");
	});

	it("omits tool_use_id when absent (exactOptionalPropertyTypes)", () => {
		const rec = mapEventToActivityRecord(harnessEvent({}), "/r");
		expect(rec && "tool_use_id" in rec).toBe(false);
	});

	it("uses agent_name when present, else falls back to agent_source", () => {
		expect(mapEventToActivityRecord(harnessEvent({ agent_name: "alice" }), "/r")?.agent).toBe(
			"alice",
		);
		expect(mapEventToActivityRecord(harnessEvent({}), "/r")?.agent).toBe("claude");
	});
});

describe("writeActivityRecord — round-trips through readLocalActivity", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "activity-writer-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("a written tool event is readable by the reader the CLI commands use", () => {
		writeActivityRecord(
			harnessEvent({
				hook_event: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: "ls" },
				cwd: dir,
				session_id: "round-trip",
			}),
			dir,
		);
		const events = readLocalActivity({ cwd: dir });
		expect(events.length).toBe(1);
		expect(events[0].type).toBe("tool_use_start");
		expect(events[0].tool).toBe("Bash");
		expect(events[0].summary).toBe("ls");
		expect(events[0].session).toBe("round-trip");
	});

	it("writes nothing for a lifecycle event", () => {
		writeActivityRecord(harnessEvent({ hook_event: "SessionStart", cwd: dir }), dir);
		expect(readLocalActivity({ cwd: dir })).toEqual([]);
	});

	it("is best-effort: never throws", () => {
		expect(() =>
			writeActivityRecord(harnessEvent({ hook_event: "PreToolUse", cwd: dir }), dir),
		).not.toThrow();
	});
});
