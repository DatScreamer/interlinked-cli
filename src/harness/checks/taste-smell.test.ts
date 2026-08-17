// Unit tests for taste-smell.ts
//
// checkMagicNumbers:
//   MP1  a bare magic number in a conditional fires
//   MP2  cap at 10 matches per file
//   MP3  a second flagged number on the same line is skipped (one per line)
//   MN1  wrong extension does not fire
//   MN2  an array index is not flagged
//
// checkNegatedConditionWithElse:
//   NP1  if (!x) { } else { } fires
//   NN1  wrong extension does not fire
//   NN2  cap at 10 matches per file (indirectly exercises the no-matching-else fallback too)
//   NN3  an if-block with no matching else within the scan window does not fire
//
// checkNestedTernary:
//   TP1  nested ternary fires
//   TN1  an unbalanced generic `>` does not crash and does not fire
//   TN2  an extra `:` with no open ternary does not push depth negative
//   TN3  cap at 10 matches per file
//
// checkFlagArguments:
//   FP1  2+ boolean params fires
//   FN1  a signature with no closing paren within the collect window does not fire
//
// checkCommentedOutCode:
//   CP1  a real disabled-code block fires
//   CP2  a Python bare-call disabled block fires
//   CP3  an assignment-shaped line whose LHS breaks the tight assignment pattern
//        still classifies as code via the generic ";"+"=("/ "(" fallback
//   CP4  a prose parenthetical veto ("(see docs)") stops the block from firing
//   CP5  cap at 5 matches per file
//   CN1  wrong extension does not fire

import { describe, expect, it } from "vitest";
import {
	checkCommentedOutCode,
	checkFlagArguments,
	checkMagicNumbers,
	checkNegatedConditionWithElse,
	checkNestedTernary,
} from "./taste-smell.js";

const TS_PATH = "src/lib/app.ts";

function magic(lines: string[], path = TS_PATH) {
	return checkMagicNumbers(lines.join("\n"), path);
}
function negated(lines: string[], path = TS_PATH) {
	return checkNegatedConditionWithElse(lines.join("\n"), path);
}
function ternary(lines: string[], path = TS_PATH) {
	return checkNestedTernary(lines.join("\n"), path);
}
function flagArgs(lines: string[], path = TS_PATH) {
	return checkFlagArguments(lines.join("\n"), path);
}
function commentedOut(lines: string[], path = TS_PATH) {
	return checkCommentedOutCode(lines.join("\n"), path);
}

// ─── checkMagicNumbers ─────────────────────────────────────────────────────

describe("checkMagicNumbers — positive (must fire)", () => {
	it("MP1: a bare magic number in a conditional fires", () => {
		const found = magic(["function f(retries) {", "  if (retries > 37) return;", "}"]);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
		expect(found[0]?.text).toBe("if (retries > 37) return;");
	});

	it("MP2: matches are capped at 10 per file", () => {
		const lines = ["function f(x) {"];
		for (let i = 0; i < 15; i++) lines.push(`  if (x > ${37 + i}) return;`);
		lines.push("}");
		const found = magic(lines);
		expect(found).toHaveLength(10);
	});

	it("MP3: only the first flagged number on a line is reported", () => {
		const found = magic(["function f(x) {", "  if (x > 37 && x < 41) return;", "}"]);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});
});

describe("checkMagicNumbers — negative (must not fire)", () => {
	it("MN1: wrong extension does not fire", () => {
		const found = magic(["if (x > 37) return;"], "src/app.py");
		expect(found).toEqual([]);
	});

	it("MN2: an array index is not flagged", () => {
		const found = magic(["function f(arr) {", "  if (arr[37] > 0) return;", "}"]);
		expect(found).toEqual([]);
	});
});

// ─── checkNegatedConditionWithElse ──────────────────────────────────────────

describe("checkNegatedConditionWithElse — positive (must fire)", () => {
	it("NP1: if (!x) { } else { } fires at the if line", () => {
		const found = negated([
			"function f(x) {", // 1
			"  if (!x) {", // 2
			"    doA();", // 3
			"  } else {", // 4
			"    doB();", // 5
			"  }", // 6
			"}", // 7
		]);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(2);
	});
});

describe("checkNegatedConditionWithElse — negative (must not fire)", () => {
	it("NN1: wrong extension does not fire", () => {
		const found = negated(
			["function f(x) {", "  if (!x) {", "    doA();", "  } else {", "    doB();", "  }", "}"],
			"src/app.rs",
		);
		expect(found).toEqual([]);
	});

	it("NN2: matches are capped at 10 per file", () => {
		const lines: string[] = [];
		for (let i = 0; i < 12; i++) {
			lines.push(
				`function f${i}(x) {`,
				"  if (!x) {",
				`    doA${i}();`,
				"  } else {",
				`    doB${i}();`,
				"  }",
				"}",
			);
		}
		const found = negated(lines);
		expect(found).toHaveLength(10);
	});

	it("NN3: an if-block with no matching else within the scan window does not fire", () => {
		const lines = ["function f(x) {", "  if (!x) {", "    doA();", "  }", "  doC();", "}"];
		expect(negated(lines)).toEqual([]);
	});

	it("NN4: an if-block that never closes within the 50-line scan window does not fire", () => {
		const lines = ["function f(x) {", "  if (!x) {"];
		for (let i = 0; i < 55; i++) lines.push(`    step${i}();`); // no closing brace anywhere
		expect(negated(lines)).toEqual([]);
	});
});

// ─── checkNestedTernary ──────────────────────────────────────────────────────

describe("checkNestedTernary — positive (must fire)", () => {
	it("TP1: a nested ternary fires", () => {
		const found = ternary(["const x = a ? b ? c : d : e;"]);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});
});

describe("checkNestedTernary — negative (must not fire)", () => {
	it("TN1: a `?`/`:` pair inside a generic's angle brackets is skipped (inGeneric > 0)", () => {
		// The `?`/`:` inside `A<B ? C : D>` are skipped by the inGeneric guard;
		// only the ternary outside the generic is counted (depth 1, not nested).
		const found = ternary(["const t: A<B ? C : D> = e ? f : g;"]);
		expect(found).toEqual([]);
	});

	it("TN1b: an unbalanced generic `>` (no preceding `<`) does not push inGeneric negative or crash", () => {
		// No preceding `<` — the `>` clamp (Math.max(0, inGeneric - 1)) is exercised.
		const found = ternary(["const y = a > b ? c : d ? e : f;"]);
		expect(found).toEqual([]);
	});

	it("TN2: an extra `:` at depth 0 (object literal) does not go negative and does not fire", () => {
		// Object-literal colon before any `?` on the line, plus two sequential
		// (non-nested) ternaries so the qCount >= 2 quick-check is satisfied.
		const found = ternary(["const o = { k: 1 }; const y = a ? b : c ? d : e;"]);
		expect(found).toEqual([]);
	});

	it("TN3: matches are capped at 10 per file", () => {
		const lines: string[] = [];
		for (let i = 0; i < 12; i++) lines.push(`const x${i} = a ? b ? c : d : e;`);
		const found = ternary(lines);
		expect(found).toHaveLength(10);
	});
});

// ─── checkFlagArguments ──────────────────────────────────────────────────────

describe("checkFlagArguments — positive (must fire)", () => {
	it("FP1: 2+ boolean params fires", () => {
		const found = flagArgs(["function f(a: boolean, b: boolean) {", "  return a && b;", "}"]);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
		expect(found[0]?.text).toContain("2 boolean params");
	});

	it("FP2: matches are capped at 10 per file", () => {
		const lines: string[] = [];
		for (let i = 0; i < 12; i++) {
			lines.push(`function f${i}(a: boolean, b: boolean) {`, "  return a && b;", "}");
		}
		const found = flagArgs(lines);
		expect(found).toHaveLength(10);
	});
});

describe("checkFlagArguments — negative (must not fire)", () => {
	it("FN1: an unclosed signature (no `)` within the 20-line collect window) does not fire", () => {
		// The function-name pattern matches "f(" but the opening paren is never
		// closed anywhere in the 20-line collect window (no "{" or "=>" either,
		// so the window runs its full length), so paramMatch fails at line 295.
		const lines = ["function f(", ...Array.from({ length: 25 }, (_, i) => `  x${i}`)];
		expect(flagArgs(lines)).toEqual([]);
	});
});

// ─── checkCommentedOutCode ────────────────────────────────────────────────────

describe("checkCommentedOutCode — positive (must fire)", () => {
	it("CP1: a real disabled-code block of 3+ lines fires", () => {
		const found = commentedOut([
			"// const a = 1;", // 1
			"// doWork(a);", // 2
			"// return a;", // 3
			"realCode();", // 4
		]);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
		expect(found[0]?.text).toBe("[3 lines of commented-out code → use version control instead]");
	});

	it("CP2: a Python bare-call disabled block fires", () => {
		const found = commentedOut(
			["# save(data)", "# audit(data)", "# publish(data)", "real_code()"],
			"scripts/run.py",
		);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	it("CP3: an assignment whose LHS breaks the tight pattern still classifies via the generic fallback", () => {
		const found = commentedOut([
			"// obj.method(a).prop = val();", // 1 — LHS has '(' so the tight assign regex can't match
			"// obj.method(b).prop = val();", // 2
			"// obj.method(c).prop = val();", // 3
			"realCode();", // 4
		]);
		expect(found).toHaveLength(1);
		expect(found[0]?.line).toBe(1);
	});

	it("CP5: matches are capped at 5 per file", () => {
		const lines: string[] = [];
		for (let i = 0; i < 7; i++) {
			lines.push(`// const a${i} = 1;`, `// doWork(a${i});`, `// return a${i};`, `real${i}();`);
		}
		const found = commentedOut(lines);
		expect(found).toHaveLength(5);
	});
});

describe("checkCommentedOutCode — negative (must not fire)", () => {
	it("CP4: a prose parenthetical veto stops the block from firing", () => {
		const found = commentedOut([
			"// const a = 1; (see docs for details)", // 1 — doc veto
			"// doWork(a);", // 2
			"// return a;", // 3
			"realCode();", // 4
		]);
		expect(found).toEqual([]);
	});

	it("CN2: a Python line matching neither assignment nor bare-call classifies as neutral", () => {
		// No '=' (not an assignment) and not a bare `name(...)` call — falls
		// through to the Python branch's final `return "neutral"`.
		const found = commentedOut(["# x + y", "real_code()"], "scripts/x.py");
		expect(found).toEqual([]);
	});

	it("CN3: a semicolon-terminated line with no assignment/call shape is not classified as code", () => {
		const found = commentedOut([
			"// a();", // 1 — bare call → code
			"// b();", // 2 — bare call → code
			"// x;", // 3 — semicolon-terminated but no '=' or '(' anywhere → not code
			"realCode();", // 4
		]);
		// codeLineCount stays at 2 (< 3), so the block never fires — this
		// exercises line 399's false branch without needing it to fire.
		expect(found).toEqual([]);
	});

	it("CN1: wrong extension does not fire", () => {
		const found = commentedOut(
			["// const a = 1;", "// doWork(a);", "// return a;", "realCode();"],
			"src/app.md",
		);
		expect(found).toEqual([]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Survivor-kill campaign — hardens the boundary-condition and regex-anchor
// behavior the sections above don't individually pin: extension allowlists,
// isTestFile guards, declaration/return/case-skip regexes (anchor removal,
// glued vs spaced whitespace), the operator/call-context gate (note: that
// gate's `[<>=!]+`/`[+\-*/%]` alternative requires the operator to be
// GLUED to a word char with no surrounding space to satisfy `\b` on both
// sides — `x > 37` does not qualify, `x>37` or a call like `doIt(37)`
// does — verified empirically), nested-ternary-vs-generic-type-param
// disambiguation, boolean-flag-arg regex anchors, and the commented-out-code
// detector's doc/license/keyword classification regexes plus its ratio
// arithmetic. Each fixture targets a specific regex/boundary behavior;
// see the fixture name for the mechanism under test.
// ─── checkCommentedOutCode — survivor-kill coverage (additional fixtures) ───
describe("checkCommentedOutCode — additional survivor-kill coverage — positive (must fire)", () => {
	it("assignment compound op", () => {
		const found = checkCommentedOutCode(
			"// total += 1;\n// count -= 1;\n// flag |= mask;",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("classify js call dotted multichar", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// obj.method(data)\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("python assignment", () => {
		const found = checkCommentedOutCode(
			"# data = request.json()\n# x = 3\n# y = compute(data)",
			"scripts/x.py",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("classify block closer multi paren", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// }))\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("docpattern double space before marker", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// publish(data);\n//  TODO: fix this\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("classify js assign terminator glued", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// x=5,\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("classify divider dots not ellipsis doc", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// publish(data);\n// ...\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("classify py assign glued", () => {
		const found = checkCommentedOutCode(
			"# save(data)\n# audit(data)\n# x=5\nreal_code()",
			"scripts/x.py",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("classify py call dotted multichar", () => {
		const found = checkCommentedOutCode(
			"# save(data)\n# audit(data)\n# obj.method(data)\nreal_code()",
			"scripts/x.py",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("classify divider start anchor", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// ---; publish(data);\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("classify block closer comma then double space else", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// },  else {\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("licensepattern double space before marker", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// publish(data);\n//  Copyright: Acme\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("classify async function double space", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// async  function foo() {}\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("classify type keyword double space", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// type  X = string\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("classify py async def double space", () => {
		const found = checkCommentedOutCode(
			"# save(data)\n# audit(data)\n# async  def foo\nreal_code()",
			"scripts/x.py",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("classify bare type annotation not anchored", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// publish(data);\n// 1; retries: number\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("classify type keyword single space", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// type X = string\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("case colon not doc", () => {
		const found = checkCommentedOutCode(
			"// case Foo:\n// doWork(a);\n// return a;\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("classify new keyword bare", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// new Foo\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("classify delete keyword bare", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// delete foo\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("classify py from keyword bare", () => {
		const found = checkCommentedOutCode(
			"# save(data)\n# audit(data)\n# from foo\nreal_code()",
			"scripts/x.py",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("classify js call bare multichar", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// save(data)\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("classify js fallback spaced word then equals", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// x = ;\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("classify block closer space then semicolon", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// } ;\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("ext .tsx", () => {
		const found = checkCommentedOutCode(
			"// const a = 1;\n// doWork(a);\n// return a;\nrealCode();",
			"handler.tsx",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("ext .js", () => {
		const found = checkCommentedOutCode(
			"// const a = 1;\n// doWork(a);\n// return a;\nrealCode();",
			"handler.js",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("ext .jsx", () => {
		const found = checkCommentedOutCode(
			"// const a = 1;\n// doWork(a);\n// return a;\nrealCode();",
			"handler.jsx",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("ext .mjs", () => {
		const found = checkCommentedOutCode(
			"// const a = 1;\n// doWork(a);\n// return a;\nrealCode();",
			"handler.mjs",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("ext .cjs", () => {
		const found = checkCommentedOutCode(
			"// const a = 1;\n// doWork(a);\n// return a;\nrealCode();",
			"handler.cjs",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("ext .go", () => {
		const found = checkCommentedOutCode(
			"// const a = 1;\n// doWork(a);\n// return a;\nrealCode();",
			"handler.go",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("ext .rs", () => {
		const found = checkCommentedOutCode(
			"// const a = 1;\n// doWork(a);\n// return a;\nrealCode();",
			"handler.rs",
		);
		expect(found.length).toBeGreaterThan(0);
	});
});

describe("checkCommentedOutCode — additional survivor-kill coverage — negative (must not fire)", () => {
	it("commentprefix js double space", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// publish(data);\n//  retries: number\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found).toEqual([]);
	});
	it("classify angle placeholder multichar", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// publish(data);\n// <foo bar>\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found).toEqual([]);
	});
	it("classify py keyword not anchored", () => {
		const found = checkCommentedOutCode(
			"# save(data)\n# audit(data)\n# x return\nreal_code()",
			"scripts/x.py",
		);
		expect(found).toEqual([]);
	});
	it("flushblock ratio exactly 0.6 boundary", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// publish(data);\n// ====\n// ----\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found).toEqual([]);
	});
	it("classify pipe union doc", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// publish(data);\n// a | b\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found).toEqual([]);
	});
	it("classify bare type annotation glued", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// publish(data);\n// retries:number\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found).toEqual([]);
	});
	it("classify js fallback semicolon not at end", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// x = 1; more\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found).toEqual([]);
	});
	it("classify js call trailing content", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// save(data) extra\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found).toEqual([]);
	});
	it("classify angle placeholder minimal space", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// publish(data);\n// x<  >\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found).toEqual([]);
	});
	it("classify ellipsis doc", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// publish(data);\n// foo ... bar\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found).toEqual([]);
	});
	it("classify bare type annotation space before colon", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// publish(data);\n// retries : number\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found).toEqual([]);
	});
	it("classify jskeyword not anchored", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// x return;\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found).toEqual([]);
	});
	it("classify py assign not anchored", () => {
		const found = checkCommentedOutCode(
			"# save(data)\n# audit(data)\n# )x = 5\nreal_code()",
			"scripts/x.py",
		);
		expect(found).toEqual([]);
	});
	it("classify py call not anchored", () => {
		const found = checkCommentedOutCode(
			"# save(data)\n# audit(data)\n# )save(data)\nreal_code()",
			"scripts/x.py",
		);
		expect(found).toEqual([]);
	});
	it("classify py call trailing content", () => {
		const found = checkCommentedOutCode(
			"# save(data)\n# audit(data)\n# save(data) extra\nreal_code()",
			"scripts/x.py",
		);
		expect(found).toEqual([]);
	});
	it("classify js assign terminator not anchored", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// )x = 5,\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found).toEqual([]);
	});
	it("classify js call not anchored", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// )save(data)\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found).toEqual([]);
	});
	it("classify block closer not anchored", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// x}\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found).toEqual([]);
	});
	it("classify block closer trailing content", () => {
		const found = checkCommentedOutCode(
			"// save(data);\n// audit(data);\n// } extra\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found).toEqual([]);
	});
	it("isTestFile", () => {
		const found = checkCommentedOutCode(
			"// const a = 1;\n// doWork(a);\n// return a;\nrealCode();",
			"util.test.ts",
		);
		expect(found).toEqual([]);
	});
	it("commentprefix py not anchored breaks block", () => {
		const found = checkCommentedOutCode(
			"# save(data)\ny = 1  # audit(data)\n# publish(data)\nreal_code()",
			"scripts/x.py",
		);
		expect(found).toEqual([]);
	});
	it("commentprefix js not anchored breaks block", () => {
		const found = checkCommentedOutCode(
			"// save(data);\ny = 1; // audit(data);\n// publish(data);\nrealCode();",
			"src/lib/app.ts",
		);
		expect(found).toEqual([]);
	});
});

// ─── checkFlagArguments — survivor-kill coverage (additional fixtures) ───
describe("checkFlagArguments — additional survivor-kill coverage — positive (must fire)", () => {
	it("arrow glued colon type", () => {
		const found = checkFlagArguments(
			"const f:MyFn = (a: boolean, b: boolean) => a && b;",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("arrow no space before equals", () => {
		const found = checkFlagArguments(
			"const f=(a: boolean, b: boolean) => a && b;",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("fn space before generic", () => {
		const found = checkFlagArguments(
			"function f <T>(a: boolean, b: boolean) { return a && b; }",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("arrow async double space", () => {
		const found = checkFlagArguments(
			"const f = async  (a: boolean, b: boolean) => a && b;",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("bool param glued default value", () => {
		const found = checkFlagArguments(
			"function f(a:boolean=true, b:boolean=false) { return a && b; }",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("ext .tsx", () => {
		const found = checkFlagArguments(
			"function f(a: boolean, b: boolean) {\n  return a && b;\n}",
			"deploy.tsx",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("ext .mts", () => {
		const found = checkFlagArguments(
			"function f(a: boolean, b: boolean) {\n  return a && b;\n}",
			"deploy.mts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("ext .cts", () => {
		const found = checkFlagArguments(
			"function f(a: boolean, b: boolean) {\n  return a && b;\n}",
			"deploy.cts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("fn double space after function", () => {
		const found = checkFlagArguments(
			"function  f(a: boolean, b: boolean) { return a && b; }",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("fn multichar generic body", () => {
		const found = checkFlagArguments(
			"function f<TFoo>(a: boolean, b: boolean) { return a && b; }",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("fn double space after generic close", () => {
		const found = checkFlagArguments(
			"function f<T>  (a: boolean, b: boolean) { return a && b; }",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("arrow double space after const", () => {
		const found = checkFlagArguments(
			"const  f = (a: boolean, b: boolean) => a && b;",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("arrow multichar name", () => {
		const found = checkFlagArguments(
			"const myFunc = (a: boolean, b: boolean) => a && b;",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("arrow spaced colon type", () => {
		const found = checkFlagArguments(
			"const f : MyFn = (a: boolean, b: boolean) => a && b;",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("cap 10", () => {
		const lines: string[] = [];
		for (let i = 0; i < 12; i++) {
			lines.push(`function f${i}(a: boolean, b: boolean) {`, "  return a && b;", "}");
		}
		const found = checkFlagArguments(lines.join("\n"), "src/lib/app.ts");
		expect(found).toHaveLength(10);
	});
	it("bool param eq default", () => {
		const found = checkFlagArguments(
			"function f(a: boolean = true, b: boolean = false) {\n  return a && b;\n}",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("long line truncation", () => {
		const found = checkFlagArguments(
			`function f(a: boolean, b: boolean, ${"z".repeat(200)}: string) {\n  return a && b;\n}`,
			"src/lib/app.ts",
		);
		expect(found).toHaveLength(1);
		expect(found[0]?.text.length).toBe(140);
	});
	it("indented fn for output text trim", () => {
		const found = checkFlagArguments(
			"    function f(a: boolean, b: boolean) { return a && b; }",
			"src/lib/app.ts",
		);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toBe(
			"[2 boolean params → use options object] function f(a: boolean, b: boolean) { return a && b; }",
		);
	});
});

describe("checkFlagArguments — additional survivor-kill coverage — negative (must not fire)", () => {
	it("no bool params", () => {
		const found = checkFlagArguments(
			"function add(a: number, b: number) {\n  return a + b;\n}",
			"src/lib/app.ts",
		);
		expect(found).toEqual([]);
	});
	it("isTestFile", () => {
		const found = checkFlagArguments(
			"function f(a: boolean, b: boolean) {\n  return a && b;\n}",
			"deploy.test.ts",
		);
		expect(found).toEqual([]);
	});
	it("js ext forces process", () => {
		const found = checkFlagArguments(
			"function f(a: boolean, b: boolean) { return a && b; }",
			"deploy.js",
		);
		expect(found).toEqual([]);
	});
});

// ─── checkNestedTernary — survivor-kill coverage (additional fixtures) ───
describe("checkNestedTernary — additional survivor-kill coverage — positive (must fire)", () => {
	it("real nested ternary after simple generic", () => {
		const found = checkNestedTernary("const t: A<B> = e ? f ? g : h : i;", "src/lib/app.ts");
		expect(found.length).toBeGreaterThan(0);
	});
	it("ext .tsx", () => {
		const found = checkNestedTernary("const x = a ? b ? c : d : e;", "roles.tsx");
		expect(found.length).toBeGreaterThan(0);
	});
	it("ext .js", () => {
		const found = checkNestedTernary("const x = a ? b ? c : d : e;", "roles.js");
		expect(found.length).toBeGreaterThan(0);
	});
	it("ext .jsx", () => {
		const found = checkNestedTernary("const x = a ? b ? c : d : e;", "roles.jsx");
		expect(found.length).toBeGreaterThan(0);
	});
	it("ext .mjs", () => {
		const found = checkNestedTernary("const x = a ? b ? c : d : e;", "roles.mjs");
		expect(found.length).toBeGreaterThan(0);
	});
	it("ext .cjs", () => {
		const found = checkNestedTernary("const x = a ? b ? c : d : e;", "roles.cjs");
		expect(found.length).toBeGreaterThan(0);
	});
	it("long line truncation", () => {
		const found = checkNestedTernary(
			`const x = a ? b ? c : d : e; // ${"z".repeat(200)}`,
			"src/lib/app.ts",
		);
		expect(found).toHaveLength(1);
		expect(found[0]?.text.length).toBe(150);
	});
	it("indented for trim on output text", () => {
		const found = checkNestedTernary("    const x = a ? b ? c : d : e;", "src/lib/app.ts");
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toBe("const x = a ? b ? c : d : e;");
	});
});

describe("checkNestedTernary — additional survivor-kill coverage — negative (must not fire)", () => {
	it("nested generic then ternary min max probe", () => {
		const found = checkNestedTernary("const t: A<B<C> ? D ? E : F : G> = 1;", "src/lib/app.ts");
		expect(found).toEqual([]);
	});
	it("optional chain", () => {
		const found = checkNestedTernary('const x = user?.name?.first ?? "anon";', "src/lib/app.ts");
		expect(found).toEqual([]);
	});
	it("isTestFile", () => {
		const found = checkNestedTernary("const x = a ? b ? c : d : e;", "util.test.ts");
		expect(found).toEqual([]);
	});
	it("py ext with nested ternary content", () => {
		const found = checkNestedTernary("const x = a ? b ? c : d : e;", "util.py");
		expect(found).toEqual([]);
	});
});

// ─── checkMagicNumbers — survivor-kill coverage (additional fixtures) ───
describe("checkMagicNumbers — additional survivor-kill coverage — positive (must fire)", () => {
	it("decl const semi prefix", () => {
		const found = checkMagicNumbers(";const FOO = compute(37);", "src/lib/app.ts");
		expect(found.length).toBeGreaterThan(0);
	});
	it("return semi prefix", () => {
		const found = checkMagicNumbers(";return 37; compute();", "src/lib/app.ts");
		expect(found.length).toBeGreaterThan(0);
	});
	it("case semi prefix", () => {
		const found = checkMagicNumbers(";case 37: compute();", "src/lib/app.ts");
		expect(found.length).toBeGreaterThan(0);
	});
	it("frac multidigit allowed int", () => {
		const found = checkMagicNumbers("if (x === 200.55) return;", "src/lib/app.ts");
		expect(found.length).toBeGreaterThan(0);
	});
	it("ext .tsx", () => {
		const found = checkMagicNumbers("if (x > 42) return;", "f.tsx");
		expect(found.length).toBeGreaterThan(0);
	});
	it("ext .js", () => {
		const found = checkMagicNumbers("if (x > 42) return;", "f.js");
		expect(found.length).toBeGreaterThan(0);
	});
	it("ext .jsx", () => {
		const found = checkMagicNumbers("if (x > 42) return;", "f.jsx");
		expect(found.length).toBeGreaterThan(0);
	});
	it("ext .mjs", () => {
		const found = checkMagicNumbers("if (x > 42) return;", "f.mjs");
		expect(found.length).toBeGreaterThan(0);
	});
	it("ext .cjs", () => {
		const found = checkMagicNumbers("if (x > 42) return;", "f.cjs");
		expect(found.length).toBeGreaterThan(0);
	});
	it("ext .go", () => {
		const found = checkMagicNumbers("if (x > 42) return;", "f.go");
		expect(found.length).toBeGreaterThan(0);
	});
	it("ext .rs", () => {
		const found = checkMagicNumbers("if (x > 42) return;", "f.rs");
		expect(found.length).toBeGreaterThan(0);
	});
	it("ctx call space paren", () => {
		const found = checkMagicNumbers("doSomething (37);", "src/lib/app.ts");
		expect(found.length).toBeGreaterThan(0);
	});
	it("long line truncation", () => {
		const found = checkMagicNumbers(`if (x > 37) return; ${"z".repeat(200)}`, "src/lib/app.ts");
		expect(found).toHaveLength(1);
		expect(found[0]?.text.length).toBe(150);
	});
});

describe("checkMagicNumbers — additional survivor-kill coverage — negative (must not fire)", () => {
	it("return base", () => {
		const found = checkMagicNumbers("return 37; compute();", "src/lib/app.ts");
		expect(found).toEqual([]);
	});
	it("case base", () => {
		const found = checkMagicNumbers("case 37: compute();", "src/lib/app.ts");
		expect(found).toEqual([]);
	});
	it("decl static base", () => {
		const found = checkMagicNumbers("static MAX = compute(37);", "src/lib/app.ts");
		expect(found).toEqual([]);
	});
	it("ctx neither", () => {
		const found = checkMagicNumbers("retryCount 37;", "src/lib/app.ts");
		expect(found).toEqual([]);
	});
	it("isTestFile", () => {
		const found = checkMagicNumbers("if (x > 42) return;", "math.test.ts");
		expect(found).toEqual([]);
	});
	it.each([
		"1",
		"2",
		"-1",
		"-2",
		"10",
		"16",
		"100",
		"1000",
		"200",
		"201",
		"204",
		"301",
		"302",
		"304",
		"400",
		"401",
		"403",
		"404",
		"405",
		"409",
		"422",
		"429",
		"500",
		"502",
		"503",
		"504",
		"32",
		"8",
		"128",
		"64",
		"512",
		"256",
		"2048",
		"1024",
		"4096",
	])("allowed number %s is not flagged in isolation", (n) => {
		const found = checkMagicNumbers(`if (x === ${n}) return;`, "src/lib/app.ts");
		expect(found).toEqual([]);
	});
	it("decl static double sp", () => {
		const found = checkMagicNumbers("static  readonly MAX = compute(37);", "src/lib/app.ts");
		expect(found).toEqual([]);
	});
	it("return double sp", () => {
		const found = checkMagicNumbers("return  37; compute();", "src/lib/app.ts");
		expect(found).toEqual([]);
	});
	it("case double sp", () => {
		const found = checkMagicNumbers("case  37: compute();", "src/lib/app.ts");
		expect(found).toEqual([]);
	});
});

// ─── checkNegatedConditionWithElse — survivor-kill coverage (additional fixtures) ───
describe("checkNegatedConditionWithElse — additional survivor-kill coverage — positive (must fire)", () => {
	it("nested braces with else", () => {
		const found = negated([
			"function f(x) {",
			"  if (!x) {",
			"    if (y) {",
			"      doA();",
			"    }",
			"    doB();",
			"  } else {",
			"    doC();",
			"  }",
			"}",
		]);
		expect(found.length).toBeGreaterThan(0);
	});
	it("close brace end of line else next", () => {
		const found = checkNegatedConditionWithElse(
			"function f(x) {\n  if (!x) {\n    doA();\n  }\nelse {\n    doB();\n  }\n}",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("if dotted ident", () => {
		const found = negated([
			"function f(o) {",
			"  if (!o.flag) {",
			"    doA();",
			"  } else {",
			"    doB();",
			"  }",
			"}",
		]);
		expect(found.length).toBeGreaterThan(0);
	});
	it.each([".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"])(
		"extension %s fires",
		(ext) => {
			const found = negated(
				["function f(x) {", "  if (!x) {", "    doA();", "  } else {", "    doB();", "  }", "}"],
				`form${ext}`,
			);
			expect(found.length).toBeGreaterThan(0);
		},
	);
	it("cap 10", () => {
		const lines: string[] = [];
		for (let i = 0; i < 12; i++) {
			lines.push(
				`function f${i}(x) {`,
				"  if (!x) {",
				`    doA${i}();`,
				"  } else {",
				`    doB${i}();`,
				"  }",
				"}",
			);
		}
		expect(negated(lines)).toHaveLength(10);
	});
	it("if regex double sp", () => {
		const found = checkNegatedConditionWithElse(
			"function f(x) {\n  if  (!x) {\n    doA();\n  } else {\n    doB();\n  }\n}",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("if paren double sp", () => {
		const found = checkNegatedConditionWithElse(
			"function f(x) {\n  if (  !x) {\n    doA();\n  } else {\n    doB();\n  }\n}",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("if bang double sp", () => {
		const found = checkNegatedConditionWithElse(
			"function f(x) {\n  if (!  x) {\n    doA();\n  } else {\n    doB();\n  }\n}",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("if close paren double sp", () => {
		const found = checkNegatedConditionWithElse(
			"function f(x) {\n  if (!x  ) {\n    doA();\n  } else {\n    doB();\n  }\n}",
			"src/lib/app.ts",
		);
		expect(found.length).toBeGreaterThan(0);
	});
	it("long line truncation", () => {
		const found = checkNegatedConditionWithElse(
			`function f(x) {\n  if (!x) { ${"z".repeat(200)}\n    doA();\n  } else {\n    doB();\n  }\n}`,
			"src/lib/app.ts",
		);
		expect(found).toHaveLength(1);
		expect(found[0]?.text.length).toBe(150);
	});
});

describe("checkNegatedConditionWithElse — additional survivor-kill coverage — negative (must not fire)", () => {
	it("closer exactly at 51st line", () => {
		const lines = ["function f(x) {", "  if (!x) {"];
		for (let k = 0; k < 49; k++) lines.push(`    step${k}();`);
		lines.push("  } else {", "    doB();", "  }", "}");
		expect(negated(lines)).toEqual([]);
	});
	it("closer is last line no next", () => {
		const found = checkNegatedConditionWithElse(
			"function f(x) {\n  if (!x) {\n    doA();\n  }",
			"src/lib/app.ts",
		);
		expect(found).toEqual([]);
	});
	it("next line else glued no space", () => {
		const found = checkNegatedConditionWithElse(
			"function f(x) {\n  if (!x) {\n    doA();\n  }\nx;else();\n}",
			"src/lib/app.ts",
		);
		expect(found).toEqual([]);
	});
	it("decoy else before close brace", () => {
		const found = checkNegatedConditionWithElse(
			"function f(x) {\n  if (!x) {\n    foo(); else; }\n  bar();\n}",
			"src/lib/app.ts",
		);
		expect(found).toEqual([]);
	});
	it("isTestFile", () => {
		const found = checkNegatedConditionWithElse(
			"function f(x) {\n  if (!x) {\n    doA();\n  } else {\n    doB();\n  }\n}",
			"form.test.ts",
		);
		expect(found).toEqual([]);
	});
});
