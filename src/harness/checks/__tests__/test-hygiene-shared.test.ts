// Direct unit coverage for `stripPreservingOffsets` — the offset-preserving
// comment/string blanker shared by the test-hygiene isolation and quality
// check families. `findCallSpan` and `IT_TEST_OPEN_RE` are already exercised
// indirectly (and fully covered) via `test-hygiene-isolation.integration.test.ts`
// and `test-hygiene-quality-mock-only.test.ts`, so this file focuses on the
// blanking function's own branches, which had no dedicated test file at all.

import { describe, expect, it } from "vitest";
import { stripPreservingOffsets } from "../test-hygiene-shared.js";

describe("stripPreservingOffsets", () => {
	it("passes plain code through unchanged", () => {
		const code = "const x = 1;\nconst y = 2;\n";
		expect(stripPreservingOffsets(code)).toBe(code);
	});

	it("blanks a line comment up to the newline, preserving offsets", () => {
		const code = 'const x = 1; // trailing comment\nconst y = 2;';
		const out = stripPreservingOffsets(code);
		expect(out).toBe('const x = 1; ' + " ".repeat("// trailing comment".length) + "\nconst y = 2;");
		expect(out.length).toBe(code.length);
	});

	it("blanks a line comment that runs to end-of-file (no trailing newline)", () => {
		const code = "const x = 1; // no newline after this";
		const out = stripPreservingOffsets(code);
		expect(out).toBe("const x = 1; " + " ".repeat("// no newline after this".length));
		expect(out.length).toBe(code.length);
		expect(out).not.toContain("//");
	});

	it("blanks a single-line block comment, replacing non-newline chars with spaces", () => {
		const code = "const x = /* inline */ 1;";
		const out = stripPreservingOffsets(code);
		expect(out).toBe("const x = " + " ".repeat("/* inline */".length) + " 1;");
		expect(out.length).toBe(code.length);
	});

	it("blanks a multi-line block comment, preserving embedded newlines", () => {
		const code = "const x = /* line one\nline two */ 1;";
		const out = stripPreservingOffsets(code);
		expect(out.length).toBe(code.length);
		expect(out).toContain("\n");
		expect(out).not.toContain("line one");
		expect(out).not.toContain("line two");
		// The newline inside the block comment survives blanking.
		expect(out.split("\n")).toHaveLength(2);
	});

	it("blanks an unterminated block comment through to end-of-file", () => {
		const code = "const x = 1; /* never closed";
		const out = stripPreservingOffsets(code);
		expect(out).toBe("const x = 1; " + " ".repeat("/* never closed".length));
		expect(out.length).toBe(code.length);
	});

	it("blanks a double-quoted string literal's contents, preserving offsets", () => {
		const code = 'const s = "secret value";';
		const out = stripPreservingOffsets(code);
		expect(out).toBe('const s = ' + " ".repeat('"secret value"'.length) + ";");
		expect(out.length).toBe(code.length);
	});

	it("blanks a single-quoted string literal's contents", () => {
		const code = "const s = 'secret value';";
		const out = stripPreservingOffsets(code);
		expect(out).toBe("const s = " + " ".repeat("'secret value'".length) + ";");
	});

	it("blanks a template literal, preserving any embedded newlines", () => {
		const code = "const s = `line one\nline two`;";
		const out = stripPreservingOffsets(code);
		expect(out.length).toBe(code.length);
		expect(out).not.toContain("line one");
		expect(out.split("\n")).toHaveLength(2);
	});

	it("treats an escaped quote as part of the string, not its terminator", () => {
		const code = 'const s = "a \\" b" ;';
		const out = stripPreservingOffsets(code);
		// The escaped quote must not end the string early — the trailing
		// `" ;` after it should be blanked, not left as live code.
		expect(out.length).toBe(code.length);
		expect(out).not.toContain("a ");
		expect(out).toBe("const s = " + " ".repeat('"a \\" b"'.length) + " ;");
	});

	it("bails an unterminated double-quoted string at the line end instead of consuming the newline", () => {
		const code = 'const s = "never closed\nconst next = 1;';
		const out = stripPreservingOffsets(code);
		expect(out.length).toBe(code.length);
		// The newline is preserved (not blanked away) and the next line's
		// real code survives untouched.
		expect(out).toContain("\nconst next = 1;");
	});

	it("bails an unterminated single-quoted string at the line end", () => {
		const code = "const s = 'never closed\nconst next = 1;";
		const out = stripPreservingOffsets(code);
		expect(out).toContain("\nconst next = 1;");
		expect(out.length).toBe(code.length);
	});

	it("does NOT bail a template literal at a newline — backticks span lines", () => {
		const code = "const s = `spans\nmultiple\nlines`;\nconst next = 1;";
		const out = stripPreservingOffsets(code);
		expect(out.length).toBe(code.length);
		expect(out).not.toContain("spans");
		expect(out).not.toContain("multiple");
		expect(out).toContain("const next = 1;");
	});

	it("returns an empty string for empty input", () => {
		expect(stripPreservingOffsets("")).toBe("");
	});
});
