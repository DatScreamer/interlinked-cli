// ===========================================
// Tests for the `ToolExternality` axis
// ===========================================
//
// Two scopes:
//
// 1. `classifyToolExternality` correctness across the four taxonomy buckets
//    declared in the task spec (pure_read / local_write / external_action /
//    cautious-default-when-unknown).
//
// 2. `matchesRule` honours the optional `tool_externality` allowlist as a
//    new gating step. The gate is *additive*: a rule with no
//    `tool_externality` field keeps firing as before; a rule with one
//    only fires when `classifyToolExternality` lands inside the
//    allowlist. The fixture rule below uses `field: "tool_name"` so the
//    positive pattern is vacuously satisfied (the `*` regex matches any
//    non-empty value), isolating the externality gate from
//    pattern-matching concerns.

import { describe, expect, it } from "vitest";
import { matchesRule } from "../evaluator/rule-matching.js";
import {
	classifyToolExternality,
	type ToolExternality,
} from "../evaluator/tool-classifiers.js";
import type { GuardRule } from "../types.js";

// -------------------------------------------------------------------------
// Test helpers
// -------------------------------------------------------------------------

function makeExternalityRule(allowlist: ToolExternality[] | undefined): GuardRule {
	return {
		id: "test-externality-rule",
		category: "test",
		severity: "medium",
		trigger: "PreToolUse",
		// `*` => the rule applies to every tool name at the `shouldEvaluateRule`
		// stage. The externality gate inside `matchesRule` is what we're
		// exercising here.
		tool_match: ["*"],
		// Match anything in the `tool_name` field (always present in the
		// fixture inputs below) so the positive-pattern check is satisfied
		// and only the externality gate decides the outcome.
		patterns: [{ field: "tool_name", regex: ".+" }],
		action: "warn",
		reason: "externality test",
		enabled: true,
		tool_externality: allowlist,
	};
}

// -------------------------------------------------------------------------
// classifyToolExternality — taxonomy coverage
// -------------------------------------------------------------------------

describe("classifyToolExternality", () => {
	it("Read → pure_read", () => {
		expect(classifyToolExternality("Read")).toBe("pure_read");
	});

	it("Grep → pure_read", () => {
		expect(classifyToolExternality("Grep")).toBe("pure_read");
	});

	it("Glob → pure_read", () => {
		expect(classifyToolExternality("Glob")).toBe("pure_read");
	});

	it("mcp__github__list_issues → pure_read", () => {
		expect(classifyToolExternality("mcp__github__list_issues")).toBe("pure_read");
	});

	it("mcp__claude_ai_Google_Drive__get_file_metadata → pure_read (server name with underscores)", () => {
		// Sanity for MCP names whose server segment contains underscores —
		// the splitter must locate the *last* `__` to isolate the verb.
		expect(classifyToolExternality("mcp__claude_ai_Google_Drive__get_file_metadata")).toBe(
			"pure_read",
		);
	});

	it("Write → local_write", () => {
		expect(classifyToolExternality("Write")).toBe("local_write");
	});

	it("Edit → local_write", () => {
		expect(classifyToolExternality("Edit")).toBe("local_write");
	});

	it("NotebookEdit → local_write", () => {
		expect(classifyToolExternality("NotebookEdit")).toBe("local_write");
	});

	it("WebFetch → external_action", () => {
		expect(classifyToolExternality("WebFetch")).toBe("external_action");
	});

	it("mcp__slack__send_message → external_action", () => {
		expect(classifyToolExternality("mcp__slack__send_message")).toBe("external_action");
	});

	it("mcp__github__create_pull_request → external_action", () => {
		expect(classifyToolExternality("mcp__github__create_pull_request")).toBe("external_action");
	});

	it("Bash 'curl https://example.com' → external_action", () => {
		expect(classifyToolExternality("Bash", { command: "curl https://example.com" })).toBe(
			"external_action",
		);
	});

	it("Bash 'git push origin main' → external_action", () => {
		expect(classifyToolExternality("Bash", { command: "git push origin main" })).toBe(
			"external_action",
		);
	});

	it("Bash 'npm publish' → external_action", () => {
		expect(classifyToolExternality("Bash", { command: "npm publish" })).toBe("external_action");
	});

	it("Bash 'gh pr create --fill' → external_action", () => {
		expect(classifyToolExternality("Bash", { command: "gh pr create --fill" })).toBe(
			"external_action",
		);
	});

	it("Bash 'echo hello' → local_write", () => {
		expect(classifyToolExternality("Bash", { command: "echo hello" })).toBe("local_write");
	});

	it("Bash 'ls -la' → local_write (no external verb)", () => {
		expect(classifyToolExternality("Bash", { command: "ls -la" })).toBe("local_write");
	});

	it("Unknown 'RandomTool' → local_write (cautious default)", () => {
		expect(classifyToolExternality("RandomTool")).toBe("local_write");
	});

	it("Bash with no command field → local_write (no signal)", () => {
		expect(classifyToolExternality("Bash")).toBe("local_write");
		expect(classifyToolExternality("Bash", {})).toBe("local_write");
	});

	it("Empty tool name → local_write (cautious default)", () => {
		expect(classifyToolExternality("")).toBe("local_write");
	});
});

// -------------------------------------------------------------------------
// matchesRule — gates by `tool_externality` after tool_match passes
// -------------------------------------------------------------------------

describe("matchesRule + tool_externality", () => {
	it("rule with tool_externality: ['external_action'] does NOT fire on Read", () => {
		const rule = makeExternalityRule(["external_action"]);
		expect(
			matchesRule({
				command: "",
				toolInput: { tool_name: "Read", file_path: "src/index.ts" },
				rule,
				toolName: "Read",
			}),
		).toBe(false);
	});

	it("rule with tool_externality: ['external_action'] DOES fire on WebFetch", () => {
		const rule = makeExternalityRule(["external_action"]);
		expect(
			matchesRule({
				command: "",
				toolInput: { tool_name: "WebFetch", url: "https://example.com" },
				rule,
				toolName: "WebFetch",
			}),
		).toBe(true);
	});

	it("rule with no tool_externality fires regardless of externality", () => {
		const rule = makeExternalityRule(undefined);
		// pure_read tool — would be filtered out by an explicit
		// `tool_externality: ['external_action']`, but isn't here.
		expect(
			matchesRule({
				command: "",
				toolInput: { tool_name: "Read", file_path: "src/index.ts" },
				rule,
				toolName: "Read",
			}),
		).toBe(true);
		// external_action tool — same rule, same allow-everything semantics.
		expect(
			matchesRule({
				command: "",
				toolInput: { tool_name: "WebFetch", url: "https://example.com" },
				rule,
				toolName: "WebFetch",
			}),
		).toBe(true);
	});

	it("rule with empty tool_externality allowlist preserves fire-on-all", () => {
		// Empty array is semantically identical to undefined — the gate is
		// only meaningful when the author has *narrowed* the set.
		const rule = makeExternalityRule([]);
		expect(
			matchesRule({
				command: "",
				toolInput: { tool_name: "WebFetch", url: "https://example.com" },
				rule,
				toolName: "WebFetch",
			}),
		).toBe(true);
	});

	it("rule with tool_externality: ['local_write'] fires on Bash 'echo hi'", () => {
		const rule = makeExternalityRule(["local_write"]);
		expect(
			matchesRule({
				command: "echo hi",
				toolInput: { tool_name: "Bash", command: "echo hi" },
				rule,
				toolName: "Bash",
			}),
		).toBe(true);
	});

	it("rule with tool_externality: ['external_action'] fires on Bash 'git push'", () => {
		// Same rule, same tool name — only the command differs.
		// Demonstrates the per-call Bash refinement reaches `matchesRule`.
		const rule = makeExternalityRule(["external_action"]);
		expect(
			matchesRule({
				command: "git push origin main",
				toolInput: { tool_name: "Bash", command: "git push origin main" },
				rule,
				toolName: "Bash",
			}),
		).toBe(true);
	});

	it("rule with tool_externality: ['external_action'] does NOT fire on Bash 'echo hi'", () => {
		const rule = makeExternalityRule(["external_action"]);
		expect(
			matchesRule({
				command: "echo hi",
				toolInput: { tool_name: "Bash", command: "echo hi" },
				rule,
				toolName: "Bash",
			}),
		).toBe(false);
	});

	it("rule with multi-tier allowlist fires on any listed tier", () => {
		const rule = makeExternalityRule(["pure_read", "external_action"]);
		// pure_read — listed → fires
		expect(
			matchesRule({
				command: "",
				toolInput: { tool_name: "Read", file_path: "src/index.ts" },
				rule,
				toolName: "Read",
			}),
		).toBe(true);
		// external_action — listed → fires
		expect(
			matchesRule({
				command: "",
				toolInput: { tool_name: "WebFetch", url: "https://example.com" },
				rule,
				toolName: "WebFetch",
			}),
		).toBe(true);
		// local_write — NOT listed → skipped
		expect(
			matchesRule({
				command: "",
				toolInput: { tool_name: "Write", file_path: "x.ts", content: "" },
				rule,
				toolName: "Write",
			}),
		).toBe(false);
	});
});
