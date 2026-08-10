import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import type { GuardRule } from "../types.js";
import { findingRulesPath, getFindingRulesWatchPaths, loadFindingRules } from "./finding-rules.js";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "finding-rules-"));
	mkdirSync(join(cwd, ".interlinked"), { recursive: true });
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
});

function writeRules(rules: unknown[]): void {
	writeFileSync(findingRulesPath(cwd), JSON.stringify({ version: 1, rules }), "utf-8");
}

function writeOverrides(overrides: unknown): void {
	writeFileSync(
		join(cwd, ".interlinked", "findings-rules.overrides.json"),
		JSON.stringify(overrides),
		"utf-8",
	);
}

const baseRule = (over: Partial<GuardRule> & { id: string; source?: Record<string, unknown> }): Record<string, unknown> => ({
	enabled: true,
	trigger: "PostToolUse",
	tool_match: ["Write", "Edit"],
	action: "warn",
	patterns: [{ field: "content", regex: "Date\\.parse\\([^)]*\\)\\s*[<>]" }],
	reason: "Date.parse result compared without a finite guard",
	severity: "medium",
	source: { kind: "finding", finding_id: "fnd_x", bug_class: "nan_coercion_guard" },
	...over,
});

describe("loadFindingRules", () => {
	it("returns [] when the file is missing", () => {
		expect(loadFindingRules(cwd)).toEqual([]);
	});

	it("returns [] on malformed JSON (fail-open)", () => {
		writeFileSync(findingRulesPath(cwd), "{ not json", "utf-8");
		expect(loadFindingRules(cwd)).toEqual([]);
	});

	it("returns [] when the file is valid JSON but not an object with rules", () => {
		writeFileSync(findingRulesPath(cwd), "[]", "utf-8");
		expect(loadFindingRules(cwd)).toEqual([]);
	});

	it("loads an enabled finding rule", () => {
		writeRules([baseRule({ id: "finding-nan-1" })]);
		const rules = loadFindingRules(cwd);
		expect(rules).toHaveLength(1);
		expect(nonNull(rules[0]).id).toBe("finding-nan-1");
		expect(nonNull(rules[0]).action).toBe("warn");
	});

	it("preserves finding source metadata for recurrence and CLI consumers", () => {
		writeRules([
			baseRule({
				id: "finding-source",
				source: {
					kind: "finding",
					finding_id: "fnd_123",
					bug_class: "nan_coercion_guard",
					found_at: "2026-06-18T12:00:00.000Z",
				},
			}),
		]);

		expect(loadFindingRules(cwd)[0]).toMatchObject({
			source: {
				finding_id: "fnd_123",
				found_at: "2026-06-18T12:00:00.000Z",
			},
		});
	});

	it("treats a rule with no patterns array as non-ReDoS (loads it)", () => {
		const { patterns: _omit, ...noPatterns } = baseRule({ id: "finding-np" });
		writeRules([noPatterns]);
		expect(loadFindingRules(cwd).map((r) => r.id)).toEqual(["finding-np"]);
	});

	it("drops rules with a ReDoS-prone pattern (same gate as distilled)", () => {
		writeRules([
			baseRule({ id: "finding-ok" }),
			baseRule({ id: "finding-redos", patterns: [{ field: "content", regex: "(a+)+b" }] }),
		]);
		const ids = loadFindingRules(cwd).map((r) => r.id);
		expect(ids).toContain("finding-ok");
		expect(ids).not.toContain("finding-redos");
	});

	it("removes rules listed in removed_rule_ids", () => {
		writeRules([baseRule({ id: "finding-keep" }), baseRule({ id: "finding-drop" })]);
		writeOverrides({ removed_rule_ids: ["finding-drop"] });
		const ids = loadFindingRules(cwd).map((r) => r.id);
		expect(ids).toEqual(["finding-keep"]);
	});

	it("omits rules listed in disabled_rule_ids from the active set", () => {
		writeRules([baseRule({ id: "finding-d" })]);
		writeOverrides({ disabled_rule_ids: ["finding-d"] });
		expect(loadFindingRules(cwd)).toEqual([]);
	});

	it("applies per-rule modifications (action / severity)", () => {
		writeRules([baseRule({ id: "finding-m" })]);
		writeOverrides({ modifications: { "finding-m": { action: "block", severity: "high" } } });
		const rule = loadFindingRules(cwd)[0];
		expect(nonNull(rule).action).toBe("block");
		expect(nonNull(rule).severity).toBe("high");
	});

	it("skips rows without an id", () => {
		writeRules([{ enabled: true, action: "warn" }, baseRule({ id: "finding-valid" })]);
		expect(loadFindingRules(cwd).map((r) => r.id)).toEqual(["finding-valid"]);
	});

	it("ignores malformed overrides (still loads rules)", () => {
		writeRules([baseRule({ id: "finding-r" })]);
		writeFileSync(join(cwd, ".interlinked", "findings-rules.overrides.json"), "{ bad", "utf-8");
		expect(loadFindingRules(cwd).map((r) => r.id)).toEqual(["finding-r"]);
	});

	it("P1: loads rules when the pristine file parses to a proper JSON object", () => {
		writeRules([baseRule({ id: "finding-shape-ok" })]);
		expect(loadFindingRules(cwd).map((r) => r.id)).toEqual(["finding-shape-ok"]);
	});

	it("N1: treats a top-level JSON array in the pristine file as invalid shape, not a rules object", () => {
		// Hardening regression: `typeof parsed === "object"` is also true for
		// arrays, so a rules array written directly at the top level (instead of
		// wrapped in `{ version, rules: [...] }`) must still yield no rules
		// rather than being read as a keyed record.
		writeFileSync(findingRulesPath(cwd), JSON.stringify([baseRule({ id: "top-level-array" })]), "utf-8");
		expect(loadFindingRules(cwd)).toEqual([]);
	});

	it("N2: treats a top-level JSON array in the overrides file as invalid shape, rules load unaffected", () => {
		writeRules([baseRule({ id: "finding-unaffected" })]);
		writeFileSync(
			join(cwd, ".interlinked", "findings-rules.overrides.json"),
			JSON.stringify(["not", "an", "object"]),
			"utf-8",
		);
		expect(loadFindingRules(cwd).map((r) => r.id)).toEqual(["finding-unaffected"]);
	});
});

describe("getFindingRulesWatchPaths", () => {
	it("returns the pristine + overrides paths", () => {
		expect(getFindingRulesWatchPaths(cwd)).toEqual([
			join(cwd, ".interlinked", "findings-rules.json"),
			join(cwd, ".interlinked", "findings-rules.overrides.json"),
		]);
	});
});
