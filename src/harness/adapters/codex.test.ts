import { describe, expect, it } from "vitest";
import { createCodexAdapter } from "./codex.js";

const adapter = createCodexAdapter();

describe("Codex adapter identity", () => {
	it("has the expected id", () => {
		expect(adapter.id).toBe("codex");
	});
	it("is marked experimental", () => {
		expect(adapter.experimental).toBe(true);
	});
	it("lists native event names", () => {
		expect(adapter.nativeEventNames).toContain("pre_tool");
		expect(adapter.nativeEventNames).toContain("post_tool");
	});
});

describe("Codex detectFromEnv", () => {
	it("detects CODEX_CLI env", () => {
		expect(adapter.detectFromEnv({ CODEX_CLI: "1" })).toBe(true);
	});
	it("does not detect a plain environment", () => {
		expect(adapter.detectFromEnv({})).toBe(false);
	});
});

describe("Codex parseHookInput — pre_command shell", () => {
	const event = adapter.parseHookInput(
		{ session_id: "cx-1", cwd: "/repo", command: "ls" },
		"pre_command",
	);
	it("produces shell_command action", () => {
		expect(event.action.kind).toBe("shell_command");
	});
	it("classifies ls as read", () => {
		if (event.action.kind !== "shell_command") throw new Error("expected shell_command");
		expect(event.action.tool_class).toBe("read");
	});
});

describe("Codex parseHookInput — pre_tool", () => {
	const event = adapter.parseHookInput(
		{ session_id: "cx-2", name: "edit_file", arguments: { path: "/a" } },
		"pre_tool",
	);
	it("produces tool_call action", () => {
		expect(event.action.kind).toBe("tool_call");
	});
});

describe("Codex encodeDecision", () => {
	const event = adapter.parseHookInput({ session_id: "c", tool_name: "x" }, "pre_tool");
	it("allow exits 0", () => {
		const out = adapter.encodeDecision({ decision: "allow" }, event);
		expect(out.exit_code).toBe(0);
	});
	it("block exits 2 with reason on stderr", () => {
		const out = adapter.encodeDecision({ decision: "block", reason: "no" }, event);
		expect(out.exit_code).toBe(2);
		expect(out.stderr).toContain("no");
	});
	it("ask exits 1 with reason on stderr", () => {
		const out = adapter.encodeDecision({ decision: "ask", reason: "confirm?" }, event);
		expect(out.exit_code).toBe(1);
		expect(out.stderr).toContain("confirm?");
	});
});
