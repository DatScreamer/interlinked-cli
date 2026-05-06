import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAsyncAnalysisManager } from "../async-analysis.js";
import {
	applyRewrite,
	classifyToolConcurrency,
	decomposeCommand,
	evaluateCompoundCommand,
	inferAgentRole,
	ruleAppliesToRole,
	stripEnvVarPrefix,
} from "../command-decomposition.js";
import { createLearnedRulesStore } from "../learned-rules.js";
import { buildTurnEndSummary, detectTurnPatterns, formatTurnEndWarnings } from "../turn-end.js";
import type { CheckResultEntry, GuardRule, HarnessEvent, SessionTrajectory } from "../types.js";

// ===========================================
// Helpers
// ===========================================

// Deterministic timestamps for test fixtures.
const FIXED_NOW = 1_700_000_000_000;
const FIXED_TIMESTAMP = new Date(FIXED_NOW).toISOString();
const FIXED_SESSION_STARTED_AT = new Date(FIXED_NOW - 60_000).toISOString();
const FIXED_RECORDED_AT = new Date(FIXED_NOW - 30_000).toISOString();

function makeEvent(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "test-session",
		agent_source: "claude",
		agent_name: "test-agent",
		tool_name: "Bash",
		tool_input: { command: "ls -la" },
		timestamp: FIXED_TIMESTAMP,
		...overrides,
	};
}

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

function makeRule(overrides: Partial<GuardRule> = {}): GuardRule {
	return {
		id: "test-rule",
		enabled: true,
		trigger: "PreToolUse",
		tool_match: ["Bash"],
		action: "block",
		patterns: [{ field: "command", regex: "rm\\s+-rf" }],
		reason: "Blocked destructive command",
		severity: "critical",
		...overrides,
	};
}

// ===========================================
// 1. Compound Command Decomposition
// ===========================================

describe("decomposeCommand", () => {
	it("splits on &&", () => {
		expect(decomposeCommand("cd /tmp && ls")).toEqual(["cd /tmp", "ls"]);
	});

	it("splits on ||", () => {
		expect(decomposeCommand("test -f foo || echo missing")).toEqual([
			"test -f foo",
			"echo missing",
		]);
	});

	it("splits on ;", () => {
		expect(decomposeCommand("echo a; echo b; echo c")).toEqual(["echo a", "echo b", "echo c"]);
	});

	it("splits on mixed operators", () => {
		expect(decomposeCommand("cd /tmp && npm test || echo fail; cleanup")).toEqual([
			"cd /tmp",
			"npm test",
			"echo fail",
			"cleanup",
		]);
	});

	it("does NOT split inside single quotes", () => {
		expect(decomposeCommand("echo 'a && b'")).toEqual(["echo 'a && b'"]);
	});

	it("does NOT split inside double quotes", () => {
		expect(decomposeCommand('grep "foo || bar" file.txt')).toEqual([
			'grep "foo || bar" file.txt',
		]);
	});

	it("does NOT split inside subshells", () => {
		expect(decomposeCommand("echo $(cat foo && cat bar)")).toEqual([
			"echo $(cat foo && cat bar)",
		]);
	});

	it("does NOT split inside backtick substitution", () => {
		expect(decomposeCommand("echo `cat foo && cat bar`")).toEqual([
			"echo `cat foo && cat bar`",
		]);
	});

	it("does NOT split on pipe (|)", () => {
		expect(decomposeCommand("cat file | grep pattern")).toEqual(["cat file | grep pattern"]);
	});

	it("handles empty input", () => {
		expect(decomposeCommand("")).toEqual([]);
	});

	it("handles single command", () => {
		expect(decomposeCommand("npm test")).toEqual(["npm test"]);
	});
});

// ===========================================
// 2. Env Var Stripping
// ===========================================

describe("stripEnvVarPrefix", () => {
	it("strips safe env vars in deny mode", () => {
		const result = stripEnvVarPrefix("NODE_ENV=test npm test", "deny");
		expect(result.stripped).toBe("npm test");
		expect(result.dangerous_var).toBeUndefined();
	});

	it("strips ALL env vars in deny mode (prevents bypass)", () => {
		const result = stripEnvVarPrefix("CUSTOM_VAR=x npm test", "deny");
		expect(result.stripped).toBe("npm test");
	});

	it("stops at unknown env vars in allow mode (prevents escalation)", () => {
		const result = stripEnvVarPrefix("CUSTOM_VAR=x npm test", "allow");
		expect(result.stripped).toBe("CUSTOM_VAR=x npm test");
	});

	it("strips known safe vars in allow mode", () => {
		const result = stripEnvVarPrefix("NODE_ENV=prod CI=1 npm test", "allow");
		expect(result.stripped).toBe("npm test");
	});

	it("flags dangerous env vars", () => {
		const result = stripEnvVarPrefix("LD_PRELOAD=/evil.so npm test", "deny");
		expect(result.dangerous_var).toBe("LD_PRELOAD");
	});

	it("flags PATH as dangerous", () => {
		const result = stripEnvVarPrefix("PATH=/tmp:$PATH ls", "deny");
		expect(result.dangerous_var).toBe("PATH");
	});

	it("flags PYTHONPATH as dangerous", () => {
		const result = stripEnvVarPrefix("PYTHONPATH=/evil python main.py", "allow");
		expect(result.dangerous_var).toBe("PYTHONPATH");
	});

	it("handles command with no env vars", () => {
		const result = stripEnvVarPrefix("npm test", "deny");
		expect(result.stripped).toBe("npm test");
	});
});

// ===========================================
// 3. Compound Command + Guard Rule Evaluation
// ===========================================

describe("evaluateCompoundCommand", () => {
	it("blocks if any subcommand matches a block rule", () => {
		const rules = [makeRule()];
		const result = evaluateCompoundCommand("cd /tmp && rm -rf /", rules);
		expect(result.decision).toBe("block");
		expect(result.reason).toContain("rm -rf");
	});

	it("allows if no subcommands match", () => {
		const rules = [makeRule()];
		const result = evaluateCompoundCommand("cd /tmp && ls -la", rules);
		expect(result.decision).toBe("allow");
	});

	it("aggregates warnings from warn rules", () => {
		const rules = [makeRule({ action: "warn", id: "warn-test" })];
		const result = evaluateCompoundCommand("cd /tmp && rm -rf /tmp/test", rules);
		expect(result.decision).toBe("allow");
		expect(result.warnings.length).toBeGreaterThan(0);
	});

	it("blocks on dangerous env vars in subcommands", () => {
		const rules: GuardRule[] = [];
		const result = evaluateCompoundCommand("cd /tmp && LD_PRELOAD=/evil.so ls", rules);
		expect(result.decision).toBe("block");
		expect(result.reason).toContain("LD_PRELOAD");
	});

	it("returns allow for single commands (fast path)", () => {
		const rules = [makeRule()];
		const result = evaluateCompoundCommand("ls -la", rules);
		expect(result.decision).toBe("allow");
		expect(result.warnings).toEqual([]);
	});

	it("applies rewrites and returns updated_input", () => {
		const rules = [
			makeRule({
				action: "rewrite",
				patterns: [{ field: "command", regex: "^rm (.+)" }],
				rewrite: { field: "command", match: "^rm (.+)", replace: "trash $1" },
			}),
		];
		const result = evaluateCompoundCommand("cd /tmp && rm foo.txt", rules);
		expect(result.decision).toBe("allow");
		expect(result.updated_input?.command).toContain("trash foo.txt");
	});
});

// ===========================================
// 4. Agent Role Inference
// ===========================================

describe("inferAgentRole", () => {
	it("returns explicit role when set", () => {
		expect(inferAgentRole(makeEvent({ agent_role: "worker" }))).toBe("worker");
	});

	it("returns subagent when parent_agent is set", () => {
		expect(inferAgentRole(makeEvent({ parent_agent: "lead-agent" }))).toBe("subagent");
	});

	it("returns subagent for SubagentStart events", () => {
		expect(inferAgentRole(makeEvent({ hook_event: "SubagentStart" }))).toBe("subagent");
	});

	it("infers subagent from agent_type explore", () => {
		expect(inferAgentRole(makeEvent({ agent_type: "Explore" }))).toBe("subagent");
	});

	it("infers worker from agent_type", () => {
		expect(inferAgentRole(makeEvent({ agent_type: "worker-general" }))).toBe("worker");
	});

	it("infers lead from agent_name", () => {
		expect(inferAgentRole(makeEvent({ agent_name: "lead-architect" }))).toBe("lead");
	});

	it("infers worker from agent_name", () => {
		expect(inferAgentRole(makeEvent({ agent_name: "worker-1" }))).toBe("worker");
	});

	it("returns unknown for generic agents", () => {
		expect(inferAgentRole(makeEvent({ agent_name: "my-agent" }))).toBe("unknown");
	});
});

describe("ruleAppliesToRole", () => {
	it("applies to all roles when applies_to_roles is empty", () => {
		const rule = makeRule({ applies_to_roles: [] });
		expect(ruleAppliesToRole(rule, "worker")).toBe(true);
		expect(ruleAppliesToRole(rule, "lead")).toBe(true);
	});

	it("applies to all roles when applies_to_roles is undefined", () => {
		const rule = makeRule();
		expect(ruleAppliesToRole(rule, "subagent")).toBe(true);
	});

	it("restricts to specified roles", () => {
		const rule = makeRule({ applies_to_roles: ["worker", "subagent"] });
		expect(ruleAppliesToRole(rule, "worker")).toBe(true);
		expect(ruleAppliesToRole(rule, "subagent")).toBe(true);
		expect(ruleAppliesToRole(rule, "lead")).toBe(false);
	});
});

// ===========================================
// 5. Input Rewrite
// ===========================================

describe("applyRewrite", () => {
	it("rewrites matching patterns", () => {
		const result = applyRewrite("rm -rf /tmp/test", {
			field: "command",
			match: "^rm -rf",
			replace: "trash",
		});
		expect(result).toBe("trash /tmp/test");
	});

	it("returns original on no match", () => {
		const result = applyRewrite("ls -la", {
			field: "command",
			match: "^rm",
			replace: "trash",
		});
		expect(result).toBe("ls -la");
	});

	it("returns original on invalid regex", () => {
		const result = applyRewrite("test", {
			field: "command",
			match: "[invalid",
			replace: "x",
		});
		expect(result).toBe("test");
	});

	it("rejects patterns over 200 chars", () => {
		const result = applyRewrite("test", {
			field: "command",
			match: "a".repeat(201),
			replace: "x",
		});
		expect(result).toBe("test");
	});
});

// ===========================================
// 6. Tool Concurrency Classification
// ===========================================

describe("classifyToolConcurrency", () => {
	it("classifies read tools as read_only", () => {
		expect(classifyToolConcurrency("Read")).toBe("read_only");
		expect(classifyToolConcurrency("Grep")).toBe("read_only");
		expect(classifyToolConcurrency("Glob")).toBe("read_only");
		expect(classifyToolConcurrency("WebFetch")).toBe("read_only");
		expect(classifyToolConcurrency("WebSearch")).toBe("read_only");
	});

	it("classifies write tools as state_changing", () => {
		expect(classifyToolConcurrency("Write")).toBe("state_changing");
		expect(classifyToolConcurrency("Edit")).toBe("state_changing");
		expect(classifyToolConcurrency("Bash")).toBe("state_changing");
		expect(classifyToolConcurrency("NotebookEdit")).toBe("state_changing");
	});

	it("classifies unknown tools as unknown", () => {
		expect(classifyToolConcurrency("CustomTool")).toBe("unknown");
		expect(classifyToolConcurrency("mcp__some_server__tool")).toBe("unknown");
	});
});

// ===========================================
// 7. Turn End Patterns
// ===========================================

describe("detectTurnPatterns", () => {
	it("detects edit-without-test", () => {
		const session = makeSession({
			files_written: new Set(["src/foo.ts"]),
			commands_run: ["npm run build"],
		});
		expect(detectTurnPatterns(session)).toContain("edit-without-test");
	});

	it("does not flag edit-without-test when tests ran", () => {
		const session = makeSession({
			files_written: new Set(["src/foo.ts"]),
			commands_run: ["npm test"],
		});
		expect(detectTurnPatterns(session)).not.toContain("edit-without-test");
	});

	it("detects write-without-read", () => {
		const session = makeSession({
			files_written: new Set(["src/foo.ts"]),
			files_read: new Set(),
		});
		expect(detectTurnPatterns(session)).toContain("write-without-read");
	});

	it("detects file-thrashing", () => {
		const session = makeSession({
			tool_sequence: [
				"Edit:src/foo.ts",
				"Edit:src/foo.ts",
				"Edit:src/foo.ts",
				"Edit:src/foo.ts",
			],
		});
		expect(detectTurnPatterns(session)).toContain("file-thrashing");
	});

	it("detects repeated-failure", () => {
		const failedFiles = new Map();
		failedFiles.set("src/foo.ts", {
			failure_count: 3,
			checks: ["typescript"],
			recorded_at: FIXED_RECORDED_AT,
			tool_call_count: 5,
		});
		const session = makeSession({ failed_files: failedFiles });
		expect(detectTurnPatterns(session)).toContain("repeated-failure");
	});
});

describe("buildTurnEndSummary", () => {
	it("builds a complete summary", () => {
		const session = makeSession({
			files_written: new Set(["src/a.ts"]),
			files_read: new Set(["src/b.ts"]),
			commands_run: ["npm test"],
			tool_call_count: 10,
		});
		const summary = buildTurnEndSummary(session, 2, 5);
		expect(summary.tool_call_count).toBe(10);
		expect(summary.block_count).toBe(2);
		expect(summary.warning_count).toBe(5);
		expect(summary.files_written).toEqual(["src/a.ts"]);
		expect(summary.turn_duration_ms).toBeGreaterThan(0);
	});
});

describe("formatTurnEndWarnings", () => {
	it("formats pattern warnings", () => {
		const session = makeSession({
			files_written: new Set(["src/foo.ts"]),
			commands_run: [],
		});
		const summary = buildTurnEndSummary(session, 0, 0);
		const warnings = formatTurnEndWarnings(summary);
		expect(warnings.some((w) => w.includes("didn't run tests"))).toBe(true);
	});
});

// ===========================================
// 8. Learned Rules Store
// ===========================================

describe("createLearnedRulesStore", () => {
	const tmpDir = join(process.cwd(), "tmp", "test-learned-rules");

	beforeEach(() => {
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
		mkdirSync(tmpDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
	});

	it("learns a pattern after threshold observations", () => {
		const store = createLearnedRulesStore(tmpDir, 3);
		expect(store.observe("Bash(npm test *)", "s1")).toBeNull();
		expect(store.observe("Bash(npm test *)", "s1")).toBeNull();
		const learned = store.observe("Bash(npm test *)", "s1");
		expect(learned).not.toBeNull();
		expect(learned!.pattern).toBe("Bash(npm test *)");
		expect(learned!.observation_count).toBe(3);
	});

	it("persists learned rules to disk", () => {
		const store = createLearnedRulesStore(tmpDir, 2);
		store.observe("Bash(npm test *)", "s1");
		store.observe("Bash(npm test *)", "s1");

		// Load a fresh store from the same directory
		const store2 = createLearnedRulesStore(tmpDir, 2);
		expect(store2.has("Bash(npm test *)")).toBe(true);
		expect(store2.rules.length).toBe(1);
	});

	it("does not re-learn already learned patterns", () => {
		const store = createLearnedRulesStore(tmpDir, 2);
		store.observe("Bash(ls *)", "s1");
		store.observe("Bash(ls *)", "s1"); // learned
		const result = store.observe("Bash(ls *)", "s2");
		expect(result).toBeNull();
	});

	it("tracks has() correctly", () => {
		const store = createLearnedRulesStore(tmpDir, 1);
		expect(store.has("Bash(foo *)")).toBe(false);
		store.observe("Bash(foo *)", "s1");
		expect(store.has("Bash(foo *)")).toBe(true);
	});
});

// ===========================================
// 9. Async Analysis Manager
// ===========================================

describe("createAsyncAnalysisManager", () => {
	const tmpDir = join(process.cwd(), "tmp", "test-async-analysis");

	beforeEach(() => {
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
		mkdirSync(tmpDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
	});

	it("runs analysis and stores findings", async () => {
		const mgr = createAsyncAnalysisManager(tmpDir);
		const findings: CheckResultEntry[] = [
			{
				source: "structural",
				name: "export_surface",
				severity: "warning",
				message: "Export removed",
				determinism: "fully_deterministic",
			},
		];
		mgr.submit("src/foo.ts", async () => findings);
		await mgr.drain();
		const consumed = mgr.consume("src/foo.ts");
		expect(consumed).toHaveLength(1);
		expect(consumed[0].name).toBe("export_surface");
	});

	it("consume clears findings", async () => {
		const mgr = createAsyncAnalysisManager(tmpDir);
		mgr.submit("src/foo.ts", async () => [
			{
				source: "quality",
				name: "tsc",
				severity: "error",
				message: "Type error",
				determinism: "fully_deterministic" as const,
			},
		]);
		await mgr.drain();
		mgr.consume("src/foo.ts");
		expect(mgr.consume("src/foo.ts")).toEqual([]);
	});

	it("coalesces overlapping requests", async () => {
		const mgr = createAsyncAnalysisManager(tmpDir);
		let callCount = 0;

		// First submission starts immediately
		mgr.submit("src/a.ts", async () => {
			callCount++;
			await new Promise((r) => setTimeout(r, 50));
			return [
				{
					source: "quality" as const,
					name: "first",
					severity: "info" as const,
					message: "First",
					determinism: "heuristic" as const,
				},
			];
		});

		// Second submission while first is running — gets stashed
		mgr.submit("src/b.ts", async () => {
			callCount++;
			return [
				{
					source: "quality" as const,
					name: "second",
					severity: "info" as const,
					message: "Second",
					determinism: "heuristic" as const,
				},
			];
		});

		// Third submission replaces the stashed one (coalescing)
		mgr.submit("src/c.ts", async () => {
			callCount++;
			return [
				{
					source: "quality" as const,
					name: "third",
					severity: "info" as const,
					message: "Third",
					determinism: "heuristic" as const,
				},
			];
		});

		await mgr.drain(5000);

		// Should have run first + third (second was coalesced away)
		expect(callCount).toBe(2);
		expect(mgr.consume("src/a.ts")).toHaveLength(1);
		expect(mgr.consume("src/b.ts")).toEqual([]); // coalesced away
		expect(mgr.consume("src/c.ts")).toHaveLength(1);
	});

	it("reports inProgress correctly", async () => {
		const mgr = createAsyncAnalysisManager(tmpDir);
		expect(mgr.inProgress).toBe(false);

		mgr.submit("x.ts", async () => {
			await new Promise((r) => setTimeout(r, 50));
			return [];
		});
		expect(mgr.inProgress).toBe(true);

		await mgr.drain();
		expect(mgr.inProgress).toBe(false);
	});
});
