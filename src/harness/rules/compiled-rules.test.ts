// Tests for the compiled-from-markdown rules loader (companion to
// `compiled-rules.ts`). Verifies:
//   1. Pristine load returns rules unchanged when no overrides exist.
//   2. `removed_groups[]` filters out matching rules entirely.
//   3. `removed_rule_ids[]` filters out matching rules entirely.
//   4. `disabled_rule_ids[]` flips `enabled: false` (rule still present).
//   5. `modifications{}` overrides action/severity and stamps `user_modified`.
//   6. Malformed compiled-rules.json returns [] (fail-open).
//   7. Watch-paths returns the canonical pair.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCompiledRulesWatchPaths, loadCompiledRules } from "./compiled-rules.js";

interface SamplePayload {
	rules?: unknown[];
	[k: string]: unknown;
}

let tmpRoot: string;

function writeCompiled(payload: SamplePayload): void {
	mkdirSync(join(tmpRoot, ".interlinked"), { recursive: true });
	writeFileSync(
		join(tmpRoot, ".interlinked", "compiled-rules.json"),
		JSON.stringify(payload),
	);
}

function writeOverrides(payload: Record<string, unknown>): void {
	mkdirSync(join(tmpRoot, ".interlinked"), { recursive: true });
	writeFileSync(
		join(tmpRoot, ".interlinked", "compiled-rules.overrides.json"),
		JSON.stringify(payload),
	);
}

const SAMPLE_RULE = {
	id: "enforce-local-agents-md-no-push-main",
	enabled: true,
	trigger: "PreToolUse",
	tool_match: ["Bash"],
	action: "block",
	patterns: [{ field: "command", regex: "^git\\s+push\\b.*\\bmain\\b" }],
	reason: "BLOCKED by AGENTS.md:42",
	severity: "critical",
	category: "compiled-from-md",
	source: {
		group_id: "local:AGENTS.md",
		file: "AGENTS.md",
		lines: [42, 42],
		quote: "Never push to main without code review.",
		lexical_marker: "Never",
	},
};

const SECOND_RULE = {
	id: "enforce-skill-tdd-no-bulk-tests",
	enabled: true,
	trigger: "PreToolUse",
	tool_match: ["Edit", "Write"],
	action: "ask",
	patterns: [{ field: "file_path", regex: "src/" }],
	reason: "tdd skill",
	severity: "medium",
	category: "compiled-from-md",
	source: {
		group_id: "skill:tdd",
		file: ".claude/skills/tdd/SKILL.md",
		lines: [23, 25],
		quote: "explicitly bans the horizontal anti-pattern",
	},
};

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "compiled-rules-test-"));
});

afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loadCompiledRules", () => {
	it("returns [] when compiled-rules.json is absent", () => {
		expect(loadCompiledRules(tmpRoot)).toEqual([]);
	});

	it("returns rules unchanged when no overrides file exists", () => {
		writeCompiled({ rules: [SAMPLE_RULE, SECOND_RULE] });
		const rules = loadCompiledRules(tmpRoot);
		expect(rules).toHaveLength(2);
		expect(rules[0].id).toBe(SAMPLE_RULE.id);
		expect(rules[0].action).toBe("block");
		expect(rules[1].action).toBe("ask");
	});

	it("filters out rules whose source.group_id is in removed_groups[]", () => {
		writeCompiled({ rules: [SAMPLE_RULE, SECOND_RULE] });
		writeOverrides({ removed_groups: ["skill:tdd"] });
		const rules = loadCompiledRules(tmpRoot);
		expect(rules).toHaveLength(1);
		expect(rules[0].id).toBe(SAMPLE_RULE.id);
	});

	it("filters out rules whose id is in removed_rule_ids[]", () => {
		writeCompiled({ rules: [SAMPLE_RULE, SECOND_RULE] });
		writeOverrides({ removed_rule_ids: [SAMPLE_RULE.id] });
		const rules = loadCompiledRules(tmpRoot);
		expect(rules).toHaveLength(1);
		expect(rules[0].id).toBe(SECOND_RULE.id);
	});

	it("flips enabled:false on rules in disabled_rule_ids[] but keeps them", () => {
		writeCompiled({ rules: [SAMPLE_RULE, SECOND_RULE] });
		writeOverrides({ disabled_rule_ids: [SAMPLE_RULE.id] });
		const rules = loadCompiledRules(tmpRoot);
		expect(rules).toHaveLength(2);
		const disabled = rules.find((r) => r.id === SAMPLE_RULE.id);
		expect(disabled?.enabled).toBe(false);
		const stillEnabled = rules.find((r) => r.id === SECOND_RULE.id);
		expect(stillEnabled?.enabled).toBe(true);
	});

	it("applies modifications.action and stamps user_modified", () => {
		writeCompiled({ rules: [SAMPLE_RULE] });
		writeOverrides({
			modifications: {
				[SAMPLE_RULE.id]: { action: "ask", severity: "medium" },
			},
		});
		const rules = loadCompiledRules(tmpRoot);
		expect(rules).toHaveLength(1);
		expect(rules[0].action).toBe("ask");
		expect(rules[0].severity).toBe("medium");
		// user_modified is a sidecar field; cast through unknown to read it
		// without widening the GuardRule type for tests.
		expect((rules[0] as unknown as { user_modified?: boolean }).user_modified).toBe(true);
	});

	it("returns [] when compiled-rules.json is malformed (fail-open)", () => {
		mkdirSync(join(tmpRoot, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmpRoot, ".interlinked", "compiled-rules.json"),
			"{ not valid json",
		);
		expect(loadCompiledRules(tmpRoot)).toEqual([]);
	});

	it("ignores malformed overrides and still loads pristine rules", () => {
		writeCompiled({ rules: [SAMPLE_RULE] });
		mkdirSync(join(tmpRoot, ".interlinked"), { recursive: true });
		writeFileSync(
			join(tmpRoot, ".interlinked", "compiled-rules.overrides.json"),
			"not json at all",
		);
		const rules = loadCompiledRules(tmpRoot);
		expect(rules).toHaveLength(1);
		expect(rules[0].action).toBe("block");
	});

	it("skips entries with missing id rather than throwing", () => {
		writeCompiled({ rules: [{ ...SAMPLE_RULE, id: undefined }, SECOND_RULE] });
		const rules = loadCompiledRules(tmpRoot);
		expect(rules).toHaveLength(1);
		expect(rules[0].id).toBe(SECOND_RULE.id);
	});

	it("removed_rule_ids takes precedence over modifications", () => {
		writeCompiled({ rules: [SAMPLE_RULE] });
		writeOverrides({
			removed_rule_ids: [SAMPLE_RULE.id],
			modifications: {
				[SAMPLE_RULE.id]: { action: "ask" },
			},
		});
		const rules = loadCompiledRules(tmpRoot);
		expect(rules).toHaveLength(0);
	});
});

describe("getCompiledRulesWatchPaths", () => {
	it("returns the two canonical paths under .interlinked/", () => {
		const paths = getCompiledRulesWatchPaths(tmpRoot);
		expect(paths).toHaveLength(2);
		expect(paths[0]).toBe(join(tmpRoot, ".interlinked", "compiled-rules.json"));
		expect(paths[1]).toBe(
			join(tmpRoot, ".interlinked", "compiled-rules.overrides.json"),
		);
	});
});
