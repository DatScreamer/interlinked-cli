// ===========================================
// turn-end.ts — trajectory-level turn summary + pattern detection
// ===========================================

import { describe, expect, it } from "vitest";

import { buildTurnEndSummary, detectTurnPatterns, formatTurnEndWarnings } from "./turn-end.js";
import type { SessionTrajectory } from "./types.js";

const FIXED_STARTED_AT = new Date(1_700_000_000_000 - 5_000).toISOString();

function makeSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		session_id: "sess-1",
		agent_name: "test-agent",
		started_at: FIXED_STARTED_AT,
		tool_call_count: 0,
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
		last_coordination_ts: 1_700_000_000_000,
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
		assertion_counts: new Map(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// detectTurnPatterns — edit-without-test
// ---------------------------------------------------------------------------

describe("detectTurnPatterns — edit-without-test", () => {
	it("does not fire when no files were written", () => {
		const session = makeSession({ files_written: new Set() });
		expect(detectTurnPatterns(session)).not.toContain("edit-without-test");
	});

	it("does not fire when written files are all non-source (e.g. test files only)", () => {
		const session = makeSession({ files_written: new Set(["src/foo.test.ts"]) });
		expect(detectTurnPatterns(session)).not.toContain("edit-without-test");
	});

	it("fires when a source file was written and no test command ran", () => {
		const session = makeSession({
			files_written: new Set(["src/foo.ts"]),
			commands_run: ["ls -la"],
		});
		expect(detectTurnPatterns(session)).toContain("edit-without-test");
	});

	it("does not fire when a source file was written and a test command ran", () => {
		const session = makeSession({
			files_written: new Set(["src/foo.ts"]),
			commands_run: ["npx vitest run src/foo.test.ts"],
		});
		expect(detectTurnPatterns(session)).not.toContain("edit-without-test");
	});
});

// ---------------------------------------------------------------------------
// detectTurnPatterns — repeated-failure
// ---------------------------------------------------------------------------

describe("detectTurnPatterns — repeated-failure", () => {
	it("does not fire when no file has 3+ failures", () => {
		const session = makeSession({
			failed_files: new Map([
				["src/a.ts", { failure_count: 2, checks: ["tsc"], recorded_at: "x", tool_call_count: 1 }],
			]),
		});
		expect(detectTurnPatterns(session)).not.toContain("repeated-failure");
	});

	it("fires when a file has failed 3+ times", () => {
		const session = makeSession({
			failed_files: new Map([
				["src/a.ts", { failure_count: 3, checks: ["tsc"], recorded_at: "x", tool_call_count: 1 }],
			]),
		});
		expect(detectTurnPatterns(session)).toContain("repeated-failure");
	});
});

// ---------------------------------------------------------------------------
// detectTurnPatterns — redundant-reread
// ---------------------------------------------------------------------------

describe("detectTurnPatterns — redundant-reread", () => {
	it("does not fire when fewer than 3 reads are stale", () => {
		const session = makeSession({
			tool_call_count: 10,
			file_read_at: new Map([
				["a.ts", 8], // within 5 of current -> not stale
				["b.ts", 9],
			]),
		});
		expect(detectTurnPatterns(session)).not.toContain("redundant-reread");
	});

	it("fires when 3+ reads are stale (read more than 5 calls ago)", () => {
		const session = makeSession({
			tool_call_count: 10,
			file_read_at: new Map([
				["a.ts", 1],
				["b.ts", 2],
				["c.ts", 3],
			]),
		});
		expect(detectTurnPatterns(session)).toContain("redundant-reread");
	});
});

// ---------------------------------------------------------------------------
// detectTurnPatterns — write-without-read
// ---------------------------------------------------------------------------

describe("detectTurnPatterns — write-without-read", () => {
	it("does not fire when every written file was also read", () => {
		const session = makeSession({
			files_written: new Set(["src/a.ts"]),
			files_read: new Set(["src/a.ts"]),
		});
		expect(detectTurnPatterns(session)).not.toContain("write-without-read");
	});

	it("does not fire for a written test file that was never read (exempted)", () => {
		const session = makeSession({
			files_written: new Set(["src/a.test.ts"]),
			files_read: new Set(),
		});
		expect(detectTurnPatterns(session)).not.toContain("write-without-read");
	});

	it("fires when a non-test file was written but never read", () => {
		const session = makeSession({
			files_written: new Set(["src/a.ts"]),
			files_read: new Set(),
		});
		expect(detectTurnPatterns(session)).toContain("write-without-read");
	});
});

// ---------------------------------------------------------------------------
// detectTurnPatterns — file-thrashing
// ---------------------------------------------------------------------------

describe("detectTurnPatterns — file-thrashing", () => {
	it("does not fire when no tool_sequence entries are Edit:/Write:", () => {
		const session = makeSession({ tool_sequence: ["Read:src/a.ts", "Bash:ls"] });
		expect(detectTurnPatterns(session)).not.toContain("file-thrashing");
	});

	it("does not fire when a file was edited 3 or fewer times", () => {
		const session = makeSession({
			tool_sequence: ["Edit:src/a.ts", "Edit:src/a.ts", "Edit:src/a.ts"],
		});
		expect(detectTurnPatterns(session)).not.toContain("file-thrashing");
	});

	it("fires when a file was edited more than 3 times", () => {
		const session = makeSession({
			tool_sequence: [
				"Edit:src/a.ts",
				"Write:src/a.ts",
				"Edit:src/a.ts",
				"Edit:src/a.ts",
			],
		});
		expect(detectTurnPatterns(session)).toContain("file-thrashing");
	});

	it("joins the file path back together when it contains colons", () => {
		const session = makeSession({
			tool_sequence: [
				"Edit:C:\\repo\\a.ts",
				"Edit:C:\\repo\\a.ts",
				"Edit:C:\\repo\\a.ts",
				"Edit:C:\\repo\\a.ts",
			],
		});
		expect(detectTurnPatterns(session)).toContain("file-thrashing");
	});
});

// ---------------------------------------------------------------------------
// detectTurnPatterns — combination: all patterns fire together
// ---------------------------------------------------------------------------

describe("detectTurnPatterns — combined", () => {
	it("returns every pattern that independently qualifies, in declared order", () => {
		const session = makeSession({
			tool_call_count: 10,
			files_written: new Set(["src/a.ts"]),
			files_read: new Set(),
			commands_run: ["ls"],
			failed_files: new Map([
				["src/a.ts", { failure_count: 3, checks: ["tsc"], recorded_at: "x", tool_call_count: 1 }],
			]),
			file_read_at: new Map([
				["x.ts", 1],
				["y.ts", 2],
				["z.ts", 3],
			]),
			tool_sequence: ["Edit:src/a.ts", "Edit:src/a.ts", "Edit:src/a.ts", "Edit:src/a.ts"],
		});
		expect(detectTurnPatterns(session)).toEqual([
			"edit-without-test",
			"repeated-failure",
			"redundant-reread",
			"write-without-read",
			"file-thrashing",
		]);
	});
});

// ---------------------------------------------------------------------------
// buildTurnEndSummary
// ---------------------------------------------------------------------------

describe("buildTurnEndSummary", () => {
	it("assembles a summary reflecting session state and counts", () => {
		const session = makeSession({
			session_id: "abc",
			agent_name: "claude",
			tool_call_count: 7,
			files_written: new Set(["src/a.ts"]),
			files_read: new Set(["src/b.ts"]),
			commands_run: ["npm test"],
			sensitivity_level: "Confidential",
		});
		const summary = buildTurnEndSummary(session, 2, 5);
		expect(summary.session_id).toBe("abc");
		expect(summary.agent_name).toBe("claude");
		expect(summary.tool_call_count).toBe(7);
		expect(summary.files_written).toEqual(["src/a.ts"]);
		expect(summary.files_read).toEqual(["src/b.ts"]);
		expect(summary.commands_run).toEqual(["npm test"]);
		expect(summary.block_count).toBe(2);
		expect(summary.warning_count).toBe(5);
		expect(summary.sensitivity_level).toBe("Confidential");
		expect(summary.turn_patterns).toEqual(["write-without-read"]);
		expect(summary.turn_duration_ms).toBeGreaterThanOrEqual(0);
	});
});

// ---------------------------------------------------------------------------
// formatTurnEndWarnings
// ---------------------------------------------------------------------------

describe("formatTurnEndWarnings", () => {
	function summaryWithPatterns(patterns: string[]) {
		return {
			session_id: "s",
			agent_name: "a",
			tool_call_count: 1,
			files_written: ["src/a.ts", "src/b.ts"],
			files_read: [],
			commands_run: [],
			warning_count: 0,
			block_count: 0,
			turn_patterns: patterns,
			sensitivity_level: "Public" as const,
			turn_duration_ms: 0,
		};
	}

	it("returns [] when there are no turn patterns", () => {
		expect(formatTurnEndWarnings(summaryWithPatterns([]))).toEqual([]);
	});

	it("formats the edit-without-test warning with the written-file count", () => {
		const warnings = formatTurnEndWarnings(summaryWithPatterns(["edit-without-test"]));
		expect(warnings).toEqual([
			"[interlinked:turn-end] You edited 2 source file(s) but didn't run tests. Consider running the test suite before finishing.",
		]);
	});

	it("formats the repeated-failure warning", () => {
		const warnings = formatTurnEndWarnings(summaryWithPatterns(["repeated-failure"]));
		expect(warnings).toEqual([
			"[interlinked:turn-end] Multiple files failed checks repeatedly this session. Step back and re-read the failing files before making more edits.",
		]);
	});

	it("formats the redundant-reread warning", () => {
		const warnings = formatTurnEndWarnings(summaryWithPatterns(["redundant-reread"]));
		expect(warnings).toEqual([
			"[interlinked:turn-end] Several files were re-read without changes. Use the information from the first read — re-reading wastes context.",
		]);
	});

	it("emits no warning for write-without-read (advisory intentionally cut)", () => {
		expect(formatTurnEndWarnings(summaryWithPatterns(["write-without-read"]))).toEqual([]);
	});

	it("formats the file-thrashing warning", () => {
		const warnings = formatTurnEndWarnings(summaryWithPatterns(["file-thrashing"]));
		expect(warnings).toEqual([
			"[interlinked:turn-end] A file was edited 4+ times this session. Plan your changes before editing — frequent small edits waste tool calls.",
		]);
	});

	it("formats multiple warnings in pattern order, skipping the cut one", () => {
		const warnings = formatTurnEndWarnings(
			summaryWithPatterns(["edit-without-test", "write-without-read", "file-thrashing"]),
		);
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("didn't run tests");
		expect(warnings[1]).toContain("edited 4+ times");
	});
});
