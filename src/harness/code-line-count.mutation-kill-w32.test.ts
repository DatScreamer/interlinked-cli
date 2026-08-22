// Mutation-kill pass (w32) for code-line-count.ts survivors, per
// .interlinked/mutation-manifest.json. Black-box through the public
// `countCodeLines` API (endCodeLine/scanCodeLineChar are internal).
//
// mutantId -> case index (1-based, in file order):
//   1  fe807268de565d86
//   2  8d05a8bb044d40b4, cf223ee1930a9b9d, f2ae1d5da9223613,
//      1380035118f6b87e, 38c41a3323734ac3
//   3  a2c1009028509074, b1b2859ca50629be, 91a992dea589cc8d
//   4  435791ddb784b0de
//   5  6b1ecd810cddc355, f7fab43e8a7e7c8d
//   6  47d280782011764b, 272cb5b06952b370, 3be06d9d5387256f,
//      a389724386166d01, dfd499a07b0962d0
//   7  70d787ed9fb84b1a, 45cdaa6ce0e7c563, 5eb82a160d61931a
//   8  321779fe884830c7, 3990c46675a8a08c
//   9  0b8dc7fa687b9345
//   10 c321808279a86707, 5479b0f01101db3c
//   11 775c2e23ee051c19
//   12 a5b7b787fb0eb34d
//   13 44cae235997dfe77, 036b8de80ebf507b, 1919b91cbb00ce57,
//      34bc7494cdfde585, b9bf1ffe8974cbb4, ff24316ed6048f24,
//      0fd93a832f7bb644
//   14 afe52284282f2cbe, 3c70f77b212eae0a
//   15 255828a7ffaa67ba, 12793fcd3231f433
//   16 23ddd0494fb95fa7
import { describe, expect, it } from "vitest";
import { countCodeLines } from "./code-line-count.js";

describe("countCodeLines — mutation-kill w32", () => {
	// Blank line inside a backtick template must stay "in string" (code),
	// not fall out when the delimiter is (wrongly) cleared at EOL.
	// test-contract: invariant — case 1, see mutantId map above
	it("keeps a template literal's backtick delimiter open across a blank line", () => {
		expect(countCodeLines("const t = `line1\n   \nline3`;\n")).toBe(3);
	});

	// An unterminated single-quote string must not span the newline; a
	// blank line right after it must NOT be treated as string content.
	// test-contract: invariant — case 2, see mutantId map above
	it("closes an unterminated single-quote string at end of line", () => {
		expect(countCodeLines("const a = 'first;\n   \nconst c = 3;\n")).toBe(2);
	});

	// Same shape as above, mirrored onto the double-quote delimiter.
	// test-contract: invariant — case 3, see mutantId map above
	it("closes an unterminated double-quote string at end of line", () => {
		expect(countCodeLines('const a = "first;\n   \nconst c = 3;\n')).toBe(2);
	});

	// Inside a block comment, a non-"*" char followed by "/" must NOT
	// close the comment; only a real "*/" token closes it.
	// test-contract: invariant — case 4, see mutantId map above
	it("does not close a block comment on a stray char followed by /", () => {
		expect(countCodeLines("/* a/b */\nCODE\n")).toBe(1);
	});

	// A "/*" sequence living inside a string must stay inert content, not
	// open a real block comment that swallows the next code line.
	// test-contract: invariant — case 5, see mutantId map above
	it("treats /* inside a string as literal content, not a comment opener", () => {
		expect(countCodeLines('const s = "a/*b";\nREALCODE;\n')).toBe(2);
	});

	// An escaped backtick inside a template literal must not close it;
	// a blank middle line pins whether the escape was honored.
	// test-contract: invariant — case 6, see mutantId map above
	it("honors an escaped backtick inside a template literal", () => {
		expect(countCodeLines("const t = `a\\`b\n   \nc`;\nTAIL;\n")).toBe(4);
	});

	// A backslash directly followed by a real newline must not be
	// treated as an escape that consumes the newline character.
	// test-contract: invariant — case 7, see mutantId map above
	it("does not treat a trailing backslash-newline as an escape", () => {
		expect(countCodeLines("const t = `abc\\\nend`;\nTAIL;\n")).toBe(3);
	});

	// The string-close check must fire only on the actual delimiter
	// char, not on the first content char after opening.
	// test-contract: invariant — case 8, see mutantId map above
	it("closes a template literal only at its real backtick delimiter", () => {
		expect(countCodeLines("const t = `x\n   \ny`;\nTAIL;\n")).toBe(4);
	});

	// A template literal that never closes must not leak its "in
	// string" state into a following real // comment line.
	// test-contract: invariant — case 9, see mutantId map above
	it("closes a template literal so a later // line is a real comment", () => {
		expect(countCodeLines("const t = `abc`;\n// pure comment\n")).toBe(1);
	});

	// A non-"/" char followed by "/" must not open a line comment.
	// test-contract: invariant — case 10, see mutantId map above
	it("does not open a line comment on a non-slash char followed by /", () => {
		expect(countCodeLines("X/\nCODE\n")).toBe(2);
	});

	// A non-"/" char followed by "*" must not open a block comment.
	// test-contract: invariant — case 11, see mutantId map above
	it("does not open a block comment on a non-slash char followed by *", () => {
		expect(countCodeLines("X*\nCODE\n")).toBe(2);
	});

	// A lone "/" not followed by "*" must not open a block comment.
	// test-contract: invariant — case 12, see mutantId map above
	it("does not open a block comment on a slash not followed by *", () => {
		expect(countCodeLines("X/Y\nCODE\n")).toBe(2);
	});

	// A leading single quote must open a string, so a "/*" inside its
	// intended content stays inert instead of opening a real comment.
	// test-contract: invariant — case 13, see mutantId map above
	it("opens a string on a leading single quote so embedded /* stays inert", () => {
		expect(countCodeLines("'/*x\nTAIL\n")).toBe(2);
	});

	// Same shape as above, mirrored onto the double-quote delimiter.
	// test-contract: invariant — case 14, see mutantId map above
	it("opens a string on a leading double quote so embedded /* stays inert", () => {
		expect(countCodeLines('"/*x\nTAIL\n')).toBe(2);
	});

	// Same shape again, mirrored onto the backtick delimiter; the blank
	// middle line pins the divergence.
	// test-contract: invariant — case 15, see mutantId map above
	it("opens a string on a leading backtick so embedded /* stays inert", () => {
		expect(countCodeLines("`/*x\n   \nTAIL\n")).toBe(3);
	});

	// Opening a string on a bare quote char must mark that line as
	// having code even though nothing else follows it.
	// test-contract: invariant — case 16, see mutantId map above
	it("marks a bare opening quote's own line as code", () => {
		expect(countCodeLines("'\n")).toBe(1);
	});
});
