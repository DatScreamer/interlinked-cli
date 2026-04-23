import { describe, expect, it } from "vitest";
import { EVENT_NORMALIZERS_CHUNK } from "./event-normalizers.js";

// This file is a template-literal chunk that becomes runtime JavaScript in
// the generated `.interlinked/hooks/interlinked-activity.mjs`. We can't
// usefully import its functions directly (they reference globals like
// `truncate`, `summarize`, `extractFilePath` defined elsewhere in the
// generated script). Instead we verify shape: every event we claim to
// normalize is referenced, every per-event envelope field we promised is
// emitted, and the expected canonical event_type names show up.

describe("EVENT_NORMALIZERS_CHUNK — shape", () => {
	it("is a non-empty string", () => {
		expect(typeof EVENT_NORMALIZERS_CHUNK).toBe("string");
		expect(EVENT_NORMALIZERS_CHUNK.length).toBeGreaterThan(100);
	});

	it("defines the three provider normalizer entry points", () => {
		expect(EVENT_NORMALIZERS_CHUNK).toContain("function normalizeClaudeEvent(");
		expect(EVENT_NORMALIZERS_CHUNK).toContain("function normalizeGeminiEvent(");
		expect(EVENT_NORMALIZERS_CHUNK).toContain("function normalizeCopilotEvent(");
	});

	it("handles every Claude Code hook event we subscribe to", () => {
		for (const ev of [
			"SessionStart",
			"SessionEnd",
			"Stop",
			"UserPromptSubmit",
			"PreToolUse",
			"PostToolUse",
			"PostToolUseFailure",
			"SubagentStart",
			"SubagentStop",
			"Notification",
			"PreCompact",
			"TaskCompleted",
			"TeammateIdle",
			"PermissionRequest",
		]) {
			expect(EVENT_NORMALIZERS_CHUNK).toContain(`case "${ev}":`);
		}
	});

	it("handles every Gemini CLI hook event we subscribe to", () => {
		for (const ev of [
			"SessionStart",
			"SessionEnd",
			"BeforeAgent",
			"AfterAgent",
			"BeforeTool",
			"AfterTool",
			"AfterModel",
			"PreCompress",
			"Notification",
		]) {
			expect(EVENT_NORMALIZERS_CHUNK).toContain(`case "${ev}":`);
		}
	});

	it("Step 1: keeps envelope fields (cwd, transcript_path, session_id_hint)", () => {
		expect(EVENT_NORMALIZERS_CHUNK).toContain("function envelopeFieldsClaude(");
		expect(EVENT_NORMALIZERS_CHUNK).toContain("cwd: input.cwd");
		expect(EVENT_NORMALIZERS_CHUNK).toContain("transcript_path: input.transcript_path");
		expect(EVENT_NORMALIZERS_CHUNK).toContain("session_id_hint: input.session_id");
	});

	it("Step 1: emits status + error_category on tool events", () => {
		expect(EVENT_NORMALIZERS_CHUNK).toContain('status: "success"');
		expect(EVENT_NORMALIZERS_CHUNK).toContain('status: "error"');
		expect(EVENT_NORMALIZERS_CHUNK).toContain("categorizeToolError");
		expect(EVENT_NORMALIZERS_CHUNK).toContain('"user_interrupt"');
		expect(EVENT_NORMALIZERS_CHUNK).toContain('"timeout"');
		expect(EVENT_NORMALIZERS_CHUNK).toContain('"permission"');
		expect(EVENT_NORMALIZERS_CHUNK).toContain('"tool_error"');
	});

	it("Step 1: emits byte counts on PreToolUse / PostToolUse", () => {
		expect(EVENT_NORMALIZERS_CHUNK).toContain("tool_input_bytes");
		expect(EVENT_NORMALIZERS_CHUNK).toContain("tool_output_bytes");
	});

	it("Step 1: emits prompt_chars on UserPromptSubmit", () => {
		expect(EVENT_NORMALIZERS_CHUNK).toContain("prompt_chars");
	});

	it("Step 1: captures thinking/reasoning tokens when provided", () => {
		expect(EVENT_NORMALIZERS_CHUNK).toContain("thinking_tokens");
	});

	it("Step 1b: computes LOC delta per edit (lines_added / lines_removed / net_loc_delta)", () => {
		expect(EVENT_NORMALIZERS_CHUNK).toContain("function computeLocDelta(");
		expect(EVENT_NORMALIZERS_CHUNK).toContain("lines_added");
		expect(EVENT_NORMALIZERS_CHUNK).toContain("lines_removed");
		expect(EVENT_NORMALIZERS_CHUNK).toContain("net_loc_delta");
	});

	it("Step 1b: covers Edit / Write / MultiEdit / NotebookEdit tools", () => {
		for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
			expect(EVENT_NORMALIZERS_CHUNK).toContain(`"${tool}"`);
		}
	});

	it("Step 1b: sniffs is_new_file from tool_response", () => {
		expect(EVENT_NORMALIZERS_CHUNK).toContain("function sniffIsNewFile(");
		expect(EVENT_NORMALIZERS_CHUNK).toContain("is_new_file");
		expect(EVENT_NORMALIZERS_CHUNK).toContain("file created successfully");
	});

	it("Step 1b: attaches is_test_file heuristic from file path", () => {
		expect(EVENT_NORMALIZERS_CHUNK).toContain("is_test_file");
	});

	it("Gemini AfterModel handler present (was falling through to default)", () => {
		expect(EVENT_NORMALIZERS_CHUNK).toContain('case "AfterModel":');
		expect(EVENT_NORMALIZERS_CHUNK).toContain("model_response");
		expect(EVENT_NORMALIZERS_CHUNK).toContain("usageMetadata");
	});

	it("canonical event_type names match the normalized vocabulary", () => {
		for (const canonical of [
			"session_start",
			"session_end",
			"user_prompt",
			"agent_stop",
			"tool_use_start",
			"tool_use",
			"tool_use_error",
			"subagent_start",
			"subagent_stop",
			"notification",
			"context_compact",
			"task_completed",
			"teammate_idle",
			"permission_request",
			"model_response",
		]) {
			expect(EVENT_NORMALIZERS_CHUNK).toContain(`event_type: "${canonical}"`);
		}
	});
});
