import { describe, expect, it } from "vitest";
import { isSkippedOrTodoCall, maskCommentsAndStrings } from "./test-hygiene-masking.js";

describe("maskCommentsAndStrings — line-comment newline handling (kills mutantId b250464177585b3d)", () => {
	// test-contract: public-api — maskCommentsAndStrings must not skip the char
	// right after a line comment's closing newline.
	it("P1: a line comment ends exactly at its own newline, so a second line comment is masked too", () => {
		// If the newline-return step wrongly reports `advanced: true`, the loop skips
		// the char right after the newline — the second comment's opening "/" is
		// never visited and the whole second comment survives unmasked.
		const masked = maskCommentsAndStrings("// a\n// b\n");
		expect(masked).toBe("    \n    \n");
	});
});

describe("maskBlockCommentChar — closing condition requires BOTH '*' and following '/' (kills mutantIds b91e4f9477efc9e8, 7aa0de294180feb5, 6a2ebea32e2c27e5)", () => {
	// test-contract: public-api — maskCommentsAndStrings must only close a block
	// comment on a literal "*/" pair.
	it("P1: a lone '*' not followed by '/' does not close the block comment early", () => {
		// Only a real "*/" may close. A lone '*' (next char 'y') must not trigger
		// closing on its own — this kills the LogicalOperator (&&->||) mutant and
		// the ConditionalExpression (next==='/' -> true) mutant.
		const masked = maskCommentsAndStrings("/*x*y*/z");
		expect(masked).toBe("       z");
	});

	// test-contract: public-api — maskCommentsAndStrings must only close a block
	// comment on a literal "*/" pair, not on a stray '/'.
	it("P2: a lone '/' not preceded by '*' does not close the block comment early", () => {
		// Only a real "*/" may close. A stray '/' preceded by a non-'*' char ('a')
		// must not trigger closing — this kills the ConditionalExpression
		// (ch==='*' -> true) mutant.
		const masked = maskCommentsAndStrings("/*a/b*/z");
		expect(masked).toBe("       z");
	});
});

describe("maskStringChar — newline inside a string literal is preserved verbatim (kills mutantIds aa865b693134606e, 46bd655ba1c5e408, c7ff8043b8bfb2d8)", () => {
	// test-contract: invariant — maskCommentsAndStrings preserves byte offsets and
	// newlines (module doc comment: "preserving offsets and line counts").
	it("P1: an embedded newline in a template literal stays a literal newline character", () => {
		// The offset/newline-preservation contract: a `\n` inside the string must
		// remain `\n` in the masked output (not blanked to ' ' and not dropped
		// to '' — either change breaks line-count and offset preservation).
		const masked = maskCommentsAndStrings("`a\nb`");
		expect(masked).toBe("  \n  ");
		expect(masked.length).toBe("`a\nb`".length);
		expect(masked.includes("\n")).toBe(true);
	});
});

describe("maskStringChar — closing a string does not skip the following character (kills mutantId ae1ea7770f69d0b7)", () => {
	// test-contract: public-api — maskCommentsAndStrings must not skip the char
	// right after a string literal's closing quote.
	it("P1: code right after a closed string is still scanned for a following comment", () => {
		// If the string-close step wrongly reports `advanced: true`, the char right
		// after the closing quote is skipped, so a comment starting immediately
		// after the string survives unmasked.
		const masked = maskCommentsAndStrings('"a"//b');
		expect(masked).toBe("      ");
	});
});

describe("isSkippedOrTodoCall — only inspects text before the call's opening paren (kills mutantId 306c20d55f1201af)", () => {
	// test-contract: public-api — isSkippedOrTodoCall must inspect only the call
	// head (text before the opening paren), not the whole match text.
	it("P1: a plain call whose string argument happens to contain '.skip' is not flagged", () => {
		// The call head is `it` (before the first '('); the argument text
		// containing ".skip" must not leak into the check.
		expect(isSkippedOrTodoCall('it("test.skip case")')).toBe(false);
	});

	// test-contract: public-api — isSkippedOrTodoCall true-path control: a real
	// `.skip` call must still be flagged.
	it("P2: an actual `.skip` call is still flagged", () => {
		expect(isSkippedOrTodoCall("it.skip(\"desc\", () => {})")).toBe(true);
	});

	// test-contract: public-api — isSkippedOrTodoCall true-path control: a real
	// `.todo` call must still be flagged.
	it("P3: an actual `.todo` call is still flagged", () => {
		expect(isSkippedOrTodoCall("test.todo(\"desc\")")).toBe(true);
	});
});
