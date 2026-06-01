import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCollectionPath } from "../../../lib/collection/writer.js";
import type { HarnessEvent } from "../../types.js";
import { mapEventToCollectionInput, writeCollectionRecord } from "../collection-writer.js";

function harnessEvent(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "sess",
		agent_source: "claude",
		timestamp: "2026-06-01T12:00:00.000Z",
		...partial,
	};
}

describe("mapEventToCollectionInput — event_type derivation", () => {
	it("maps PreToolUse to tool_use_start", () => {
		const m = mapEventToCollectionInput(harnessEvent({ hook_event: "PreToolUse" }), "/repo");
		expect(m.event_type).toBe("tool_use_start");
	});

	it("maps Gemini BeforeTool to tool_use_start", () => {
		const m = mapEventToCollectionInput(harnessEvent({ hook_event: "BeforeTool" }), "/repo");
		expect(m.event_type).toBe("tool_use_start");
	});

	it("maps PostToolUseFailure to tool_use_error", () => {
		const m = mapEventToCollectionInput(
			harnessEvent({ hook_event: "PostToolUseFailure" }),
			"/repo",
		);
		expect(m.event_type).toBe("tool_use_error");
	});

	it("maps PostToolUse / AfterTool to tool_use", () => {
		expect(
			mapEventToCollectionInput(harnessEvent({ hook_event: "PostToolUse" }), "/repo").event_type,
		).toBe("tool_use");
		expect(
			mapEventToCollectionInput(harnessEvent({ hook_event: "AfterTool" }), "/repo").event_type,
		).toBe("tool_use");
	});
});

describe("mapEventToCollectionInput — client runner detection", () => {
	it("detects codex from agent_source", () => {
		const m = mapEventToCollectionInput(harnessEvent({ agent_source: "codex" }), "/repo");
		expect(m.client_runner).toBe("codex");
		expect(m.cursor_version).toBeUndefined();
	});

	it("detects copilot from agent_source", () => {
		const m = mapEventToCollectionInput(
			harnessEvent({ agent_source: "copilot" as HarnessEvent["agent_source"] }),
			"/repo",
		);
		expect(m.client_runner).toBe("copilot");
	});

	it("detects cursor and sets cursor_version instead of client_runner", () => {
		const m = mapEventToCollectionInput(harnessEvent({ agent_source: "cursor" }), "/repo");
		expect(m.cursor_version).toBe("1");
		expect(m.client_runner).toBeUndefined();
	});

	it("omits both runner keys for plain claude", () => {
		const m = mapEventToCollectionInput(harnessEvent({ agent_source: "claude" }), "/repo");
		expect("client_runner" in m).toBe(false);
		expect("cursor_version" in m).toBe(false);
	});
});

describe("mapEventToCollectionInput — field carryover and cwd fallback", () => {
	it("prefers event.cwd over the fallback", () => {
		const m = mapEventToCollectionInput(harnessEvent({ cwd: "/explicit" }), "/fallback");
		expect(m.cwd).toBe("/explicit");
	});

	it("uses the fallback cwd when the event omits cwd", () => {
		const m = mapEventToCollectionInput(harnessEvent({}), "/fallback");
		expect(m.cwd).toBe("/fallback");
	});

	it("carries tool_name, tool_input, tool_use_id, and sha256 through", () => {
		const m = mapEventToCollectionInput(
			harnessEvent({
				tool_name: "Read",
				tool_input: { file_path: "/a.ts" },
				tool_use_id: "tu_1",
				tool_response_sha256: "sha-1",
			}),
			"/repo",
		);
		expect(m.tool_name).toBe("Read");
		expect(m.tool_input).toEqual({ file_path: "/a.ts" });
		expect(m.tool_use_id).toBe("tu_1");
		expect(m.tool_response_sha256).toBe("sha-1");
		expect(m.session).toBe("sess");
		expect(m.ts).toBe("2026-06-01T12:00:00.000Z");
	});

	it("defaults tool_name to empty string and tool_input to {} when absent", () => {
		const m = mapEventToCollectionInput(harnessEvent({}), "/repo");
		expect(m.tool_name).toBe("");
		expect(m.tool_input).toEqual({});
	});
});

describe("writeCollectionRecord — end-to-end append", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "collection-writer-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("appends a record for a tool event under the event's cwd", () => {
		const event = harnessEvent({
			hook_event: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command: "ls" },
			tool_response: { stdout: "x", stderr: "", exitCode: 0 },
			cwd: dir,
		});
		writeCollectionRecord(event, "/unused-fallback");
		const path = getCollectionPath(dir);
		expect(existsSync(path)).toBe(true);
		const lines = readFileSync(path, "utf-8").trim().split("\n");
		expect(lines.length).toBe(1);
		const rec = JSON.parse(lines[0]);
		expect(rec.schema).toBe("collection.v1");
		expect(rec.provider_tool).toBe("Bash");
	});

	it("does not throw and writes nothing for a lifecycle event", () => {
		const event = harnessEvent({ hook_event: "SessionStart", cwd: dir });
		expect(() => writeCollectionRecord(event, dir)).not.toThrow();
		// SessionStart maps to no tool event_type → builder returns null → no file.
		expect(existsSync(getCollectionPath(dir))).toBe(false);
	});

	it("is best-effort: never throws even on a malformed-ish event", () => {
		// Missing tool fields must not crash the writer.
		expect(() =>
			writeCollectionRecord(harnessEvent({ hook_event: "PreToolUse", cwd: dir }), dir),
		).not.toThrow();
	});
});
