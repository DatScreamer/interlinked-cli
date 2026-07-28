import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	DRIFT_PCT_THRESHOLD,
	detectPlanDrift,
	formatPlanDriftWarning,
	UNEXPECTED_ACTIONS_THRESHOLD,
} from "../plan-drift.js";
import type { CapturedPlan, PlanStep } from "../types/plan.js";
import type { SessionTrajectory } from "../types.js";

// ===========================================
// Helpers
// ===========================================

const FIXED_NOW = 1_700_000_000_000;
const FIXED_SESSION_STARTED_AT = new Date(FIXED_NOW - 60_000).toISOString();

function makeSession(
	overrides: Partial<SessionTrajectory> & { declared_plan?: CapturedPlan } = {},
): SessionTrajectory {
	const base: SessionTrajectory = {
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
	};
	// `declared_plan` is added to SessionTrajectory by Item #2 of the
	// agent-quality rollout. Until that field is merged, we attach it
	// dynamically with the same defensive cast the detector uses.
	const merged = { ...base, ...overrides } as SessionTrajectory & {
		declared_plan?: CapturedPlan;
	};
	if (overrides.declared_plan) merged.declared_plan = overrides.declared_plan;
	return merged;
}

function step(intent: string, extra: Partial<PlanStep> = {}): PlanStep {
	return { intent, status: "pending", ...extra };
}

function makePlan(steps: PlanStep[], extra: Partial<CapturedPlan> = {}): CapturedPlan {
	return {
		session_id: "test-session",
		agent_name: "test-agent",
		created_at_iso: FIXED_SESSION_STARTED_AT,
		created_at_step: 0,
		source: "TaskCreate",
		steps,
		...extra,
	};
}

// ===========================================
// detectPlanDrift
// ===========================================

describe("detectPlanDrift", () => {
	it("returns null when session has no declared_plan", () => {
		const session = makeSession({
			tool_sequence: ["Edit:src/foo.ts", "Bash:npm test"],
		});
		expect(detectPlanDrift(session)).toBeNull();
	});

	it("declared 3 steps, all executed → drift 0%, no missing", () => {
		const session = makeSession({
			declared_plan: makePlan([
				step("Edit src/foo.ts"),
				step("Run npm test"),
				step("Edit README.md"),
			]),
			tool_sequence: [
				"Edit:src/foo.ts",
				"Bash:npm test",
				"Edit:README.md",
			],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.declared_count).toBe(3);
		expect(report!.matched_count).toBe(3);
		expect(report!.missing_steps).toHaveLength(0);
		expect(report!.drift_pct).toBe(0);
	});

	it("declared 3 steps, 2 executed → 1 missing, drift ≈ 0.33", () => {
		const session = makeSession({
			declared_plan: makePlan([
				step("Edit src/foo.ts file"),
				step("Edit src/bar.ts file"),
				step("Run npm test"),
			]),
			tool_sequence: ["Edit:src/foo.ts", "Edit:src/bar.ts"],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.declared_count).toBe(3);
		expect(report!.matched_count).toBe(2);
		expect(report!.missing_steps).toHaveLength(1);
		expect(nonNull(report!.missing_steps[0]).intent).toContain("npm test");
		expect(report!.drift_pct).toBeCloseTo(1 / 3, 5);
	});

	it("declared 2 steps, 5 actions (3 unexpected non-Read) → 3 unexpected", () => {
		const session = makeSession({
			declared_plan: makePlan([
				step("Edit src/foo.ts file"),
				step("Run npm test"),
			]),
			tool_sequence: [
				"Edit:src/foo.ts", // matches step 1
				"Bash:npm test", // matches step 2
				"Edit:src/secret.ts", // unexpected
				"Bash:git commit -am x", // unexpected
				"Write:src/new.ts", // unexpected
			],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.matched_count).toBe(2);
		expect(report!.unexpected_actions).toHaveLength(3);
		expect(report!.unexpected_actions).toContain("Edit:src/secret.ts");
		expect(report!.unexpected_actions).toContain("Bash:git commit -am x");
		expect(report!.unexpected_actions).toContain("Write:src/new.ts");
	});

	it("declared plan with empty steps array → drift_pct 0, declared_count 0", () => {
		const session = makeSession({
			declared_plan: makePlan([]),
			tool_sequence: ["Edit:src/foo.ts"],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.declared_count).toBe(0);
		expect(report!.drift_pct).toBe(0);
		expect(report!.missing_steps).toHaveLength(0);
	});

	it("tool_sequence contains only Read/Grep entries → none counted as unexpected", () => {
		const session = makeSession({
			declared_plan: makePlan([step("Edit src/foo.ts")]),
			tool_sequence: [
				"Read:src/a.ts",
				"Read:src/b.ts",
				"Grep:foo",
				"Glob:**/*.ts",
				"LS:src/",
				"NotebookRead:notebook.ipynb",
			],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.unexpected_actions).toHaveLength(0);
		// The single declared step has no match (no Edit entry in sequence).
		expect(report!.missing_steps).toHaveLength(1);
	});

	it("token matching: 'Edit src/foo.ts' step matches 'Edit:src/foo.ts' entry", () => {
		const session = makeSession({
			declared_plan: makePlan([step("Edit src/foo.ts")]),
			tool_sequence: ["Edit:src/foo.ts"],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.matched_count).toBe(1);
		expect(report!.missing_steps).toHaveLength(0);
	});

	it("each step claims at most one tool_sequence entry (greedy first-match)", () => {
		// Two declared steps that both could match "Edit:src/foo.ts" — only
		// the first step should consume it; the second step is missing.
		const session = makeSession({
			declared_plan: makePlan([
				step("Edit foo file in src"),
				step("Edit foo file in src"),
			]),
			tool_sequence: ["Edit:src/foo.ts"],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.matched_count).toBe(1);
		expect(report!.missing_steps).toHaveLength(1);
	});

	it("respects step.tool_hint and target_hint when tokenizing", () => {
		const session = makeSession({
			declared_plan: makePlan([
				step("set up the new module", {
					tool_hint: "Edit",
					target_hint: "src/foo.ts",
				}),
			]),
			tool_sequence: ["Edit:src/foo.ts"],
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		// Without the hints, "set up the new module" would not tokenize
		// to overlap with "Edit:src/foo.ts". With the hints folded in,
		// the overlap is high enough.
		expect(report!.matched_count).toBe(1);
	});

	it("unexpected_actions list is capped at 10", () => {
		const sequence: string[] = [];
		for (let i = 0; i < 20; i++) {
			sequence.push(`Bash:cmd-${i}`);
		}
		// tool_sequence is bounded at 20 entries in session-state.ts, so a
		// 20-entry pool is the worst-case input shape.
		const session = makeSession({
			declared_plan: makePlan([step("totally unrelated step")]),
			tool_sequence: sequence,
		});
		const report = detectPlanDrift(session);
		expect(report).not.toBeNull();
		expect(report!.unexpected_actions.length).toBeLessThanOrEqual(10);
	});
});

// ===========================================
// formatPlanDriftWarning — threshold behavior
// ===========================================

describe("formatPlanDriftWarning", () => {
	it("emits advisory when drift_pct > threshold (0.4 > 0.3)", () => {
		const warning = formatPlanDriftWarning({
			report: {
				declared_count: 5,
				matched_count: 3,
				missing_steps: [step("missing one"), step("missing two")],
				unexpected_actions: [],
				drift_pct: 0.4,
			},
		});
		expect(warning).not.toBeNull();
		expect(warning).toContain("[interlinked:plan-drift]");
		expect(warning).toContain("Declared 5");
		expect(warning).toContain("matched 3");
		expect(warning).toContain("missing one");
		expect(warning).toContain("missing two");
	});

	it("suppresses advisory when drift_pct=0.1 and 2 unexpected (both under threshold)", () => {
		const warning = formatPlanDriftWarning({
			report: {
				declared_count: 10,
				matched_count: 9,
				missing_steps: [step("only one missing")],
				unexpected_actions: ["Edit:src/a.ts", "Edit:src/b.ts"],
				drift_pct: 0.1,
			},
		});
		expect(warning).toBeNull();
	});

	it("emits advisory when 5 unexpected actions cross unexpected-threshold (>3)", () => {
		const warning = formatPlanDriftWarning({
			report: {
				declared_count: 2,
				matched_count: 2,
				missing_steps: [],
				unexpected_actions: [
					"Edit:src/a.ts",
					"Edit:src/b.ts",
					"Edit:src/c.ts",
					"Edit:src/d.ts",
					"Edit:src/e.ts",
				],
				drift_pct: 0,
			},
		});
		expect(warning).not.toBeNull();
		expect(warning).toContain("Edit:src/a.ts");
	});

	it("returns null when both thresholds are at-or-below their gates", () => {
		// drift_pct exactly equals threshold (uses strict >, so suppress)
		const warning = formatPlanDriftWarning({
			report: {
				declared_count: 10,
				matched_count: 7,
				missing_steps: [step("a"), step("b"), step("c")],
				unexpected_actions: ["Edit:x.ts", "Edit:y.ts", "Edit:z.ts"],
				drift_pct: DRIFT_PCT_THRESHOLD,
			},
			driftThreshold: DRIFT_PCT_THRESHOLD,
			unexpectedThreshold: UNEXPECTED_ACTIONS_THRESHOLD,
		});
		expect(warning).toBeNull();
	});

	it("truncates missing-steps list at 5 with an 'and N more' suffix", () => {
		const missing: PlanStep[] = [];
		for (let i = 0; i < 8; i++) {
			missing.push(step(`step number ${i}`));
		}
		const warning = formatPlanDriftWarning({
			report: {
				declared_count: 10,
				matched_count: 2,
				missing_steps: missing,
				unexpected_actions: [],
				drift_pct: 0.8,
			},
		});
		expect(warning).not.toBeNull();
		expect(warning).toContain("step number 0");
		expect(warning).toContain("step number 4");
		expect(warning).not.toContain("step number 5");
		expect(warning).toContain("and 3 more");
	});
});
