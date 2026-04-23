import { describe, expect, it } from "vitest";
import { createCursorAdapter } from "./cursor.js";

const adapter = createCursorAdapter();

describe("Cursor adapter identity", () => {
	it("has the expected id", () => {
		expect(adapter.id).toBe("cursor");
	});
	it("lists native event names", () => {
		expect(adapter.nativeEventNames).toContain("beforeShellExecution");
		expect(adapter.nativeEventNames).toContain("beforeMcpToolExecution");
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
		"beforeMcpToolExecution",
	);
	it("produces a tool_call", () => {
		expect(event.action.kind).toBe("tool_call");
	});
});

describe("Cursor encodeDecision", () => {
	const event = adapter.parseHookInput({ session_id: "c", path: "/a" }, "beforeReadFile");
	it("allow emits stdout with allow:true", () => {
		const out = adapter.encodeDecision({ decision: "allow" }, event);
		expect(JSON.parse(out.stdout as string)).toEqual({ allow: true });
	});
	it("block emits allow:false with reason", () => {
		const out = adapter.encodeDecision({ decision: "block", reason: "no" }, event);
		expect(JSON.parse(out.stdout as string)).toEqual({ allow: false, reason: "no" });
	});
	it("ask emits ask:true with reason", () => {
		const out = adapter.encodeDecision({ decision: "ask", reason: "confirm?" }, event);
		expect(JSON.parse(out.stdout as string)).toEqual({ ask: true, reason: "confirm?" });
	});
});
