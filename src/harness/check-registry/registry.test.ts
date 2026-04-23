import { describe, expect, it } from "vitest";
import { CHECK_REGISTRY } from "./registry.js";

describe("CHECK_REGISTRY", () => {
	it("exposes a non-empty array of check registrations", () => {
		expect(Array.isArray(CHECK_REGISTRY)).toBe(true);
		expect(CHECK_REGISTRY.length).toBeGreaterThan(0);
	});

	it("every registered check has a unique id", () => {
		const ids = CHECK_REGISTRY.map((c) => c.id);
		const unique = new Set(ids);
		expect(unique.size).toBe(ids.length);
	});

	it("every registered check has a unique resultsPropName", () => {
		const names = CHECK_REGISTRY.map((c) => c.resultsPropName);
		const unique = new Set(names);
		expect(unique.size).toBe(names.length);
	});

	it("every check has the required structural fields populated", () => {
		for (const c of CHECK_REGISTRY) {
			expect(c.id, `id for ${c.name}`).toMatch(/^[a-z][a-z0-9_]*$/);
			expect(c.name, `name for ${c.id}`).toBeTruthy();
			expect(c.description, `description for ${c.id}`).toBeTruthy();
			expect([1, 2, 3], `tier for ${c.id}`).toContain(c.tier);
			expect(["pre_block", "pre_warn", "post"], `phase for ${c.id}`).toContain(c.phase);
			expect(["error", "warning"], `severity for ${c.id}`).toContain(c.severity);
			expect(["agent_safety", "suggestion"], `pipeline for ${c.id}`).toContain(c.pipeline);
			expect(c.fix_instruction.length, `fix_instruction for ${c.id}`).toBeGreaterThan(20);
			expect(typeof c.fn, `fn for ${c.id}`).toBe("function");
			expect(c.resultsPropName, `resultsPropName for ${c.id}`).toMatch(/^[a-z][A-Za-z0-9]*$/);
		}
	});

	it("pre_block checks are always fully_deterministic (no FP allowed)", () => {
		for (const c of CHECK_REGISTRY) {
			if (c.phase === "pre_block") {
				expect(c.determinism, `${c.id} is pre_block`).toBe("fully_deterministic");
			}
		}
	});

	it("every check.fn returns an array for trivial input (smoke test)", () => {
		for (const c of CHECK_REGISTRY) {
			const result = c.fn("", "smoke.ts");
			expect(Array.isArray(result), `fn for ${c.id} returned non-array`).toBe(true);
		}
	});
});
