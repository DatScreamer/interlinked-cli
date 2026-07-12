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
});
