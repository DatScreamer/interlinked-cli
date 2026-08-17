// Missing-return-type detector tests (checkMissingReturnTypes).
//
// The detector flags EXPORTED functions in .ts/.tsx that lack an explicit
// return-type annotation. It has three syntactic patterns and a handful of
// early-exit gates. Cases below drive every branch with behavioral asserts
// on the returned InlineMatch[] (line numbers + text), not import-only
// padding.
//
// Three syntactic patterns are exercised, each described in its own
// describe-block below (plain exported functions, exported arrow consts,
// and exported consts bound to function expressions). Gates exercised:
// non-TS ext, .d.ts, test-file path, and the 20-match cap.

import { describe, expect, it } from "vitest";
import { checkMissingReturnTypes } from "../return-types.js";
import type { InlineMatch } from "../shared.js";

const TS = "src/lib/widget.ts";
const TSX = "src/lib/widget.tsx";

function lines(matches: InlineMatch[]): number[] {
	return matches.map((m) => m.line);
}

// ===========================================
// Early-exit gates
// ===========================================

describe("checkMissingReturnTypes — gates", () => {
	it("returns [] for non-TS extensions even with an obviously-untyped export", () => {
		const code = "export function go(a) { return a; }";
		expect(checkMissingReturnTypes(code, "src/lib/widget.js")).toEqual([]);
		expect(checkMissingReturnTypes(code, "src/lib/widget.jsx")).toEqual([]);
		expect(checkMissingReturnTypes(code, "src/lib/widget.mjs")).toEqual([]);
		// No extension at all.
		expect(checkMissingReturnTypes(code, "Makefile")).toEqual([]);
	});

	it("returns [] for .d.ts declaration files", () => {
		const code = "export function declared(a: number) { return a; }";
		expect(checkMissingReturnTypes(code, "src/types/widget.d.ts")).toEqual([]);
	});

	it("returns [] for test files (path-based detection)", () => {
		const code = "export function helper(a: number) { return a; }";
		expect(checkMissingReturnTypes(code, "src/lib/widget.test.ts")).toEqual([]);
		expect(checkMissingReturnTypes(code, "src/lib/widget.spec.ts")).toEqual([]);
		expect(checkMissingReturnTypes(code, "src/__tests__/widget.ts")).toEqual([]);
	});

	it("processes .tsx like .ts", () => {
		const code = "export function render(a: number) { return a; }";
		const matches = checkMissingReturnTypes(code, TSX);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(1);
	});
});

// ===========================================
// Pattern 1: export [async] function name(...)
// ===========================================

describe("checkMissingReturnTypes — Pattern 1 (export function)", () => {
	it("flags an exported function with no return type", () => {
		const code = "export function add(a: number, b: number) { return a + b; }";
		const matches = checkMissingReturnTypes(code, TS);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.line).toBe(1);
		expect(matches[0]?.text).toBe("export function add(a: number, b: number) { return a + b; }");
	});

	it("flags an exported async function with no return type", () => {
		const code = "export async function load(id: string) { return id; }";
		const matches = checkMissingReturnTypes(code, TS);
		expect(lines(matches)).toEqual([1]);
		expect(matches[0]?.text).toContain("export async function load");
	});

	it("does NOT flag an exported function WITH a return type", () => {
		const code = "export function add(a: number, b: number): number { return a + b; }";
		expect(checkMissingReturnTypes(code, TS)).toEqual([]);
	});

	it("does NOT flag an exported async function with a Promise return type", () => {
		const code = "export async function load(id: string): Promise<string> { return id; }";
		expect(checkMissingReturnTypes(code, TS)).toEqual([]);
	});

	it("does NOT flag a NON-exported function", () => {
		const code = "function internal(a: number) { return a; }";
		expect(checkMissingReturnTypes(code, TS)).toEqual([]);
	});

	it("flags a generic exported function with no return type", () => {
		const code = "export function identity<T>(x: T) { return x; }";
		const matches = checkMissingReturnTypes(code, TS);
		expect(lines(matches)).toEqual([1]);
	});

	it("handles repeated signature whitespace and multi-character generics", () => {
		const code = [
			"  export  function spaced  (x: number) { return x; }",
			"export async  function asyncSpaced(x: number) { return x; }",
			"export function  keywordSpaced(x: number) { return x; }",
			"export function generic<LongType>(x: LongType) { return x; }",
		].join("\n");
		expect(lines(checkMissingReturnTypes(code, TS))).toEqual([1, 2, 3, 4]);
	});

	it("requires an export-function declaration at the start of the line", () => {
		const code = 'const source = "export function fake(x: number) { return x; }";';
		expect(checkMissingReturnTypes(code, TS)).toEqual([]);
	});

	// test-contract: boundary — only an export-function declaration at the line boundary may produce a public finding
	it("does not treat an export-function fragment after executable code as a declaration", () => {
		const code = "if (enabled) export function fake(x: number) { return x; }";
		expect(checkMissingReturnTypes(code, TS)).toEqual([]);
	});

	// test-contract: boundary — malformed punctuation between an exported function name and its parameters is not a finding
	it("does not accept punctuation as part of an exported function name", () => {
		const code = "export function fake-name(x: number) { return x; }";
		expect(checkMissingReturnTypes(code, TS)).toEqual([]);
	});

	it("does NOT flag a generic exported function WITH a return type", () => {
		const code = "export function identity<T>(x: T): T { return x; }";
		expect(checkMissingReturnTypes(code, TS)).toEqual([]);
	});

	it("flags a multi-line exported function signature with no return type", () => {
		const code = [
			"export function combine(",
			"  a: number,",
			"  b: number,",
			") {",
			"  return a + b;",
			"}",
		].join("\n");
		const matches = checkMissingReturnTypes(code, TS);
		expect(lines(matches)).toEqual([1]);
		// Text comes from the FIRST line of the signature.
		expect(matches[0]?.text).toBe("export function combine(");
	});

	it("does NOT flag a multi-line exported function signature WITH a return type", () => {
		const code = [
			"export function combine(",
			"  a: number,",
			"  b: number,",
			"): number {",
			"  return a + b;",
			"}",
		].join("\n");
		expect(checkMissingReturnTypes(code, TS)).toEqual([]);
	});

	it("does NOT crash and does not flag when signature has no opening brace (afterParen null)", () => {
		// An exported `function` declaration with no body brace within the
		// 20-line collection window — afterParen regex (needs `... ) ... {`)
		// fails to match, so no push happens.
		const filler = Array.from({ length: 25 }, (_, i) => `// pad ${i}`);
		const code = ["export function neverOpens(a: number)", ...filler].join("\n");
		expect(checkMissingReturnTypes(code, TS)).toEqual([]);
	});

	it("flags only the `: ` empty-annotation degenerate case", () => {
		// `): ` with nothing before the `{` — returnAnnotation trims to ":" so
		// it is treated as missing.
		const code = "export function weird(a: number):  { return a; }";
		const matches = checkMissingReturnTypes(code, TS);
		expect(lines(matches)).toEqual([1]);
	});

	it("trims and truncates the finding text to 150 characters", () => {
		const code = `  export function ${"longName".repeat(30)}(a: number) { return a; }`;
		const matches = checkMissingReturnTypes(code, TS);
		expect(matches[0]?.text).toBe(code.trim().slice(0, 150));
	});

	it("handles multiple spaces before the opening brace", () => {
		const code = "export function spaced(a: number):   { return a; }";
		expect(lines(checkMissingReturnTypes(code, TS))).toEqual([1]);
	});

	// test-contract: boundary — a directly adjacent opening brace still closes an unannotated exported signature and must be reported
	it("flags an unannotated function when its opening brace touches the closing paren", () => {
		const code = "export function compact(a: number){ return a; }";
		expect(lines(checkMissingReturnTypes(code, TS))).toEqual([1]);
	});

	// test-contract: boundary — unrelated non-whitespace text between parameters and a brace is not mistaken for a return annotation
	it("ignores a malformed function signature with text between the paren and brace", () => {
		const code = "export function malformed(a: number)junk{ return a; }";
		expect(checkMissingReturnTypes(code, TS)).toEqual([]);
	});
});

// ===========================================
// Pattern 2: export const name = (...) => (arrow)
// ===========================================

describe("checkMissingReturnTypes — Pattern 2 (arrow const)", () => {
	it("flags an arrow const with no return type", () => {
		const code = "export const double = (n: number) => n * 2;";
		const matches = checkMissingReturnTypes(code, TS);
		expect(lines(matches)).toEqual([1]);
		expect(matches[0]?.text).toBe("export const double = (n: number) => n * 2;");
	});

	it("flags an async arrow const with no return type", () => {
		const code = "export const fetchIt = async (u: string) => u;";
		const matches = checkMissingReturnTypes(code, TS);
		expect(lines(matches)).toEqual([1]);
	});

	it("does NOT flag an arrow const with a return type after the params", () => {
		const code = "export const double = (n: number): number => n * 2;";
		expect(checkMissingReturnTypes(code, TS)).toEqual([]);
	});

	it("does NOT flag an arrow const with a type annotation on the binding itself", () => {
		// A binding-typed const never even enters Pattern 2: the pattern's
		// entry guard requires `export const <name> =` (an `=` right after the
		// name), but here the name is followed by `:`. So the const is silently
		// not-flagged via the entry-guard miss, not via the (unreachable)
		// `if (constTypeMatch) continue` at line 68. Either way: no finding.
		const code = "export const double: (n: number) => number = (n) => n * 2;";
		expect(checkMissingReturnTypes(code, TS)).toEqual([]);
	});

	it("does NOT flag a non-arrow exported const (plain value)", () => {
		// `export const x = 5;` matches the `export const \w+ =` test but the
		// signature has no `=>`, so Pattern 2's second guard fails — no flag.
		const code = "export const answer = 42;";
		expect(checkMissingReturnTypes(code, TS)).toEqual([]);
	});

	it("flags a multi-line arrow const with no return type", () => {
		const code = [
			"export const combine = (",
			"  a: number,",
			"  b: number,",
			") => a + b;",
		].join("\n");
		const matches = checkMissingReturnTypes(code, TS);
		expect(lines(matches)).toEqual([1]);
		expect(matches[0]?.text).toBe("export const combine = (");
	});

	it("does NOT flag a multi-line arrow const WITH a return type after params", () => {
		const code = [
			"export const combine = (",
			"  a: number,",
			"  b: number,",
			"): number => a + b;",
		].join("\n");
		expect(checkMissingReturnTypes(code, TS)).toEqual([]);
	});

	it("handles repeated declaration whitespace and an arrow with no following space", () => {
		const code = [
			"  export  const spaced  = (n: number) => n * 2;",
			"export const compact = (n: number)=>n * 2;",
		].join("\n");
		expect(lines(checkMissingReturnTypes(code, TS))).toEqual([1, 2]);
	});

	it("recognizes return annotations with spacing variations and long types", () => {
		const code = [
			"export const gap = (n: number) : number => n;",
			"export const noSpace = (n: number):number=>n;",
			"export const promise = (n: number): Promise<number> => n;",
		].join("\n");
		expect(checkMissingReturnTypes(code, TS)).toEqual([]);
	});

	// test-contract: boundary — only an export-const declaration at the line boundary may produce an arrow finding
	it("does not treat an export-const arrow fragment after executable code as a declaration", () => {
		const code = "if (enabled) export const fake = (n: number) => n;";
		expect(checkMissingReturnTypes(code, TS)).toEqual([]);
	});

	it("requires an export-const declaration at the start of the line", () => {
		const code = 'const source = "export const fake = (n: number) => n;";';
		expect(checkMissingReturnTypes(code, TS)).toEqual([]);
	});

	it("trims and truncates arrow finding text", () => {
		const code = `  export const ${"longName".repeat(30)} = (a: number) => a;`;
		const matches = checkMissingReturnTypes(code, TS);
		expect(matches[0]?.text).toBe(code.trim().slice(0, 150));
	});
});

// ===========================================
// Pattern 3: export const name = function name(
// ===========================================

describe("checkMissingReturnTypes — Pattern 3 (const = function expr)", () => {
	it("flags an exported const bound to a function expression with no return type", () => {
		const code = "export const run = function (a: number) { return a; };";
		const matches = checkMissingReturnTypes(code, TS);
		expect(lines(matches)).toEqual([1]);
		expect(matches[0]?.text).toContain("export const run = function");
	});

	it("flags an exported const bound to a NAMED function expression, no return type", () => {
		const code = "export const run = function runImpl(a: number) { return a; };";
		const matches = checkMissingReturnTypes(code, TS);
		expect(lines(matches)).toEqual([1]);
	});

	it("flags an exported const bound to an async function expression, no return type", () => {
		const code = "export const run = async function (a: number) { return a; };";
		const matches = checkMissingReturnTypes(code, TS);
		expect(lines(matches)).toEqual([1]);
	});

	it("does NOT flag a function-expression const WITH a return type", () => {
		const code = "export const run = function (a: number): number { return a; };";
		expect(checkMissingReturnTypes(code, TS)).toEqual([]);
	});

	it("does NOT flag a function-expression const with a type annotation on the binding", () => {
		// Like the Pattern-2 binding-typed case: Pattern 3's entry guard
		// (`export const <name> = ... function`) requires `=` right after the
		// name, so a `name:` binding never enters the block. The `if
		// (constTypeMatch) continue` at line 89 is therefore unreachable; the
		// not-flagged behavior comes from the entry-guard miss.
		const code = "export const run: (a: number) => number = function (a) { return a; };";
		expect(checkMissingReturnTypes(code, TS)).toEqual([]);
	});

	it("does not push when the function-expression signature never opens a brace (afterParen null)", () => {
		// No `{` within the collection window after the params — afterParen is
		// null so Pattern 3 falls through without a push.
		const filler = Array.from({ length: 25 }, (_, i) => `const pad${i} = ${i};`);
		const code = ["export const run = function (a: number)", ...filler].join("\n");
		expect(checkMissingReturnTypes(code, TS)).toEqual([]);
	});

	it("flags the empty-annotation `): ` degenerate case for a function expression", () => {
		const code = "export const run = function (a: number):  { return a; };";
		const matches = checkMissingReturnTypes(code, TS);
		expect(lines(matches)).toEqual([1]);
	});

	it("handles repeated declaration and function-expression whitespace", () => {
		const code = [
			"  export  const run  = async  function  named (a: number) { return a; };",
			"export const other = function  (a: number) { return a; };",
		].join("\n");
		expect(lines(checkMissingReturnTypes(code, TS))).toEqual([1, 2]);
	});

	it("requires an export-const function expression at the start of the line", () => {
		const code = 'const source = "export const fake = function (a: number) { return a; }";';
		expect(checkMissingReturnTypes(code, TS)).toEqual([]);
	});

	// test-contract: boundary — only an export-const function expression at the line boundary may produce a finding
	it("does not treat an export-const function fragment after executable code as a declaration", () => {
		const code = "if (enabled) export const fake = function (a: number) { return a; };";
		expect(checkMissingReturnTypes(code, TS)).toEqual([]);
	});

	// test-contract: boundary — punctuation immediately after the function keyword is not a valid exported function expression
	it("does not accept punctuation as a function-expression delimiter", () => {
		const code = "export const fake = function!(a: number) { return a; };";
		expect(checkMissingReturnTypes(code, TS)).toEqual([]);
	});

	it("trims and truncates function-expression finding text", () => {
		const code = `  export const ${"longName".repeat(30)} = function (a: number) { return a; };`;
		const matches = checkMissingReturnTypes(code, TS);
		expect(matches[0]?.text).toBe(code.trim().slice(0, 150));
	});
});

// ===========================================
// Cross-cutting behavior
// ===========================================

describe("checkMissingReturnTypes — aggregate behavior", () => {
	it("collects multiple findings across patterns with correct line numbers", () => {
		const code = [
			"export function a(x: number) { return x; }", // line 1 — flag (P1)
			"export function b(x: number): number { return x; }", // line 2 — ok
			"export const c = (x: number) => x;", // line 3 — flag (P2)
			"const d = (x: number) => x;", // line 4 — not exported
			"export const e = function (x: number) { return x; };", // line 5 — flag (P3)
		].join("\n");
		const matches = checkMissingReturnTypes(code, TS);
		expect(lines(matches)).toEqual([1, 3, 5]);
	});

	it("returns [] for an empty file", () => {
		expect(checkMissingReturnTypes("", TS)).toEqual([]);
	});

	it("ignores return-type-looking text inside comments (comments are stripped)", () => {
		// The export here HAS a real return type; the commented-out untyped
		// export must not produce a finding because comments are stripped first.
		const code = [
			"// export function ghost(a: number) { return a; }",
			"export function real(a: number): number { return a; }",
		].join("\n");
		expect(checkMissingReturnTypes(code, TS)).toEqual([]);
	});

	it("caps output at 20 findings even when more untyped exports exist", () => {
		// 25 untyped exported functions — the loop breaks once matches hits 20.
		const code = Array.from(
			{ length: 25 },
			(_, i) => `export function fn${i}(a: number) { return a; }`,
		).join("\n");
		const matches = checkMissingReturnTypes(code, TS);
		expect(matches).toHaveLength(20);
		// First 20 lines (1..20) are the ones captured; the break is at the
		// TOP of the loop so iteration 21 (index 20) never runs.
		expect(matches[0]?.line).toBe(1);
		expect(matches[19]?.line).toBe(20);
	});
});
