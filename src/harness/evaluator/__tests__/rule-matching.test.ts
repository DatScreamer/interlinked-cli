import { describe, expect, it } from "vitest";
import type { GuardRule } from "../../types.js";
import {
	formatReason,
	getCachedRegex,
	getField,
	matchesRule,
	shouldEvaluateRule,
} from "../rule-matching.js";

function makeRule(overrides: Partial<GuardRule> = {}): GuardRule {
	return {
		id: "test-rule",
		category: "test",
		severity: "medium",
		trigger: "PreToolUse",
		tool_match: ["Bash"],
		patterns: [{ field: "command", regex: "rm\\s+-rf" }],
		action: "block",
		reason: "do not delete everything",
		enabled: true,
		...overrides,
	} as GuardRule;
}

describe("shouldEvaluateRule", () => {
	it("respects enabled flag", () => {
		expect(shouldEvaluateRule(makeRule({ enabled: false }), "PreToolUse", "Bash")).toBe(false);
	});

	it("matches the configured trigger or 'both'", () => {
		expect(shouldEvaluateRule(makeRule({ trigger: "PreToolUse" }), "PreToolUse", "Bash")).toBe(
			true,
		);
		expect(shouldEvaluateRule(makeRule({ trigger: "PostToolUse" }), "PreToolUse", "Bash")).toBe(
			false,
		);
		expect(shouldEvaluateRule(makeRule({ trigger: "both" }), "PostToolUse", "Bash")).toBe(true);
	});

	it("handles wildcard tool_match and case-insensitive tool names", () => {
		expect(shouldEvaluateRule(makeRule({ tool_match: ["*"] }), "PreToolUse", "AnyTool")).toBe(
			true,
		);
		expect(shouldEvaluateRule(makeRule({ tool_match: ["bash"] }), "PreToolUse", "Bash")).toBe(
			true,
		);
		expect(shouldEvaluateRule(makeRule({ tool_match: ["Write"] }), "PreToolUse", "Bash")).toBe(
			false,
		);
	});
});

describe("getCachedRegex", () => {
	it("returns the same RegExp object for identical pattern+flags", () => {
		const a = getCachedRegex("foo", "i");
		const b = getCachedRegex("foo", "i");
		expect(a).toBe(b);
	});

	it("differentiates by flags", () => {
		const a = getCachedRegex("foo", "i");
		const b = getCachedRegex("foo", "g");
		expect(a).not.toBe(b);
	});
});

describe("matchesRule", () => {
	it("returns true when any positive pattern matches", () => {
		const rule = makeRule();
		expect(
			matchesRule({
				command: "rm -rf /",
				toolInput: { command: "rm -rf /" },
				rule,
			}),
		).toBe(true);
	});

	it("returns false when no positive pattern matches", () => {
		const rule = makeRule();
		expect(
			matchesRule({
				command: "ls -la",
				toolInput: { command: "ls -la" },
				rule,
			}),
		).toBe(false);
	});

	it("skips rules when a negated pattern matches (exception)", () => {
		const rule = makeRule({
			patterns: [
				{ field: "command", regex: "rm\\s+-rf" },
				{ field: "command", regex: "node_modules", negate: true },
			],
		});
		expect(
			matchesRule({
				command: "rm -rf node_modules",
				toolInput: { command: "rm -rf node_modules" },
				rule,
			}),
		).toBe(false);
	});

	it("applies extra_exceptions substring allowlist from local config", () => {
		const rule = makeRule({ id: "destructive-delete" });
		expect(
			matchesRule({
				command: "rm -rf /tmp/cache",
				toolInput: { command: "rm -rf /tmp/cache" },
				rule,
				extraExceptions: { "destructive-delete": ["/tmp/cache"] },
			}),
		).toBe(false);
	});
});

describe("getField", () => {
	it("returns shallow field when path has no dot", () => {
		expect(getField({ a: 1 }, "a")).toBe(1);
	});

	it("traverses dot paths", () => {
		expect(getField({ a: { b: { c: 42 } } }, "a.b.c")).toBe(42);
	});

	it("returns undefined on dead-end traversal", () => {
		expect(getField({ a: 1 }, "a.b")).toBeUndefined();
		expect(getField({ a: [1, 2] }, "a.b")).toBeUndefined();
	});
});

describe("formatReason", () => {
	it("prefixes with BLOCKED and appends suggestion if present", () => {
		const rule = makeRule({ reason: "nope", suggestion: "try this" });
		expect(formatReason(rule)).toBe("BLOCKED: nope\n\nSuggestion: try this");
	});

	it("omits suggestion block when undefined", () => {
		const rule = makeRule({ reason: "nope" });
		expect(formatReason(rule)).toBe("BLOCKED: nope");
	});
});
