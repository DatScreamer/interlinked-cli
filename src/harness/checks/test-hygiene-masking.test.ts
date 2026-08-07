// Direct unit coverage for test-hygiene-masking.ts's pure char-level helpers,
// targeting paths the end-to-end consumer (checkHappyPathOnlyTest, exercised in
// test-hygiene.test.ts) does not happen to reach: block comments, string
// backslash-escape edge cases, and the blankRange/isCodeMatch boundary clamps.
import { describe, expect, it } from "vitest";
import { blankRange, isCodeMatch, isSkippedOrTodoCall, maskCommentsAndStrings } from "./test-hygiene-masking.js";

describe("maskCommentsAndStrings — block comments", () => {
	it("blanks a single-line block comment, preserving surrounding code", () => {
		const src = "const a = 1; /* hi */ const b = 2;";
		expect(maskCommentsAndStrings(src)).toBe("const a = 1;          const b = 2;");
	});

	it("blanks a multi-line block comment, keeping newlines and non-comment lines intact", () => {
		const src = "const a = 1;\n/*\n  multi\n  line\n*/\nconst b = 2;";
		expect(maskCommentsAndStrings(src)).toBe(
			"const a = 1;\n  \n       \n      \n  \nconst b = 2;",
		);
	});
});

describe("maskCommentsAndStrings — string backslash-escape edge cases", () => {
	it("a backslash as the very last character of the file is blanked with no char to escape", () => {
		const src = 'const s = "abc\\';
		expect(maskCommentsAndStrings(src)).toBe("const s =      ");
	});

	it("a backslash escaping a real newline inside a string keeps the newline and continues the string", () => {
		const src = 'const s = "a\\\nb"; code();';
		const out = maskCommentsAndStrings(src);
		// The escaped newline is preserved as a real newline (offsets stay
		// stable); the rest of the string content is blanked.
		expect(out).toBe("const s =    \n  ; code();");
	});

	it("a backslash escaping an ordinary character (not a newline) blanks both chars", () => {
		const src = 'const s = "a\\"b"; code();';
		const out = maskCommentsAndStrings(src);
		expect(out).toBe("const s =       ; code();");
	});
});

describe("maskCommentsAndStrings — line comments and quote-type dispatch", () => {
	it("blanks a line comment to (not including) the newline", () => {
		const src = "const a = 1; // trailing\nconst b = 2;";
		expect(maskCommentsAndStrings(src)).toBe("const a = 1;            \nconst b = 2;");
	});

	it("division is not mistaken for a comment opener", () => {
		const src = "const a = 4 / 2;";
		expect(maskCommentsAndStrings(src)).toBe(src);
	});

	it("blanks single, double, and template string literals alike", () => {
		const src = "const a = 'x'; const b = \"y\"; const c = `z`;";
		expect(maskCommentsAndStrings(src)).toBe("const a =    ; const b =    ; const c =    ;");
	});
});

describe("isCodeMatch", () => {
	it("is true for a non-blank char at offset", () => {
		expect(isCodeMatch("ab c", 0)).toBe(true);
	});

	it("is false for a blank (masked) char at offset", () => {
		expect(isCodeMatch("a  c", 1)).toBe(false);
	});

	it("is false when offset is past the end of the content (undefined char)", () => {
		expect(isCodeMatch("ab", 10)).toBe(false);
	});
});

describe("isSkippedOrTodoCall", () => {
	it("recognizes a .skip call", () => {
		expect(isSkippedOrTodoCall("it.skip(")).toBe(true);
	});

	it("recognizes a .todo call", () => {
		expect(isSkippedOrTodoCall("describe.todo(")).toBe(true);
	});

	it("is false for a plain call with no .skip/.todo", () => {
		expect(isSkippedOrTodoCall("it(")).toBe(false);
	});
});

describe("blankRange", () => {
	it("blanks the given range in place, preserving newlines", () => {
		const chars = "abc\nefg".split("");
		blankRange(chars, 1, 6);
		expect(chars.join("")).toBe("a  \n  g");
	});

	it("clamps end to chars.length so an out-of-bounds end does not throw", () => {
		const chars = "abc".split("");
		blankRange(chars, 1, 100);
		expect(chars.join("")).toBe("a  ");
	});
});
