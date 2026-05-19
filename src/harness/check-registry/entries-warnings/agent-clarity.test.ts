import { describe, expect, it } from "vitest";
import { AGENT_CLARITY_ENTRIES } from "./agent-clarity.js";

describe("AGENT_CLARITY_ENTRIES", () => {
	it("is non-empty", () => {
		expect(AGENT_CLARITY_ENTRIES.length).toBeGreaterThan(0);
	});

	it("every entry is in the agent_safety pipeline", () => {
		for (const c of AGENT_CLARITY_ENTRIES) {
			expect(c.pipeline, c.id).toBe("agent_safety");
		}
	});

	it("every entry has a callable fn + valid phase + warning severity", () => {
		for (const c of AGENT_CLARITY_ENTRIES) {
			expect(typeof c.fn, `${c.id} fn`).toBe("function");
			expect(["pre_warn", "post", "pre_block"], `${c.id} phase`).toContain(c.phase);
			expect(c.severity, `${c.id} severity`).toBe("warning");
		}
	});

	it("every entry has the required metadata fields populated", () => {
		for (const c of AGENT_CLARITY_ENTRIES) {
			expect(c.id, "id").toMatch(/^[a-z][a-z0-9_]*$/);
			expect(c.fix_instruction.length, `fix_instruction for ${c.id}`).toBeGreaterThan(20);
			expect(c.resultsPropName.length, `resultsPropName for ${c.id}`).toBeGreaterThan(0);
		}
	});

	it("includes the 2026-04 agent-quality cold-reader checks", () => {
		const ids = new Set(AGENT_CLARITY_ENTRIES.map((c) => c.id));
		for (const expected of [
			"default_export",
			"broad_object_types",
			"magic_literal_in_conditional",
			"unvalidated_json_boundary",
			"circular_imports",
			"lifecycle_cleanup",
			"dead_exports",
			"discriminated_union_exhaustiveness",
			"boolean_trap",
		]) {
			expect(ids, `should include ${expected}`).toContain(expected);
		}
	});

	it("includes the five comment-vs-behavior drift detectors", () => {
		const ids = new Set(AGENT_CLARITY_ENTRIES.map((c) => c.id));
		for (const expected of [
			"comment_claims_limit_no_guard",
			"comment_claims_null_throws_instead",
			"comment_claims_validation_missing",
			"comment_claims_idempotent_mutates",
			"comment_claims_throws_doesnt",
		]) {
			expect(ids, `should include ${expected}`).toContain(expected);
		}
	});

	it("has no duplicate ids", () => {
		const ids = AGENT_CLARITY_ENTRIES.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
