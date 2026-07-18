import { describe, expect, it } from "vitest";
import { countTestSignals, testSignalErosion } from "./test-integrity-prewarn.js";

describe("countTestSignals", () => {
	it("counts JS/TS test blocks and assertions", () => {
		const src = `it("a", () => { expect(x).toBe(1); expect(y).toBe(2); });\ntest("b", () => { assert(z); });`;
		expect(countTestSignals(src, "a.test.ts")).toEqual({ tests: 2, assertions: 3 });
	});

	it("counts Python test functions and asserts", () => {
		const src = "def test_a():\n    assert x == 1\n    assert y\ndef test_b():\n    assert z";
		expect(countTestSignals(src, "test_a.py")).toEqual({ tests: 2, assertions: 3 });
	});

	it("returns zero for content with no test signals", () => {
		expect(countTestSignals("export const x = 1;", "a.ts")).toEqual({ tests: 0, assertions: 0 });
	});
});

describe("testSignalErosion", () => {
	const base = { relPath: "src/foo.test.ts", prodPairChangedThisSession: false };

	it("warns when test blocks drop", () => {
		const w = testSignalErosion({ tests: 3, assertions: 9 }, { tests: 2, assertions: 9 }, base);
		expect(w).toContain("[interlinked:test-integrity]");
		expect(w).toContain("1 test block(s)");
	});

	it("warns when assertions drop", () => {
		const w = testSignalErosion({ tests: 2, assertions: 6 }, { tests: 2, assertions: 3 }, base);
		expect(w).toContain("3 assertion(s)");
	});

	it("strengthens the wording when the prod pair changed this session", () => {
		const w = testSignalErosion(
			{ tests: 2, assertions: 5 },
			{ tests: 1, assertions: 5 },
			{ relPath: "src/foo.test.ts", prodPairChangedThisSession: true },
		);
		expect(w).toContain("its source changed earlier this session");
	});

	it("is silent when counts hold or grow (a legitimate additive edit)", () => {
		expect(testSignalErosion({ tests: 2, assertions: 5 }, { tests: 2, assertions: 5 }, base)).toBeNull();
		expect(testSignalErosion({ tests: 2, assertions: 5 }, { tests: 3, assertions: 8 }, base)).toBeNull();
	});

	it("is silent when tests grow even if assertions dip slightly is NOT — reports the assertion drop", () => {
		// Both axes are independent: a test added but assertions net-removed still warns on assertions.
		const w = testSignalErosion({ tests: 2, assertions: 8 }, { tests: 3, assertions: 6 }, base);
		expect(w).toContain("2 assertion(s)");
	});
});
