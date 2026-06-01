// ===========================================
// section-table-core fragment tests
// ===========================================

import { describe, expect, it } from "vitest";
import { coreSections } from "./section-table-core.js";

describe("coreSections", () => {
	it("is non-empty", () => {
		expect(coreSections.length).toBeGreaterThan(0);
	});

	it("each entry has well-formed fields", () => {
		for (const spec of coreSections) {
			expect(typeof spec.label).toBe("string");
			expect(typeof spec.key).toBe("string");
			expect(typeof spec.noun).toBe("string");
			expect(typeof spec.passLabel).toBe("string");
			expect(["31", "33"].includes(spec.color)).toBe(true);
		}
	});

	it("opens with the error-severity red sections", () => {
		expect(coreSections[0]?.key).toBe("jsonValidity");
		expect(coreSections[0]?.color).toBe("31");
		expect(coreSections.map((s) => s.key)).toContain("phantomImports");
		expect(coreSections.map((s) => s.key)).toContain("exportRipple");
	});

	it("ends with the warning-severity inline sections", () => {
		const keys = coreSections.map((s) => s.key);
		expect(keys).toContain("largeFiles");
		expect(keys).toContain("strongTyping");
		expect(coreSections.at(-1)?.key).toBe("crap");
	});
});
