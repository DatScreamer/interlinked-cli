// Coverage for regex-trigrams-grep-parse.ts: parseGrepCommand is the only
// export, so every branch inside classifyGrepFlag, hasUnquotedShellOperator,
// applyGrepFlag, assignGrepPositionals, and tokenizeShellArgs (all internal)
// is exercised indirectly through crafted command strings.

import { describe, expect, it } from "vitest";
import { parseGrepCommand } from "./regex-trigrams-grep-parse.js";

describe("parseGrepCommand — flag classification", () => {
	it("P1: -s forces caseInsensitive false even after -i (must fire)", () => {
		const result = parseGrepCommand("rg -i -s foo file.ts");
		expect(result).toEqual({
			pattern: "foo",
			isRegex: true,
			caseInsensitive: false,
			path: "file.ts",
		});
	});

	it("P2: --case-sensitive is the long form of -s (must fire)", () => {
		const result = parseGrepCommand("rg -i --case-sensitive foo file.ts");
		expect(result?.caseInsensitive).toBe(false);
	});

	it("P3: -i sets caseInsensitive true (must fire)", () => {
		const result = parseGrepCommand("rg -i foo");
		expect(result?.caseInsensitive).toBe(true);
	});

	it("P4: -F / --fixed-strings sets isRegex false (must fire)", () => {
		expect(parseGrepCommand("rg -F foo")?.isRegex).toBe(false);
		expect(parseGrepCommand("rg --fixed-strings foo")?.isRegex).toBe(false);
	});

	it("N1: an unmodeled flag declines to null (must not fire / correctly declines)", () => {
		expect(parseGrepCommand("rg -v foo")).toBeNull();
	});
});

describe("parseGrepCommand — -e / --regexp pattern-from-flag", () => {
	it("P5: -e PATTERN sets the pattern from the following token (must fire)", () => {
		const result = parseGrepCommand("rg -e foo file.ts");
		expect(result).toEqual({
			pattern: "foo",
			isRegex: true,
			caseInsensitive: false,
			path: "file.ts",
		});
	});

	it("N2: a dangling -e with no following token declines (must not fire)", () => {
		expect(parseGrepCommand("rg -e")).toBeNull();
	});

	it("N3: -e PATTERN followed by more than one positional declines (must not fire)", () => {
		expect(parseGrepCommand("rg -e foo file1.ts file2.ts")).toBeNull();
	});

	it("P6: -e PATTERN with zero trailing positionals omits path (must fire)", () => {
		const result = parseGrepCommand("rg -e foo");
		expect(result).toEqual({
			pattern: "foo",
			isRegex: true,
			caseInsensitive: false,
		});
	});
});

describe("parseGrepCommand — positional resolution (non-flag pattern)", () => {
	it("N4: zero positionals declines (must not fire)", () => {
		expect(parseGrepCommand("rg")).toBeNull();
	});

	it("N5: more than two positionals declines (must not fire)", () => {
		expect(parseGrepCommand("rg foo path1 path2")).toBeNull();
	});

	it("P7: one positional is the pattern with no path (must fire)", () => {
		const result = parseGrepCommand("rg foo");
		expect(result).toEqual({
			pattern: "foo",
			isRegex: true,
			caseInsensitive: false,
		});
	});

	it("P8: two positionals are pattern + path (must fire)", () => {
		const result = parseGrepCommand("rg foo src/");
		expect(result).toEqual({
			pattern: "foo",
			isRegex: true,
			caseInsensitive: false,
			path: "src/",
		});
	});
});

describe("parseGrepCommand — `--` end-of-flags marker", () => {
	it("P9: everything after -- is positional, even flag-shaped text (must fire)", () => {
		const result = parseGrepCommand("rg -i -- --looks-like-a-flag");
		expect(result).toEqual({
			pattern: "--looks-like-a-flag",
			isRegex: true,
			caseInsensitive: true,
		});
	});
});

describe("parseGrepCommand — shell operator detection (quoting-aware)", () => {
	it("N6: an unquoted pipe declines (compound command) (must not fire)", () => {
		expect(parseGrepCommand("rg foo | wc -l")).toBeNull();
	});

	it("P10: a backslash-escaped pipe outside quotes is literal, not an operator (must fire)", () => {
		const result = parseGrepCommand("rg foo\\|bar");
		expect(result).toEqual({
			pattern: "foo|bar",
			isRegex: true,
			caseInsensitive: false,
		});
	});

	it("P11: a pipe inside single quotes is literal, not an operator (must fire)", () => {
		const result = parseGrepCommand("rg 'foo|bar'");
		expect(result).toEqual({
			pattern: "foo|bar",
			isRegex: true,
			caseInsensitive: false,
		});
	});

	it("P12: plain double-quoted content with no escapes parses normally (must fire)", () => {
		const result = parseGrepCommand('rg "foobar" file.ts');
		expect(result).toEqual({
			pattern: "foobar",
			isRegex: true,
			caseInsensitive: false,
			path: "file.ts",
		});
	});

	it("P13: a backslash-escaped quote inside double quotes stays literal (must fire)", () => {
		const result = parseGrepCommand('rg "a\\"b" file.ts');
		expect(result).toEqual({
			pattern: 'a"b',
			isRegex: true,
			caseInsensitive: false,
			path: "file.ts",
		});
	});
});

describe("parseGrepCommand — tokenizer backslash handling", () => {
	it("P14: a mid-token backslash escape substitutes the escaped char (must fire)", () => {
		// `\x` inside an unquoted token becomes a literal `x` — exercises the
		// two-character-advance branch of the outside-quotes backslash handler.
		const result = parseGrepCommand("rg fo\\xo file.ts");
		expect(result?.pattern).toBe("foxo");
	});

	it("P15: a trailing dangling backslash with no following char is dropped (must fire)", () => {
		// Exercises the single-character-advance ("nothing to escape") branch.
		const result = parseGrepCommand("rg foo\\");
		expect(result).toEqual({
			pattern: "foo",
			isRegex: true,
			caseInsensitive: false,
		});
	});

	it("P16: repeated whitespace collapses without emitting empty tokens (must fire)", () => {
		const result = parseGrepCommand("rg   foo   file.ts");
		expect(result).toEqual({
			pattern: "foo",
			isRegex: true,
			caseInsensitive: false,
			path: "file.ts",
		});
	});
});

describe("parseGrepCommand — command recognition", () => {
	it("N7: a non-grep command declines (must not fire)", () => {
		expect(parseGrepCommand("ls -la")).toBeNull();
	});

	it("P17: an absolute-path-invoked ugrep binary is recognized (must fire)", () => {
		const result = parseGrepCommand("/usr/bin/ugrep foo file.ts");
		expect(result).toEqual({
			pattern: "foo",
			isRegex: true,
			caseInsensitive: false,
			path: "file.ts",
		});
	});
});
