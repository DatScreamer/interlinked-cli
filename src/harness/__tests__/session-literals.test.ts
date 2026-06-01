import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	extractNonTrivialLiterals,
	extractWriteChunks,
	isPostToolUseEvent,
	isSequenceWriteOperation,
	recordLiteralOccurrences,
	recordRecentLineEdit,
} from "../session-literals.js";
import type { HarnessEvent, SessionTrajectory } from "../types.js";

// Unit suite for session-literals.ts — the standalone sequence-detector input
// helpers. The integration-level population (driven through
// SessionTracker.recordEvent) is pinned in session-state.test.ts; here we hit
// the pure helpers directly so their contracts are covered in isolation.

function sha256(s: string): string {
	return createHash("sha256").update(s).digest("hex");
}

/** Minimal trajectory carrying just the maps these helpers mutate. */
function makeSession(): SessionTrajectory {
	return {
		session_id: "s",
		agent_name: "a",
		started_at: "2026-05-27T00:00:00.000Z",
		tool_call_count: 3,
		error_count: 0,
		files_read: new Set(),
		files_written: new Set(),
		commands_run: [],
		curl_localhost_count: {},
		mcp_tools_used: 0,
		local_tools_used: 0,
		file_write_times: new Map(),
		failed_files: new Map(),
		pending_completions: new Map(),
		file_read_at: new Map(),
		tool_sequence: [],
		sensitivity_level: "Public",
		taint_sources: [],
		step_limit: Number.POSITIVE_INFINITY,
		consecutive_pattern: null,
		suggested_permissions: new Set(),
		acknowledged_checks: new Set(),
		fired_reminders: new Set(),
		soft_blocks: new Set(),
		injection_detected_steps: [],
		pii_detected_steps: [],
		last_coordination_at: 0,
		last_coordination_ts: 0,
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
		assertion_counts: new Map(),
	};
}

function evt(partial: Partial<HarnessEvent>): HarnessEvent {
	return {
		hook_event: "PostToolUse",
		session_id: "s",
		agent_source: "claude",
		timestamp: "2026-05-27T00:00:00.000Z",
		...partial,
	};
}

describe("isPostToolUseEvent", () => {
	it("is true for PostToolUse / AfterTool / PostToolUseFailure", () => {
		expect(isPostToolUseEvent(evt({ hook_event: "PostToolUse" }))).toBe(true);
		expect(isPostToolUseEvent(evt({ hook_event: "AfterTool" }))).toBe(true);
		expect(isPostToolUseEvent(evt({ hook_event: "PostToolUseFailure" }))).toBe(true);
	});

	it("is false for PreToolUse", () => {
		expect(isPostToolUseEvent(evt({ hook_event: "PreToolUse" }))).toBe(false);
	});
});

describe("isSequenceWriteOperation", () => {
	it("includes MultiEdit (superset of plain write ops)", () => {
		expect(isSequenceWriteOperation("MultiEdit")).toBe(true);
		expect(isSequenceWriteOperation("Write")).toBe(true);
		expect(isSequenceWriteOperation("Edit")).toBe(true);
	});

	it("is false for read-only / undefined tools", () => {
		expect(isSequenceWriteOperation("Read")).toBe(false);
		expect(isSequenceWriteOperation(undefined)).toBe(false);
	});
});

describe("extractWriteChunks", () => {
	it("pulls a Write's `content`, an Edit's `new_string`, and each MultiEdit entry", () => {
		expect(extractWriteChunks(evt({ tool_input: { content: "whole file" } }))).toEqual([
			"whole file",
		]);
		expect(extractWriteChunks(evt({ tool_input: { new_string: "edited" } }))).toEqual(["edited"]);
		expect(
			extractWriteChunks(
				evt({ tool_input: { edits: [{ new_string: "a" }, { new_string: "b" }] } }),
			),
		).toEqual(["a", "b"]);
	});

	it("returns [] when no recognized field is present", () => {
		expect(extractWriteChunks(evt({ tool_input: { file_path: "x.ts" } }))).toEqual([]);
		expect(extractWriteChunks(evt({}))).toEqual([]);
	});
});

describe("recordRecentLineEdit", () => {
	it("creates a ring-buffer entry with sha256 content_hash and line-count range", () => {
		const s = makeSession();
		recordRecentLineEdit(s, "src/a.ts", "line1\nline2\nline3");
		const entries = s.recent_line_edits?.get("src/a.ts");
		expect(entries?.length).toBe(1);
		expect(entries?.[0]?.content_hash).toBe(sha256("line1\nline2\nline3"));
		expect(entries?.[0]?.range).toEqual({ start: 0, end: 3 });
	});

	it("drops a no-op re-apply of the immediately-preceding identical chunk", () => {
		const s = makeSession();
		recordRecentLineEdit(s, "src/a.ts", "same");
		recordRecentLineEdit(s, "src/a.ts", "same");
		expect(s.recent_line_edits?.get("src/a.ts")?.length).toBe(1);
	});

	it("STILL records a genuine A→B→A oscillation", () => {
		const s = makeSession();
		recordRecentLineEdit(s, "src/a.ts", "A");
		recordRecentLineEdit(s, "src/a.ts", "B");
		recordRecentLineEdit(s, "src/a.ts", "A");
		const entries = s.recent_line_edits?.get("src/a.ts");
		expect(entries?.length).toBe(3);
		expect(entries?.[0]?.content_hash).toBe(entries?.[2]?.content_hash);
	});

	it("caps the ring buffer at 20 entries per file (drops oldest)", () => {
		const s = makeSession();
		for (let i = 0; i < 25; i++) recordRecentLineEdit(s, "src/a.ts", `x${i}`);
		const entries = s.recent_line_edits?.get("src/a.ts");
		expect(entries?.length).toBe(20);
		expect(entries?.[0]?.content_hash).toBe(sha256("x5"));
		expect(entries?.[19]?.content_hash).toBe(sha256("x24"));
	});
});

describe("recordLiteralOccurrences", () => {
	it("adds the file path to each non-trivial literal's occurrence set", () => {
		const s = makeSession();
		recordLiteralOccurrences(s, "src/a.ts", 'const P = "/etc/secret-keys/app";');
		recordLiteralOccurrences(s, "src/b.ts", 'const Q = "/etc/secret-keys/app";');
		const hash = sha256("/etc/secret-keys/app");
		expect(s.literal_occurrences?.get(hash)?.size).toBe(2);
	});

	it("caps literal extraction per edit at 50 entries", () => {
		const s = makeSession();
		const parts: string[] = [];
		for (let i = 0; i < 80; i++) parts.push(`const N${i} = ${1000 + i};`);
		recordLiteralOccurrences(s, "src/a.ts", parts.join("\n"));
		expect(s.literal_occurrences?.size).toBe(50);
	});

	it("leaves the map empty when the chunk has no qualifying literals", () => {
		const s = makeSession();
		recordLiteralOccurrences(s, "src/a.ts", "const x = a + b");
		expect(s.literal_occurrences?.size ?? 0).toBe(0);
	});
});

describe("extractNonTrivialLiterals", () => {
	it("returns string literals ≥8 chars, skips shorter ones", () => {
		expect(extractNonTrivialLiterals('const x = "abcdefghij";')).toContain("abcdefghij");
		expect(extractNonTrivialLiterals('const x = "abc";')).not.toContain("abc");
	});

	it("returns 3+-digit numbers outside the boring and HTTP-status ranges", () => {
		expect(extractNonTrivialLiterals("const x = 12345;")).toContain("12345");
	});

	it("skips HTTP status codes (200/404/500) and boring numbers (≤256)", () => {
		expect(extractNonTrivialLiterals("status === 200")).not.toContain("200");
		expect(extractNonTrivialLiterals("status === 404")).not.toContain("404");
		expect(extractNonTrivialLiterals("const x = 256;")).not.toContain("256");
	});
});
