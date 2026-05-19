import { describe, expect, it } from "vitest";
import { CODE_QUALITY_ENTRIES } from "./code-quality.js";

describe("CODE_QUALITY_ENTRIES", () => {
	it("is non-empty", () => {
		expect(CODE_QUALITY_ENTRIES.length).toBeGreaterThan(0);
	});

	it("every entry is in the agent_safety pipeline", () => {
		for (const c of CODE_QUALITY_ENTRIES) {
			expect(c.pipeline, c.id).toBe("agent_safety");
		}
	});

	it("every entry has a callable fn + valid phase", () => {
		for (const c of CODE_QUALITY_ENTRIES) {
			expect(typeof c.fn, `${c.id} fn`).toBe("function");
			expect(["pre_warn", "post", "pre_block"], `${c.id} phase`).toContain(c.phase);
		}
	});

	it("every entry has the required metadata fields populated", () => {
		for (const c of CODE_QUALITY_ENTRIES) {
			expect(c.id, "id").toMatch(/^[a-z][a-z0-9_]*$/);
			expect(c.fix_instruction.length, `fix_instruction for ${c.id}`).toBeGreaterThan(20);
			expect(c.resultsPropName.length, `resultsPropName for ${c.id}`).toBeGreaterThan(0);
			expect(["error", "warning"], `${c.id} severity`).toContain(c.severity);
		}
	});

	it("carries the two error-severity project entries that sit beside related rules", () => {
		const errors = CODE_QUALITY_ENTRIES.filter((c) => c.severity === "error").map((c) => c.id);
		expect(errors).toContain("focused_tests");
		expect(errors).toContain("migration_ordering");
		// every error entry runs at pre_block
		for (const c of CODE_QUALITY_ENTRIES) {
			if (c.severity === "error") {
				expect(c.phase, `${c.id} should be pre_block`).toBe("pre_block");
			}
		}
	});

	it("includes the general code-quality / React / test-hygiene checks", () => {
		const ids = new Set(CODE_QUALITY_ENTRIES.map((c) => c.id));
		for (const expected of [
			"floating_promises",
			"non_null_assertion",
			"silent_promise_catch",
			"json_parse_unsafe",
			"excessive_use_state",
			"sql_schema_consistency",
			"visibility_filter_missing",
		]) {
			expect(ids, `should include ${expected}`).toContain(expected);
		}
	});

	it("has no duplicate ids", () => {
		const ids = CODE_QUALITY_ENTRIES.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
