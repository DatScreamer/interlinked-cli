import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { checkFunctionComplexity } from "./complexity.js";

// Behavioral tests for the function-complexity detector.
//
// `checkFunctionComplexity(content, filePath)` returns InlineMatch[] describing
// functions whose shape exceeds one of three thresholds:
//   - 6+ parameters                -> "[N parameters] ..."
//   - nesting depth 5+ (relative)  -> "[nesting depth N] ..."
//   - 15+ branch statements        -> "[N branches — high complexity] ..."
// Test files are exempt. Language is chosen by file extension.

// ---------------------------------------------------------------------------
// Helpers for synthesizing fixtures at exact thresholds (no real model names).
// ---------------------------------------------------------------------------

/** A TS function declaration with exactly `n` parameters (p0..p(n-1): number). */
function tsFnWithParams(n: number): string {
	const params = Array.from({ length: n }, (_, k) => `p${k}: number`).join(", ");
	return `export function vendorModelV6(${params}) {\n\treturn 0;\n}\n`;
}

/** A TS function whose body nests `depth` levels of `if` blocks. */
function tsFnNested(depth: number): string {
	let body = "";
	for (let d = 0; d < depth; d++) {
		body += `${"\t".repeat(d + 1)}if (x > ${d}) {\n`;
	}
	body += `${"\t".repeat(depth + 1)}return x;\n`;
	for (let d = depth - 1; d >= 0; d--) {
		body += `${"\t".repeat(d + 1)}}\n`;
	}
	return `function deeplyNested(x: number) {\n${body}}\n`;
}

/** A TS function with exactly `n` top-level sibling `if` statements. */
function tsFnBranches(n: number): string {
	let body = "";
	for (let k = 0; k < n; k++) {
		body += `\tif (x === ${k}) return ${k};\n`;
	}
	body += "\treturn -1;\n";
	return `function manyBranches(x: number) {\n${body}}\n`;
}

describe("checkFunctionComplexity — file gating", () => {
	it("returns [] for a test file even when the body is clearly complex", () => {
		// Path matches the test-file detector; the content would otherwise fire.
		const out = checkFunctionComplexity(tsFnWithParams(8), "src/foo.test.ts");
		expect(out).toEqual([]);
	});

	it("returns [] for an unrecognized extension (no analyzer dispatched)", () => {
		// .md is none of the brace/python/swift families -> falls through.
		const out = checkFunctionComplexity(tsFnWithParams(8), "docs/notes.md");
		expect(out).toEqual([]);
	});

	it("returns [] when content has no function declarations at all", () => {
		const out = checkFunctionComplexity(
			"const a = 1;\nconst b = 2;\nconsole.log(a + b);\n",
			"src/plain.ts",
		);
		expect(out).toEqual([]);
	});
});

describe("checkFunctionComplexity — parameter overflow (brace languages)", () => {
	it("flags a function with exactly 6 parameters (threshold boundary)", () => {
		const out = checkFunctionComplexity(tsFnWithParams(6), "src/a.ts");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(1);
		expect(nonNull(out[0]).text).toContain("[6 parameters]");
		expect(nonNull(out[0]).text).toContain("vendorModelV6");
	});

	it("does NOT flag a function with 5 parameters (just below threshold)", () => {
		const out = checkFunctionComplexity(tsFnWithParams(5), "src/a.ts");
		expect(out).toEqual([]);
	});

	it("does NOT flag a zero-parameter function (empty param string short-circuits)", () => {
		const out = checkFunctionComplexity("function noArgs() {\n\treturn 1;\n}\n", "src/a.ts");
		expect(out).toEqual([]);
	});

	it("counts top-level params only — nested generics/objects don't inflate the count", () => {
		// 5 visible top-level params, but several carry nested <,> and {,} commas.
		// If nesting weren't respected, the inner commas would push it to >=6.
		const sig =
			"export function withGenerics(" +
			"a: Map<string, number>, " +
			"b: Record<string, { x: number; y: number }>, " +
			"c: Array<[number, number]>, " +
			"d: number, " +
			"e: number" +
			") {\n\treturn 0;\n}\n";
		const out = checkFunctionComplexity(sig, "src/a.ts");
		// Exactly 5 top-level params -> below threshold -> no finding.
		expect(out).toEqual([]);
	});

	it("counts a 6th top-level param even when earlier params nest commas", () => {
		const sig =
			"export function sixWithGenerics(" +
			"a: Map<string, number>, " + // nested comma must not count
			"b: number, c: number, d: number, e: number, f: number" +
			") {\n\treturn 0;\n}\n";
		const out = checkFunctionComplexity(sig, "src/a.ts");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("[6 parameters]");
	});

	it("flags an arrow-assigned const with 6 params via the const pattern", () => {
		const sig = "const handler = (a, b, c, d, e, f) => {\n\treturn a;\n};\n";
		const out = checkFunctionComplexity(sig, "src/a.ts");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("[6 parameters]");
		expect(nonNull(out[0]).text).toContain("handler");
	});

	it("does not crash and returns no finding when the signature has no parens to collect", () => {
		// Matches the const-arrow regex shape loosely but collectFunctionSignature
		// yields no (...) group on the immediate line -> braceParamOverflow null,
		// and there is no body brace either.
		const out = checkFunctionComplexity("const x = y;\n", "src/a.ts");
		expect(out).toEqual([]);
	});

	it("returns no finding when a matched func head has an unclosed parameter paren", () => {
		// `const f = (a =>` matches the const-arrow head (so a func name IS
		// recognized) but the collected signature stops at `=>` with no closing
		// `)`, so the param regex fails to match -> braceParamOverflow returns
		// null. A malformed / mid-stream edit must degrade quietly, not throw.
		const src = "const f = (a =>\n";
		const out = checkFunctionComplexity(src, "src/a.ts");
		expect(out).toEqual([]);
	});
});

describe("checkFunctionComplexity — nesting depth (brace languages)", () => {
	it("flags nesting depth 5 (relative to the function brace)", () => {
		// 5 nested `if` blocks inside the function body -> relative depth 5.
		const out = checkFunctionComplexity(tsFnNested(5), "src/a.ts");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("[nesting depth 5]");
		expect(nonNull(out[0]).text).toContain("deeplyNested");
	});

	it("does NOT flag nesting depth 4 (just below threshold)", () => {
		const out = checkFunctionComplexity(tsFnNested(4), "src/a.ts");
		expect(out).toEqual([]);
	});

	it("ignores braces that live inside string literals (stripping prevents FP)", () => {
		// A single shallow function whose strings are full of { and } chars.
		// Without stripForBraceScan these would inflate depth past threshold.
		const src =
			"function withStrings(x: number) {\n" +
			'\tconst a = "{{{{{{ open braces in a string }}}}}}";\n' +
			'\tconst b = "more { { { { { { braces";\n' +
			"\treturn x;\n" +
			"}\n";
		const out = checkFunctionComplexity(src, "src/a.ts");
		expect(out).toEqual([]);
	});
});

describe("checkFunctionComplexity — branch count (brace languages)", () => {
	it("flags 15 sibling if-statements as high complexity", () => {
		const out = checkFunctionComplexity(tsFnBranches(15), "src/a.ts");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("branches — high complexity");
		expect(nonNull(out[0]).text).toContain("[15 branches");
	});

	it("does NOT flag 14 sibling if-statements (below the 15 threshold)", () => {
		const out = checkFunctionComplexity(tsFnBranches(14), "src/a.ts");
		expect(out).toEqual([]);
	});

	it("counts ternary operators toward the branch total", () => {
		// 15 ternaries on distinct lines, shallow nesting -> branch finding.
		let body = "";
		for (let k = 0; k < 15; k++) {
			body += `\tconst v${k} = x ? ${k} : -${k};\n`;
		}
		const src = `function ternaryHeavy(x: number) {\n${body}\treturn x;\n}\n`;
		const out = checkFunctionComplexity(src, "src/a.ts");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("branches — high complexity");
	});

	it("counts `else if` lines toward the branch total", () => {
		// Build an if / else-if chain of 15 conditions, kept flat (depth 1).
		let body = "\tif (x === 0) return 0;\n";
		for (let k = 1; k < 15; k++) {
			body += `\telse if (x === ${k}) return ${k};\n`;
		}
		body += "\treturn -1;\n";
		const src = `function elseIfChain(x: number) {\n${body}}\n`;
		const out = checkFunctionComplexity(src, "src/a.ts");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("branches — high complexity");
	});

	it("does NOT count case labels in a flat switch (depth < 3 exemption)", () => {
		// A flat switch with 20 cases: readable, must not trip the branch finding.
		let body = "\tswitch (x) {\n";
		for (let k = 0; k < 20; k++) {
			body += `\t\tcase ${k}: return ${k};\n`;
		}
		body += "\t\tdefault: return -1;\n\t}\n";
		const src = `function flatSwitch(x: number) {\n${body}}\n`;
		const out = checkFunctionComplexity(src, "src/a.ts");
		expect(out).toEqual([]);
	});

	it("DOES count case labels nested at depth >= 3", () => {
		// Wrap the switch one level deeper so the `case` lines sit at depth >= 3.
		// function brace = depth 1, outer `if {` = depth 2, `switch {` = depth 3,
		// so each `case` line is evaluated at depth 3.
		let cases = "";
		for (let k = 0; k < 15; k++) {
			cases += `\t\t\t\tcase ${k}: r = ${k}; break;\n`;
		}
		const src =
			"function nestedSwitch(x: number) {\n" +
			"\tlet r = -1;\n" +
			"\tif (x >= 0) {\n" +
			"\t\tswitch (x) {\n" +
			cases +
			"\t\t}\n" +
			"\t}\n" +
			"\treturn r;\n" +
			"}\n";
		const out = checkFunctionComplexity(src, "src/a.ts");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("branches — high complexity");
	});

	it("prefers the nesting finding over the branch finding when both trip", () => {
		// Deep nesting (>=5) AND many branches: nesting is reported first.
		const out = checkFunctionComplexity(tsFnNested(6), "src/a.ts");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("[nesting depth");
		expect(nonNull(out[0]).text).not.toContain("branches —");
	});
});

describe("checkFunctionComplexity — body discovery edge cases", () => {
	it("skips a function whose opening brace is not within the 10-line window", () => {
		// A declaration that matches a func pattern but whose `{` is pushed far
		// down by a long multi-line parameter list (each on its own line, <6
		// params so paramOverflow is null) -> findBraceLine returns -1 -> skipped.
		const filler = Array.from({ length: 12 }, () => "\t// padding comment line").join("\n");
		const src = `function lateBrace(\n\ta: number\n${filler}\n) {\n\treturn a;\n}\n`;
		const out = checkFunctionComplexity(src, "src/a.ts");
		expect(out).toEqual([]);
	});

	it("returns [] for a healthy function within all thresholds", () => {
		const src =
			"function healthy(a: number, b: number) {\n" +
			"\tif (a > b) {\n\t\treturn a;\n\t}\n" +
			"\treturn b;\n}\n";
		const out = checkFunctionComplexity(src, "src/a.ts");
		expect(out).toEqual([]);
	});
});

describe("checkFunctionComplexity — language dispatch", () => {
	it("analyzes Go via the brace path (func with 6 params)", () => {
		const src =
			"func processGo(a int, b int, c int, d int, e int, f int) int {\n\treturn a\n}\n";
		const out = checkFunctionComplexity(src, "src/main.go");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("[6 parameters]");
	});

	it("recognizes a Go method with a receiver and flags its deep body", () => {
		// func (r *Recv) name( ... ) — exercises the optional receiver group in
		// the Go func pattern. Param-overflow is body-independent here; we drive
		// the body-nesting path (5 nested ifs -> relative depth 5) so the
		// receiver form is provably matched as a function head.
		let body = "";
		for (let d = 0; d < 5; d++) {
			body += `${"\t".repeat(d + 1)}if x > ${d} {\n`;
		}
		body += `${"\t".repeat(6)}return x\n`;
		for (let d = 4; d >= 0; d--) {
			body += `${"\t".repeat(d + 1)}}\n`;
		}
		const src = `func (r *Recv) doWork(x int) int {\n${body}}\n`;
		const out = checkFunctionComplexity(src, "src/main.go");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("[nesting depth 5]");
		expect(nonNull(out[0]).text).toContain("doWork");
	});

	it("analyzes Rust via the brace path (fn with deep nesting)", () => {
		// Rust fn with 5 nested if blocks -> relative nesting depth 5.
		let body = "";
		for (let d = 0; d < 5; d++) {
			body += `${"    ".repeat(d + 1)}if x > ${d} {\n`;
		}
		body += `${"    ".repeat(6)}return x;\n`;
		for (let d = 4; d >= 0; d--) {
			body += `${"    ".repeat(d + 1)}}\n`;
		}
		const src = `pub fn deep(x: i32) -> i32 {\n${body}}\n`;
		const out = checkFunctionComplexity(src, "src/lib.rs");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("[nesting depth 5]");
	});

	it("analyzes Swift via the brace path", () => {
		// Swift functions parse with the brace func patterns (func name(...)).
		const src =
			"func swiftFn(a: Int, b: Int, c: Int, d: Int, e: Int, f: Int) -> Int {\n\treturn a\n}\n";
		const out = checkFunctionComplexity(src, "src/App.swift");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("[6 parameters]");
	});
});

describe("checkFunctionComplexity — Python", () => {
	it("flags a Python def with 6 real parameters (self excluded)", () => {
		const src =
			"class C:\n" +
			"    def method(self, a, b, c, d, e, f):\n" +
			"        return a\n";
		const out = checkFunctionComplexity(src, "src/m.py");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("[6 parameters]");
		// self is dropped, so 6 (not 7) parameters reported.
	});

	it("excludes both self and cls from the Python parameter count", () => {
		// 5 real params + cls -> below threshold once cls is dropped.
		const src =
			"class C:\n" +
			"    @classmethod\n" +
			"    def make(cls, a, b, c, d, e):\n" +
			"        return a\n";
		const out = checkFunctionComplexity(src, "src/m.py");
		expect(out).toEqual([]);
	});

	it("flags an async def with 6 parameters", () => {
		const src = "async def fetcher(a, b, c, d, e, f):\n    return a\n";
		const out = checkFunctionComplexity(src, "src/m.py");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("[6 parameters]");
	});

	it("joins a multi-line Python signature to count parameters across lines", () => {
		const src =
			"def spread(\n" +
			"    a,\n" +
			"    b,\n" +
			"    c,\n" +
			"    d,\n" +
			"    e,\n" +
			"    f,\n" +
			"):\n" +
			"    return a\n";
		const out = checkFunctionComplexity(src, "src/m.py");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("[6 parameters]");
	});

	it("counts if/elif lines toward the Python branch total", () => {
		let body = "";
		for (let k = 0; k < 15; k++) {
			const kw = k === 0 ? "if" : "elif";
			body += `    ${kw} x == ${k}:\n        return ${k}\n`;
		}
		const src = `def branchy(x):\n${body}`;
		const out = checkFunctionComplexity(src, "src/m.py");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("branches — high complexity");
	});

	it("counts Python `case` lines toward the branch total", () => {
		let body = "    match x:\n";
		for (let k = 0; k < 15; k++) {
			body += `        case ${k}:\n            return ${k}\n`;
		}
		const src = `def matcher(x):\n${body}`;
		const out = checkFunctionComplexity(src, "src/m.py");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("branches — high complexity");
	});

	it("flags deep Python nesting at the depth-5 boundary", () => {
		// 4 nested `if`s: the deepest if sits at indent 16 (level 4) and its leaf
		// `return` at indent 20 (level 5). Python reports raw nesting (no -1), so
		// maxNesting = 5 -> exactly the >=5 boundary.
		let body = "";
		for (let d = 0; d < 4; d++) {
			body += `${" ".repeat(4 * (d + 1))}if x > ${d}:\n`;
		}
		body += `${" ".repeat(4 * 5)}return x\n`;
		const src = `def nest(x):\n${body}`;
		const out = checkFunctionComplexity(src, "src/m.py");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("[nesting depth 5]");
	});

	it("does NOT flag Python nesting one level below the boundary", () => {
		// 3 nested `if`s -> leaf at indent 16 -> level 4 -> below the >=5 threshold.
		let body = "";
		for (let d = 0; d < 3; d++) {
			body += `${" ".repeat(4 * (d + 1))}if x > ${d}:\n`;
		}
		body += `${" ".repeat(4 * 4)}return x\n`;
		const src = `def shallow(x):\n${body}`;
		const out = checkFunctionComplexity(src, "src/m.py");
		expect(out).toEqual([]);
	});

	it("returns no finding for a Python def whose parameter paren never closes", () => {
		// `def broken(` followed by many lines that never contain `)`. The
		// continuation-join loop exhausts its 10-line window without finding a
		// closing paren, so the param regex fails -> pythonParamOverflow null.
		// (Body analysis then runs but finds nothing complex.)
		let src = "def broken(\n";
		for (let k = 0; k < 12; k++) {
			src += `    a${k},\n`;
		}
		const out = checkFunctionComplexity(src, "src/m.py");
		expect(out).toEqual([]);
	});

	it("returns [] for a healthy Python function within thresholds", () => {
		const src =
			"def ok(a, b):\n" +
			"    if a > b:\n" +
			"        return a\n" +
			"    return b\n";
		const out = checkFunctionComplexity(src, "src/m.py");
		expect(out).toEqual([]);
	});

	it("stops scanning the Python body at a dedent back to the def's indent", () => {
		// Two top-level defs; the first is healthy, the deep nesting belongs to
		// the SECOND. The body walk for the first must stop at the dedent so it
		// does not absorb the second function's nesting.
		const src =
			"def first(a, b):\n" +
			"    return a\n" +
			"def second(x):\n" +
			"    if x:\n" +
			"        if x:\n" +
			"            if x:\n" +
			"                if x:\n" +
			"                    if x:\n" +
			"                        return x\n";
		const out = checkFunctionComplexity(src, "src/m.py");
		// Only `second` should be flagged (nesting), `first` stays clean.
		// 5 nested ifs -> leaf at level 6 (Python reports raw depth).
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).text).toContain("second");
		expect(nonNull(out[0]).text).toContain("[nesting depth 6]");
	});

	it("skips blank lines inside a Python body without breaking the walk", () => {
		// Blank lines between nested ifs must be tolerated (continue branch).
		const src =
			"def withblanks(x):\n" +
			"    if x > 0:\n" +
			"\n" +
			"        if x > 1:\n" +
			"\n" +
			"            if x > 2:\n" +
			"                if x > 3:\n" +
			"                    if x > 4:\n" +
			"                        return x\n";
		const out = checkFunctionComplexity(src, "src/m.py");
		expect(out).toHaveLength(1);
		// 5 nested ifs -> leaf at level 6; blank lines between them are skipped.
		expect(nonNull(out[0]).text).toContain("[nesting depth 6]");
	});
});

describe("checkFunctionComplexity — result cap", () => {
	it("caps brace-language findings at 15 even when more functions qualify", () => {
		// 20 distinct 6-param functions; the loop breaks once 15 are collected.
		let src = "";
		for (let k = 0; k < 20; k++) {
			src += `function over${k}(a, b, c, d, e, f) {\n\treturn a;\n}\n`;
		}
		const out = checkFunctionComplexity(src, "src/many.ts");
		expect(out).toHaveLength(15);
		for (const m of out) {
			expect(m.text).toContain("[6 parameters]");
		}
	});

	it("caps Python findings at 15 even when more functions qualify", () => {
		let src = "";
		for (let k = 0; k < 20; k++) {
			src += `def pover${k}(a, b, c, d, e, f):\n    return a\n`;
		}
		const out = checkFunctionComplexity(src, "src/many.py");
		expect(out).toHaveLength(15);
	});
});

// ---------------------------------------------------------------------------
// Mutation-hardening: precise, mutant-killing assertions targeting specific
// regex/arithmetic/boolean sites in complexity.ts's private helpers, driven
// entirely through the public checkFunctionComplexity API.
// ---------------------------------------------------------------------------

describe("checkFunctionComplexity — module-level function-pattern regex edge cases", () => {
	// test-contract: invariant — BRACE_FUNC_PATTERNS' quantifiers must tolerate
	// realistic spacing variants (double spaces, space-before-generic,
	// space-before-paren) without silently failing to recognize the function
	// head, which would drop an otherwise-real complexity finding.
	it.each([
		"function  paramFn(a, b, c, d, e, f) {",
		"export function foo <T>(a, b, c, d, e, f) {",
		"export function foo<T, U>(a, b, c, d, e, f) {",
		"export function foo<T> (a, b, c, d, e, f) {",
		"const  foo = (a, b, c, d, e, f) => {",
		"export const foo: Handler = (a, b, c, d, e, f) => {",
		"export const foo : Handler = (a, b, c, d, e, f) => {",
		"export const foo:Handler = (a, b, c, d, e, f) => {",
		"export const foo=(a, b, c, d, e, f) => {",
		"export const foo = async  (a, b, c, d, e, f) => {",
		"func  paramFn(a, b, c, d, e, f) int {",
		"func paramFn (a, b, c, d, e, f) int {",
		"fn  paramFn(a, b, c, d, e, f) {",
		"pub fn foo <T>(a, b, c, d, e, f) {",
		"pub fn foo<TU>(a, b, c, d, e, f) {",
		"pub fn foo<T> (a, b, c, d, e, f) {",
	])("still recognizes the function head: %s", (declLine) => {
		const src = `${declLine}\n\treturn a;\n}\n`;
		const out = checkFunctionComplexity(src, "src/a.ts");
		expect(out).toEqual([{ line: 1, text: `[6 parameters] ${declLine}` }]);
	});

	// test-contract: invariant — a Go receiver's closing paren may be followed
	// by 2+ spaces before the method name. Unlike the param-overflow cases
	// above, the naive `\(([^)]*)\)` param extraction latches onto the
	// RECEIVER's own parens here, so the observable signal must come from the
	// body (nesting), not the parameter count.
	it("recognizes a Go method receiver even with extra space before the method name", () => {
		let body = "";
		for (let d = 0; d < 5; d++) body += `${"\t".repeat(d + 1)}if x > ${d} {\n`;
		body += `${"\t".repeat(6)}return x\n`;
		for (let d = 4; d >= 0; d--) body += `${"\t".repeat(d + 1)}}\n`;
		const src = `func (r *Recv)  doWork(x int) int {\n${body}}\n`;
		const out = checkFunctionComplexity(src, "src/main.go");
		expect(out).toEqual([
			{ line: 1, text: "[nesting depth 5] func (r *Recv)  doWork(x int) int {" },
		]);
	});
});

describe("checkFunctionComplexity — analyzeBraceBody nesting/branch tracking internals", () => {
	// test-contract: invariant — nesting depth must track the TRUE brace depth
	// (increment on "{", decrement on "}"), not just a running count of "{"
	// seen. Five sibling if-blocks (each opening and closing its own brace)
	// never nest past depth 2, so this must stay clean.
	it("tracks true nesting across sibling if-blocks that each open and close their own brace", () => {
		const src =
			"function foo(x) {\n" +
			"\tif (x === 0) { return 0; }\n" +
			"\tif (x === 1) { return 1; }\n" +
			"\tif (x === 2) { return 2; }\n" +
			"\tif (x === 3) { return 3; }\n" +
			"\tif (x === 4) { return 4; }\n" +
			"\treturn -1;\n" +
			"}\n";
		expect(checkFunctionComplexity(src, "src/a.ts")).toEqual([]);
	});

	// test-contract: invariant — maxDepth must track the TRUE maximum depth
	// ever reached, not just the depth of the most-recently-opened brace. A
	// 5-deep nest followed by a later shallow sibling if must still report 5.
	it("tracks the true MAX nesting depth, not the depth of the last-opened brace", () => {
		const src =
			"function foo(x) {\n" +
			"\tif (x > 0) {\n" +
			"\t\tif (x > 1) {\n" +
			"\t\t\tif (x > 2) {\n" +
			"\t\t\t\tif (x > 3) {\n" +
			"\t\t\t\t\tif (x > 4) {\n" +
			"\t\t\t\t\t\treturn 1;\n" +
			"\t\t\t\t\t}\n" +
			"\t\t\t\t}\n" +
			"\t\t\t}\n" +
			"\t\t}\n" +
			"\t}\n" +
			"\tif (x > 5) {\n" +
			"\t\treturn 2;\n" +
			"\t}\n" +
			"}\n";
		expect(checkFunctionComplexity(src, "src/a.ts")).toEqual([
			{ line: 1, text: "[nesting depth 5] function foo(x) {" },
		]);
	});

	// test-contract: bug — a function whose braces never close before EOF must
	// degrade to no finding, not throw (the body walk is bounded by the array,
	// not by an assumption that a closing brace exists).
	it("does not crash and returns no finding when a function's braces never close", () => {
		const src = "function unclosed(x) {\n\treturn x;\n";
		expect(() => checkFunctionComplexity(src, "src/a.ts")).not.toThrow();
		expect(checkFunctionComplexity(src, "src/a.ts")).toEqual([]);
	});

	// test-contract: bug — the body walk must stop at ITS OWN closing brace.
	// `first` closes cleanly (shallow); `second`, right after, has a genuine
	// 5-deep nest. A walk that never breaks would bleed second's nesting into
	// a finding wrongly attributed to first.
	it("stops walking a function's body at its own closing brace (no bleed into later code)", () => {
		const src =
			"function first(x) {\n" +
			"\tif (x) { return 1; }\n" +
			"\treturn 0;\n" +
			"}\n" +
			"function second(x) {\n" +
			"\tif (x > 0) {\n" +
			"\t\tif (x > 1) {\n" +
			"\t\t\tif (x > 2) {\n" +
			"\t\t\t\tif (x > 3) {\n" +
			"\t\t\t\t\tif (x > 4) {\n" +
			"\t\t\t\t\t\treturn 1;\n" +
			"\t\t\t\t\t}\n" +
			"\t\t\t\t}\n" +
			"\t\t\t}\n" +
			"\t\t}\n" +
			"\t}\n" +
			"\treturn 0;\n" +
			"}\n";
		expect(checkFunctionComplexity(src, "src/a.ts")).toEqual([
			{ line: 5, text: "[nesting depth 5] function second(x) {" },
		]);
	});

	// test-contract: invariant — an if with NO space before its paren (if(x))
	// is still a branch statement; the char right after the keyword may be
	// whitespace OR the opening paren itself.
	it("recognizes an if with no space before its paren as a branch", () => {
		let body = "";
		for (let k = 0; k < 15; k++) body += `\tif(x === ${k}) return ${k};\n`;
		const src = `function foo(x) {\n${body}\treturn -1;\n}\n`;
		expect(checkFunctionComplexity(src, "src/a.ts")).toEqual([
			{ line: 1, text: "[15 branches — high complexity] function foo(x) {" },
		]);
	});

	// test-contract: invariant — the branch regex must anchor to the start of
	// the line; a call like `motif (k)` contains the substring "if (" but is
	// not an if-statement.
	it("does not count a call whose name merely contains the substring \"if (\" as a branch", () => {
		let body = "";
		for (let k = 0; k < 15; k++) body += `\tmotif (${k});\n`;
		const src = `function foo(x) {\n${body}\treturn -1;\n}\n`;
		expect(checkFunctionComplexity(src, "src/a.ts")).toEqual([]);
	});

	// test-contract: invariant — "else" and "if" may be separated by more
	// than one space in an else-if chain.
	it("tolerates a double space between else and if in an else-if chain", () => {
		let body = "\tif (x === 0) return 0;\n";
		for (let k = 1; k < 15; k++) body += `\telse  if (x === ${k}) return ${k};\n`;
		body += "\treturn -1;\n";
		const src = `function foo(x) {\n${body}}\n`;
		expect(checkFunctionComplexity(src, "src/a.ts")).toEqual([
			{ line: 1, text: "[15 branches — high complexity] function foo(x) {" },
		]);
	});

	// test-contract: invariant — an identifier that merely STARTS with "if"
	// (ifPresent0(x)) is not a branch; the char after "if" must be whitespace
	// or "(", not another identifier letter.
	it("does not count an identifier that merely starts with \"if\" as a branch", () => {
		let body = "";
		for (let k = 0; k < 15; k++) body += `\tifPresent${k}(x);\n`;
		const src = `function foo(x) {\n${body}\treturn -1;\n}\n`;
		expect(checkFunctionComplexity(src, "src/a.ts")).toEqual([]);
	});

	// test-contract: invariant — if-statements indented with 2+ leading
	// whitespace characters must still be counted (indentation amount is
	// arbitrary, not exactly one character).
	it("counts if-statements indented with 2+ tabs", () => {
		let body = "";
		for (let k = 0; k < 15; k++) body += `\t\tif (x === ${k}) return ${k};\n`;
		const src = `function foo(x) {\n${body}\treturn -1;\n}\n`;
		expect(checkFunctionComplexity(src, "src/a.ts")).toEqual([
			{ line: 1, text: "[15 branches — high complexity] function foo(x) {" },
		]);
	});
});

describe("checkFunctionComplexity — analyzePythonBody nesting/branch tracking internals", () => {
	// test-contract: bug — a whitespace-only line (spaces but no newline-only
	// blank) must be treated as blank, not as a dedent that ends the body scan
	// early and hides the real nesting below it.
	it("treats a whitespace-only line as blank, not as a dedent", () => {
		const src =
			"def foo(x):\n" +
			"    if x > 0:\n" +
			"        if x > 1:\n" +
			"    \n" +
			"            if x > 2:\n" +
			"                if x > 3:\n" +
			"                    if x > 4:\n" +
			"                        return x\n";
		expect(checkFunctionComplexity(src, "src/m.py")).toEqual([
			{ line: 1, text: "[nesting depth 6] def foo(x):" },
		]);
	});

	// test-contract: invariant — nesting must be computed relative to the
	// def's OWN indent (headIndent), not the raw file column. A class method
	// (headIndent 4) with 2 levels of nesting stays well under the threshold
	// once its own indent is correctly subtracted rather than added.
	it("computes nesting relative to the def's own indent, not the raw column", () => {
		const src =
			"class C:\n" +
			"    def method(self, x):\n" +
			"        if x > 0:\n" +
			"            if x > 1:\n" +
			"                return x\n" +
			"        return 0\n";
		expect(checkFunctionComplexity(src, "src/m.py")).toEqual([]);
	});

	// test-contract: invariant — maxNesting must track the TRUE maximum
	// nesting level ever reached, not just the level of the last statement
	// scanned (a shallow `return 0` sibling after a 5-deep nest must not
	// erase the recorded max).
	it("tracks the true MAX nesting level, not the level of the last statement", () => {
		const src =
			"def foo(x):\n" +
			"    if x > 0:\n" +
			"        if x > 1:\n" +
			"            if x > 2:\n" +
			"                if x > 3:\n" +
			"                    if x > 4:\n" +
			"                        return 1\n" +
			"    return 0\n";
		expect(checkFunctionComplexity(src, "src/m.py")).toEqual([
			{ line: 1, text: "[nesting depth 6] def foo(x):" },
		]);
	});

	// test-contract: invariant — plain assignment/return lines are never
	// if/elif/case branches, no matter how many of them a function body has.
	it("does not count plain body lines as if/elif/case branches", () => {
		let body = "";
		for (let k = 0; k < 16; k++) body += `    x = x + ${k}\n`;
		const src = `def foo(x):\n${body}    return x\n`;
		expect(checkFunctionComplexity(src, "src/m.py")).toEqual([]);
	});

	// test-contract: invariant — the if/elif regex must anchor to the line
	// start; a call like `motif (k)` contains the substring "if " but is not
	// an if-statement.
	it("does not count a call whose name merely contains the substring \"if \" as a branch", () => {
		let body = "";
		for (let k = 0; k < 15; k++) body += `    result = motif (${k})\n`;
		const src = `def foo(x):\n${body}    return result\n`;
		expect(checkFunctionComplexity(src, "src/m.py")).toEqual([]);
	});

	// test-contract: invariant — the case regex must anchor to the line
	// start; a call like `staircase (k)` contains the substring "case " but
	// is not a match statement's case label.
	it("does not count a call whose name merely contains the substring \"case \" as a branch", () => {
		let body = "";
		for (let k = 0; k < 15; k++) body += `    result = staircase (${k})\n`;
		const src = `def foo(x):\n${body}    return result\n`;
		expect(checkFunctionComplexity(src, "src/m.py")).toEqual([]);
	});
});

describe("checkFunctionComplexity — finding line numbers and message truncation", () => {
	// test-contract: invariant — a finding's `line` is the function's OWN
	// 1-indexed declaration line, not an off-by-one in either direction.
	it("reports the nesting finding at the function's own declaration line", () => {
		const out = checkFunctionComplexity(tsFnNested(5), "src/a.ts");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(1);
	});

	// test-contract: invariant — the nesting message truncates the trimmed
	// signature to 120 chars; a longer signature must not appear in full.
	it("truncates the nesting finding's message to 120 chars of the trimmed line", () => {
		const longName = "veryLongFunctionName".repeat(10); // 200 chars
		let body = "";
		for (let d = 0; d < 5; d++) body += `${"\t".repeat(d + 1)}if (x > ${d}) {\n`;
		body += `${"\t".repeat(6)}return x;\n`;
		for (let d = 4; d >= 0; d--) body += `${"\t".repeat(d + 1)}}\n`;
		const src = `function ${longName}(x) {\n${body}}\n`;
		const trimmed = `function ${longName}(x) {`;
		const out = checkFunctionComplexity(src, "src/a.ts");
		expect(out).toEqual([{ line: 1, text: `[nesting depth 5] ${trimmed.slice(0, 120)}` }]);
	});

	// test-contract: invariant — the branch finding's `line` is likewise the
	// function's own declaration line, not an off-by-one in either direction.
	it("reports the branch finding at the function's own declaration line", () => {
		const out = checkFunctionComplexity(tsFnBranches(15), "src/a.ts");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(1);
	});

	// test-contract: invariant — the branch message truncates the trimmed
	// signature to 100 chars (a DIFFERENT limit than the nesting message's
	// 120), so a signature between 100 and 120 chars must still be cut.
	it("truncates the branch finding's message to 100 chars of the trimmed line", () => {
		const longName = "veryLongFunctionName".repeat(6); // 120 chars
		let body = "";
		for (let k = 0; k < 15; k++) body += `\tif (x === ${k}) return ${k};\n`;
		const src = `function ${longName}(x) {\n${body}}\n`;
		const trimmed = `function ${longName}(x) {`;
		const out = checkFunctionComplexity(src, "src/a.ts");
		expect(out).toEqual([
			{ line: 1, text: `[15 branches — high complexity] ${trimmed.slice(0, 100)}` },
		]);
	});

	// test-contract: invariant — the parameter-overflow message also
	// truncates to 120 chars of the trimmed signature.
	it("truncates the parameter-overflow message to 120 chars of the trimmed line", () => {
		const longName = "veryLongParamFunctionNameForTesting".repeat(4); // 140 chars
		const src = `function ${longName}(a, b, c, d, e, f) {\n\treturn a;\n}\n`;
		const trimmed = `function ${longName}(a, b, c, d, e, f) {`;
		const out = checkFunctionComplexity(src, "src/a.ts");
		expect(out).toEqual([{ line: 1, text: `[6 parameters] ${trimmed.slice(0, 120)}` }]);
	});

	// test-contract: invariant — the finding text uses the TRIMMED line (no
	// leading indentation), even for a function declared inside an indented
	// block (namespace/module).
	it("uses the trimmed line (no leading indentation) in the finding text", () => {
		const src =
			"namespace X {\n\texport function helper(a, b, c, d, e, f) {\n\t\treturn a;\n\t}\n}\n";
		const out = checkFunctionComplexity(src, "src/a.ts");
		expect(out).toEqual([
			{ line: 2, text: "[6 parameters] export function helper(a, b, c, d, e, f) {" },
		]);
	});
});

describe("checkFunctionComplexity — Python def-regex edge cases", () => {
	// test-contract: invariant — the def regex must anchor to the line start;
	// "typedef" contains "def" as a substring but is not a def statement.
	it("does not recognize \"def\" as a substring of a longer identifier (typedef)", () => {
		const src = "    typedef helper(a, b, c, d, e, f):\n        return a\n";
		expect(checkFunctionComplexity(src, "src/m.py")).toEqual([]);
	});

	// test-contract: invariant — "async" and "def" may be separated by more
	// than one space.
	it("tolerates a double space between async and def", () => {
		const src = "async  def foo(a, b, c, d, e, f):\n    return a\n";
		expect(checkFunctionComplexity(src, "src/m.py")).toEqual([
			{ line: 1, text: "[6 parameters] async  def foo(a, b, c, d, e, f):" },
		]);
	});

	// test-contract: invariant — "def" and the function name may likewise be
	// separated by more than one space.
	it("tolerates a double space between def and the function name", () => {
		const src = "def  foo(a, b, c, d, e, f):\n    return a\n";
		expect(checkFunctionComplexity(src, "src/m.py")).toEqual([
			{ line: 1, text: "[6 parameters] def  foo(a, b, c, d, e, f):" },
		]);
	});

	// test-contract: invariant — a space between the def name and its opening
	// paren (def foo (...)) must not stop the head from being recognized.
	it("tolerates a space between the def name and its opening paren", () => {
		const src = "def foo (a, b, c, d, e, f):\n    return a\n";
		expect(checkFunctionComplexity(src, "src/m.py")).toEqual([
			{ line: 1, text: "[6 parameters] def foo (a, b, c, d, e, f):" },
		]);
	});
});

describe("checkFunctionComplexity — recognizes every configured brace-language extension", () => {
	// test-contract: invariant — every extension listed in checkFunctionComplexity's
	// dispatch condition must route to the brace analyzer, not just ".ts".
	it.each([".tsx", ".js", ".jsx", ".mjs", ".cjs", ".cts", ".mts"])(
		"analyzes %s files for parameter overflow",
		(ext) => {
			const src = tsFnWithParams(6);
			const declLine = nonNull(src.split("\n")[0]);
			const out = checkFunctionComplexity(src, `src/a${ext}`);
			expect(out).toEqual([{ line: 1, text: `[6 parameters] ${declLine}` }]);
		},
	);
});

describe("checkFunctionComplexity — countTopLevelCommas bracket-balance edge cases", () => {
	// test-contract: invariant — a comma nested inside {...} must not count as
	// a top-level parameter separator.
	it("does not count a comma nested inside {...} as a top-level separator", () => {
		const declLine = "function foo(a: { x, y }, b: number, c: number, d: number, e: number, f: number) {";
		const out = checkFunctionComplexity(`${declLine}\n\treturn a;\n}\n`, "src/a.ts");
		expect(out).toEqual([{ line: 1, text: `[6 parameters] ${declLine}` }]);
	});

	// test-contract: invariant — after a {...} block closes, top-level comma
	// counting must resume (depth returns to 0, not stuck open).
	it("resumes counting top-level commas after a {...} block closes", () => {
		const declLine = "function foo(a: { x: number }, b: number, c: number, d: number, e: number, f: number) {";
		const out = checkFunctionComplexity(`${declLine}\n\treturn a;\n}\n`, "src/a.ts");
		expect(out).toEqual([{ line: 1, text: `[6 parameters] ${declLine}` }]);
	});

	// test-contract: invariant — a comma nested inside [...] must not count as
	// a top-level parameter separator (the "[" depth-tracking branch).
	it("does not count a comma nested inside [...] as a top-level separator", () => {
		const declLine = "function foo(a: [x, y], b: number, c: number, d: number, e: number, f: number) {";
		const out = checkFunctionComplexity(`${declLine}\n\treturn a;\n}\n`, "src/a.ts");
		expect(out).toEqual([{ line: 1, text: `[6 parameters] ${declLine}` }]);
	});

	// test-contract: invariant — after a [...] block closes, top-level comma
	// counting must resume (the "]" depth-tracking branch).
	it("resumes counting top-level commas after a [...] block closes", () => {
		const declLine = "function foo(a: [number], b: number, c: number, d: number, e: number, f: number) {";
		const out = checkFunctionComplexity(`${declLine}\n\treturn a;\n}\n`, "src/a.ts");
		expect(out).toEqual([{ line: 1, text: `[6 parameters] ${declLine}` }]);
	});

	// test-contract: invariant — a comma nested inside (...) must not count
	// as a top-level separator either (the "(" depth-tracking branch).
	it("does not count a comma nested inside (...) as a top-level separator", () => {
		const declLine =
			"function foo(a: number, b: number, c: number, d: number, e: number, f: (x, y)) {";
		const out = checkFunctionComplexity(`${declLine}\n\treturn a;\n}\n`, "src/a.ts");
		expect(out).toEqual([{ line: 1, text: `[6 parameters] ${declLine}` }]);
	});
});

describe("checkFunctionComplexity — findBraceLine search-window edge cases", () => {
	// test-contract: bug — a declaration whose opening brace is never found
	// (no body at all) must not be analyzed at all; 15 bare if-statements
	// that follow it must not be wrongly attributed to it as branches.
	it("does not analyze a function whose opening brace is never found", () => {
		let src = "const handler = (a, b)\n";
		for (let k = 0; k < 15; k++) src += `if (x === ${k}) return ${k};\n`;
		expect(checkFunctionComplexity(src, "src/a.ts")).toEqual([]);
	});
});

describe("checkFunctionComplexity — pythonParamOverflow signature-join bounds", () => {
	// test-contract: bug — a short file that ends mid-signature (no closing
	// paren, fewer lines than the +10 search window) must degrade to no
	// finding, not throw from an out-of-bounds array read.
	it("does not crash and returns no finding when a short file ends mid-signature", () => {
		const src = "def broken(\n    a,\n    b,\n";
		expect(() => checkFunctionComplexity(src, "src/m.py")).not.toThrow();
		expect(checkFunctionComplexity(src, "src/m.py")).toEqual([]);
	});

	// test-contract: invariant — the Python parameter-overflow finding's
	// `line` is the def's own declaration line, not an off-by-one.
	it("reports the parameter-overflow finding at the def's own line", () => {
		const src = "def foo(a, b, c, d, e, f):\n    return a\n";
		const out = checkFunctionComplexity(src, "src/m.py");
		expect(out).toHaveLength(1);
		expect(nonNull(out[0]).line).toBe(1);
	});

	// test-contract: invariant — the Python parameter-overflow message also
	// truncates to 120 chars of the trimmed line.
	it("truncates the Python parameter-overflow message to 120 chars of the trimmed line", () => {
		const longName = "veryLongPyParamFunctionNameForTesting".repeat(4); // 148 chars
		const src = `def ${longName}(a, b, c, d, e, f):\n    return a\n`;
		const trimmed = `def ${longName}(a, b, c, d, e, f):`;
		const out = checkFunctionComplexity(src, "src/m.py");
		expect(out).toEqual([{ line: 1, text: `[6 parameters] ${trimmed.slice(0, 120)}` }]);
	});
});
