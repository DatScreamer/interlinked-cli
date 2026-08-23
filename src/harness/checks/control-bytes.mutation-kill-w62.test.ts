import { describe, expect, it } from "vitest";
import { checkRawControlBytes } from "./control-bytes.js";

describe("checkRawControlBytes — positive (must fire)", () => {
	// test-contract: public-api — asEscape() docstring promises "uppercase, zero-padded" hex.
	it("renders the escape hex in uppercase (kills MethodExpression toUpperCase->toLowerCase)", () => {
		// \x1B has a hex digit that differs between upper/lower case: "1B" vs "1b".
		const content = "const x = \x1Bfoo;";
		const matches = checkRawControlBytes(content, "example.ts");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.text).toContain("\\x1B");
		expect(matches[0]?.text).not.toContain("\\x1b");
	});

	// test-contract: public-api — InlineMatch.text is documented as "truncated to 150 chars" (shared.ts).
	it("truncates the rendered line to 150 characters (kills MethodExpression .slice(0,150) removal)", () => {
		const longLine = `\x01${"A".repeat(300)}`;
		const matches = checkRawControlBytes(longLine, "example.ts");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.text.length).toBe(150);
	});

	// test-contract: invariant — control-bytes.ts comments the render as trim()-ed plain text before truncation.
	it("trims leading/trailing whitespace from the rendered line (kills MethodExpression .trim() removal)", () => {
		const content = "   \x01abc   ";
		const matches = checkRawControlBytes(content, "example.ts");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.text).toBe("\\x01abc");
	});

	// test-contract: bug — a non-global replace regex leaves later control bytes on the same line
	// un-escaped, which is exactly the "review can't see the difference" failure this check exists to catch.
	it("replaces every control byte on a line, not just the first (kills StringLiteral 'g'->'' on the global regex flags)", () => {
		const content = "\x01a\x02b";
		const matches = checkRawControlBytes(content, "example.ts");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.text).toBe("\\x01a\\x02b");
	});

	const extensionCases: Array<[string, string]> = [
		[".jsonc", "config.jsonc"],
		[".pyi", "stub.pyi"],
		[".h", "header.h"],
		[".cc", "impl.cc"],
		[".cpp", "impl.cpp"],
		[".cxx", "impl.cxx"],
		[".hpp", "header.hpp"],
		[".java", "Main.java"],
		[".cs", "Program.cs"],
		[".yml", "config.yml"],
		[".toml", "config.toml"],
		[".css", "style.css"],
		[".scss", "style.scss"],
		[".html", "index.html"],
	];

	for (const [ext, filePath] of extensionCases) {
		// test-contract: public-api — TEXT_SOURCE_EXTS in control-bytes.ts explicitly lists this
		// extension as an in-scope text-source format that must be scanned for raw control bytes.
		it(`recognizes ${ext} as a scanned text-source extension (kills StringLiteral "${ext}"->"" )`, () => {
			const content = "abc\x01def";
			const matches = checkRawControlBytes(content, filePath);
			expect(matches).toHaveLength(1);
		});
	}
});

describe("checkRawControlBytes — negative (must not fire)", () => {
	// test-contract: boundary — baseline zero-finding case for a clean file with no control bytes.
	it("returns no matches for clean content with a recognized extension", () => {
		const matches = checkRawControlBytes("const x = 1;\nconst y = 2;\n", "example.ts");
		expect(matches).toEqual([]);
	});

	// test-contract: security — if a StringLiteral extension mutant turns a real extension into "",
	// TEXT_SOURCE_EXTS gains an empty-string member and starts matching every extension-less path,
	// which is not a real text-source format and must never be scanned.
	it("does not treat an extension-less path (guards against an empty-string extension entry) as a text source", () => {
		const matches = checkRawControlBytes("abc\x01def", "no-extension-at-all");
		expect(matches).toEqual([]);
	});
});
