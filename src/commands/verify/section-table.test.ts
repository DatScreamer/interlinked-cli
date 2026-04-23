// ===========================================
// section-table unit tests
// ===========================================

import { describe, expect, it } from "vitest";
import { SECTIONS } from "./section-table.js";

describe("SECTIONS", () => {
	it("is non-empty", () => {
		expect(SECTIONS.length).toBeGreaterThan(0);
	});

	it("each entry has required fields", () => {
		for (const spec of SECTIONS) {
			expect(typeof spec.label).toBe("string");
			expect(typeof spec.key).toBe("string");
			expect(typeof spec.noun).toBe("string");
			expect(typeof spec.passLabel).toBe("string");
			expect(typeof spec.color).toBe("string");
		}
	});

	it("labels are unique", () => {
		const labels = SECTIONS.map((s) => s.label);
		expect(new Set(labels).size).toBe(labels.length);
	});

	it("colors use ANSI severity codes (31=red or 33=yellow)", () => {
		for (const spec of SECTIONS) {
			expect(["31", "33"].includes(spec.color)).toBe(true);
		}
	});
});
