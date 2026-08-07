// Coverage-gap tests for command-decomposition.ts. The broad behavioral
// surface (decomposeCommand, stripEnvVarPrefix, evaluateCompoundCommand happy
// paths, inferAgentRole, ruleAppliesToRole, applyRewrite happy paths,
// classifyToolConcurrency) is already covered by
// `__tests__/cc-patterns.test.ts`; this file targets the specific
// lines/branches that suite doesn't reach: the rewrite-throws catch, the
// negated-pattern loop, the non-"command" field resolution path, the
// per-edit rewrite bookkeeping branches, shouldEvaluateForBash's
// disabled/wrong-trigger paths, the overlong-regex safeRegex guard, and the
// cohort-lineage / agent_type "lead" branches of inferAgentRole.

import { describe, expect, it } from "vitest";
import { CohortManager } from "./cohort.js";
import {
	applyRewrite,
	evaluateCompoundCommand,
	inferAgentRole,
} from "./command-decomposition.js";
import type { GuardRule, HarnessEvent } from "./types.js";

const FIXED_TIMESTAMP = new Date(1_700_000_000_000).toISOString();

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

describe("applyRewrite — replacement throws", () => {
	it("returns the original command when the replacer throws", () => {
		// String.prototype.replace() accepts a replacer FUNCTION at runtime even
		// though InputRewrite.replace is typed as `string` — force that shape to
		// exercise applyRewrite's catch path.
		const throwingReplacer = (() => {
			throw new Error("boom");
		}) as unknown as string;
		const result = applyRewrite("rm -rf /tmp", {
			field: "command",
			match: "rm",
			replace: throwingReplacer,
		});
		expect(result).toBe("rm -rf /tmp");
	});
});

describe("evaluateCompoundCommand — shouldEvaluateForBash gating", () => {
	it("ignores disabled rules", () => {
		const rules = [makeRule({ enabled: false })];
		const result = evaluateCompoundCommand("cd /tmp && rm -rf /", rules);
		expect(result).toEqual({ decision: "allow", warnings: [] });
	});

	it("ignores rules whose trigger excludes PreToolUse", () => {
		const rules = [makeRule({ trigger: "PostToolUse" })];
		const result = evaluateCompoundCommand("cd /tmp && rm -rf /", rules);
		expect(result).toEqual({ decision: "allow", warnings: [] });
	});
});

describe("evaluateCompoundCommand — default matcher field resolution + negation", () => {
	it("treats an empty positive-pattern field value as non-matching", () => {
		const rules = [makeRule({ patterns: [{ field: "nonexistent_field", regex: "x" }] })];
		const result = evaluateCompoundCommand("cd /tmp && anything", rules);
		expect(result).toEqual({ decision: "allow", warnings: [] });
	});

	it("excludes the rule when a negated pattern matches a non-command field", () => {
		const rules = [
			makeRule({
				action: "block",
				patterns: [
					{ field: "command", regex: "rm" },
					{ field: "command", regex: "safe", negate: true },
				],
			}),
		];
		const result = evaluateCompoundCommand("cd /tmp && rm -rf /tmp/safe", rules);
		expect(result).toEqual({ decision: "allow", warnings: [] });
	});

	it("still blocks when a negated pattern's field resolves empty (nothing to exclude on)", () => {
		const rules = [
			makeRule({
				action: "block",
				patterns: [
					{ field: "command", regex: "rm" },
					{ field: "nonexistent_field", regex: "x", negate: true },
				],
			}),
		];
		const result = evaluateCompoundCommand("cd /tmp && rm -rf /tmp/x", rules);
		expect(result.decision).toBe("block");
	});

	it("rejects an overlong pattern regex (safeRegex length guard) as non-matching", () => {
		const longPattern = "a".repeat(201);
		const rules = [makeRule({ patterns: [{ field: "command", regex: longPattern }] })];
		const result = evaluateCompoundCommand("cd /tmp && rm -rf /", rules);
		expect(result).toEqual({ decision: "allow", warnings: [] });
	});
});

describe("evaluateCompoundCommand — rewrite bookkeeping", () => {
	it("does not record a rewrite when the replacement produces no textual change", () => {
		const rules = [
			makeRule({
				action: "rewrite",
				patterns: [{ field: "command", regex: "^ls$" }],
				rewrite: { field: "command", match: "^ls$", replace: "ls" },
			}),
		];
		const result = evaluateCompoundCommand("cd /tmp && ls", rules);
		expect(result.decision).toBe("allow");
		expect(result.updated_input).toBeUndefined();
	});

	it("rewrites every matching subcommand without resetting the rewritten-parts buffer", () => {
		const rules = [
			makeRule({
				action: "rewrite",
				patterns: [{ field: "command", regex: "^rm " }],
				rewrite: { field: "command", match: "^rm (.+)", replace: "trash $1" },
			}),
		];
		const result = evaluateCompoundCommand("rm a.txt && rm b.txt", rules);
		expect(result.decision).toBe("allow");
		expect(result.updated_input).toEqual({ command: "trash a.txt && trash b.txt" });
	});
});

describe("inferAgentRole — cohort lineage and agent_type lead inference", () => {
	it("infers subagent from cohort-recorded parent lineage when the event itself carries none", () => {
		const cohort = new CohortManager();
		cohort.subagentJoined(
			makeEvent({ agent_name: "sub-1", tool_input: { parent_agent: "lead-1" } }),
		);
		const event = makeEvent({ agent_name: "sub-1" });
		expect(inferAgentRole(event, cohort)).toBe("subagent");
	});

	it("infers lead from agent_type containing 'lead'", () => {
		expect(inferAgentRole(makeEvent({ agent_type: "lead-driver" }))).toBe("lead");
	});

	it("infers lead from agent_type containing 'coordinator'", () => {
		expect(inferAgentRole(makeEvent({ agent_type: "coordinator-driver" }))).toBe("lead");
	});
});
