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

	it("N1: skips when a same-scope early-exit guard sits on a preceding line — `if (n === 0) return; ... total / n`", () => {
		// Known-FP fix (2026-08): the guard scan used to be same-line only,
		// so this exact split-across-lines shape still fired. Confirmed
		// over-firer from wave 1 dogfooding.
		const code = "function f(n) {\n  if (n === 0) return 0;\n  return total / n;\n}";
		expect(checkDivisionByVariable(code, "calc.ts")).toEqual([]);
	});

	it("N2: skips when the early-exit guard uses `continue` — `if (n === 0) continue; sum += total / n;`", () => {
		const code = "for (const n of counts) {\n  if (n === 0) continue;\n  sum += total / n;\n}";
		expect(checkDivisionByVariable(code, "calc.ts")).toEqual([]);
	});

	it("N3: skips a Python single-line early-exit — `if n == 0: return` then `x = total / n`", () => {
		const code = "def f(n):\n    if n == 0: return 0\n    return total / n";
		expect(checkDivisionByVariable(code, "calc.py")).toEqual([]);
	});

	it("N4: skips an enclosing preceding guard open — `if (n !== 0) {` wrapping `total / n`", () => {
		const code = "function f(n) {\n  if (n !== 0) {\n    return total / n;\n  }\n}";
		expect(checkDivisionByVariable(code, "calc.ts")).toEqual([]);
	});

	it("N5: skips a Python enclosing guard — `if n > 0:` on the preceding line", () => {
		const code = "def f(n):\n    if n > 0:\n        return total / n";
		expect(checkDivisionByVariable(code, "calc.py")).toEqual([]);
	});

	it("N6: skips a falsy early-exit guard — `if (!n) return; x = total / n;`", () => {
		const code = "function f(n) {\n  if (!n) return 0;\n  return total / n;\n}";
		expect(checkDivisionByVariable(code, "calc.ts")).toEqual([]);
	});

	it("N7: skips a fallback-default guard — `n = n || 1;` on the preceding line", () => {
		const code = "function f(n) {\n  n = n || 1;\n  return total / n;\n}";
		expect(checkDivisionByVariable(code, "calc.ts")).toEqual([]);
	});

	it("P2: STILL fires when the preceding-line guard is on a DIFFERENT identifier than the divisor", () => {
		// The guard must key to the actual divisor — a guard on an unrelated
		// name must not suppress a real division-by-zero risk.
		const code = "function f(n, m) {\n  if (m === 0) return 0;\n  return total / n;\n}";
		expect(checkDivisionByVariable(code, "calc.ts").length).toBeGreaterThan(0);
	});

	it("P3: STILL fires when the guard is beyond the lookback window (6+ non-blank lines above)", () => {
		const lines = [
			"function f(n) {",
			"  if (n === 0) return 0;",
			"  a();",
			"  b();",
			"  c();",
			"  d();",
			"  e();",
			"  return total / n;",
			"}",
		];
		expect(checkDivisionByVariable(lines.join("\n"), "calc.ts").length).toBeGreaterThan(0);
	});

	it("skips a pathlib Path-join (`base / 'sub'`)", () => {
		const code = "base = Path('/tmp')\ntarget = base / sub";
		expect(checkDivisionByVariable(code, "paths.py")).toEqual([]);
	});

	it("returns empty for files with no division", () => {
		expect(checkDivisionByVariable("const x = 42;", "x.ts")).toEqual([]);
	});
});
