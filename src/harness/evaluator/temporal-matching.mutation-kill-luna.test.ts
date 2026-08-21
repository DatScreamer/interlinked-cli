import { describe, expect, it } from "vitest";
import {
	evaluateForbidsAfter,
	evaluateRequiresPrior,
} from "./temporal-matching.js";
import type { SessionTrajectory, TemporalPredicate } from "../types.js";

function session(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		session_id: "mutation-fixture",
		agent_name: "test-agent",
		started_at: "2026-01-01T00:00:00.000Z",
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
		last_coordination_ts: 0,
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
		assertion_counts: new Map(),
		verification_observed: new Set(),
		...overrides,
	};
}

describe("temporal matching boundary contracts", () => {
	// test-contract: boundary — non-positive windows mean the complete trajectory is eligible
	it("uses the complete tool trajectory for undefined, zero, and negative windows", () => {
		const tool_sequence = ["Read:old.ts", "Edit:new.ts"];
		const predicates: TemporalPredicate[] = [
			{ tool: "Read" },
			{ tool: "Read", within_last_n: 0 },
			{ tool: "Read", within_last_n: -1 },
		];
		for (const predicate of predicates) {
			expect(
				evaluateRequiresPrior(session({ tool_sequence }), predicate).satisfied,
			).toBe(true);
		}
	});

	// test-contract: boundary — a window exactly as long as the history includes its oldest action
	it("includes the oldest entry when the window equals the trajectory length", () => {
		expect(
			evaluateRequiresPrior(
			session({ tool_sequence: ["Read:old.ts", "Edit:new.ts"] }),
			{ tool: "Read", within_last_n: 2 },
		).satisfied,
	).toBe(true);
	});

	// test-contract: public-api — tool names are matched exactly while targets may contain colons
	it("distinguishes a tool name from a colon-containing target and supports colonless entries", () => {
		expect(
			evaluateRequiresPrior(
				session({ tool_sequence: ["Read", "Bash:git log --oneline"] }),
				{ tool: "Read" },
			).satisfied,
		).toBe(true);
		expect(
			evaluateRequiresPrior(
				session({ tool_sequence: [":target"] }),
				{ tool: "" },
			).satisfied,
		).toBe(true);
	});

	// test-contract: boundary — an empty command history cannot satisfy a command precondition
	it("reports an unsatisfied bash predicate for an empty command history", () => {
		const result = evaluateRequiresPrior(session(), { bash_match: ".*" });
		expect(result).toEqual({
			satisfied: false,
			reason: "no prior command matching /.*/",
		});
	});

	// test-contract: public-api — an omitted file predicate leaves other predicate fields unaffected
	it("treats an omitted file field as vacuously satisfied", () => {
		expect(
			evaluateRequiresPrior(session(), { verification_kind: "test" }).reason,
		).toContain("no prior test verification");
	});

	// test-contract: public-api — exact file names use set membership and preserve literal path characters
	it("matches an exact file path literally", () => {
		expect(
			evaluateRequiresPrior(session({ files_read: new Set(["src/[a].ts"]) }), {
				file_read: "src/[a].ts",
			}).satisfied,
		).toBe(true);
	});

	// test-contract: boundary — single-star globs stay within one path segment
	it("does not let a single-star glob cross a directory separator", () => {
		expect(
			evaluateRequiresPrior(session({ files_read: new Set(["src/deep/file.ts"]) }), {
				file_read: "src/*/other.ts",
			}).satisfied,
		).toBe(false);
	});

	// test-contract: boundary — double-star globs intentionally cross directory separators
	it("lets a double-star glob match nested path segments", () => {
		expect(
			evaluateRequiresPrior(session({ files_read: new Set(["src/deep/file.ts"]) }), {
				file_read: "src/**/file.ts",
			}).satisfied,
		).toBe(true);
	});

	// test-contract: public-api — anchored file globs reject a partial filename match
	it("requires a complete file path for a glob", () => {
		expect(
			evaluateRequiresPrior(session({ files_read: new Set(["src/file.ts.bak"]) }), {
				file_read: "src/*.ts",
			}).satisfied,
		).toBe(false);
	});

	// test-contract: public-api — an observed verification kind is required for the predicate to hold
	it("handles an absent verification set as unsatisfied", () => {
		const empty = session();
		delete empty.verification_observed;
		const result = evaluateRequiresPrior(
			empty,
			{ verification_kind: "test" },
		);
		expect(result.satisfied).toBe(false);
		expect(result.reason).toBe("no prior test verification");
	});

	// test-contract: invariant — every populated temporal field contributes to the AND result
	it("describes each missing field and the active window", () => {
		const result = evaluateRequiresPrior(
			session(),
			{
				tool: "Read",
				bash_match: "git",
				file_read: "src/a.ts",
				verification_kind: "test",
				within_last_n: 3,
			},
		);
		expect(result.satisfied).toBe(false);
		expect(result.reason).toContain("no prior `Read` tool call");
		expect(result.reason).toContain("no prior command matching /git/");
		expect(result.reason).toContain("no prior file read matching src/a.ts");
		expect(result.reason).toContain("no prior test verification");
		expect(result.reason).toContain("within last 3 actions");
	});

	// test-contract: public-api — a satisfied predicate returns no explanatory failure reason
	it("returns the dormant result without a reason when forbids_after is absent", () => {
		const result = evaluateForbidsAfter(session(), { tool: "Bash" });
		expect(result).toEqual({ satisfied: false });
	});
});
