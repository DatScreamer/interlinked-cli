import { describe, expect, it } from "vitest";
import {
	blankStringLiteralsPreserveLength,
	checkErrorDispatchByInstanceof,
	checkInconsistentErrorStrategy,
	checkLossyErrorRethrow,
} from "./error-handling.js";

describe("blankStringLiteralsPreserveLength — positive (must fire)", () => {
	// test-contract: boundary — loop bound must be `i < n`, not `i <= n`;
	// an off-by-one appends a stray char past the input's own length.
	it("does not overrun the buffer for an unterminated quote at end of input", () => {
		// n = 2: 'x' then an opening quote with no closer. Kills the `i < n` ->
		// `i <= n` mutant, which would run one extra iteration and append a
		// stray trailing space, growing the output past the input's length.
		const out = blankStringLiteralsPreserveLength('x"');
		expect(out).toBe('x"');
		expect(out.length).toBe(2);
	});

	// test-contract: invariant — function docstring: "preserving length and
	// newlines so byte offsets stay aligned"; a real newline after an escape
	// must survive blanking.
	it("preserves a real newline that appears after an escape sequence inside a string", () => {
		// quote, backslash, real newline, quote — the escape branch inspects
		// `s[i + 1] !== "\n"` to decide whether to blank the escaped char; if
		// that literal were replaced with `""` the newline would incorrectly
		// be blanked to a space, losing line alignment.
		const input = '"' + "\\" + "\n" + '"';
		const out = blankStringLiteralsPreserveLength(input);
		expect(out).toBe('"' + " " + "\n" + '"');
	});

	// test-contract: invariant — same length/newline-preservation contract as
	// above, for plain (non-escaped) string content.
	it("preserves a real newline inside plain (non-escaped) string content", () => {
		const input = '"a\nb"';
		const out = blankStringLiteralsPreserveLength(input);
		expect(out).toBe('" \n "');
		expect(out.split("\n").length).toBe(input.split("\n").length);
	});
});

describe("checkLossyErrorRethrow — positive (must fire)", () => {
	// test-contract: bug — regression for the same class of defect the
	// module's own comment on the `matches.length >= 10` cap warns about:
	// a per-catch scan must stay bounded to its own catch block's close
	// brace, never spilling into a later catch's body.
	it("does not attribute a later catch block's throw to an earlier catch with no throw inside it", () => {
		// Catch #1 has no throw at all; catch #2 has a lossy rethrow. The bound
		// check `throwMatch.index < closeIdx` inside collectLossyRethrowsInCatch
		// is what prevents catch #1's scan from reaching into catch #2's body.
		// Forcing that condition to `true` makes catch #1 spuriously "steal" the
		// throw belonging to catch #2, doubling the match count.
		// test-contract: bug — regression for the same class of defect the
		// module's own comment on the `matches.length >= 10` cap warns about:
		// a per-catch scan must stay bounded to its own catch block's close
		// brace, never spilling into a later catch's body.
		const content = [
			"function a() {",
			"  try {",
			"    doA();",
			"  } catch (e1) {",
			"    console.log(e1);",
			"  }",
			"}",
			"function b() {",
			"  try {",
			"    doB();",
			'  } catch (e2) {',
			'    throw new Error("boom");',
			"  }",
			"}",
		].join("\n");

		const matches = checkLossyErrorRethrow(content, "test.ts");
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).toContain("e2");
		expect(matches[0]?.text).not.toContain("catch(e1)");
	});
});

describe("checkErrorDispatchByInstanceof — positive (must fire)", () => {
	// test-contract: boundary — the documented `matches.length >= 10` cap
	// (mirrors the sibling checks' shared 10-match limit) must stop at
	// exactly 10, across separate catch blocks.
	it("caps findings at exactly 10 across many separate catch blocks", () => {
		const blocks: string[] = [];
		for (let n = 0; n < 11; n++) {
			blocks.push(`function f${n}() {`);
			blocks.push(`  try {`);
			blocks.push(`    doThing();`);
			blocks.push(`  } catch (e) {`);
			blocks.push(`    if (e instanceof Error) {`);
			blocks.push(`      handle(e);`);
			blocks.push(`    }`);
			blocks.push(`  }`);
			blocks.push(`}`);
		}
		const content = blocks.join("\n");
		const matches = checkErrorDispatchByInstanceof(content, "test.ts");
		expect(matches.length).toBe(10);
	});

	// test-contract: boundary — same 10-match cap, exercised within a single
	// catch block's inner instanceof scan rather than across catch blocks.
	it("caps findings at exactly 10 within a single catch block with many instanceof checks", () => {
		const lines: string[] = ["function f() {", "  try {", "    doThing();", "  } catch (e) {"];
		for (let n = 0; n < 11; n++) {
			lines.push(`    if (e instanceof Error) { handle(e); }`);
		}
		lines.push("  }");
		lines.push("}");
		const content = lines.join("\n");
		const matches = checkErrorDispatchByInstanceof(content, "test.ts");
		expect(matches.length).toBe(10);
	});
});

describe("checkInconsistentErrorStrategy — negative (must not fire)", () => {
	// test-contract: public-api — checkInconsistentErrorStrategy fires only at
	// `strategies >= 3`; with zero throw/return-null/return-error-object
	// occurrences all three regex `.match()` calls return null, exercising
	// the `|| []` fallback, and the result must stay empty.
	it("reports nothing when none of the three error strategies appear (all three regex matches null)", () => {
		const lines: string[] = ["function f() {"];
		for (let n = 0; n < 20; n++) {
			lines.push(`  doStep${n}();`);
		}
		lines.push("}");
		const content = lines.join("\n");
		expect(content.split("\n").length).toBeGreaterThanOrEqual(20);
		const matches = checkInconsistentErrorStrategy(content, "test.ts");
		expect(matches).toEqual([]);
	});
});
