// Targeted branch/line coverage for stripForBraceScan's edge paths: unterminated
// string/regex literals (real newline mid-literal), backslash-escape handling at
// EOF, block-comment EOF, and regex-vs-division disambiguation via precedingWord.
// See strip-brace-balance.test.ts for the invariant-level (brace-balance) tests.
import { describe, expect, it } from "vitest";
import { stripForBraceScan } from "./shared-text-utils.js";

describe("stripForBraceScan — unterminated string literal (real newline bails)", () => {
	it("a double-quoted string containing a raw newline is abandoned at the newline", () => {
		// Real newline chars, not escaped \n, so the string frame is unterminated.
		const src = 'const s = "abc\ndef";\nfunction f() { return 1; }';
		const out = stripForBraceScan(src);
		// Everything up to (not including) the newline is blanked; the newline
		// itself and "def" (now parsed as top-level code) survive. The `"` that
		// follows opens a SECOND (also unterminated) string that swallows `;`
		// and bails again at the next newline — a chained consequence of
		// treating the file as two unterminated strings, not one.
		expect(out).toBe('const s =     \ndef  \nfunction f() { return 1; }');
	});
});

describe("stripForBraceScan — unterminated regex literal (real newline bails)", () => {
	it("a regex literal containing a raw newline is abandoned at the newline", () => {
		const src = "const re = /abc\ndef/; function g() { return 1; }";
		const out = stripForBraceScan(src);
		expect(out).toBe("const re =     \ndef/; function g() { return 1; }");
	});
});

describe("stripForBraceScan — string backslash-escape edge cases", () => {
	it("backslash as the very last character of the file (no char to escape)", () => {
		const src = 'const s = "abc\\';
		// The backslash blanks itself; there is no i+1 to also blank (EOF).
		expect(stripForBraceScan(src)).toBe("const s =      ");
	});

	it("backslash escaping a normal character mid-string keeps scanning", () => {
		const src = 'const s = "a\\"b"; function h() { return 1; }';
		const out = stripForBraceScan(src);
		expect(out).toBe("const s =       ; function h() { return 1; }");
	});
});

describe("stripForBraceScan — block comment unterminated at EOF", () => {
	it("an unterminated block comment blanks to end of file without throwing", () => {
		const src = "function f() { return 1; } /* never closed";
		const out = stripForBraceScan(src);
		expect(out).toBe("function f() { return 1; }                ");
	});
});

describe("stripForBraceScan — regex literal backslash-escape edge cases", () => {
	it("backslash as the very last character inside a regex (no char to escape)", () => {
		const src = "const re = /abc\\";
		expect(stripForBraceScan(src)).toBe("const re =      ");
	});

	it("backslash escaping a slash inside a regex keeps it from closing the literal", () => {
		const src = "const re = /a\\/b/; function i() { return 1; }";
		const out = stripForBraceScan(src);
		expect(out).toBe("const re =       ; function i() { return 1; }");
	});
});

describe("stripForBraceScan — template literal backslash-escape edge cases", () => {
	it("backslash as the very last character inside a template literal (no char to escape)", () => {
		const src = "const t = `abc\\";
		expect(stripForBraceScan(src)).toBe("const t =      ");
	});

	it("backslash escaping a backtick inside a template literal keeps it open", () => {
		const src = "const t = `a\\`b`; function j() { return 1; }";
		const out = stripForBraceScan(src);
		expect(out).toBe("const t =       ; function j() { return 1; }");
	});
});

describe("stripForBraceScan — regex vs. division disambiguation (precedingWord)", () => {
	it("a keyword immediately (no whitespace) before `/` is still recognized as a regex preceder", () => {
		const src = "if(typeof/x/.test(y)){ z(); }";
		const out = stripForBraceScan(src);
		// The regex body `x` is blanked; structural code survives.
		expect(out).toBe("if(typeof   .test(y)){ z(); }");
	});

	it("a keyword with whitespace before `/` is recognized as a regex preceder", () => {
		const src = "function k() { return /x/.test(y); }";
		const out = stripForBraceScan(src);
		expect(out).toBe("function k() { return    .test(y); }");
	});

	it("division after an identifier that is not a regex-preceder word stays division (not a regex)", () => {
		const src = "function m() { return a/b; }";
		const out = stripForBraceScan(src);
		// `/` here is division: not a frame opener, so nothing is blanked at all.
		expect(out).toBe(src);
	});
});
