import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	analyzeParenBalance,
	isParenBalanced,
	stripMalformedRules,
	suggestRuleFix,
	validateSettingsFile,
} from "./settings-validator.js";

describe("isParenBalanced", () => {
	it("accepts simple balanced rules", () => {
		expect(isParenBalanced("Bash(grep *)")).toBe(true);
		expect(isParenBalanced("Bash(node *)")).toBe(true);
		expect(isParenBalanced("WebFetch(domain:github.com)")).toBe(true);
	});

	it("accepts nested balanced parens (e.g. command substitution)", () => {
		expect(isParenBalanced("Bash(DEMO_CWD=$(ls *))")).toBe(true);
	});

	it("rejects extra closing paren — the /doctor regression case", () => {
		// Real entry that triggered Claude Code's /doctor "Mismatched
		// parentheses" warning: opens `Bash(`, prematurely closes after
		// `-d)`, then trails an extra `)`.
		expect(
			isParenBalanced(
				"Bash(-d) && cd && echo && node /Users/quentincody/interlinked-cli/dist/index.js *)",
			),
		).toBe(false);
	});

	it("rejects unclosed opener", () => {
		expect(isParenBalanced("Bash(foo")).toBe(false);
	});

	it("rejects close-before-open", () => {
		expect(isParenBalanced(")(")).toBe(false);
	});
});

describe("validateSettingsFile + stripMalformedRules", () => {
	let dir: string;
	let path: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "interlinked-settings-"));
		path = join(dir, "settings.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reports zero malformed for a clean allowlist", () => {
		writeFileSync(
			path,
			JSON.stringify({
				permissions: { allow: ["Bash(grep *)", "Bash(git *)"] },
			}),
		);
		const v = validateSettingsFile(path);
		expect(v.exists).toBe(true);
		expect(v.totalRules).toBe(2);
		expect(v.malformed).toHaveLength(0);
	});

	it("flags malformed entries across allow/deny/ask buckets with bucket+index metadata", () => {
		writeFileSync(
			path,
			JSON.stringify({
				permissions: {
					allow: ["Bash(grep *)", "Bash(-d) && echo *)"],
					deny: ["Bash(broken"],
					ask: ["Bash(ok *)"],
				},
			}),
		);
		const v = validateSettingsFile(path);
		expect(v.totalRules).toBe(4);
		expect(v.malformed).toHaveLength(2);
		const buckets = v.malformed.map((m) => m.bucket).sort();
		expect(buckets).toEqual(["allow", "deny"]);
		// Index points to the offender, not the surviving sibling.
		const allowOffender = v.malformed.find((m) => m.bucket === "allow");
		expect(allowOffender?.index).toBe(1);
	});

	it("handles missing file without throwing", () => {
		const v = validateSettingsFile(join(dir, "does-not-exist.json"));
		expect(v.exists).toBe(false);
		expect(v.malformed).toHaveLength(0);
	});

	it("captures parseError for invalid JSON instead of crashing", () => {
		writeFileSync(path, "{not json");
		const v = validateSettingsFile(path);
		expect(v.exists).toBe(true);
		expect(v.parseError).toBeTruthy();
		expect(v.malformed).toHaveLength(0);
	});

	it("ignores files that have no permissions block", () => {
		writeFileSync(path, JSON.stringify({ hooks: {} }));
		const v = validateSettingsFile(path);
		expect(v.totalRules).toBe(0);
		expect(v.malformed).toHaveLength(0);
	});

	it("strips malformed rules and rewrites file, preserving order of survivors", () => {
		writeFileSync(
			path,
			JSON.stringify({
				permissions: {
					allow: [
						"Bash(grep *)",
						"Bash(-d) && echo *)",
						"Bash(git *)",
						"Bash(broken",
						"Bash(node *)",
					],
				},
			}),
		);
		const stripped = stripMalformedRules(path);
		expect(stripped).toBe(2);
		const after = JSON.parse(readFileSync(path, "utf-8")) as {
			permissions: { allow: string[] };
		};
		expect(after.permissions.allow).toEqual([
			"Bash(grep *)",
			"Bash(git *)",
			"Bash(node *)",
		]);
		// Re-validating the rewritten file finds nothing.
		expect(validateSettingsFile(path).malformed).toHaveLength(0);
	});

	it("returns 0 and does not touch the file when nothing is malformed", () => {
		const original = JSON.stringify({
			permissions: { allow: ["Bash(grep *)"] },
		});
		writeFileSync(path, original);
		const stripped = stripMalformedRules(path);
		expect(stripped).toBe(0);
		expect(readFileSync(path, "utf-8")).toBe(original);
	});

	it("is a no-op on missing files (safe to call from --fix unconditionally)", () => {
		expect(stripMalformedRules(join(dir, "missing.json"))).toBe(0);
	});
});

describe("analyzeParenBalance", () => {
	it("returns depth 0 for balanced rules", () => {
		expect(analyzeParenBalance("Bash(grep *)").depth).toBe(0);
		expect(analyzeParenBalance("Bash(MARKER=$(date *))").depth).toBe(0);
		expect(analyzeParenBalance("WebFetch(domain:github.com)").depth).toBe(0);
	});

	it("reports positive depth for missing closing parens", () => {
		const r = analyzeParenBalance("Bash(MARKER=$(date *)");
		expect(r.depth).toBe(1);
		// firstBadCol points at end-of-string for missing-close cases
		expect(r.firstBadCol).toBe("Bash(MARKER=$(date *)".length);
	});

	it("reports negative depth for extra closing parens", () => {
		const r = analyzeParenBalance("Bash(ls))");
		expect(r.depth).toBe(-1);
		expect(r.firstBadCol).toBe("Bash(ls)".length); // the offending second `)`
	});
});

describe("suggestRuleFix", () => {
	it("appends `)` for missing-close paren imbalance", () => {
		expect(suggestRuleFix("Bash(MARKER=$(date *)", "paren_imbalance")).toBe(
			"Bash(MARKER=$(date *))",
		);
		// Two missing closes
		expect(suggestRuleFix("Bash(a$(b$(c)", "paren_imbalance")).toBe("Bash(a$(b$(c)))");
	});

	it("drops the first extra `)` for depth = -1 paren imbalance", () => {
		expect(suggestRuleFix("Bash(ls))", "paren_imbalance")).toBe("Bash(ls)");
	});

	it("returns null for ambiguous deeper depth-negative cases", () => {
		// Two excess closing parens — too many plausible edits to guess.
		expect(suggestRuleFix("Bash(ls))) ", "paren_imbalance")).toBeNull();
	});

	it("treats undefined reason as paren_imbalance (legacy)", () => {
		expect(suggestRuleFix("Bash(MARKER=$(date *)", undefined)).toBe("Bash(MARKER=$(date *))");
	});

	it("returns null for empty_rule (no mechanical fix)", () => {
		expect(suggestRuleFix("", "empty_rule")).toBeNull();
		expect(suggestRuleFix("   ", "empty_rule")).toBeNull();
	});

	it("wraps shell-shaped bodies for missing_tool_prefix", () => {
		expect(suggestRuleFix("ls *", "missing_tool_prefix")).toBe("Bash(ls *)");
		expect(suggestRuleFix("rm -rf *", "missing_tool_prefix")).toBe("Bash(rm -rf *)");
		expect(suggestRuleFix("grep | head", "missing_tool_prefix")).toBe("Bash(grep | head)");
	});

	it("returns null for missing_tool_prefix when the body has no shell shape", () => {
		// A single-word entry could be a wrong tool name, a malformed identifier,
		// or accidental garbage — too ambiguous to auto-wrap.
		expect(suggestRuleFix("foobar", "missing_tool_prefix")).toBeNull();
	});
});
