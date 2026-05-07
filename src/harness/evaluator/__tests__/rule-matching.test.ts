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

	// --- file_extensions allowlist ---
	// A rule that opts into a file-extension allowlist should only fire when the
	// tool's file_path/path matches one of the listed extensions. Documentation
	// files (.md/.html) describing the same pattern are not violations.

	it("file_extensions: rule fires when path matches the allowlist", () => {
		const rule = makeRule({
			tool_match: ["Write"],
			patterns: [{ field: "content", regex: "DROP\\s+TABLE", flags: "i" }],
			file_extensions: ["py", "ts", "rb"],
		});
		expect(
			matchesRule({
				command: "",
				toolInput: { file_path: "src/migrate.py", content: "DROP TABLE users" },
				rule,
			}),
		).toBe(true);
	});

	it("file_extensions: rule skipped when path is documentation (.md)", () => {
		const rule = makeRule({
			tool_match: ["Write"],
			patterns: [{ field: "content", regex: "DROP\\s+TABLE", flags: "i" }],
			file_extensions: ["py", "ts", "rb"],
		});
		expect(
			matchesRule({
				command: "",
				toolInput: { file_path: "docs/dangerous-things.md", content: "DROP TABLE users" },
				rule,
			}),
		).toBe(false);
	});

	it("file_extensions: rule skipped when path is HTML marketing", () => {
		const rule = makeRule({
			tool_match: ["Write"],
			patterns: [{ field: "content", regex: "chmod\\s+777", flags: "i" }],
			file_extensions: ["py", "rb", "sh"],
		});
		expect(
			matchesRule({
				command: "",
				toolInput: { file_path: "landing/public/index.html", content: "chmod 777 example" },
				rule,
			}),
		).toBe(false);
	});

	it("file_extensions: tolerates leading dots and case in the allowlist", () => {
		const rule = makeRule({
			tool_match: ["Write"],
			patterns: [{ field: "content", regex: "DROP\\s+TABLE", flags: "i" }],
			file_extensions: [".PY", "Ts"],
		});
		expect(
			matchesRule({
				command: "",
				toolInput: { file_path: "src/migrate.py", content: "DROP TABLE users" },
				rule,
			}),
		).toBe(true);
	});

	it("file_extensions: empty / undefined allowlist preserves existing fire-on-all behavior", () => {
		const rule = makeRule({
			tool_match: ["Write"],
			patterns: [{ field: "content", regex: "DROP\\s+TABLE", flags: "i" }],
			// no file_extensions
		});
		expect(
			matchesRule({
				command: "",
				toolInput: { file_path: "docs/dangerous.md", content: "DROP TABLE users" },
				rule,
			}),
		).toBe(true);
	});

	it("file_extensions: rule rejects path-less Bash payload when scope is set", () => {
		const rule = makeRule({
			tool_match: ["Bash"],
			patterns: [{ field: "command", regex: "rm\\s+-rf" }],
			file_extensions: ["py"],
		});
		expect(
			matchesRule({
				command: "rm -rf /tmp/x",
				toolInput: { command: "rm -rf /tmp/x" },
				rule,
			}),
		).toBe(false);
	});

	it("file_extensions: also reads `path` field as a fallback to `file_path`", () => {
		const rule = makeRule({
			tool_match: ["Write"],
			patterns: [{ field: "content", regex: "DROP\\s+TABLE", flags: "i" }],
			file_extensions: ["py"],
		});
		expect(
			matchesRule({
				command: "",
				toolInput: { path: "src/migrate.py", content: "DROP TABLE users" },
				rule,
			}),
		).toBe(true);
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
