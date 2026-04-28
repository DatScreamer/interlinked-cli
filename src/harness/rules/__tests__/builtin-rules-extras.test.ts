// ===========================================
// Plan 02 — DESTRUCTIVE_V1_EXTRA_RULES shape tests
// ===========================================
//
// Static-shape assertions for the 10 DCG-port rules. These complement
// the behavioral tests in
// `src/harness/__tests__/builtin-rules-destructive-v1.test.ts` which
// exercise each rule end-to-end through `evaluatePreToolUse()`.
//
// The two checks here lock in:
//   1. Every rule populates the Plan-01 `keywords` field (Plan 02
//      acceptance criteria — without this, plan-01 keyword-quick-reject
//      would silently fall through to "always evaluate" and waste the
//      regex budget on commands that don't mention the platform).
//   2. The id / action / severity / category metadata matches the row
//      in `_phase1-phase-matrix.md` §"Section A" (rows 1–10). Drift here
//      means a subagent edited a rule without updating the matrix.

import { describe, expect, it } from "vitest";
import type { GuardRule } from "../../types.js";
import { DESTRUCTIVE_V1_EXTRA_RULES } from "../builtin-rules-extras.js";

interface MatrixRow {
	id: string;
	action: GuardRule["action"];
	severity: GuardRule["severity"];
	category: string;
	keyword: string;
}

const PHASE_MATRIX_ROWS: readonly MatrixRow[] = [
	{
		id: "builtin-kubectl-delete-namespace",
		action: "block",
		severity: "critical",
		category: "kubernetes",
		keyword: "kubectl",
	},
	{
		id: "builtin-kubectl-delete-all",
		action: "block",
		severity: "high",
		category: "kubernetes",
		keyword: "kubectl",
	},
	{
		id: "builtin-kubectl-delete-pvc",
		action: "block",
		severity: "high",
		category: "kubernetes",
		keyword: "kubectl",
	},
	{
		id: "builtin-docker-system-prune",
		action: "ask",
		severity: "medium",
		category: "containers",
		keyword: "docker",
	},
	{
		id: "builtin-docker-volume-prune",
		action: "block",
		severity: "high",
		category: "containers",
		keyword: "docker",
	},
	{
		id: "builtin-git-stash-drop-or-clear",
		action: "block",
		severity: "high",
		category: "git",
		keyword: "git",
	},
	{
		id: "builtin-git-rebase-interactive",
		action: "ask",
		severity: "medium",
		category: "git",
		keyword: "git",
	},
	{
		id: "builtin-terraform-state-rm",
		action: "block",
		severity: "high",
		category: "infrastructure",
		keyword: "terraform",
	},
	{
		id: "builtin-terraform-taint",
		action: "ask",
		severity: "medium",
		category: "infrastructure",
		keyword: "terraform",
	},
	{
		id: "builtin-helm-uninstall-prod",
		action: "block",
		severity: "critical",
		category: "kubernetes",
		keyword: "helm",
	},
];

describe("DESTRUCTIVE_V1_EXTRA_RULES (Plan 02)", () => {
	it("contains exactly the 10 matrix rows in order", () => {
		const ids = DESTRUCTIVE_V1_EXTRA_RULES.map((r: GuardRule) => r.id);
		const expected = PHASE_MATRIX_ROWS.map((row) => row.id);
		expect(ids).toEqual(expected);
	});

	it("every rule matches the matrix metadata (id/action/severity/category/keywords)", () => {
		for (const expected of PHASE_MATRIX_ROWS) {
			const rule: GuardRule | undefined = DESTRUCTIVE_V1_EXTRA_RULES.find(
				(r: GuardRule) => r.id === expected.id,
			);
			expect(rule, `Missing rule ${expected.id}`).toBeDefined();
			if (!rule) continue;
			expect(rule.action, `Wrong action for ${expected.id}`).toBe(expected.action);
			expect(rule.severity, `Wrong severity for ${expected.id}`).toBe(expected.severity);
			expect(rule.category, `Wrong category for ${expected.id}`).toBe(expected.category);
			expect(rule.keywords, `Missing keywords for ${expected.id}`).toEqual([expected.keyword]);
		}
	});

	it("every rule has the canonical `Bash, Shell, run_command` tool_match and PreToolUse trigger", () => {
		for (const rule of DESTRUCTIVE_V1_EXTRA_RULES) {
			expect(rule.trigger, `Wrong trigger for ${rule.id}`).toBe("PreToolUse");
			expect(rule.tool_match, `Wrong tool_match for ${rule.id}`).toEqual([
				"Bash",
				"Shell",
				"run_command",
			]);
			expect(rule.enabled, `Rule ${rule.id} should be enabled`).toBe(true);
		}
	});

	it("every rule has at least one pattern with a non-empty regex and a suggestion", () => {
		for (const rule of DESTRUCTIVE_V1_EXTRA_RULES) {
			expect(rule.patterns.length, `Rule ${rule.id} has no patterns`).toBeGreaterThan(0);
			for (const pattern of rule.patterns) {
				expect(pattern.field, `Pattern in ${rule.id} missing field`).toBeTruthy();
				expect(pattern.regex, `Pattern in ${rule.id} missing regex`).toBeTruthy();
			}
			expect(rule.suggestion, `Rule ${rule.id} missing suggestion`).toBeTruthy();
			expect(rule.reason, `Rule ${rule.id} missing reason`).toBeTruthy();
		}
	});
});
