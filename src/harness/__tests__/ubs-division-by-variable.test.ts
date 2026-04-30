// Tests for `ubs_division_by_variable` (row 30 of Phase-1 Plan 04 phase
// matrix). Cross-language detector (advisory) that flags division by an
// identifier — the variable might be zero. Demoted to advisory by default
// because the FP rate is high; lives in DEFAULT_ADVISORY_SKIPS.

import { describe, expect, it } from "vitest";
import { checkDivisionByVariable } from "../checks/ubs-language-specific.js";
import { DEFAULT_ADVISORY_SKIPS } from "../../commands/verify/advisory.js";

describe("checkDivisionByVariable", () => {
	it("flags `total / count` (both sides are identifiers)", () => {
		const code = "const avg = total / count;";
		const matches = checkDivisionByVariable(code, "stats.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags member access on the LHS — `obj.x / count`", () => {
		const code = "const r = obj.x / count;";
		const matches = checkDivisionByVariable(code, "calc.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag a multi-line continuation where `/` starts the line — known TP loss from bilateral matching", () => {
		// Bilateral matching requires LHS identifier on the same line as `/`.
		// Multi-line continuations (`numerator\n  / denominator`) are missed.
		// Acceptable trade since the check is advisory.
		const code = "const x = numerator\n  / denominator;";
		expect(checkDivisionByVariable(code, "calc.ts")).toEqual([]);
	});

	it("does NOT flag `arr[i] / b` — known TP loss from bilateral matching", () => {
		// Bilateral matching requires the LHS to end in an identifier, so
		// expression results (index, call, member of subscript) are skipped.
		const code = "const r = arr[i] / b;";
		expect(checkDivisionByVariable(code, "calc.ts")).toEqual([]);
	});

	it("does NOT flag `func() / b` — known TP loss from bilateral matching", () => {
		const code = "const r = func() / b;";
		expect(checkDivisionByVariable(code, "calc.ts")).toEqual([]);
	});

	it("does NOT flag compact `TS/JS` — known TP loss; whitespace required around slash", () => {
		// Regression for codewiki.md L28 / L30. Bilateral matching alone
		// fired on these (`TS` + slash + `JS`); requiring whitespace on
		// each side blocks the compact ratio/abbreviation pattern that
		// often appears in prose. File path is `.ts` so the ext gate
		// doesn't trivially handle this — the bilateral matcher is
		// what's under test.
		const code = "// the harness's working surface is JS/TS today";
		expect(checkDivisionByVariable(code, "stats.ts")).toEqual([]);
	});

	it("does NOT flag compact `if/when` in prose", () => {
		const code = "// Worth a separate look if/when we want to expose harness capabilities.";
		expect(checkDivisionByVariable(code, "stats.ts")).toEqual([]);
	});

	it("does NOT flag compact `a/b` code division — known TP loss; modern style guides format spaces", () => {
		const code = "const r = a/b;";
		expect(checkDivisionByVariable(code, "calc.ts")).toEqual([]);
	});

	it("does NOT flag division by a numeric literal (`x / 2`)", () => {
		const code = "const half = x / 2;";
		expect(checkDivisionByVariable(code, "calc.ts")).toEqual([]);
	});

	it("does NOT flag closing comment `*/`", () => {
		const code = "/* block comment */\nconst x = 1;";
		expect(checkDivisionByVariable(code, "calc.ts")).toEqual([]);
	});

	it("does NOT flag stripped-backtick LHS (template literals collapse to empty strings)", () => {
		// Originally a regression for FPs observed on docs/external-pulse/INTAKE.md L15.
		// After stripStrings collapses backtick spans, the slash has no
		// identifier on the left, so the bilateral rule rejects it. Pinned
		// in a `.ts` context so the ext gate doesn't trivially handle it —
		// template-literal stripping is what's under test.
		const code = "const r = `project-graph.ts` / `trigram-index.ts`;";
		expect(checkDivisionByVariable(code, "stats.ts")).toEqual([]);
	});

	it("file-extension gate: skips `.md` (was the prior PIN's 'next refinement')", () => {
		// Pre-gate: bilateral matching fired on prose alternation when both
		// tokens were id-shaped. Post-gate: the .md extension short-circuits
		// before the matcher runs, so docs like docs/external-pulse/INTAKE.md
		// no longer surface false positives.
		const code = "A specific regex / AST query / taint pattern / structural rule";
		expect(checkDivisionByVariable(code, "INTAKE.md")).toEqual([]);
	});

	it("file-extension gate boundary: same id/id pattern still fires inside a `.ts` file", () => {
		// The bilateral matcher is unchanged; only the gate is new. If the
		// same shape escapes into source code, the detector still flags it.
		const code = "const r = regex / AST;";
		const matches = checkDivisionByVariable(code, "stats.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("file-extension gate: skips `.txt`", () => {
		const code = "ratio computed as a / b for the sample set";
		expect(checkDivisionByVariable(code, "notes.txt")).toEqual([]);
	});

	it("file-extension gate: skips an unknown extension (`.yml`)", () => {
		const code = "value: a / b";
		expect(checkDivisionByVariable(code, "config.yml")).toEqual([]);
	});

	it("FP guard: regex literals are an accepted FP for v1 (Plan 04 §4.3 — high-FP advisory)", () => {
		const code = "const re = /pattern/i;";
		// Behaviour is permitted to vary; pin only that the call is total.
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
