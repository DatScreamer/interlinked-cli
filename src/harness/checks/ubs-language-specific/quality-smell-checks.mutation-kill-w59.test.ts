import { describe, expect, it } from "vitest";
import { checkLargeFunction, checkUbsStringConcatInLoop } from "./quality-smell-checks.js";

// Targets survivors from scratch/fleet-r3/w59-briefs/
// src_harness_checks_ubs-language-specific_quality-smell-checks.ts.json

describe("checkUbsStringConcatInLoop — positive (must fire only inside a loop)", () => {
	// Kills 34e2c13edfffc15f (ConditionalExpression: `state.loopDepth > 0` -> `true`)
	// and 4c8e1726b3d574bd (EqualityOperator: `state.loopDepth > 0` -> `state.loopDepth >= 0`).
	// Both mutants make the `+=` scan fire even when no loop has been entered
	// (loopDepth stays 0 for the whole file, and 0 satisfies both mutated forms).
	// test-contract: bug — the `loopDepth > 0` guard must gate the concat scan;
	// a mutated guard that is always true fires on ordinary out-of-loop `+=`.
	it("does NOT flag a string `+=` that is not inside any for/while loop", () => {
		const content = ["function foo() {", "  result += chunk;", "}", ""].join("\n");
		const matches = checkUbsStringConcatInLoop(content, "src/no-loop-concat.ts");
		expect(matches).toEqual([]);
	});

	// test-contract: public-api — checkUbsStringConcatInLoop's documented purpose
	// is flagging `+=` inside a loop body; pin the positive case alongside the
	// negative one above so the guard's true branch stays exercised too.
	it("still flags the same `+=` once it actually sits inside a for loop (sanity check)", () => {
		const content = [
			"function foo() {",
			"  for (let i = 0; i < 10; i++) {",
			"    result += chunk;",
			"  }",
			"}",
			"",
		].join("\n");
		const matches = checkUbsStringConcatInLoop(content, "src/in-loop-concat.ts");
		expect(matches.length).toBeGreaterThan(0);
	});
});

describe("checkLargeFunction (C-family arm) — negative (must not fire / must not throw)", () => {
	// Kills 614314b341295b8c (UnaryOperator: the `-1` in
	// `if (openIdx === -1) continue;` inside scanCFamilyLargeFunctions -> `+1`).
	// When findOpeningBrace() legitimately returns -1 (no `{` within its 5-line
	// lookahead), the guard must `continue` and skip the header. Under the `+1`
	// mutant the guard never matches (-1 !== +1), so the code falls through and
	// calls findBraceBalanceEnd(strippedLines, -1), which indexes
	// strippedLines[-1] (undefined) through `nonNull` and throws.
	// test-contract: boundary — findOpeningBrace's documented -1 "not found"
	// sentinel must short-circuit via `continue`; a mutated sentinel comparison
	// falls through into findBraceBalanceEnd(strippedLines, -1), which reads
	// strippedLines[-1] through nonNull() and throws.
	it("skips a header with no opening brace in range, without throwing", () => {
		const content = [
			"function headerWithNoBrace()",
			"  // no brace anywhere in the next few lines",
			"  a();",
			"  b();",
			"  c();",
			"  d();",
			"  e();",
			"}",
			"",
		].join("\n");
		expect(() => checkLargeFunction(content, "src/no-brace-header.ts")).not.toThrow();
		const matches = checkLargeFunction(content, "src/no-brace-header.ts");
		expect(matches).toEqual([]);
	});
});
