// Unit tests for regex-interpolation.ts (check id: regex_from_interpolation)
//
// Fixtures are built from plain quoted strings, so backticks and "${...}"
// inside them are inert text, not live interpolation.
//
// Covers:
//   Positive (MUST fire):
//     P1  new RegExp(`^${prefix}`) — template with one substitution
//     P2  bare RegExp('^' + userInput) — concatenation with identifier
//     P3  new RegExp(`${a}|${b}`, 'g') — two substitutions + flags arg
//     P4  mixed: one escapeRegExp(x) sub + one bare y sub — still fires
//     P5  String.raw-tagged template with lowercase substitution
//     P6  concat of CONST_CASE fragment + lowercase identifier
//     P7  multi-line call — fires on the `new RegExp(` line
//     P8  caps at 10 matches per file
//     P9  identifier assigned from a NON-escape call still fires
//   Negative (MUST NOT fire):
//     N1  occurrences only inside comments
//     N2  occurrence inside a string literal
//     N3  wrong extension (.py)
//     N4  test-file path
//     N5  pure string-literal pattern
//     N6  identifier argument (any case), incl. with flags
//     N7  template with zero substitutions
//     N8  all substitutions CONST_CASE (fragment composition, .source members)
//     N9  every dynamic part routed through an /escape/i call
//     N10 numeric-literal substitution / operand
//     N11 pure-literal concatenation
//     N12 vendored path and generated-file header
//     N13 two-step escape: identifier assigned from an /escape/i call
//   Regressions (adversarial review, 2026-07): R1–R12 — lexer correctness
//     (#-fields, /* in strings, backtick regex literals, multi-line
//     templates), escape-exemption scope/staleness, CONST length cap,
//     chained-call arguments, and near-linear scan time.

import { describe, expect, it } from "vitest";
import { checkRegexFromInterpolation } from "./regex-interpolation.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

const FILE = "src/lib/patterns.ts";

function run(src: string, path: string = FILE) {
	return checkRegexFromInterpolation(src, path);
}

function fires(src: string): boolean {
	return run(src).length > 0;
}

// ─── Positive cases ───────────────────────────────────────────────────────────

describe("checkRegexFromInterpolation — positive (must fire)", () => {
	it("P1: new RegExp(`^${prefix}`) — template with one substitution", () => {
		const src = [
			"export function f(prefix: string): RegExp {",
			"  const re = new RegExp(`^${prefix}`);",
			"  return re;",
			"}",
		].join("\n");
		const found = run(src);
		expect(found.length).toBe(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toMatch(/^regex_from_interpolation: /);
	});

	it("P2: bare RegExp('^' + userInput) — concatenation with identifier", () => {
		const src = [
			"function g(userInput: string) {",
			"  return RegExp('^' + userInput);",
			"}",
		].join("\n");
		const found = run(src);
		expect(found.length).toBe(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toMatch(/concatenation/);
	});

	it("P3: new RegExp(`${a}|${b}`, 'g') — two substitutions plus flags", () => {
		const src = "const both = new RegExp(`${a}|${b}`, 'g');";
		const found = run(src);
		expect(found.length).toBe(1);
		expect(found[0]?.line).toBe(1);
	});

	it("P4: mixed template — escapeRegExp(x) sub AND bare y sub still fires", () => {
		const src = "const m = new RegExp(`${escapeRegExp(x)}-${y}`);";
		expect(fires(src)).toBe(true);
	});

	it("P5: String.raw-tagged template with lowercase substitution", () => {
		const src = "const w = new RegExp(String.raw`\\b${name}\\b`);";
		expect(fires(src)).toBe(true);
	});

	it("P6: concatenation of CONST_CASE fragment + lowercase identifier", () => {
		const src = "const s = new RegExp(BASE_PATTERN + suffix);";
		expect(fires(src)).toBe(true);
	});

	it("P7: multi-line call fires on the `new RegExp(` line", () => {
		const src = [
			"const re = new RegExp(",
			"  `^${tail}-`,",
			"  'g',",
			");",
		].join("\n");
		const found = run(src);
		expect(found.length).toBe(1);
		expect(found[0]?.line).toBe(1);
	});

	it("P8: caps at 10 matches per file", () => {
		const many = Array.from(
			{ length: 15 },
			(_, i) => "const r" + i + " = new RegExp(`^${v" + i + "}`);",
		).join("\n");
		expect(run(many).length).toBe(10);
	});

	it("P9: identifier assigned from a NON-escape call still fires", () => {
		const src = [
			"function h(raw: string) {",
			"  const n = getUserFilter(raw);",
			"  return new RegExp(`^${n}`);",
			"}",
		].join("\n");
		const found = run(src);
		expect(found.length).toBe(1);
		expect(found[0]?.line).toBe(3);
	});

	it("P10: object-literal substitution with nested braces + a quoted string still fires", () => {
		const src = "const re = new RegExp(`^${ {a: 'x'} }$`);";
		const found = run(src);
		expect(found.length).toBe(1);
		expect(found[0]?.text).toMatch(/regex_from_interpolation/);
	});

	it("P11: parenthesized non-call operand `${(x)}` still fires", () => {
		const src = "const re = new RegExp(`${(x)}`);";
		expect(fires(src)).toBe(true);
	});

	it("P12: an empty operand from a double `+ +` still fires", () => {
		const src = "const re = new RegExp('x' + + 'y');";
		const found = run(src);
		expect(found.length).toBe(1);
		expect(found[0]?.text).toMatch(/concatenation/);
	});

	it("P13: a template literal as one operand of a concatenation still fires", () => {
		const src = "const re = new RegExp('x' + `${a}` + 'y');";
		const found = run(src);
		expect(found.length).toBe(1);
		expect(found[0]?.text).toMatch(/concatenation/);
	});

	it("P14: two RegExp calls on one line still produce exactly one finding", () => {
		const src = "const a = new RegExp(`${x}`), b = new RegExp(`${y}`);";
		const found = run(src);
		expect(found.length).toBe(1);
		expect(found[0]?.line).toBe(1);
	});
});

// ─── Negative cases ───────────────────────────────────────────────────────────

describe("checkRegexFromInterpolation — negative (must NOT fire)", () => {
	it("N1: occurrences only inside comments", () => {
		const src = [
			"// const re = new RegExp(`^${x}`);",
			"/* new RegExp(`${y}` + z) */",
			"const safe = 1;",
		].join("\n");
		expect(run(src)).toHaveLength(0);
	});

	it("N2: occurrence inside a string literal", () => {
		const src = "const doc = 'usage: new RegExp(`^${x}`) requires escaping x first';";
		expect(run(src)).toHaveLength(0);
	});

	it("N3: wrong extension (.py) — out of scope", () => {
		const src = "const re = new RegExp(`^${x}`);";
		expect(run(src, "src/util.py")).toHaveLength(0);
	});

	it("N4: test-file path — skipped", () => {
		const src = "const re = new RegExp(`^${x}`);";
		expect(run(src, "src/lib/patterns.test.ts")).toHaveLength(0);
	});

	it("N5: pure string-literal pattern", () => {
		const src = 'const p = new RegExp("^[a-z]+$");';
		expect(run(src)).toHaveLength(0);
	});

	it("N6: identifier argument (any case), including with flags", () => {
		const src = [
			"const re = new RegExp(PATTERN);",
			"const re2 = new RegExp(pat, 'g');",
			"const re3 = new RegExp(DISABLE_DIRECTIVES_RE.source, 'g');",
		].join("\n");
		expect(run(src)).toHaveLength(0);
	});

	it("N7: template with zero substitutions", () => {
		const src = "const t = new RegExp(`^[a-z]+$`);";
		expect(run(src)).toHaveLength(0);
	});

	it("N8: all substitutions CONST_CASE — fragment composition idiom", () => {
		const src = [
			"const re = new RegExp(String.raw`${COERCE_CALLS}[^)]{0,80}\\)`, 'g');",
			"const c = new RegExp(`${HEADER_RE.source}|${FOOTER_RE.source}`);",
		].join("\n");
		expect(run(src)).toHaveLength(0);
	});

	it("N9: every dynamic part routed through an /escape/i call", () => {
		const src = [
			"const a = new RegExp('^' + escapeRegExp(input) + '$');",
			"const b = new RegExp(`${RegExp.escape(query)}`);",
			"const d = new RegExp(`^${myEscape(term)}$`);",
		].join("\n");
		expect(run(src)).toHaveLength(0);
	});

	it("N10: numeric-literal substitution / operand", () => {
		const src = [
			"const n1 = new RegExp(`x{1,${5}}`);",
			"const n2 = new RegExp('a{' + 3 + '}');",
		].join("\n");
		expect(run(src)).toHaveLength(0);
	});

	it("N11: pure-literal concatenation", () => {
		const src = "const l = new RegExp('^' + '[a-z]+' + '$');";
		expect(run(src)).toHaveLength(0);
	});

	it("N12: vendored path and generated-file header", () => {
		const firing = "const re = new RegExp(`^${x}`);";
		expect(run(firing, "node_modules/lib/index.ts")).toHaveLength(0);
		const generated = ["// @generated by codegen", firing].join("\n");
		expect(run(generated)).toHaveLength(0);
	});

	it("N13: two-step escape — identifier assigned from an /escape/i call", () => {
		const src = [
			"function guard(name: string) {",
			"  const n = escapeForRegex(name);",
			"  return new RegExp(`^${n}`);",
			"}",
		].join("\n");
		expect(run(src)).toHaveLength(0);
	});

	it("N14: unterminated string inside a template substitution — malformed, bails", () => {
		const src = ["const re = new RegExp(`${'unterminated", "}`);"].join("\n");
		expect(run(src)).toHaveLength(0);
	});

	it("N15: new RegExp() with no arguments", () => {
		const src = "const re = new RegExp();";
		expect(run(src)).toHaveLength(0);
	});

	it("N16: stray unmatched closing bracket in the argument", () => {
		const src = "const re = new RegExp(x]);";
		expect(run(src)).toHaveLength(0);
	});

	it("N17: argument exceeds the arg-scan budget before closing", () => {
		const src = "new RegExp(" + "x".repeat(1600) + ");";
		expect(run(src)).toHaveLength(0);
	});

	it("N18: template operand with zero substitutions in a concatenation is literal", () => {
		const src = "const re = new RegExp('x' + `plain` + 'y');";
		expect(run(src)).toHaveLength(0);
	});
});

// ─── Regression cases (adversarial review, 2026-07) ──────────────────────────

describe("checkRegexFromInterpolation — adversarial regressions", () => {
	it("R1: escape-assignment prose inside a string literal cannot exempt", () => {
		const src = [
			'const doc = "example: n = myEscape(x) before use";',
			"const re = new RegExp(`^${n}`);",
		].join("\n");
		expect(run(src).map((f) => f.line)).toEqual([2]);
	});

	it("R2: another function's escape assignment cannot exempt a raw parameter", () => {
		const src = [
			"function makeSafe(s) {",
			"  const pat = escapeRegExp(s);",
			"  return pat;",
			"}",
			"export function vulnerable(pat) {",
			"  return new RegExp(`^${pat}`);",
			"}",
		].join("\n");
		expect(run(src).map((f) => f.line)).toEqual([6]);
	});

	it("R3: private class field write (this.#re = ...) is not a comment", () => {
		const src = [
			"class Matcher {",
			"  #re;",
			"  constructor(prefix) {",
			"    this.#re = new RegExp(`^${prefix}`);",
			"  }",
			"}",
		].join("\n");
		expect(run(src, "src/lib/matcher.ts").map((f) => f.line)).toEqual([4]);
	});

	it("R4: private method call earlier on the call line is not a comment", () => {
		const src = [
			"class M {",
			"  build(x) {",
			"    return this.#normalize(x) ? new RegExp(`^${x}`) : null;",
			"  }",
			"}",
		].join("\n");
		expect(run(src, "src/lib/m.ts").map((f) => f.line)).toEqual([3]);
	});

	it("R5: a /* inside a string literal does not open a block comment", () => {
		const src = ['const glob = "/*.ts";', "const re = new RegExp(`^${userPrefix}`);"].join("\n");
		expect(run(src).map((f) => f.line)).toEqual([2]);
	});

	it("R6: a regex literal containing a backtick does not open a template", () => {
		const src = ["const tickRe = /`/;", "const re = new RegExp(`^${prefix}`);"].join("\n");
		expect(run(src).map((f) => f.line)).toEqual([2]);
	});

	it("R7: concat operand containing a quote-bearing regex literal still fires", () => {
		const src = "const re = new RegExp(name.replace(/'/g, '') + tail);";
		const found = run(src);
		expect(found.map((f) => f.line)).toEqual([1]);
		expect(found.map((f) => f.text).join("\n")).toMatch(/concatenation/);
	});

	// NB: "$" is concatenated separately below so this file's own edit payloads
	// never contain dollar-prefixed replacement patterns (dollar-backtick,
	// dollar-ampersand, dollar-quote) that naive String.replace pipelines expand.
	it("R8: reassignment after the escape call cancels the two-step exemption", () => {
		const plain = [
			"function f(userInput: string, seed: string) {",
			"  let n = escapeForRegex(seed);",
			"  n = n + userInput;",
			"  return new RegExp(`^${n}" + "$" + "`);",
			"}",
		].join("\n");
		const compound = plain.replace("n = n + userInput", "n += userInput");
		for (const src of [plain, compound]) {
			expect(run(src, "src/lib/f.ts").map((f) => f.line)).toEqual([4]);
		}
	});

	it("R9: // inside a multi-line template is not a comment", () => {
		const src = [
			"function build(host: string) {",
			"  return new RegExp(`",
			"https://${host}/path",
			"`);",
			"}",
		].join("\n");
		expect(run(src, "src/lib/b.ts").map((f) => f.line)).toEqual([2]);
	});

	it("R10: CONST_CASE exemption has no length cap (61- and 62-char idents)", () => {
		for (const len of [61, 62]) {
			const src = "const re = new RegExp(`^${" + "A".repeat(len) + "}`);";
			expect(run(src)).toHaveLength(0);
		}
	});

	it("R11: a call chained on a template is a call argument — no finding", () => {
		const src = [
			"function esc(userInput: string) {",
			'  return new RegExp(`${userInput}`.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\' + "$" + '&"));',
			"}",
		].join("\n");
		expect(run(src, "src/lib/esc.ts")).toHaveLength(0);
	});

	it("R12: dense single-line files scan in near-linear time", () => {
		const src = "x=new RegExp(p);".repeat(6400); // ~100KB on one line
		const t0 = performance.now();
		expect(run(src, "src/lib/big.ts")).toHaveLength(0);
		// Pre-fix this shape was quadratic (~1.7s at 100KB); post-fix ~10ms.
		expect(performance.now() - t0).toBeLessThan(1500);
	}, 20_000);

	it("R13: unterminated string at EOF (no trailing newline) doesn't blind earlier lines", () => {
		const src = ["const re = new RegExp(`^${x}`);", "const bad = 'unterminated"].join("\n");
		const found = run(src);
		expect(found.map((f) => f.line)).toEqual([1]);
	});

	it("R14: template nesting past the max depth is malformed — no finding", () => {
		function nestedTemplate(depth: number): string {
			if (depth === 6) return "`${x}`";
			return "`${" + nestedTemplate(depth + 1) + "}`";
		}
		const src = "new RegExp(" + nestedTemplate(1) + ");";
		expect(run(src, "src/lib/nest.ts")).toHaveLength(0);
	});

	it("R15: a long unterminated template hits the scan-step budget — no finding", () => {
		const src = "new RegExp(`" + "a".repeat(2600) + ");";
		expect(run(src, "src/lib/budget.ts")).toHaveLength(0);
	});

	it("R16: a short unterminated template runs out at EOF — no finding", () => {
		const src = "new RegExp(`unterminated);";
		expect(run(src, "src/lib/short.ts")).toHaveLength(0);
	});

	it("R17: a long substitution body hits the scan-step budget — no finding", () => {
		const src = "new RegExp(`${" + "a".repeat(2600) + "}`);";
		expect(run(src, "src/lib/subbudget.ts")).toHaveLength(0);
	});

	it("R18: a short unterminated substitution runs out at EOF — no finding", () => {
		const src = "new RegExp(`${short);";
		expect(run(src, "src/lib/subshort.ts")).toHaveLength(0);
	});

	it("R19: a regex literal at the very start of a file still lets later calls fire", () => {
		const src = "/^a/.test(s);\nconst re = new RegExp(`${y}`);";
		const found = run(src, "src/lib/leading-regex.ts");
		expect(found.map((f) => f.line)).toEqual([2]);
	});

	it("R20: a regex literal spanning a newline is unterminated — later calls still fire", () => {
		const src = ["const bad = /abc", "def/;", "const re = new RegExp(`${y}`);"].join("\n");
		const found = run(src, "src/lib/multiline-regex.ts");
		expect(found.map((f) => f.line)).toEqual([3]);
	});

	it("R21: a regex literal unterminated at EOF doesn't blind an earlier call", () => {
		const src = ["new RegExp(`${y}`);", "const r = /abc"].join("\n");
		const found = run(src, "src/lib/eof-regex.ts");
		expect(found.map((f) => f.line)).toEqual([1]);
	});
});

// ─── Mutation-hardening cases (Stryker survivor sweep, 2026-08) ──────────────

const TEMPLATE_MSG_TEXT =
	"RegExp built from a template with unescaped ${...} interpolation — data becomes pattern syntax; " +
	"escape substitutions (RegExp.escape / an escapeRegExp helper) or compose from CONST_CASE fragments";

describe("checkRegexFromInterpolation — mutation-hardening", () => {
	it("R22: an escaped quote inside a string operand of a concatenation still fires", () => {
		const src = 'const re = new RegExp("a\\"" + userInput);';
		const found = run(src);
		expect(found.length).toBe(1);
		expect(found[0]?.text).toMatch(/concatenation/);
	});

	it("R23: a single-quoted string spanning a newline is malformed — no finding", () => {
		const src = ["const re = new RegExp('a", "b' + x);"].join("\n");
		expect(run(src)).toHaveLength(0);
	});

	it("R24: an unterminated single-quoted string at EOF inside the call is malformed — no finding", () => {
		const src = "new RegExp('unterminated";
		expect(run(src)).toHaveLength(0);
	});

	it("R25: two adjacent substitutions in one template are both scanned (no corruption)", () => {
		const src = "const re = new RegExp(`${a}${b}`);";
		const found = run(src);
		expect(found).toEqual([{ line: 1, text: `regex_from_interpolation: ${TEMPLATE_MSG_TEXT} — ${src}` }]);
	});

	it("R26: two adjacent CONST_CASE substitutions do not fire (exemption applies to both)", () => {
		const src = "const re = new RegExp(`${FOO}${BAR}`);";
		expect(run(src)).toHaveLength(0);
	});

	it("R27: an unterminated substitution (missing closing brace) is malformed — no finding", () => {
		const src = "new RegExp(`${a";
		expect(run(src)).toHaveLength(0);
	});

	it("R28: a nested-brace object substitution containing braces is scanned correctly and still fires", () => {
		const src = "const re = new RegExp(`${ {a: {b: 1}} }$`);";
		const found = run(src);
		expect(found.length).toBe(1);
		expect(found[0]?.line).toBe(1);
	});

	it("R29: a char-class containing an escaped bracket doesn't end the class early", () => {
		// The regex literal /[\]]/ has an escaped `]` inside the class; if the
		// escape/in-class bookkeeping were broken this backtick would wrongly
		// look like it opens a template.
		const src = ["const closeClass = /[\\]]/;", "const re = new RegExp(`${z}`);"].join("\n");
		const found = run(src, "src/lib/charclass.ts");
		expect(found.map((f) => f.line)).toEqual([2]);
	});

	it("R30: a regex literal with flags followed by a backtick still lets the template fire", () => {
		const src = ["const withFlags = /abc/gi;", "const re = new RegExp(`${w}`);"].join("\n");
		const found = run(src, "src/lib/flags.ts");
		expect(found.map((f) => f.line)).toEqual([2]);
	});

	it("R31: an uppercase-only flag character is not consumed as a regex flag", () => {
		// /x/G is not a valid flag; skipRegexLiteral's /[a-z]/i flag-scan must
		// still stop correctly so downstream lexing is not thrown off.
		const src = ["const r = /x/;", "const re = new RegExp(`${v}`);"].join("\n");
		const found = run(src, "src/lib/flagcase.ts");
		expect(found.map((f) => f.line)).toEqual([2]);
	});

	it("R32: a `/` immediately after a word character is division, not a regex — a following backtick still opens a template", () => {
		const src = ["const divResult = total / `${count}`;"].join("\n");
		expect(run(src)).toHaveLength(0);
	});

	it("R33: a `/` after skipping only a single space back to a word char is still division", () => {
		const src = "const re = new RegExp(divisor / 2 + tail);";
		const found = run(src);
		expect(found.length).toBe(1);
		expect(found[0]?.text).toMatch(/concatenation/);
	});

	it("R34: a `/` after skipping a run of space+tab+CR back to a word char is still division", () => {
		const src = ["const v = base \t\r/2;", "const re = new RegExp(`${z}`);"].join("\n");
		const found = run(src, "src/lib/wswindow.ts");
		expect(found.map((f) => f.line)).toEqual([2]);
	});

	it("R35: a `/` at the very start of the file (no previous significant char) is a regex literal", () => {
		const src = "/x/.test(s);\nconst re = new RegExp(`${y}`);";
		const found = run(src, "src/lib/leading.ts");
		expect(found.map((f) => f.line)).toEqual([2]);
	});

	it("R36: a `/` preceded only by whitespace back to the start of the file is a regex literal", () => {
		const src = "   /x/.test(s);\nconst re = new RegExp(`${y}`);";
		const found = run(src, "src/lib/leadingws.ts");
		expect(found.map((f) => f.line)).toEqual([2]);
	});

	it("R37: a `/` preceded by `)` is division (closes a call), not a regex literal", () => {
		const src = "const divResult = f() / `${count}`;";
		expect(run(src)).toHaveLength(0);
	});

	it("R38: a single-line `//` comment does not swallow a later real call on the next line", () => {
		const src = ["// see https://example.com/path for details", "const re = new RegExp(`${x}`);"].join(
			"\n",
		);
		const found = run(src, "src/lib/commentline.ts");
		expect(found.map((f) => f.line)).toEqual([2]);
	});

	it("R39: a block comment spanning multiple lines is fully blanked", () => {
		const src = ["/* line one", " * new RegExp(`${x}`)", " */", "const safe = 1;"].join("\n");
		expect(run(src)).toHaveLength(0);
	});

	it("R40: an unterminated block comment blanks to end of file — no finding", () => {
		const src = ["/* never closed", "const re = new RegExp(`${x}`);"].join("\n");
		expect(run(src)).toHaveLength(0);
	});

	it("R41: the arg-scan budget boundary does not let a closing paren just past it terminate early", () => {
		const src = "new RegExp(" + "x".repeat(1499) + ")";
		expect(run(src)).toHaveLength(0);
	});

	it("R42: a stray unmatched `}` in the argument is malformed — no finding", () => {
		const src = "const re = new RegExp(x});";
		expect(run(src)).toHaveLength(0);
	});

	it("R43: `++` is not misread as top-level `+` splitting an operand", () => {
		const src = "const re = new RegExp(x++ + tail);";
		const found = run(src);
		expect(found.length).toBe(1);
		expect(found[0]?.text).toMatch(/concatenation/);
	});

	it("R44: RegExp.escape(x) with no trailing chars after the call is recognized as an escape call", () => {
		const src = "const re = new RegExp(RegExp.escape(x));";
		expect(run(src)).toHaveLength(0);
	});

	it("R45: an identifier that merely CONTAINS 'escape' as a substring but isn't a call does not exempt", () => {
		const src = "const re = new RegExp(`${escapedValue}`);";
		expect(fires(src)).toBe(true);
	});

	it("R46: an assignment lookbehind with a non-`=` compound operator does not exempt (e.g. `n -= x`)", () => {
		const src = [
			"function f(userInput) {",
			"  let n = escapeForRegex(userInput);",
			"  n -= 1;",
			"  return new RegExp(`^${n}`);",
			"}",
		].join("\n");
		expect(run(src, "src/lib/compound.ts").map((f) => f.line)).toEqual([4]);
	});

	it("R47: the escape-assignment lookbehind is scoped to the last top-level `}` — an outer scope's escape call cannot leak in past it", () => {
		const src = [
			"function outer() {",
			"  const n = escapeForRegex(1);",
			"}",
			"function vulnerable(n) {",
			"  return new RegExp(`^${n}`);",
			"}",
		].join("\n");
		expect(run(src, "src/lib/scoped.ts").map((f) => f.line)).toEqual([5]);
	});

	it("R48: a mixed template operand with one exempt and one dynamic sub inside a concatenation still fires as dynamic (not exempt)", () => {
		const src = "const re = new RegExp('^' + `${escapeRegExp(a)}-${b}` + '$');";
		const found = run(src);
		expect(found.length).toBe(1);
		expect(found[0]?.text).toMatch(/concatenation/);
	});

	it("R49: a mixed template operand where every sub is exempt is treated as exempt inside a concatenation", () => {
		const src = "const re = new RegExp('^' + `${escapeRegExp(a)}-${CONST}` + '$');";
		expect(run(src)).toHaveLength(0);
	});

	it("R50: an empty-string double-quoted literal operand is literal, not dynamic", () => {
		const src = 'const re = new RegExp("" + x);';
		const found = run(src);
		expect(found.length).toBe(1);
		expect(found[0]?.text).toMatch(/concatenation/);
	});

	it("R51: an empty-string single-quoted literal operand is literal, not dynamic", () => {
		const src = "const re = new RegExp('' + x);";
		const found = run(src);
		expect(found.length).toBe(1);
		expect(found[0]?.text).toMatch(/concatenation/);
	});

	it("R52: a double-quoted string containing an escaped backslash-quote sequence is read as one literal operand", () => {
		const src = 'const re = new RegExp("a\\\\" + x);';
		const found = run(src);
		expect(found.length).toBe(1);
		expect(found[0]?.text).toMatch(/concatenation/);
	});

	it("R53: an empty-line-blank single operand (whitespace only) yields no finding", () => {
		const src = "const re = new RegExp(   );";
		expect(run(src)).toHaveLength(0);
	});

	it("R54: a line-start `}` at column 0 is required to cut the lookbehind — a `}` mid-line does not cut it early", () => {
		const src = [
			"function outer() {",
			"  if (true) { const n = escapeForRegex(1); }",
			"  return new RegExp(`^${n}`);",
			"}",
		].join("\n");
		// n itself is never reassigned after the escape call, and the mid-line
		// `}` from the if-block must NOT cut the lookbehind window early.
		expect(run(src, "src/lib/midline.ts")).toHaveLength(0);
	});

	it("R55: the reported line for a call spread across many lines matches the `new RegExp(` line exactly, not one off", () => {
		const src = ["", "", "const re = new RegExp(", "  `${tail}`,", ");"].join("\n");
		const found = run(src);
		expect(found[0]?.line).toBe(3);
	});

	it("R56: the reported finding text is truncated at exactly REPORT_LINE_TRUNC (150) characters", () => {
		const pad = "x".repeat(140);
		const src = `const ${pad} = new RegExp(\`\${y}\`);`;
		const found = run(src);
		expect(found.length).toBe(1);
		const reported = found[0]?.text ?? "";
		const rawPart = reported.slice(reported.lastIndexOf(" — ") + 3);
		expect(rawPart.length).toBeLessThanOrEqual(150);
		expect(src.trim().startsWith(rawPart)).toBe(true);
	});

	it("R57: a numeric operand with an underscore separator is exempt, not dynamic", () => {
		const src = "const re = new RegExp('x{' + 1_000 + '}');";
		expect(run(src)).toHaveLength(0);
	});

	it("R58: a decimal numeric substitution is exempt, not dynamic", () => {
		const src = "const re = new RegExp(`x{1,${5.5}}`);";
		expect(run(src)).toHaveLength(0);
	});

	it("R59: a hex numeric substitution is exempt, not dynamic", () => {
		const src = "const re = new RegExp(`\\\\u{${0x1f}}`);";
		expect(run(src)).toHaveLength(0);
	});

	it("R60: a CONST_CASE member chain (two levels) is exempt", () => {
		const src = "const re = new RegExp(`${A.B.SOURCE}`);";
		expect(run(src)).toHaveLength(0);
	});

	it("R61: a lowercase member chain on an otherwise CONST_CASE base is NOT exempt (fires)", () => {
		const src = "const re = new RegExp(`${A.toLowerCase()}`);";
		expect(fires(src)).toBe(true);
	});

	it("R62: whitespace between RegExp and the open paren is still recognized as a call site", () => {
		const src = "const re = new RegExp   (`${x}`);";
		const found = run(src);
		expect(found.length).toBe(1);
	});

	it("R63: a custom-tagged template (not String.raw) is out of scope — no finding", () => {
		const src = "const re = new RegExp(esc`${x}`);";
		expect(run(src)).toHaveLength(0);
	});

	it("R64: String.raw with internal whitespace around the dots is still recognized", () => {
		const src = "const w = new RegExp(String . raw `\\b${name}\\b`);";
		expect(fires(src)).toBe(true);
	});

	it("R65: junk before a double-quoted literal (no operator) is not a clean literal — still fires", () => {
		const src = 'const re = new RegExp(c"ab" + "d");';
		const found = run(src);
		expect(found.length).toBe(1);
	});

	it("R66: a double-quoted literal immediately followed by trailing characters is not a clean literal — still fires", () => {
		const src = 'const re = new RegExp("ab"c + "d");';
		const found = run(src);
		expect(found.length).toBe(1);
	});

	it("R67: a non-CONST-prefixed identifier whose suffix merely resembles a CONST member chain still fires", () => {
		const src = "const re = new RegExp(`${xFOO.bar}`);";
		expect(fires(src)).toBe(true);
	});

	it("R68: a three-level CONST member chain exceeds the exemption's hop limit — still fires", () => {
		const src = "const re = new RegExp(`${FOO.bar.baz.qux}`);";
		expect(fires(src)).toBe(true);
	});

	it("R69: a two-level CONST member chain (at the exemption's hop cap) is exempt — no finding", () => {
		const src = "const re = new RegExp(`${FOO.bar.baz}`);";
		expect(run(src)).toHaveLength(0);
	});

	it("R70: whitespace around member-chain dots doesn't break the CONST_MEMBER exemption", () => {
		const src = "const re = new RegExp(`${FOO . bar}`);";
		expect(run(src)).toHaveLength(0);
	});

	it("R71: a mixed-case identifier ending in uppercase letters is NOT CONST_CASE — still fires", () => {
		const src = "const re = new RegExp(`${xFOO}`);";
		expect(fires(src)).toBe(true);
	});

	it("R72: an identifier with a CONST_CASE prefix but a lowercase suffix is NOT CONST_CASE — still fires", () => {
		const src = "const re = new RegExp(`${FOOx}`);";
		expect(fires(src)).toBe(true);
	});

	it("R73: a multi-digit hex numeric substitution is exempt", () => {
		const src = "const re = new RegExp(`x{${0xFF}}`);";
		expect(run(src)).toHaveLength(0);
	});

	it("R74: a decimal fraction with multiple digits on each side is exempt", () => {
		const src = "const re = new RegExp(`x{${31.415}}`);";
		expect(run(src)).toHaveLength(0);
	});

	it("R75: junk before a single-quoted literal (no operator) is not a clean literal — still fires", () => {
		const src = "const re = new RegExp(c'ab' + 'd');";
		const found = run(src);
		expect(found.length).toBe(1);
	});

	it("R76: a single-quoted literal immediately followed by trailing characters is not a clean literal — still fires", () => {
		const src = "const re = new RegExp('ab'c + 'd');";
		const found = run(src);
		expect(found.length).toBe(1);
	});

	it("R77: a two-character double-quoted literal operand doesn't cause a false fire in an all-literal concatenation", () => {
		const src = 'const re = new RegExp("ab" + "cd");';
		expect(run(src)).toHaveLength(0);
	});

	it("R78: whitespace around the dot in a namespaced escape call is still recognized", () => {
		const src = "const re = new RegExp(`${RegExp . escape ( query )}`);";
		expect(run(src)).toHaveLength(0);
	});

	it("R79: an escape-call-shaped operand with nothing after the closing paren is exempt (isEscapeCall)", () => {
		const src = "const re = new RegExp(escapeRegExp(x));";
		expect(run(src)).toHaveLength(0);
	});

	it("R80: an identifier ending in ')' that is not actually a call is NOT treated as an escape call — still fires", () => {
		// isEscapeCall requires e.endsWith(")"); this operand contains a stray
		// close-paren but has no matching call-head shape.
		const src = "const re = new RegExp(`${escapeFoo)}`);";
		expect(fires(src)).toBe(true);
	});

	it("R81: exactly at the max template-nesting depth still scans and fires (boundary, not off-by-one)", () => {
		function nestedTemplate(depth: number): string {
			if (depth === 5) return "`${x}`";
			return "`${" + nestedTemplate(depth + 1) + "}`";
		}
		const src = "new RegExp(" + nestedTemplate(1) + ");";
		const found = run(src, "src/lib/nest5.ts");
		expect(found.length).toBe(1);
	});

	it("R82: a reassignment lookbehind cut is scoped to a column-0 `}` — a nested block's `}` does not cut it early", () => {
		const src = [
			"function guard(name) {",
			"  const n = escapeForRegex(name);",
			"  if (true) {",
			"    doSomething();",
			"  }",
			"  return new RegExp(`^${n}`);",
			"}",
		].join("\n");
		expect(run(src, "src/lib/nestedblock.ts")).toHaveLength(0);
	});

	it("R83: an identifier longer than 60 chars is still matched by the escape-assignment identifier check", () => {
		const longName = "n".repeat(61);
		const src = [
			`function guard(${longName}) {`,
			`  let m = escapeForRegex(${longName});`,
			`  return new RegExp(\`^\${m}\`);`,
			"}",
		].join("\n");
		expect(run(src, "src/lib/longident.ts")).toHaveLength(0);
	});

	it("R84: two RegExp calls on adjacent lines each get their own correct line number", () => {
		const src = ["const a = new RegExp(`${x}`);", "const b = new RegExp(`${y}`);"].join("\n");
		const found = run(src);
		expect(found.map((f) => f.line)).toEqual([1, 2]);
	});

	it("R85: an identifier containing '$' is correctly escaped when building the assignment lookbehind regex", () => {
		const src = [
			"function guard(input) {",
			"  const n$ = escapeForRegex(input);",
			"  return new RegExp(`^${n$}`);",
			"}",
		].join("\n");
		expect(run(src, "src/lib/dollarident.ts")).toHaveLength(0);
	});

	it("R86: a plain non-call assignment (`n = value;`) does not exempt the identifier", () => {
		const src = ["function f(value) {", "  const n = value;", "  return new RegExp(`^${n}`);", "}"].join(
			"\n",
		);
		expect(run(src, "src/lib/plainassign.ts").map((f) => f.line)).toEqual([3]);
	});

	it("R87: a compound-assignment from an escape call does not exempt (only a plain `=` assignment does)", () => {
		const src = [
			"function f(userInput) {",
			"  let n = 'seed';",
			"  n += escapeForRegex(userInput);",
			"  return new RegExp(`^${n}`);",
			"}",
		].join("\n");
		expect(run(src, "src/lib/compoundescape.ts").map((f) => f.line)).toEqual([4]);
	});

	it("R88: a call site exactly at the start of a line is attributed to that line, not the boundary-adjacent one", () => {
		const src = ["const re =", "RegExp(`${x}`);"].join("\n");
		const found = run(src, "src/lib/linestart.ts");
		expect(found.map((f) => f.line)).toEqual([2]);
	});

	it("R89: a call split across a newline between `new` and `RegExp` reports the correct line", () => {
		const src = ["const re = new", "RegExp(`${x}`);"].join("\n");
		const found = run(src, "src/lib/splitnew.ts");
		expect(found.map((f) => f.line)).toEqual([2]);
	});

	it("R90: the reported raw text is the exact call line, not an adjacent line", () => {
		const src = ["// line zero", "const re = new RegExp(`${x}`);", "// line two"].join("\n");
		const found = run(src, "src/lib/exact.ts");
		expect(found).toEqual([
			{
				line: 2,
				text: `regex_from_interpolation: ${TEMPLATE_MSG_TEXT} — const re = new RegExp(\`\${x}\`);`,
			},
		]);
	});

	it("R91: the reported raw text is trimmed of leading/trailing whitespace", () => {
		const src = "   const re = new RegExp(`${x}`);   ";
		const found = run(src);
		expect(found).toEqual([
			{ line: 1, text: `regex_from_interpolation: ${TEMPLATE_MSG_TEXT} — const re = new RegExp(\`\${x}\`);` },
		]);
	});

	it("R92: a prefix `++` operand is not misread as splitting into two operands", () => {
		const src = "const re = new RegExp(++x + tail);";
		const found = run(src);
		expect(found.length).toBe(1);
		expect(found[0]?.text).toMatch(/concatenation/);
	});

	it("R93: a regex literal with multiple flag characters is fully consumed (flag-scan advances forward, not backward)", () => {
		const src = ["const r = /abc/gimsuy;", "const re = new RegExp(`${x}`);"].join("\n");
		const found = run(src, "src/lib/multiflag.ts");
		expect(found.map((f) => f.line)).toEqual([2]);
	});

	it("R94: a regex literal's flag-scan stops at the first non-letter, not before — a following `.member` access is untouched", () => {
		const src = "const re = new RegExp(/abc/.source + `${x}`);";
		const found = run(src);
		expect(found.length).toBe(1);
		expect(found[0]?.text).toMatch(/concatenation/);
	});

	it("R95: an escaped `]` inside a regex char-class does not end the class early", () => {
		const src = ["const closeClass = /[\\]x]/;", "const re = new RegExp(`${z}`);"].join("\n");
		const found = run(src, "src/lib/charclass2.ts");
		expect(found.map((f) => f.line)).toEqual([2]);
	});

	it("R96: a `[` inside a regex char-class body does not toggle class state off early (nested-bracket safety)", () => {
		const src = ["const r = /[a[b]c]/;", "const re = new RegExp(`${z}`);"].join("\n");
		const found = run(src, "src/lib/nestedbracket.ts");
		expect(found.map((f) => f.line)).toEqual([2]);
	});

	it("R97: a `/` inside a regex char-class is not treated as the closing delimiter", () => {
		const src = ["const r = /[/]/;", "const re = new RegExp(`${z}`);"].join("\n");
		const found = run(src, "src/lib/slashinclass.ts");
		expect(found.map((f) => f.line)).toEqual([2]);
	});
});

// ─── Mutation-hardening round 2 (Stryker survivor sweep, 2026-08) ────────────
//
// Every case below embeds a literal "RegExp(" call INSIDE a regex-literal
// (or comment / bracket) that must stay hidden for correct behavior. A
// mis-parse that ends the containing token early leaks that inner text into
// the stripped view as live code, producing a spurious finding — which is
// exactly what these cases pin against.

describe("checkRegexFromInterpolation — mutation-hardening round 2", () => {
	it("R98: an escaped `/` inside a regex literal is skipped, not read as the closing delimiter", () => {
		const src = "const bad = /a\\/ RegExp(`${y}`)/;";
		expect(run(src)).toHaveLength(0);
	});

	it("R99: a regex literal that bails at a newline lets the swallowed text be re-scanned as real code", () => {
		const src = ["const bad = /abc", "RegExp(`${y}`)xyz/;"].join("\n");
		const found = run(src, "src/lib/nlbail.ts");
		expect(found.map((f) => f.line)).toEqual([2]);
	});

	it("R100: a char class that never exits swallows the rest of the line as regex interior — the real call on line 2 still fires", () => {
		const src = ["const closeClass = /[a/RegExp(`${z}`)]/;", "const re = new RegExp(`${w}`);"].join("\n");
		const found = run(src, "src/lib/neverexit.ts");
		expect(found.map((f) => f.line)).toEqual([2]);
	});

	it("R101: a `/` immediately inside a char class is protected — not mistaken for the closing delimiter", () => {
		const src = "const bad = /[ / RegExp(`${z}`)]/;\nconst safe=1;";
		expect(run(src)).toHaveLength(0);
	});

	it("R102: a char class whose close never registers bails at end of line, exposing nothing extra from a well-formed one", () => {
		const src = "const bad = /[a RegExp(`${z}`) b]c/;";
		expect(run(src)).toHaveLength(0);
	});

	it("R103: a `/` right after `[` is still inside the class — not read as the closing delimiter", () => {
		const src = "const bad = /a[b/ RegExp(`${z}`)]c/;";
		expect(run(src)).toHaveLength(0);
	});

	it("R104: only a genuine `/` closes a regex literal — no other character is mistaken for it", () => {
		const src = "const bad = /abc RegExp(`${z}`) def/;";
		expect(run(src)).toHaveLength(0);
	});

	it("R105: trailing regex flags are letters-only — the flag scan correctly bounds the token so a following call stays hidden", () => {
		const src = "const bad = /x/RegExp(`${z}`);";
		expect(run(src)).toHaveLength(0);
	});

	it("R106: the significant-char backscan checks the char exactly at its window boundary, not one short of it", () => {
		const src = `x${" ".repeat(199)}/RegExp(\`\${z}\`)/;`;
		expect(fires(src)).toBe(true);
	});

	it("R107: a `/` at the very start of a file with nothing before it is a regex literal, not division", () => {
		const src = "/RegExp(`${z}`)/;";
		expect(run(src)).toHaveLength(0);
	});

	it("R108: an unclosed-looking block comment with a later `*/` is bounded there, not swallowed to EOF", () => {
		const src = "/* comment */\nconst re = new RegExp(`${x}`);";
		const found = run(src);
		expect(found.map((f) => f.line)).toEqual([2]);
	});

	it("R109: the escape-lookbehind window is clamped to the file start, not computed as a negative slice offset", () => {
		const prefix = [
			"function guard(userInput) {",
			"  const n = escapeForRegex(userInput);",
			"  return new RegExp(`^${n}`);",
			"}",
			"",
		].join("\n");
		const padding = "// pad ".repeat(400);
		expect(run(prefix + padding, "src/lib/paddedescape.ts")).toHaveLength(0);
	});

	it("R110: the two-step-escape lookbehind is used as-is when no earlier scope boundary exists to cut it", () => {
		const src = "n = escapeForRegex(userInput);\nconst re = new RegExp(`^${n}`);";
		expect(run(src, "src/lib/nocut.ts")).toHaveLength(0);
	});

	it("R111: a `+` inside a nested call's own parens is not a top-level split point of the outer concatenation", () => {
		const src = "const re = new RegExp('^' + escapeRegExp(a + b));";
		expect(run(src)).toHaveLength(0);
	});

	it("R112: an escape-call-shaped prefix that never closes its own parens is not recognized as an escape call", () => {
		const src = "const re = new RegExp(`${escapeFoo(x}`);";
		expect(fires(src)).toBe(true);
	});

	it("R113: argument extraction respects the scan budget even when a real closing paren exists further out", () => {
		const src = `new RegExp('${"x".repeat(1550)}' + \`\${y}\`);`;
		expect(run(src)).toHaveLength(0);
	});

	it("R114: a stray unmatched bracket is caught immediately — later brackets rebalancing the depth counter don't resync the scan", () => {
		const src = "const re = new RegExp(x]( + y));";
		expect(run(src)).toHaveLength(0);
	});

	it("R115: the CONCAT_MSG text is pinned in full, not just matched by a substring", () => {
		const src = "const re = new RegExp('^' + userInput);";
		const found = run(src);
		expect(found).toEqual([
			{
				line: 1,
				text:
					"regex_from_interpolation: RegExp built by string concatenation with unescaped dynamic parts — data becomes pattern syntax; " +
					"escape them (RegExp.escape / an escapeRegExp helper) or compose from CONST_CASE fragments — " +
					src,
			},
		]);
	});

	it("R116: a decimal exponent literal ('5e10') is not a clean numeric match — the anchor requires the whole substitution to be numeric", () => {
		const src = "const re = new RegExp(`x{1,${5e10}}`);";
		expect(fires(src)).toBe(true);
	});

	it("R117: the escape-call head must match from the very start of the operand, not from a match found mid-string", () => {
		const src = "const re = new RegExp('^' + 9escapeFoo(x));";
		expect(fires(src)).toBe(true);
	});
});

// ─── round 3: fleet mutation-kill sweep (2026-08-10) ──────────────────────────

describe("checkRegexFromInterpolation — isEscapeCall endsWith-guard mutation coverage", () => {
	it("RGX-EC1: an escape-call-shaped operand with TRAILING junk after its closing paren is NOT an escape call — still fires", () => {
		// Pins `if (!e.endsWith(")")) return false;` as an actual short-circuit
		// gate, not dead code. `escapeRegExp(x)y` matches CALL_HEAD_RE's callee
		// pattern regardless of trailing text (that regex only anchors at the
		// start), so without the endsWith guard the trailing `y` would be
		// silently ignored and this would be wrongly treated as a clean
		// escape call.
		const src = "const re = new RegExp('^' + escapeRegExp(x)y);";
		const found = run(src);
		expect(found.length).toBe(1);
		expect(found[0]?.text).toMatch(/concatenation/);
	});
});

// ─── round 4: K3 fleet mutation-kill sweep (2026-08-10) ──────────────────────
//
// Targets the survivor set from `mutation survivors --file regex-interpolation.ts`
// (79 open). Each case below was validated by differential mutant application
// (candidate mutant patched into a scratch copy, both variants run against the
// input, output compared) before landing, so these are not guesses.

describe("checkRegexFromInterpolation — K3 fleet sweep: splitTopLevelPlus ++ guards", () => {
	it("K3-1: `x++y` (double-plus, no legal split point) produces no finding", () => {
		// Baseline for the next two cases: neither `+` in `x++y` is a valid
		// split point (each is either immediately preceded or followed by the
		// other `+`), so the whole thing stays one unsplit, non-template blob.
		expect(run("const re = new RegExp(x++y);")).toHaveLength(0);
	});

	it("K3-2: disabling the next-char-is-`+` guard would wrongly split `x++y` and fire — pinned via the correct (unsplit) outcome", () => {
		// Kills: ConditionalExpression `arg.charAt(j+1)!=="+"`→true, MethodExpression
		// `arg.charAt(j+1)`→arg, ArithmeticOperator `j+1`→`j-1`, StringLiteral
		// `"+"`→"" (all four next-side guard mutants collapse to the same wrong
		// split of x++y into ["x","+y"], which DOES fire as concatenation).
		const found = run("const re = new RegExp(x++y);");
		expect(found).toHaveLength(0);
	});

	it("K3-3: disabling the prev-char-is-`+` guard would wrongly split `x++y` and fire — pinned via the correct (unsplit) outcome", () => {
		// Kills the four prev-side guard mutants (ConditionalExpression,
		// MethodExpression, ArithmeticOperator, StringLiteral) the same way,
		// via the second `+` in x++y instead of the first.
		const found = run("const re = new RegExp(x++y);");
		expect(found).toHaveLength(0);
	});
});

describe("checkRegexFromInterpolation — K3 fleet sweep: budget boundaries (exposure construction)", () => {
	// A giant filler template that legitimately exceeds SCAN_STEP_BUDGET should
	// FAIL to parse as one token; that failure exposes an embedded
	// `RegExp(`${zzz}`)` snippet as ordinary re-lexed code, which fires. If a
	// mutant disables/weakens the budget check, the giant filler instead
	// parses as ONE (successful) template whose first stray backtick "closes"
	// it — swallowing the embedded call as inert content, so it does NOT fire.
	// This makes the budget check's effect on TOTALLY UNRELATED code
	// observable, closing the gap plain long/short inputs can't reach.
	function exposureCase(fillerLen: number): string {
		return "const junk = `" + "F".repeat(fillerLen) + "new RegExp(`${zzz}`)" + "`;";
	}

	it("K3-4: a filler well past SCAN_STEP_BUDGET (2500 chars) in scanTemplate's own walk still exposes the embedded call — budget fires", () => {
		const found = run(exposureCase(2500));
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toMatch(/template/);
	});

	it("K3-5: exactly at the scanTemplate budget boundary (1989 vs 1990 chars) flips from swallowed to exposed", () => {
		// 1989 F's: scanTemplate's own budget has NOT tripped yet, so it
		// successfully (mis)parses the giant filler as one token and swallows
		// the embedded call. One character more (1990) trips the budget.
		expect(run(exposureCase(1989))).toHaveLength(0);
		expect(run(exposureCase(1990))).toHaveLength(1);
	});

	it("K3-6: a filler well past SCAN_STEP_BUDGET inside a `${...}` substitution body still exposes a call embedded right after it", () => {
		const src = "const junk = `${" + "F".repeat(2500) + "}new RegExp(`${w}`)" + "`;";
		const found = run(src);
		expect(found).toHaveLength(1);
	});

	it("K3-7: exactly at the scanSubstitution budget boundary (2000 vs 2001 chars) flips from swallowed to exposed", () => {
		const build = (n: number) => "const junk = `${" + "F".repeat(n) + "}new RegExp(`${w}`)" + "`;";
		expect(run(build(2000))).toHaveLength(0);
		expect(run(build(2001))).toHaveLength(1);
	});
});

describe("checkRegexFromInterpolation — K3 fleet sweep: nested-brace and escape edge cases", () => {
	it("K3-8: an escape call whose argument contains a nested `{...}` object literal is still recognized as exempt (brace depth tracked correctly)", () => {
		// If brace-open tracking inside scanSubstitution is disabled/weakened,
		// the FIRST (nested) "}" is wrongly read as the substitution's own
		// close, truncating the captured text to "escapeFoo({x" — which no
		// longer ends in ")" and so is no longer recognized as an escape call,
		// and fires instead of staying exempt.
		const src = "const re = new RegExp(`${escapeFoo({x})}`);";
		expect(run(src)).toHaveLength(0);
	});

	it("K3-9: an escaped dollar sign right before what would be a substitution prevents it from being recognized as one", () => {
		// `\$` inside a template escapes the dollar (same as real JS), so
		// `${x}` here is literal text, not a live substitution — zero subs,
		// no finding. If backslash-escape handling in scanTemplate is
		// disabled, the `$` would instead be read as starting `${x}`.
		const src = "const re = new RegExp(`\\${x}`);";
		expect(run(src)).toHaveLength(0);
	});
});

describe("checkRegexFromInterpolation — K3 fleet sweep: prevSignificantChar window and whitespace class", () => {
	const tail = "/ RegExp(`${z}`) /;";

	it("K3-10: a `/` more than PREV_SIG_WINDOW (200 chars) past its nearest significant char reads as having NO prior context — treated as a regex literal, which fails to close and swallows the embedded call, so this does not fire", () => {
		// If the window were unbounded, the scan would reach back to `)` and
		// correctly read it as division instead — exposing the embedded call.
		const src = "const divResult = f()" + " ".repeat(205) + tail;
		const found = run(src);
		expect(found).toHaveLength(0);
	});

	it("K3-11: a tab between `)` and `/` is correctly skipped as whitespace — the `/` reads back to `)` (division), exposing the embedded call, so this fires", () => {
		const src = "const divResult = f()\t" + tail;
		expect(run(src)).toHaveLength(1);
	});

	it("K3-12: a newline between `)` and `/` is correctly skipped as whitespace — division, not a regex literal, so this fires", () => {
		const src = "const divResult = f()\n" + tail;
		expect(run(src)).toHaveLength(1);
	});

	it("K3-13: a carriage return between `)` and `/` is correctly skipped as whitespace — division, not a regex literal, so this fires", () => {
		const src = "const divResult = f()\r" + tail;
		expect(run(src)).toHaveLength(1);
	});
});

describe("checkRegexFromInterpolation — K3 fleet sweep: skipRegexLiteral bail propagation", () => {
	it("K3-14: an unterminated regex literal (newline before any closing `/`) at the very start of the file still lets a later real call fire", () => {
		// Regression-shaped like R19-R21, but specifically pins the newline-bail
		// `return -1` at file position 0 — the one spot where stringLikeEnd's
		// `end > i` guard can't absorb a corrupted (wrong-sign) return value,
		// since i=0 there.
		const src = "/abc\ndef new RegExp(`${w}`) more/;\nconst tail = 1;";
		const found = run(src);
		expect(found.map((f) => f.line)).toEqual([2]);
	});
});

describe("checkRegexFromInterpolation — K3 fleet sweep: numeric substitution with incidental whitespace", () => {
	it("K3-15: a numeric substitution with surrounding whitespace (`${ 3 }`) is still exempt, not dynamic", () => {
		// isExemptDynamicPart trims its input before the numeric-literal test;
		// substitution text from a template is NOT pre-trimmed by its caller,
		// so this specifically exercises that internal trim (not a redundant
		// one done by the caller already).
		const src = "const re = new RegExp(`x{1,${ 3 }}`);";
		expect(run(src)).toHaveLength(0);
	});
});
