// Companion tests for `ubs_division_by_variable`. The exhaustive red/green
// suite lives in src/harness/__tests__/ubs-division-by-variable.test.ts and
// exercises this via the ubs-language-specific.ts barrel; this colocated file
// imports the new module directly and satisfies the colocation gate.

import { describe, expect, it } from "vitest";
import { checkDivisionByVariable } from "./division-by-variable.js";

describe("ubs-language-specific/division-by-variable", () => {
	it("flags `total / count` (both sides identifiers)", () => {
		expect(checkDivisionByVariable("const avg = total / count;", "stats.ts").length).toBeGreaterThan(
			0,
		);
	});

	it("does not flag division by a numeric literal", () => {
		expect(checkDivisionByVariable("const half = x / 2;", "calc.ts")).toEqual([]);
	});

	it("file-extension gate: skips markdown and unknown extensions", () => {
		const prose = "A specific regex / AST query / taint pattern";
		expect(checkDivisionByVariable(prose, "INTAKE.md")).toEqual([]);
		expect(checkDivisionByVariable("value: a / b", "config.yml")).toEqual([]);
		expect(checkDivisionByVariable("ratio a / b", "notes.txt")).toEqual([]);
	});

	it("skips a same-line zero-guard ternary", () => {
		const code = "rate = total / count if count > 0 else 0.0";
		expect(checkDivisionByVariable(code, "stats.py")).toEqual([]);
	});

	it("does NOT suppress on a preceding-line guard — guard scan is same-line only", () => {
		// Pins the honest doc: there is no multi-line GUARD_LOOKBACK_LINES /
		// dominating-guard scan (an early-exit `if (n === 0) return;` on a
		// preceding line was once documented as suppressing, but was never
		// implemented). Guard-based suppression is same-line only, so a
		// division whose sole guard sits above it still fires. This forces any
		// future lookback implementation to update the doc + this pin together.
		const code = "function f(n) {\n  if (n === 0) return 0;\n  return total / n;\n}";
		expect(checkDivisionByVariable(code, "calc.ts").length).toBeGreaterThan(0);
	});

	it("skips a pathlib Path-join (`base / 'sub'`)", () => {
		const code = "base = Path('/tmp')\ntarget = base / sub";
		expect(checkDivisionByVariable(code, "paths.py")).toEqual([]);
	});

	it("returns empty for files with no division", () => {
		expect(checkDivisionByVariable("const x = 42;", "x.ts")).toEqual([]);
	});
});
