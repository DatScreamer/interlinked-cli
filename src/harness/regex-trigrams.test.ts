import { describe, expect, it } from "vitest";

import { decomposePattern } from "./regex-trigrams.js";

describe("decomposePattern - orderedTrigrams control/non-ascii filtering (lines 51-52)", () => {
	it("skips a trigram window containing a non-ASCII character (literal path)", () => {
		const pattern = "abcd" + "é" + "efgh";
		const result = decomposePattern(pattern, false, false);
		expect(result.trigramSequences.length).toBe(1);
		// windows touching "e-acute" (cd+e-acute, d+e-acute+e, e-acute+ef) are skipped; abc/bcd/efg/fgh survive
		expect(result.trigramSequences[0]!.length).toBe(4);
		expect(result.literalSegments).toEqual([pattern]);
	});

	it("skips a trigram window containing a control character (literal path)", () => {
		const pattern = "abcd" + "\u0001" + "efgh";
		const result = decomposePattern(pattern, false, false);
		expect(result.hasLiterals).toBe(true);
		// windows touching the control char are skipped
		expect(result.trigramSequences[0]!.length).toBe(4);
	});

	it("includes trigram windows for a plain ASCII literal with no control chars", () => {
		const result = decomposePattern("abcdef", false, false);
		expect(result.trigramSequences[0]!.length).toBe(4); // abc,bcd,cde,def
	});
});

describe("decomposePattern - anchors are ignored, don't consume (lines 300-303)", () => {
	it("ignores a '^' anchor in the middle of a pattern", () => {
		const result = decomposePattern("xyz^abc", true, false);
		expect(result.literalSegments).toEqual(["xyzabc"]);
	});

	it("ignores a '$' anchor in the middle of a pattern", () => {
		const result = decomposePattern("xyz$abc", true, false);
		expect(result.literalSegments).toEqual(["xyzabc"]);
	});
});

describe("decomposePattern - regex segment length filter (line 124)", () => {
	it("drops a regex literal segment shorter than 3 chars", () => {
		const result = decomposePattern("ab.cdef", true, false);
		// "ab" (length 2) is dropped, "cdef" (length 4) is kept
		expect(result.literalSegments).toEqual(["cdef"]);
	});

	it("keeps a regex literal segment of length >= 3", () => {
		const result = decomposePattern("abc.def", true, false);
		expect(result.literalSegments).toEqual(["abc", "def"]);
	});
});

describe("decomposePattern - trailing lone backslash (lines 164-165)", () => {
	it("treats a trailing lone backslash as a literal backslash", () => {
		const result = decomposePattern("abc\\", true, false);
		expect(result.literalSegments).toEqual(["abc\\"]);
	});

	it("resolves a mid-pattern escape normally (not the trailing-backslash branch)", () => {
		const result = decomposePattern("ab\\.cdef", true, false);
		expect(result.literalSegments).toEqual(["ab.cdef"]);
	});
});

describe("decomposePattern - quantifier lazy/possessive modifier skip (line 186)", () => {
	it("skips a lazy '?' modifier after '*'", () => {
		const result = decomposePattern("xyz(ab*?cde)", true, false);
		// "ab*?cde" -> quantifier drops the 'b', lazy '?' consumed, "cde" remains
		expect(result.literalSegments).toEqual(["xyz", "cde"]);
	});

	it("skips a possessive '+' modifier after '+'", () => {
		const result = decomposePattern("xyz(ab++cde)", true, false);
		expect(result.literalSegments).toEqual(["xyz", "cde"]);
	});

	it("does not consume a following char when no lazy/possessive modifier is present", () => {
		const result = decomposePattern("xyzab?cde", true, false);
		// quantifier drops 'b' from "xyzab", '?' has nothing after it to skip,
		// so 'c' of "cde" is the very next char parsed normally.
		expect(result.literalSegments).toEqual(["xyza", "cde"]);
	});
});

describe("decomposePattern - repeat quantifier handling (lines 196,201,202)", () => {
	it("flushes the preceding literal before a terminated repeat with lazy modifier", () => {
		const result = decomposePattern("xyzab{2,3}?cde", true, false);
		expect(result.literalSegments).toEqual(["xyza", "cde"]);
	});

	it("flushes the preceding literal before a terminated repeat with no lazy modifier", () => {
		const result = decomposePattern("xyzab{2,3}cde", true, false);
		expect(result.literalSegments).toEqual(["xyza", "cde"]);
	});

	it("handles an unterminated repeat (no closing brace) by consuming to end", () => {
		const result = decomposePattern("xyzab{2,3", true, false);
		expect(result.literalSegments).toEqual(["xyza"]);
	});

	it("handles a repeat with nothing preceding it (current empty)", () => {
		const result = decomposePattern("{2,3}xyzcde", true, false);
		expect(result.literalSegments).toEqual(["xyzcde"]);
	});
});

describe("decomposePattern - unknown escape resolves to the literal char (line 367)", () => {
	it("treats an unrecognized escape like backslash-q as its literal char", () => {
		const result = decomposePattern("xyz\\qcde", true, false);
		expect(result.literalSegments).toEqual(["xyzqcde"]);
	});

	it("treats a known non-literal escape like backslash-d as a flush point", () => {
		const result = decomposePattern("xyz\\dcde", true, false);
		expect(result.literalSegments).toEqual(["xyz", "cde"]);
	});
});

describe("decomposePattern - character class handling (lines 373,374,377,378,385)", () => {
	it("skips a negated character class [^abc]", () => {
		const result = decomposePattern("xyz[^abc]def", true, false);
		expect(result.literalSegments).toEqual(["xyz", "def"]);
	});

	it("skips a class with literal ']' at start", () => {
		const result = decomposePattern("xyz[]abc]def", true, false);
		expect(result.literalSegments).toEqual(["xyz", "def"]);
	});

	it("skips an escaped ']' inside a character class", () => {
		const result = decomposePattern("xyz[a\\]bc]def", true, false);
		expect(result.literalSegments).toEqual(["xyz", "def"]);
	});

	it("handles a plain character class without ^ or leading ]", () => {
		const result = decomposePattern("xyz[abc]def", true, false);
		expect(result.literalSegments).toEqual(["xyz", "def"]);
	});

	it("consumes to end of pattern on an unterminated character class", () => {
		const result = decomposePattern("xyz[abc", true, false);
		expect(result.literalSegments).toEqual(["xyz"]);
	});
});

describe("decomposePattern - group prefix classification (lines 397,398)", () => {
	it("skips a lookahead group (?=...)", () => {
		const result = decomposePattern("xyz(?=abc)def", true, false);
		expect(result.literalSegments).toEqual(["xyz", "def"]);
	});

	it("skips a negative lookahead group (?!...)", () => {
		const result = decomposePattern("xyz(?!abc)def", true, false);
		expect(result.literalSegments).toEqual(["xyz", "def"]);
	});

	it("extracts inner literals from a non-capturing group (?:...)", () => {
		const result = decomposePattern("xyz(?:abc)def", true, false);
		expect(result.literalSegments).toEqual(["xyz", "abc", "def"]);
	});

	it("extracts inner literals from a plain capturing group", () => {
		const result = decomposePattern("xyz(abc)def", true, false);
		expect(result.literalSegments).toEqual(["xyz", "abc", "def"]);
	});
});

describe("decomposePattern - group-end scanning with escapes and nesting (lines 406-410)", () => {
	it("does not treat an escaped close-paren inside a group as the group close", () => {
		const result = decomposePattern("xyz(abc\\)def)ghi", true, false);
		// groupContent = "abc\)def" (escaped paren skipped, real close found after)
		expect(result.literalSegments).toEqual(["xyz", "abc)def", "ghi"]);
	});

	it("tracks nested-paren depth to find the matching close", () => {
		const result = decomposePattern("xyz(abc(def)ghi)jkl", true, false);
		expect(result.literalSegments).toEqual(["xyz", "abc", "def", "ghi", "jkl"]);
	});
});

describe("decomposePattern - top-level alternation with escaped pipe (line 437)", () => {
	it("does not split on an escaped pipe, only a real top-level one", () => {
		const result = decomposePattern("abc\\|def|ghi", true, false);
		// branch 1: "abc\|def" (literal "abc|def"), branch 2: "ghi"
		// no trigram is common to both branches (different literals) -> empty required set
		expect(result.hasLiterals).toBe(false);
		expect(result.requiredTrigrams).toEqual([]);
		expect([...result.literalSegments].sort()).toEqual(["abc|def", "ghi"]);
	});

	it("splits on a plain top-level pipe with no escape", () => {
		const result = decomposePattern("abcxyz|abcqrs", true, false);
		// both branches share literal prefix "abc"
		expect(result.isLiteral).toBe(false);
		expect([...result.literalSegments].sort()).toEqual(["abcqrs", "abcxyz"]);
	});
});

describe("decomposePattern - stray '|' reached inside extractLiteralSegments (lines 293-297)", () => {
	it("stops the char-walk at a '|' left over after a depth-imbalanced split, dropping the tail", () => {
		// A leading unmatched ')' drives splitAlternation's depth negative, so
		// its "depth === 0" split guard never fires on the '|' that follows —
		// the whole string comes back as ONE top branch, and extractLiteralSegments
		// walks it directly, hitting the '|' case itself: it flushes what came
		// before and stops, so "def" after the pipe is never scanned.
		const result = decomposePattern(")abc|def", true, false);
		expect(result.literalSegments).toEqual([")abc"]);
		expect(result.hasLiterals).toBe(true);
	});
});

describe("decomposePattern - empty/short pattern guard", () => {
	it("returns an empty result for a pattern shorter than 3 chars", () => {
		expect(decomposePattern("ab", true, false)).toEqual({
			requiredTrigrams: [],
			literalSegments: [],
			hasLiterals: false,
			isLiteral: false,
			trigramSequences: [],
		});
	});

	it("returns an empty result for an empty pattern", () => {
		expect(decomposePattern("", false, false)).toEqual({
			requiredTrigrams: [],
			literalSegments: [],
			hasLiterals: false,
			isLiteral: true,
			trigramSequences: [],
		});
	});
});
