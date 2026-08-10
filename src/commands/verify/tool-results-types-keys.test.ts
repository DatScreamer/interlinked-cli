import { describe, expect, it } from "vitest";
import type { CodeQualityResults } from "./tool-results-types.js";
import { CQ_RESULT_KEYS, emptyResults } from "./tool-results-types-keys.js";

describe("tool-results-types-keys", () => {
	it("P1: emptyResults carries every declared key, each an empty array", () => {
		const r = emptyResults();
		for (const key of CQ_RESULT_KEYS) {
			expect(Array.isArray(r[key]), key).toBe(true);
			expect(r[key], key).toHaveLength(0);
		}
	});

	it("P2: the key list has no duplicates and includes the R2 additions", () => {
		expect(new Set(CQ_RESULT_KEYS).size).toBe(CQ_RESULT_KEYS.length);
		expect(CQ_RESULT_KEYS).toContain("homedirWriteEscape");
		expect(CQ_RESULT_KEYS).toContain("writeWithoutMkdir");
	});

	it("P3: the list and the interface agree (compile-time contract, spot-checked at runtime)", () => {
		// A key present in the list but absent from CodeQualityResults fails to
		// compile in emptyResults' return type; this runtime spot-check guards
		// the reverse direction for a representative key.
		const r: CodeQualityResults = emptyResults();
		expect(r.homedirWriteEscape).toEqual([]);
	});
});
