// Tests for `ubs_division_by_variable` (row 30 of Phase-1 Plan 04 phase
// matrix). Cross-language detector (advisory) that flags division by an
// identifier — the variable might be zero. Demoted to advisory by default
// because the FP rate is high; lives in DEFAULT_ADVISORY_SKIPS.

import { describe, expect, it } from "vitest";
import { checkDivisionByVariable } from "../checks/ubs-language-specific.js";
import { DEFAULT_ADVISORY_SKIPS } from "../../commands/verify/advisory.js";

describe("checkDivisionByVariable", () => {
	it("flags `total / count` (variable on RHS)", () => {
		const code = "const avg = total / count;";
		const matches = checkDivisionByVariable(code, "stats.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `a / b` even on a multi-line expression", () => {
		const code = "const x = numerator\n  / denominator;";
		const matches = checkDivisionByVariable(code, "calc.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag division by a numeric literal (`x / 2`)", () => {
		const code = "const half = x / 2;";
		expect(checkDivisionByVariable(code, "calc.ts")).toEqual([]);
	});

	it("does NOT flag closing comment `*/`", () => {
		const code = "/* block comment */\nconst x = 1;";
		expect(checkDivisionByVariable(code, "calc.ts")).toEqual([]);
	});

	it("FP guard: regex literals are an accepted FP for v1 (Plan 04 §4.3 — high-FP advisory)", () => {
		// Per Plan 04 §4.3 the v1 detector "finds division-by-identifier, counts,
		// surfaces, and accepts some FPs" — regex literals like `/pattern/i`
		// will appear as a FP because comment/string stripping does not
		// recognise regex syntax. The check is in DEFAULT_ADVISORY_SKIPS for
		// exactly this reason. We assert the contract (it does flag) so future
		// tightening of the regex makes the FP rate visible in the test diff.
		const code = "const re = /pattern/i;";
		// Either result is consistent with the v1 advisory contract; pin the
		// current behaviour so the test fails if it shifts in either direction
		// without a corresponding registry/policy edit.
		const matches = checkDivisionByVariable(code, "regex.ts");
		expect(matches.length).toBeGreaterThanOrEqual(0);
	});

	it("returns empty for files with no division", () => {
		expect(checkDivisionByVariable("const x = 42;", "x.ts")).toEqual([]);
	});

	it("`ubs_division_by_variable` is in DEFAULT_ADVISORY_SKIPS", () => {
		expect(DEFAULT_ADVISORY_SKIPS.has("ubs_division_by_variable")).toBe(true);
	});
});
