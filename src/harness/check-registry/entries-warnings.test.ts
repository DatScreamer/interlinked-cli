import { describe, expect, it } from "vitest";
import { WARNING_ENTRIES } from "./entries-warnings.js";

describe("WARNING_ENTRIES", () => {
	it("is non-empty", () => {
		expect(WARNING_ENTRIES.length).toBeGreaterThan(0);
	});

	it("every entry is in the agent_safety pipeline", () => {
		for (const c of WARNING_ENTRIES) {
			expect(c.pipeline).toBe("agent_safety");
		}
	});

	it("every entry has a callable fn + valid phase", () => {
		for (const c of WARNING_ENTRIES) {
			expect(typeof c.fn, `${c.id} fn`).toBe("function");
			expect(["pre_warn", "post", "pre_block"], `${c.id} phase`).toContain(c.phase);
		}
	});

	it("includes the agent-quality checks landed in the 2026-04 rollout", () => {
		const ids = new Set(WARNING_ENTRIES.map((c) => c.id));
		// Spot-check coverage of our new checks per the design doc.
		for (const expected of [
			"floating_promises",
			"broad_object_types",
			"magic_literal_in_conditional",
			"unvalidated_json_boundary",
			"circular_imports",
			"lifecycle_cleanup",
			"default_export",
			"dead_exports",
			"discriminated_union_exhaustiveness",
		]) {
			expect(ids, `WARNING_ENTRIES should include ${expected}`).toContain(expected);
		}
	});
});
