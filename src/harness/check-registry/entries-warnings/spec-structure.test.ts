import { describe, expect, it } from "vitest";
import { SPEC_STRUCTURE_ENTRIES } from "./spec-structure.js";

describe("SPEC_STRUCTURE_ENTRIES", () => {
	it("registers the eight spec checks with unique ids and prop names", () => {
		expect(SPEC_STRUCTURE_ENTRIES.map((e) => e.id)).toEqual([
			"spec_dangling_anchor",
			"spec_numbering",
			"spec_count_claim",
			"spec_pitfall",
			"spec_claim_untagged",
			"spec_capacity_claim",
			"spec_table_sum",
			"spec_stage_order",
		]);
		const props = SPEC_STRUCTURE_ENTRIES.map((e) => e.resultsPropName);
		expect(new Set(props).size).toBe(props.length);
	});

	it("keeps every entry post-phase, warning severity, agent_safety pipeline", () => {
		for (const e of SPEC_STRUCTURE_ENTRIES) {
			expect(e.phase).toBe("post");
			expect(e.severity).toBe("warning");
			expect(e.pipeline).toBe("agent_safety");
			expect(e.tier).toBe(1);
		}
	});

	it("keeps fix instructions evidence-only (no-autofix policy §6.2)", () => {
		// Fix instructions must direct the agent to decide and author the edit,
		// never promise an automatic change.
		for (const e of SPEC_STRUCTURE_ENTRIES) {
			expect(e.fix_instruction.length).toBeGreaterThan(40);
			expect(e.fix_instruction).not.toMatch(/auto-?fix|will be (fixed|rewritten)/i);
		}
	});

	it("only spec_dangling_anchor is fully deterministic", () => {
		const byId = new Map(SPEC_STRUCTURE_ENTRIES.map((e) => [e.id, e.determinism]));
		expect(byId.get("spec_dangling_anchor")).toBe("fully_deterministic");
		expect(byId.get("spec_numbering")).toBe("partially_deterministic");
		expect(byId.get("spec_count_claim")).toBe("partially_deterministic");
	});
});
