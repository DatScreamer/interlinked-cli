// ===========================================
// SUPERMODEL_RULES — write protection regression
// ===========================================
// Pins the contract that `.graph.*` shards are unwritable from agent
// tools. The pattern engine matches `tool_input.file_path` only — Codex
// `apply_patch` payloads embed paths in patch text and are covered
// separately by `evaluator/pre-tool.ts::checkSupermodelShardWrite`.

import { describe, expect, it } from "vitest";
import { nonNull } from "../../../lib/non-null.js";
import { SUPERMODEL_RULES } from "../builtin-rules-supermodel.js";

describe("SUPERMODEL_RULES", () => {
	it("exports exactly one rule", () => {
		expect(SUPERMODEL_RULES).toHaveLength(1);
	});

	const rule = SUPERMODEL_RULES[0];

	it("is the supermodel-graph-write-blocked rule", () => {
		expect(nonNull(rule).id).toBe("builtin-supermodel-graph-write-blocked");
		expect(nonNull(rule).enabled).toBe(true);
		expect(nonNull(rule).action).toBe("block");
		expect(nonNull(rule).trigger).toBe("PreToolUse");
		expect(nonNull(rule).severity).toBe("high");
		expect(nonNull(rule).category).toBe("filesystem");
	});

	it("matches every PreToolUse-relevant write tool", () => {
		expect(nonNull(rule).tool_match).toEqual(
			expect.arrayContaining(["Write", "Edit", "MultiEdit", "NotebookEdit"]),
		);
	});

	it("declares the file_path-targeted pattern", () => {
		expect(nonNull(rule).patterns).toHaveLength(1);
		expect(nonNull(nonNull(rule).patterns[0]).field).toBe("file_path");
	});

	it("matches `.graph.<ext>` shards (Go, TS, JS, Python)", () => {
		const p = nonNull(rule).patterns[0];
		const re = new RegExp(nonNull(p).regex, nonNull(p).flags);
		expect(re.test("src/foo/bar.graph.go")).toBe(true);
		expect(re.test("src/foo/bar.graph.ts")).toBe(true);
		expect(re.test("npm/install.graph.js")).toBe(true);
		expect(re.test("a/b/c/handler.graph.py")).toBe(true);
	});

	it("matches the bare `.graph` (extension-less) shard form", () => {
		const p = nonNull(rule).patterns[0];
		const re = new RegExp(nonNull(p).regex, nonNull(p).flags);
		expect(re.test("Makefile.graph")).toBe(true);
	});

	it("does not over-match files that merely contain the word 'graph'", () => {
		const p = nonNull(rule).patterns[0];
		const re = new RegExp(nonNull(p).regex, nonNull(p).flags);
		expect(re.test("src/foo/graph.ts")).toBe(false);
		expect(re.test("src/foo/grapher.ts")).toBe(false);
		expect(re.test("src/graph/index.ts")).toBe(false);
		expect(re.test("src/foo/bar.ts")).toBe(false);
	});

	it("explains why and offers an alternative", () => {
		expect(nonNull(rule).reason).toMatch(/Supermodel/i);
		expect(nonNull(rule).reason).toMatch(/daemon/i);
		expect(nonNull(rule).suggestion).toBeDefined();
		expect(nonNull(rule).suggestion).toMatch(/source file|response text/i);
	});

	it("declares no role restriction (applies to every agent role)", () => {
		expect(nonNull(rule).applies_to_roles).toBeUndefined();
	});
});
