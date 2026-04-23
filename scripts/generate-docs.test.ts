import { describe, expect, it } from "vitest";
import { STRUCTURAL_CHECK_META } from "../src/harness/check-metadata.js";
import { getBuiltinRules, getDefaultConfig } from "../src/harness/rules-loader.js";

// `scripts/generate-docs.ts` is a one-shot code-generation script run via
// `npm run docs`. It reads live data from the harness registry
// (getBuiltinRules, STRUCTURAL_CHECK_META, getDefaultConfig) and writes
// markdown under `docs/generated/`. These tests pin the shape of the data
// the script consumes, so a rule rename or metadata drift surfaces here
// before the generated docs go stale in CI.
describe("scripts/generate-docs — input-shape invariants", () => {
	it("getBuiltinRules returns a non-empty array with id+severity+action on each rule", () => {
		const rules = getBuiltinRules();
		expect(Array.isArray(rules)).toBe(true);
		expect(rules.length).toBeGreaterThan(0);
		for (const r of rules) {
			expect(typeof r.id).toBe("string");
			expect(r.id.length).toBeGreaterThan(0);
			expect(typeof r.severity).toBe("string");
			expect(typeof r.action).toBe("string");
		}
	});

	it("getDefaultConfig has quality_checks + structural_checks + diff_aware sections", () => {
		const cfg = getDefaultConfig();
		expect(cfg).toBeTruthy();
		expect(cfg.quality_checks).toBeTruthy();
		expect(cfg.structural_checks).toBeTruthy();
		expect(Object.keys(cfg.quality_checks).length).toBeGreaterThan(0);
	});

	it("STRUCTURAL_CHECK_META entries have name+description+tier", () => {
		const entries = Object.entries(STRUCTURAL_CHECK_META);
		expect(entries.length).toBeGreaterThan(0);
		for (const [key, meta] of entries) {
			expect(typeof key).toBe("string");
			expect(typeof meta.name).toBe("string");
			expect(typeof meta.description).toBe("string");
			expect([1, 2, 3]).toContain(meta.tier);
		}
	});
});
