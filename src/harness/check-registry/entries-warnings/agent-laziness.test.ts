import { describe, expect, it } from "vitest";
import { AGENT_LAZINESS_ENTRIES } from "./agent-laziness.js";

describe("AGENT_LAZINESS_ENTRIES", () => {
	it("is non-empty", () => {
		expect(AGENT_LAZINESS_ENTRIES.length).toBeGreaterThan(0);
	});

	it("every entry is in the agent_safety pipeline", () => {
		for (const c of AGENT_LAZINESS_ENTRIES) {
			expect(c.pipeline, c.id).toBe("agent_safety");
		}
	});

	it("every entry has a callable fn + valid phase + warning severity", () => {
		for (const c of AGENT_LAZINESS_ENTRIES) {
			expect(typeof c.fn, `${c.id} fn`).toBe("function");
			expect(["pre_warn", "post", "pre_block"], `${c.id} phase`).toContain(c.phase);
			expect(c.severity, `${c.id} severity`).toBe("warning");
		}
	});

	it("every entry has the required metadata fields populated", () => {
		for (const c of AGENT_LAZINESS_ENTRIES) {
			expect(c.id, "id").toMatch(/^[a-z][a-z0-9_]*$/);
			expect(c.fix_instruction.length, `fix_instruction for ${c.id}`).toBeGreaterThan(20);
			expect(c.resultsPropName.length, `resultsPropName for ${c.id}`).toBeGreaterThan(0);
		}
	});

	it("includes the Batch 1 agent-laziness checks", () => {
		const ids = new Set(AGENT_LAZINESS_ENTRIES.map((c) => c.id));
		for (const expected of [
			"agent_thumbprint_prose",
			"stub_not_implemented_throw",
			"dead_branch_literal",
			"file_level_suppression",
			"untestable_time_in_source",
			"double_cast_unknown",
			"type_smuggling",
			"unbounded_promise_all",
			"sync_io_on_hot_path",
		]) {
			expect(ids, `should include ${expected}`).toContain(expected);
		}
	});

	it("has no duplicate ids", () => {
		const ids = AGENT_LAZINESS_ENTRIES.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
