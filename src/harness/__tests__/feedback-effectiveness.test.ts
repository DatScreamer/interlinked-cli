import { describe, expect, it } from "vitest";
import {
	computeEffectivenessSummary,
	recordWarningResolutions,
	recordWarningsIssued,
} from "../feedback-effectiveness.js";
import type { SessionTrajectory } from "../types.js";

// ===========================================
// Helpers
// ===========================================

// Deterministic fixtures.
const FIXED_NOW = 1_700_000_000_000;
const FIXED_SESSION_STARTED_AT = new Date(FIXED_NOW - 60_000).toISOString();

function makeSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		session_id: "test-session",
		agent_name: "test-agent",
		started_at: FIXED_SESSION_STARTED_AT,
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
		last_coordination_ts: FIXED_NOW,
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

// ===========================================
// 1. recordWarningsIssued
// ===========================================

describe("recordWarningsIssued", () => {
	it("creates new entry in warnings_issued map", () => {
		const session = makeSession({ tool_call_count: 5 });

		recordWarningsIssued(session, "src/foo.ts", ["typescript"]);

		const record = session.warnings_issued.get("src/foo.ts::typescript");
		expect(record).toBeDefined();
		expect(record!.check_name).toBe("typescript");
		expect(record!.issue_count).toBe(1);
		expect(record!.first_issued_at).toBe(5);
		expect(record!.last_issued_at).toBe(5);
		expect(record!.resolved).toBe(false);
	});

	it("increments issue_count on re-issue", () => {
		const session = makeSession({ tool_call_count: 5 });

		recordWarningsIssued(session, "src/foo.ts", ["typescript"]);
		session.tool_call_count = 10;
		recordWarningsIssued(session, "src/foo.ts", ["typescript"]);

		const record = session.warnings_issued.get("src/foo.ts::typescript");
		expect(record!.issue_count).toBe(2);
		expect(record!.first_issued_at).toBe(5);
		expect(record!.last_issued_at).toBe(10);
	});

	it("sets resolved to false on re-issue (re-opens resolved warnings)", () => {
		const warnings = new Map([
			[
				"src/foo.ts::typescript",
				{
					check_name: "typescript",
					issue_count: 1,
					first_issued_at: 2,
					last_issued_at: 2,
					resolved: true,
				},
			],
		]);
		const session = makeSession({ warnings_issued: warnings, tool_call_count: 8 });

		recordWarningsIssued(session, "src/foo.ts", ["typescript"]);

		const record = session.warnings_issued.get("src/foo.ts::typescript");
		expect(record!.resolved).toBe(false);
		expect(record!.issue_count).toBe(2);
	});

	it("does not count operational no-verdict rows as source feedback", () => {
		const session = makeSession({ tool_call_count: 5 });
		recordWarningsIssued(session, "src/foo.ts", [
			"external_check_deferred",
			"affected_tests_deferred",
			"project_typecheck_deferred",
			"project_tests_deferred",
			"typescript",
		]);
		expect([...session.warnings_issued.keys()]).toEqual(["src/foo.ts::typescript"]);
	});
});

// ===========================================
// 2. recordWarningResolutions
// ===========================================

describe("recordWarningResolutions", () => {
	it("marks warning as resolved when check no longer fires", () => {
		const warnings = new Map([
			[
				"src/foo.ts::typescript",
				{
					check_name: "typescript",
					issue_count: 2,
					first_issued_at: 1,
					last_issued_at: 5,
					resolved: false,
				},
			],
		]);
		const session = makeSession({ warnings_issued: warnings });

		// Current checks do NOT include "typescript" -> should resolve
		recordWarningResolutions(session, "src/foo.ts", new Set(["biome"]));

		const record = session.warnings_issued.get("src/foo.ts::typescript");
		expect(record!.resolved).toBe(true);
	});

	it("does NOT mark as resolved when check still fires", () => {
		const warnings = new Map([
			[
				"src/foo.ts::typescript",
				{
					check_name: "typescript",
					issue_count: 1,
					first_issued_at: 1,
					last_issued_at: 3,
					resolved: false,
				},
			],
		]);
		const session = makeSession({ warnings_issued: warnings });

		// Current checks still include "typescript" -> should NOT resolve
		recordWarningResolutions(session, "src/foo.ts", new Set(["typescript"]));

		const record = session.warnings_issued.get("src/foo.ts::typescript");
		expect(record!.resolved).toBe(false);
	});

	it("only affects entries for the specified file", () => {
		const warnings = new Map([
			[
				"src/foo.ts::typescript",
				{
					check_name: "typescript",
					issue_count: 1,
					first_issued_at: 1,
					last_issued_at: 1,
					resolved: false,
				},
			],
			[
				"src/bar.ts::typescript",
				{
					check_name: "typescript",
					issue_count: 1,
					first_issued_at: 2,
					last_issued_at: 2,
					resolved: false,
				},
			],
		]);
		const session = makeSession({ warnings_issued: warnings });

		// Resolve for src/foo.ts only (typescript no longer fires there)
		recordWarningResolutions(session, "src/foo.ts", new Set());

		expect(session.warnings_issued.get("src/foo.ts::typescript")!.resolved).toBe(true);
		expect(session.warnings_issued.get("src/bar.ts::typescript")!.resolved).toBe(false);
	});

	it("does not infer resolution while the current call contains a no-verdict row", () => {
		const warnings = new Map([
			[
				"src/foo.ts::typescript",
				{
					check_name: "typescript",
					issue_count: 1,
					first_issued_at: 1,
					last_issued_at: 1,
					resolved: false,
				},
			],
		]);
		const session = makeSession({ warnings_issued: warnings });
		recordWarningResolutions(
			session,
			"src/foo.ts",
			new Set(["external_check_deferred"]),
		);
		expect(session.warnings_issued.get("src/foo.ts::typescript")!.resolved).toBe(false);
	});
});

// ===========================================
// 3. computeEffectivenessSummary
// ===========================================

describe("computeEffectivenessSummary", () => {
	it("computes correct per-check stats from warnings_issued entries", () => {
		const warnings = new Map([
			[
				"src/a.ts::typescript",
				{
					check_name: "typescript",
					issue_count: 3,
					first_issued_at: 1,
					last_issued_at: 5,
					resolved: true,
				},
			],
			[
				"src/b.ts::typescript",
				{
					check_name: "typescript",
					issue_count: 2,
					first_issued_at: 2,
					last_issued_at: 4,
					resolved: false,
				},
			],
			[
				"src/c.ts::biome",
				{
					check_name: "biome",
					issue_count: 1,
					first_issued_at: 3,
					last_issued_at: 3,
					resolved: true,
				},
			],
		]);
		const session = makeSession({ warnings_issued: warnings });

		const summary = computeEffectivenessSummary(session);

		// typescript: issued = 3 + 2 = 5, resolved = 1 (only first entry resolved)
		const tsStats = summary.per_check.find((s) => s.check_name === "typescript");
		expect(tsStats).toBeDefined();
		expect(tsStats!.times_issued).toBe(5);
		expect(tsStats!.times_resolved).toBe(1);

		// biome: issued = 1, resolved = 1
		const biomeStats = summary.per_check.find((s) => s.check_name === "biome");
		expect(biomeStats).toBeDefined();
		expect(biomeStats!.times_issued).toBe(1);
		expect(biomeStats!.times_resolved).toBe(1);

		// overall: issued = 6, resolved = 2
		expect(summary.total_issued).toBe(6);
		expect(summary.total_resolved).toBe(2);
	});

	it("returns 0 resolution rate when nothing resolved", () => {
		const warnings = new Map([
			[
				"src/a.ts::typescript",
				{
					check_name: "typescript",
					issue_count: 2,
					first_issued_at: 1,
					last_issued_at: 3,
					resolved: false,
				},
			],
		]);
		const session = makeSession({ warnings_issued: warnings });

		const summary = computeEffectivenessSummary(session);
		expect(summary.overall_resolution_rate).toBe(0);
		expect(summary.total_resolved).toBe(0);
	});

	it("returns 1.0 when everything resolved", () => {
		const warnings = new Map([
			[
				"src/a.ts::typescript",
				{
					check_name: "typescript",
					issue_count: 1,
					first_issued_at: 1,
					last_issued_at: 1,
					resolved: true,
				},
			],
		]);
		const session = makeSession({ warnings_issued: warnings });

		const summary = computeEffectivenessSummary(session);
		// resolved = 1, issued = 1 (from issue_count), rate = 1/1 = 1.0
		expect(summary.overall_resolution_rate).toBe(1);
		expect(summary.total_resolved).toBe(1);
		expect(summary.total_issued).toBe(1);
	});

	it("handles empty warnings_issued", () => {
		const session = makeSession();

		const summary = computeEffectivenessSummary(session);
		expect(summary.per_check).toEqual([]);
		expect(summary.overall_resolution_rate).toBe(0);
		expect(summary.total_issued).toBe(0);
		expect(summary.total_resolved).toBe(0);
	});
});
