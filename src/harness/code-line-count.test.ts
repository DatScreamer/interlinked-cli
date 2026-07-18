// Direct tests for the extracted comment/string-aware code-line counter.
// (large-file-policy.test.ts keeps exercising it through the re-export.)
import { describe, expect, it } from "vitest";
import { countCodeLines } from "./code-line-count.js";

describe("countCodeLines", () => {
	it("counts plain code lines", () => {
		expect(countCodeLines("const a = 1;\nconst b = 2;\n")).toBe(2);
	});

	it("ignores blank lines and // comment lines", () => {
		expect(countCodeLines("const a = 1;\n\n// note\n   \nconst b = 2;\n")).toBe(2);
	});

	it("ignores block comments spanning lines", () => {
		expect(countCodeLines("/*\n * doc\n * doc\n */\nconst a = 1;\n")).toBe(1);
	});

	it("counts a line with code followed by a trailing comment", () => {
		expect(countCodeLines("const a = 1; // trailing\n")).toBe(1);
	});

	it("counts template-literal content lines as code", () => {
		expect(countCodeLines("const t = `line1\nline2\nline3`;\n")).toBe(3);
	});

	it("does not open a comment from // inside a string", () => {
		expect(countCodeLines('const url = "https://example.com";\n')).toBe(1);
	});

	it("does not open a block comment from /* inside a string", () => {
		expect(countCodeLines('const s = "/* not a comment */";\nconst a = 1;\n')).toBe(2);
	});

	it("handles escaped quotes inside strings", () => {
		expect(countCodeLines('const s = "she said \\"hi\\""; // q\n')).toBe(1);
	});

	it("returns 0 for a comment-only file", () => {
		expect(countCodeLines("// only\n/* comments\n   here */\n\n")).toBe(0);
	});
});
