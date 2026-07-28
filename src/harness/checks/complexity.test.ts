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
