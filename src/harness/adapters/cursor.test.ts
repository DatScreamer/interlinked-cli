import { describe, expect, it } from "vitest";
import { createCursorAdapter } from "./cursor.js";

const adapter = createCursorAdapter();

describe("Cursor adapter identity", () => {
	it("has the expected id", () => {
		expect(adapter.id).toBe("cursor");
	});
	it("lists native event names", () => {
		expect(adapter.nativeEventNames).toContain("beforeShellExecution");
		expect(adapter.nativeEventNames).toContain("beforeMCPExecution");
		expect(adapter.nativeEventNames).toContain("afterFileEdit");
		expect(adapter.nativeEventNames).toContain("beforeReadFile");
		expect(adapter.nativeEventNames).toContain("sessionStart");
	});
});

describe("Cursor detectFromEnv", () => {
	it("detects CURSOR_SESSION_ID env", () => {
		expect(adapter.detectFromEnv({ CURSOR_SESSION_ID: "abc" })).toBe(true);
	});
	it("does not detect a plain environment", () => {
		expect(adapter.detectFromEnv({})).toBe(false);
	});
});

describe("Cursor parseHookInput — beforeShellExecution", () => {
	const event = adapter.parseHookInput(
		{ session_id: "cur-1", cwd: "/repo", command: "rm -rf /tmp/z" },
		"beforeShellExecution",
	);
	it("produces a shell_command action", () => {
		expect(event.action.kind).toBe("shell_command");
	});
	it("classifies the command", () => {
		if (event.action.kind !== "shell_command") throw new Error("expected shell_command");
		expect(event.action.tool_class).toBe("side-effect");
	});
});

describe("Cursor parseHookInput — beforeReadFile", () => {
	const event = adapter.parseHookInput(
		{ session_id: "cur-2", path: "/repo/x.ts" },
		"beforeReadFile",
	);
	it("produces a file_operation read", () => {
		if (event.action.kind !== "file_operation") throw new Error("expected file_operation");
		expect(event.action.operation).toBe("read");
		expect(event.action.path).toBe("/repo/x.ts");
	});
});

describe("Cursor parseHookInput — MCP tool", () => {
	const event = adapter.parseHookInput(
		{ session_id: "cur-3", tool_name: "search", arguments: { query: "x" } },
		"beforeMCPExecution",
	);
	it("produces a tool_call", () => {
		expect(event.action.kind).toBe("tool_call");
	});
	it("parses string-form tool_input (Cursor's MCP convention)", () => {
		const e = adapter.parseHookInput(
			{
				session_id: "cur-4",
				tool_name: "delete_volume",
				tool_input: '{"volumeId":"abc-123"}',
			},
			"beforeMCPExecution",
		);
		if (e.action.kind !== "tool_call") throw new Error("expected tool_call");
		expect(e.action.tool_input).toEqual({ volumeId: "abc-123" });
	});
});

describe("Cursor parseHookInput — afterFileEdit", () => {
	const event = adapter.parseHookInput(
		{ session_id: "cur-5", file_path: "/repo/src/foo.ts", edits: [] },
		"afterFileEdit",
	);
	it("produces a file_operation edit", () => {
		if (event.action.kind !== "file_operation") throw new Error("expected file_operation");
		expect(event.action.operation).toBe("edit");
		expect(event.action.path).toBe("/repo/src/foo.ts");
	});
});

describe("Cursor encodeDecision", () => {
	const event = adapter.parseHookInput(
		{ session_id: "c", command: "ls" },
		"beforeShellExecution",
	);
	it("allow emits stdout with permission:allow", () => {
		const out = adapter.encodeDecision({ decision: "allow" }, event);
		expect(JSON.parse(out.stdout as string)).toEqual({ permission: "allow" });
	});
	it("block emits permission:deny with agent + user messages", () => {
		const out = adapter.encodeDecision({ decision: "block", reason: "no" }, event);
		expect(JSON.parse(out.stdout as string)).toEqual({
			permission: "deny",
			agentMessage: "no",
			userMessage: "no",
		});
	});
	it("ask emits permission:ask with both messages", () => {
		const out = adapter.encodeDecision(
			{ decision: "ask", reason: "confirm?", system_message: "potentially destructive" },
			event,
		);
		expect(JSON.parse(out.stdout as string)).toEqual({
			permission: "ask",
			agentMessage: "confirm?",
			userMessage: "potentially destructive",
		});
	});
	it("non-gated event (afterFileEdit) blocks via stderr instead of stdout JSON", () => {
		const postEvent = adapter.parseHookInput(
			{ session_id: "c", file_path: "/a", edits: [] },
			"afterFileEdit",
		);
		const out = adapter.encodeDecision({ decision: "block", reason: "lint failed" }, postEvent);
		expect(out.stdout).toBeUndefined();
		expect(out.stderr).toContain("lint failed");
	});
});

describe("Cursor renderSettingsFragment", () => {
	const fragment = adapter.renderSettingsFragment("/usr/local/bin/interlinked-hook", "project");
	it("writes to .cursor/hooks.json (project scope)", () => {
		expect(fragment.path).toBe(".cursor/hooks.json");
	});
	it("includes version: 1 in the fragment", () => {
		const f = fragment.fragment as { version: number };
		expect(f.version).toBe(1);
	});
	it("sets failClosed: true on gated events", () => {
		const f = fragment.fragment as { hooks: Record<string, Array<{ failClosed?: boolean }>> };
		expect(f.hooks.beforeShellExecution?.[0]?.failClosed).toBe(true);
		expect(f.hooks.beforeMCPExecution?.[0]?.failClosed).toBe(true);
		expect(f.hooks.beforeReadFile?.[0]?.failClosed).toBe(true);
	});
	it("leaves failClosed unset on observation hooks", () => {
		const f = fragment.fragment as { hooks: Record<string, Array<{ failClosed?: boolean }>> };
		expect(f.hooks.afterFileEdit?.[0]?.failClosed).toBeUndefined();
		expect(f.hooks.sessionStart?.[0]?.failClosed).toBeUndefined();
	});
});
