import { describe, expect, it } from "vitest";
import { findAnyTypes } from "./strong-typing.js";

describe("findAnyTypes — comment-skip logic (kills fb19a88, 74d2d22, a5a3e31, d3eb0d23, a2e3895d, cb5dda11)", () => {
	it("does not flag an indented `//` comment line containing `: any;` (line.trim() must be used, not raw line)", () => {
		// Real: trimmed = "// : any;" -> startsWith("//") -> skipped.
		// Mutant fb19a88 (line.trim() -> line): trimmed keeps the leading
		// spaces, so startsWith("//") is false and the comment slips through.
		const matches = findAnyTypes("  // : any;");
		expect(matches).toHaveLength(0);
	});

	it("does not flag a non-indented `//` comment line containing `: any;`", () => {
		// Kills the whole comment-skip condition family: forcing the
		// condition to `false` (74d2d22), swapping || for && across the
		// three-term chain (a5a3e31), truncating a sub-clause to `false`
		// (d3eb0d23), swapping || for && on the sub-clause (a2e3895d), and
		// turning startsWith("//") into endsWith("//") (cb5dda11) — every
		// one of them lets this comment line fall through to a real match.
		const matches = findAnyTypes("// : any;");
		expect(matches).toHaveLength(0);
	});

	it("does not flag a `/* ... */` comment line containing `: any;` (kills 86b6d1ba)", () => {
		// startsWith("/*") -> endsWith("/*") would fail to recognize this
		// line as a block-comment opener (it ends with "*/", not "/*").
		const matches = findAnyTypes("/* : any; */");
		expect(matches).toHaveLength(0);
	});

	it("does not flag a `*` block-comment continuation line containing `: any;` (kills 6d2f7026)", () => {
		// startsWith("*") -> endsWith("*") would fail since the line ends
		// in ";" not "*".
		const matches = findAnyTypes("* : any;");
		expect(matches).toHaveLength(0);
	});
});

describe("findAnyTypes — string-literal-line skip heuristic (kills b71bdde5, eb5853f0, f3b47df5, b65e70e0, f0358c269, a98144c8)", () => {
	it("does not flag a line that looks entirely like a string literal (zero-indent) (kills b71bdde5, eb5853f0)", () => {
		// The line starts with a quote and ends with a quote (+ optional
		// `,`), so the heuristic classifies it as "entirely a string" and
		// skips it even though it visually contains `: any,`.
		// - b71bdde5 forces the whole condition to `false` -> never skips.
		// - eb5853f0 tightens the leading `\s*` to `\s` (exactly one
		//   whitespace); with zero leading whitespace before the quote the
		//   anchor no longer matches, so the skip is lost too.
		const matches = findAnyTypes(`"a": any,'b'`);
		expect(matches).toHaveLength(0);
	});

	it("flags `const x: any = 'z';` as one real any-type match (kills f3b47df5, b65e70e0, a98144c8)", () => {
		// This line does NOT start with a quote, so the real string-skip
		// heuristic (AND of start-quote && end-quote) does not fire, and
		// the genuine `: any` usage is reported.
		// - f3b47df5 (&& -> ||) would trip the skip anyway because the
		//   end-of-line quote check alone is true.
		// - b65e70e0 (drops the `^` anchor on the start-quote regex) makes
		//   the start-quote check true because a quote appears later in
		//   the line, tripping the skip via the surviving `&&`.
		// - a98144c8 (negates the quote class) makes the start-quote check
		//   true because the first char 'c' is "not a quote", and combined
		//   with the true end-quote check, wrongly trips the skip.
		const matches = findAnyTypes("const x: any = 'z';");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.kind).toBe("any");
	});

	it("does not flag an indented line that looks entirely like a string literal (kills f0358c269)", () => {
		// Two leading spaces before the quote. Real `^\s*['"\`]` matches
		// (whitespace then quote). Mutant f0358c269 changes `\s*` to `\S*`
		// (non-whitespace), which cannot skip past the leading spaces from
		// position 0, so the start-quote check wrongly becomes false and
		// the skip is lost.
		const matches = findAnyTypes(`  "a": any,'b'`);
		expect(matches).toHaveLength(0);
	});
});

describe("findAnyTypes — line-number reporting (kills c59a585c, 442dfbf3)", () => {
	it("reports the correct 1-indexed line number for an `any` match (kills c59a585c)", () => {
		const matches = findAnyTypes("const a = 1;\nconst b = 2;\nlet x: any;\n");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(3);
		expect(matches[0]?.kind).toBe("any");
	});

	it("reports the correct 1-indexed line number for an `unknown` match (kills 442dfbf3)", () => {
		const matches = findAnyTypes("const a = 1;\nconst b = 2;\nconst y = z as unknown;\n");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(3);
		expect(matches[0]?.kind).toBe("unknown");
	});
});

describe("findAnyTypes — text truncation to 120 chars (kills 4a3d38e6, d9f03a04)", () => {
	it("truncates the reported text of a long `any` match to 120 chars (kills 4a3d38e6)", () => {
		const longLine = `${"a".repeat(140)}: any;`;
		const matches = findAnyTypes(longLine);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.kind).toBe("any");
		expect(matches[0]?.text).toHaveLength(120);
		expect(matches[0]?.text).toBe("a".repeat(120));
	});

	it("truncates the reported text of a long `unknown` match to 120 chars (kills d9f03a04)", () => {
		const longLine = `${"a".repeat(140)} as unknown;`;
		const matches = findAnyTypes(longLine);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.kind).toBe("unknown");
		expect(matches[0]?.text).toHaveLength(120);
		expect(matches[0]?.text).toBe("a".repeat(120));
	});
});

describe("findAnyTypes — at most one match per line, `any` wins over `unknown` (kills d0be83fe, 4890eed5)", () => {
	it("reports exactly one match (the `any` one) when a line matches both any- and unknown-type patterns", () => {
		// Real: the `any` loop matches first, sets matched = true, and the
		// unknown loop is skipped (`!matched` is false).
		// - d0be83fe forces `!matched` to `true`, so the unknown loop
		//   always runs too, adding a second match for the same line.
		// - 4890eed5 turns the `matched = true;` assignment into
		//   `matched = false;`, so `!matched` stays true and the unknown
		//   loop again runs redundantly, adding a second match.
		const matches = findAnyTypes("const x = foo as any; const y = bar as unknown;");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.kind).toBe("any");
	});
});

describe("findAnyTypes — ANY_TYPE_PATTERNS regex precision (kills b9de3c82, 5595375c, 9251679a, 2dcac322, 677d2871, 9f8b78a3, 81c09cc4, 876be736)", () => {
	it("flags `x:any;` (zero whitespace around `any`) via the `:any` pattern", () => {
		// Kills b9de3c82 (`:\s*any` -> `:\sany`, needs exactly one space
		// before "any" — zero present, fails) and 5595375c (`any\s*[delim]`
		// -> `any\s[delim]`, needs exactly one space after "any" before the
		// delimiter — zero present, fails) and 9251679a (negates the
		// delimiter char class, excluding ";" which is what follows here).
		const matches = findAnyTypes("x:any;");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.kind).toBe("any");
	});

	it("flags `Array<any>` (zero whitespace around `any`) via the generic-parameter pattern", () => {
		// Kills 2dcac322 (`<\s*any` -> `<\sany`, needs exactly one space
		// after "<" — zero present, fails), 677d2871 (`any\s*[>,]` ->
		// `any\s[>,]`, needs exactly one space before ">" — zero present,
		// fails), and 9f8b78a3 (negates the delimiter class, excluding ">"
		// which is what follows here).
		const matches = findAnyTypes("let v: Array<any> = [];");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.kind).toBe("any");
	});

	it("flags `Array< any>` (whitespace right after `<`) via the generic-parameter pattern (kills 81c09cc4)", () => {
		// `<\s*any` -> `<\S*any` cannot skip the whitespace right after
		// "<" from the anchored position, so the match is lost.
		const matches = findAnyTypes("let v: Array< any>;");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.kind).toBe("any");
	});

	it("flags `Array<any >` (whitespace right before `>`) via the generic-parameter pattern (kills 876be736)", () => {
		// `any\s*[>,]` -> `any\S*[>,]` cannot skip the whitespace right
		// before ">", so the match is lost.
		const matches = findAnyTypes("let v: Array<any >;");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.kind).toBe("any");
	});
});

describe("findAnyTypes — return-type pattern `)\\s*:\\s*any\\b` precision (kills a8c5324, 292ceff8, b7a1d57e, c8955ae8)", () => {
	it("flags `foo():any` (zero whitespace throughout) via the return-type pattern", () => {
		// This line ends immediately after "any" (word-boundary via EOF),
		// so the `:\s*any\s*[delim-class]` pattern does NOT match (no
		// delimiter character follows) and only the return-type pattern
		// can produce a match — isolating it.
		// Kills a8c5324 (`)\s*:` -> `)\s:`, needs exactly one space between
		// ")" and ":" — zero present, fails) and 292ceff8 (`:\s*any` ->
		// `:\sany`, needs exactly one space between ":" and "any" — zero
		// present, fails).
		const matches = findAnyTypes("foo():any");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.kind).toBe("any");
	});

	it("flags `foo() : any` (space between `)` and `:`, none between `:` and `any`) via the return-type pattern (kills b7a1d57e)", () => {
		const matches = findAnyTypes("foo() : any");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.kind).toBe("any");
	});

	it("flags `foo(): any` (no space between `)` and `:`, one between `:` and `any`) via the return-type pattern (kills c8955ae8)", () => {
		// `:\s*any` -> `:\S*any` cannot accommodate the single whitespace
		// between ":" and "any", so the match is lost.
		const matches = findAnyTypes("foo(): any");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.kind).toBe("any");
	});
});

describe("findAnyTypes — `\\s+` (one-or-more) precision on `as any` / `as unknown` (kills 3933f0fe, 9b8bbe9f)", () => {
	it("flags `as  any` with two spaces (kills 3933f0fe)", () => {
		// `\bas\s+any\b` -> `\bas\sany\b` only accepts exactly one
		// whitespace, so two spaces breaks the match.
		const matches = findAnyTypes("const x = y as  any;");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.kind).toBe("any");
	});

	it("flags `as  unknown` with two spaces (kills 9b8bbe9f)", () => {
		// `\bas\s+unknown\b` -> `\bas\sunknown\b` only accepts exactly one
		// whitespace, so two spaces breaks the match.
		const matches = findAnyTypes("const x = y as  unknown;");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.kind).toBe("unknown");
	});
});
