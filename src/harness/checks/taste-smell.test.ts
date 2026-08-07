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
