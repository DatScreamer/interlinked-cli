// ===========================================
// section-table-ubs fragment tests
// ===========================================

import { describe, expect, it } from "vitest";
import { ubsSections } from "./section-table-ubs.js";

describe("ubsSections", () => {
	it("is non-empty", () => {
		expect(ubsSections.length).toBeGreaterThan(0);
	});

	it("each entry has well-formed fields", () => {
		for (const spec of ubsSections) {
			expect(typeof spec.label).toBe("string");
			expect(typeof spec.key).toBe("string");
			expect(typeof spec.noun).toBe("string");
			expect(typeof spec.passLabel).toBe("string");
			expect(["31", "33"].includes(spec.color)).toBe(true);
		}
	});

	it("opens with the UBS Plan 04 rows 27–30", () => {
		expect(ubsSections[0]?.key).toBe("jsLooseEquality");
		expect(ubsSections.map((s) => s.key)).toContain("divisionByVariable");
	});

	it("carries the critical-tier security signatures", () => {
		const keys = ubsSections.map((s) => s.key);
		expect(keys).toContain("subprocessShellTrue");
		expect(keys).toContain("pickleUntrustedLoad");
		expect(keys).toContain("weakHash");
	});

	it("ends with the D.2 pattern-parity XSS sinks", () => {
		expect(ubsSections.at(-1)?.key).toBe("insertAdjacentHtml");
	});
});
