import { describe, expect, it } from "vitest";
import { isNoqaSuppressedInRange, stripCommentsPreservingStrings } from "./_shared.js";

// Kills for wave pass1_w54 survivors in src/harness/checks/ubs-language-specific/_shared.ts
// Every test targets stripCommentsPreservingStrings' internal state machine
// (consumeBlockCommentChar / consumeQuotedChar / stripLineComments) or the
// Math.min/Math.max range clamp in isNoqaSuppressedInRange, purely via the
// two exported entry points.

describe("stripCommentsPreservingStrings — block-comment closer (consumeBlockCommentChar)", () => {
	// test-contract: bug — mutants 3b018c74444429c8, c0bdd8346f5f0789, c85d4bab3730750a,
	// 79c89d57c92c6d9f each loosen the "*" + "/" closer check; a stray "*" or "/" alone
	// must not close the block comment early.
	it("closes a block comment only at a genuine star-slash sequence, not on a stray star or slash", () => {
		const content = "/*x*y/z*/KEEP";
		expect(stripCommentsPreservingStrings(content)).toBe("KEEP");
	});
});

describe("stripCommentsPreservingStrings — quote state machine (consumeQuotedChar)", () => {
	// test-contract: bug — mutants f6bfabfaece9851f, 4aa23f24892e5223, 930a347a5ad8b586,
	// 43055c7efd0f20e2, bbbfd9707ac469f4, 44ae1970b55f72d8 each break backslash-escape
	// handling, causing the string to close one character early and the trailing
	// text to be treated as unterminated string instead of a stripped comment.
	it("honors a backslash-escaped quote and resumes comment stripping after the string closes", () => {
		const content = "'a\\'b' // comment";
		expect(stripCommentsPreservingStrings(content)).toBe("'a\\'b' ");
	});

	// test-contract: bug — mutant 82b0ba3ee9fc1399 makes the close-branch report escaped:true,
	// leaking a stale escaped flag into a second string reopened on the same line.
	it("does not leak a stale escaped flag across a reopened string on the same line", () => {
		const content = "'a''' // c";
		expect(stripCommentsPreservingStrings(content)).toBe("'a''' ");
	});

	// test-contract: bug — mutant 64fda4e367870f77 replaces the escape-branch object with {},
	// which drops `quote` to undefined and exits the string context after a backslash.
	it("keeps the quote context open after consuming a backslash-escaped ordinary char", () => {
		const content = "'a\\bc' // comment";
		expect(stripCommentsPreservingStrings(content)).toBe("'a\\bc' ");
	});
});

describe("stripCommentsPreservingStrings — stripLineComments main loop", () => {
	// test-contract: bug — mutant 096f457639abeadb flips the per-line `escaped` seed to true,
	// so the character right after an opening quote is wrongly treated as escaped.
	it("starts each line with escaped=false so the char right after an opening quote can close it", () => {
		const content = "'' // c";
		expect(stripCommentsPreservingStrings(content)).toBe("'' ");
	});

	// test-contract: bug — mutant 42bee132491a7115 flips the closer-advance to subtraction,
	// rewinding into the just-closed comment instead of stepping past it.
	it("advances past a found block-comment closer instead of rewinding into it", () => {
		const content = "Q/*Z*/KEEP";
		expect(stripCommentsPreservingStrings(content)).toBe("QKEEP");
	});

	// test-contract: bug — mutant e22330ffcb45747f flips the block-open advance to decrement,
	// rewinding into the just-opened marker instead of stepping past it.
	it("advances past the opening block-comment marker instead of rewinding into it", () => {
		const content = "/*/KEEP";
		expect(stripCommentsPreservingStrings(content)).toBe("");
	});

	// test-contract: bug — mutants 6484a4fc30d1ba1b and d88d12b85a4f1e7a disable the
	// single-quote open check, so text inside a single-quoted string is no longer
	// protected from comment stripping.
	it("recognizes a single quote as opening a string so a slash-slash inside it is preserved", () => {
		const content = "'// x'";
		expect(stripCommentsPreservingStrings(content)).toBe("'// x'");
	});

	// test-contract: bug — the block-open check's own ch-is-slash comparison, if forced
	// to true, would start a block comment on a bare star with no leading slash.
	it("does not open a block comment on a bare star with no preceding slash", () => {
		const content = "B*KEEP";
		expect(stripCommentsPreservingStrings(content)).toBe("B*KEEP");
	});

	// test-contract: bug — mutants 040c40030d6e965b and b7e709f465446524 loosen the
	// block-open condition so a lone slash (not followed by star) would start a comment.
	it("does not open a block comment on a slash followed by a non-star character", () => {
		const content = "X/YKEEPZ";
		expect(stripCommentsPreservingStrings(content)).toBe("X/YKEEPZ");
	});

	// test-contract: bug — mutants e7698c4fc4c71d1a, 855fe05cf867a53e, 0e24a6d5f5e6d6e0,
	// 02f163b66f95afcd, and 3e113df5e344c0d3 each loosen the line-comment condition so it
	// would fire one character early, on the character preceding a genuine slash-slash pair.
	it("breaks the line only at a genuine slash-slash pair, not the char before it", () => {
		const content = "A//KEEP";
		expect(stripCommentsPreservingStrings(content)).toBe("A");
	});
});

describe("isNoqaSuppressedInRange — hi clamp", () => {
	// test-contract: bug — mutant 7e2109be9bf393ac replaces Math.min(length, Math.max(...))
	// with Math.max(...), letting the scan run past the array end and throw on lookup.
	it("clamps the scan range to the array length instead of running past it", () => {
		const originalLines = ["a", "b", "c"];
		expect(() => isNoqaSuppressedInRange(originalLines, 1, 10, "some-check")).not.toThrow();
		expect(isNoqaSuppressedInRange(originalLines, 1, 10, "some-check")).toBe(false);
	});
});
