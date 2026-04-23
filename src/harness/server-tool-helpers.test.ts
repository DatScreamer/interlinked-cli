import { describe, expect, it } from "vitest";
import { isPostToolUse, isPreToolUse, summarizeToolInput } from "./server-tool-helpers.js";
import type { HarnessEvent } from "./types.js";

function makeEvent(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "s",
		agent_source: "claude",
		timestamp: "2026-04-23T00:00:00.000Z",
		...partial,
	};
}

describe("summarizeToolInput", () => {
	it("returns command truncated to 200 chars", () => {
		const cmd = "a".repeat(500);
		const out = summarizeToolInput(makeEvent({ tool_input: { command: cmd } }));
		expect(out.length).toBe(200);
	});

	it("returns file_path when command is absent", () => {
		expect(
			summarizeToolInput(
				makeEvent({ tool_name: "Edit", tool_input: { file_path: "/a/b.ts" } }),
			),
		).toBe("/a/b.ts");
	});

	it("returns url truncated when present", () => {
		const url = `https://${"x".repeat(300)}`;
		const out = summarizeToolInput(makeEvent({ tool_input: { url } }));
		expect(out.length).toBe(200);
	});

	it("falls back to tool_name when tool_input is missing", () => {
		expect(summarizeToolInput(makeEvent({ tool_name: "Read" }))).toBe("Read");
	});

	it("returns empty string when neither is present", () => {
		expect(summarizeToolInput(makeEvent({ tool_name: undefined }))).toBe("");
	});
});

describe("isPreToolUse", () => {
	it("matches PreToolUse and BeforeTool", () => {
		expect(isPreToolUse(makeEvent({ hook_event: "PreToolUse" }))).toBe(true);
		expect(isPreToolUse(makeEvent({ hook_event: "BeforeTool" }))).toBe(true);
	});
	it("does not match post/other events", () => {
		expect(isPreToolUse(makeEvent({ hook_event: "PostToolUse" }))).toBe(false);
		expect(isPreToolUse(makeEvent({ hook_event: "SessionStart" }))).toBe(false);
	});
});

describe("isPostToolUse", () => {
	it("matches PostToolUse, AfterTool, PostToolUseFailure", () => {
		expect(isPostToolUse(makeEvent({ hook_event: "PostToolUse" }))).toBe(true);
		expect(isPostToolUse(makeEvent({ hook_event: "AfterTool" }))).toBe(true);
		expect(isPostToolUse(makeEvent({ hook_event: "PostToolUseFailure" }))).toBe(true);
	});
	it("does not match pre/other events", () => {
		expect(isPostToolUse(makeEvent({ hook_event: "PreToolUse" }))).toBe(false);
		expect(isPostToolUse(makeEvent({ hook_event: "SessionEnd" }))).toBe(false);
	});
});
