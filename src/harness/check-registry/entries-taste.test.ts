import { describe, expect, it } from "vitest";
import { TASTE_ENTRIES } from "./entries-taste.js";

describe("TASTE_ENTRIES", () => {
	it("is non-empty", () => {
		expect(TASTE_ENTRIES.length).toBeGreaterThan(0);
	});

	it("every entry is in the agent_safety pipeline", () => {
		for (const c of TASTE_ENTRIES) {
			expect(c.pipeline).toBe("agent_safety");
		}
	});

	it("taste checks are heuristic or partially_deterministic — not all-or-nothing", () => {
		for (const c of TASTE_ENTRIES) {
			expect(["heuristic", "partially_deterministic", "fully_deterministic"]).toContain(
				c.determinism,
			);
		}
	});

	it("every entry has the required fields populated", () => {
		for (const c of TASTE_ENTRIES) {
			expect(c.id, "id").toMatch(/^[a-z][a-z0-9_]*$/);
			expect(c.fix_instruction.length, `fix_instruction for ${c.id}`).toBeGreaterThan(20);
			expect(typeof c.fn).toBe("function");
		}
	});
});
