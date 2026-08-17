// Mutation-kill companion for maintainability.ts (LEAN MODE, pass-1 fleet, W6).
// Pristine-source kills only — no mutant modules are built or run (see
// scratch/fleet-r3/CONTRACT-W6.md, LEAN MODE section). The two "AST
// unavailable" guard mutants (`!parsed`, `!measured`) live in the sibling
// maintainability.parsed-null.mutation-kill.test.ts instead: `vi.mock` is
// file-hoisted, so mocking cyclomatic-ast.js here would silently force every
// other test below onto the null-parse path too.
//
// A structural note for anyone re-measuring this file: the fleet inventory
// also flagged the .sort() comparator (computeMaintainability), the
// `default:` case (cyclomaticOf.walk), the `vocabulary>0` guard
// (halsteadFrom), all 14 isIgnorableKind survivors, and its call site in
// tallyTokens as suspected-equivalent — see
// scratch/fleet-r3/receipts/src_harness_checks_maintainability.ts.jsonl for
// the one-line structural argument behind each. None of those are targeted
// below on purpose.

import { describe, expect, it } from "vitest";
import {
	computeMaintainability,
	HALSTEAD_DIFFICULTY_CEILING,
	HALSTEAD_VOLUME_FLOOR,
	maintainabilityCheck,
	maintainabilityIndex,
} from "./maintainability.js";

function fnNamed(src: string, name: string, minTextForTally = 0) {
	const all = computeMaintainability(src, "src/thing.ts", minTextForTally);
	return all?.find((f) => f.name === name);
}

describe("computeMaintainability — the length pre-filter", () => {
	// test-contract: invariant — computeMaintainability's own documented perf-guard:
	// a function shorter than minTextForTally is skipped entirely, not just
	// measured-then-hidden.
	it("skips a function shorter than the minTextForTally floor", () => {
		const src = "function f(a, b) { return a + b; }";
		expect(computeMaintainability(src, "x.ts", 1000)).toEqual([]);
	});

	// test-contract: boundary — the filter is `< minTextForTally`, an EXCLUSIVE
	// bound: a function whose own span exactly equals the floor must NOT be
	// skipped (an off-by-one `<=` would wrongly drop it).
	it("includes a function whose span exactly equals the minTextForTally floor", () => {
		const fnSrc = "function f(a,b){return a+b;}";
		const all = computeMaintainability(fnSrc, "x.ts", fnSrc.length);
		expect(all).toHaveLength(1);
	});

	// test-contract: invariant — the filter measures the FUNCTION's own span
	// (getEnd() - getStart(sf)), not its absolute offset into the file; leading
	// content before the function must never change whether it gets filtered.
	it("computes the pre-filter length from the function's own span, not its absolute position", () => {
		const padding = "// padding comment to push the function's start position forward\n".repeat(5);
		const fnSrc = "function f(a,b){return a+b;}";
		const src = padding + fnSrc;
		expect(computeMaintainability(src, "x.ts", fnSrc.length + 5)).toEqual([]);
	});
});

describe("computeMaintainability — loc", () => {
	// test-contract: invariant — loc is Math.max(1, endLine - startLine + 1); a
	// known 3-line function pins both that arithmetic and the max(1,...) floor
	// direction (a min() would collapse every multi-line function's loc to 1).
	it("computes loc from the function's own start/end lines", () => {
		const src = "function f() {\n\treturn 1;\n}\n";
		expect(fnNamed(src, "f")?.loc).toBe(3);
	});
});

describe("cyclomaticOf — decision points via computeMaintainability", () => {
	// test-contract: public-api — cyclomatic = 1 + decision points; `if` is the
	// canonical decision point and the first entry in the switch-case group.
	it("counts an if statement", () => {
		expect(fnNamed("function f(a) { if (a) { return 1; } return 0; }", "f")?.cyclomatic).toBe(2);
	});

	// test-contract: public-api — `&&` is a decision point per the module's own
	// documented definition (mirrors complexityOf in cyclomatic-ast.ts).
	it("counts a logical AND", () => {
		expect(fnNamed("function f(a,b) { return a && b; }", "f")?.cyclomatic).toBe(2);
	});

	// test-contract: public-api — `||` is a decision point.
	it("counts a logical OR", () => {
		expect(fnNamed("function f(a,b) { return a || b; }", "f")?.cyclomatic).toBe(2);
	});

	// test-contract: public-api — `??` is a decision point; the module header
	// comment calls out `??` counting as the differentiator from the regex walker.
	it("counts a nullish coalescing operator", () => {
		expect(fnNamed("function f(a,b) { return a ?? b; }", "f")?.cyclomatic).toBe(2);
	});

	// test-contract: public-api — a plain arithmetic binary expression is NOT a
	// decision point; cyclomatic must stay at the base value of 1.
	it("does not count a plain arithmetic binary expression", () => {
		expect(fnNamed("function f(a,b) { return a + b; }", "f")?.cyclomatic).toBe(1);
	});
});

describe("halsteadFrom — zero-operand guard", () => {
	// test-contract: boundary — n2 (distinct operands) is 0 for an operand-free
	// function body; difficulty's ternary must take its `: 0` branch rather than
	// computing (n1/2)*(N2/0), which is NaN.
	it("reports difficulty 0 for a function with zero operands", () => {
		const fn = fnNamed("const noop = () => {};", "noop");
		expect(fn?.halstead.unique_operands).toBe(0);
		expect(fn?.halstead.difficulty).toBe(0);
	});
});

describe("isOperandKind — every operand kind is tallied as an operand", () => {
	// test-contract: public-api — every kind isOperandKind checks is exercised: a
	// misclassified kind folds into unique_operators instead, dropping the count
	// by exactly one.
	it.each<[string, string, string, number]>([
		["PrivateIdentifier", "class C { #p = 1; m() { return this.#p; } }", "m", 2],
		["NumericLiteral", "function f() { return 123; }", "f", 2],
		["BigIntLiteral", "function f() { return 123n; }", "f", 2],
		["StringLiteral", 'function f() { return "hi"; }', "f", 2],
		["NoSubstitutionTemplateLiteral", "function f() { return `hi`; }", "f", 2],
		["RegularExpressionLiteral", "function f() { return /ab/g; }", "f", 2],
		["TrueKeyword", "function f() { return true; }", "f", 2],
		["FalseKeyword", "function f() { return false; }", "f", 2],
		["NullKeyword", "function f() { return null; }", "f", 2],
		// The extra count here is the "x" parameter, a second operand distinct
		// from "f" and "undefined" (a TYPE-position UndefinedKeyword — "undefined"
		// in an expression position is an ordinary Identifier, not this kind).
		["UndefinedKeyword", "function f(x: undefined) { return x; }", "f", 3],
	])("%s counts as an operand", (_label, src, name, expectedUniqueOperands) => {
		expect(fnNamed(src, name)?.halstead.unique_operands).toBe(expectedUniqueOperands);
	});
});

describe("maintainabilityCheck — filter conditions independently", () => {
	// Every fixture's identifier is deliberately long: maintainabilityCheck
	// internally re-runs computeMaintainability with MIN_TEXT_FOR_TALLY (200
	// chars), a CHARACTER-length gate wholly separate from Halstead's token-COUNT
	// volume/difficulty. A short identifier (e.g. "a") keeps the arrow function's
	// own span under 200 chars, so it never reaches the `.filter()` predicate
	// these cases target at all — both the real code and every mutant would
	// then agree on `[]` for the wrong reason. A long identifier changes no
	// token COUNT (same n1/n2/N1/N2), only the character span, so it clears the
	// outer gate without moving volume or difficulty.
	const ID = "operandNameThatIsLongEnough";

	// test-contract: boundary — the filter is volume>=FLOOR && difficulty>CEILING;
	// this fixture isolates the volume side by being ABOVE the difficulty ceiling
	// while staying UNDER the volume floor, so it must stay silent.
	it("stays silent when difficulty is high but volume is under the floor", () => {
		const ops = ["+", "-", "*", "/", "%", "**", "&", "|", "^", "<<", ">>", ">>>"];
		const body = ID + ops.map((op) => op + ID).join("");
		const src = `const sparse = ${ID} => ${body};`;
		const fn = fnNamed(src, "sparse");
		expect(fn?.halstead.volume).toBeLessThan(HALSTEAD_VOLUME_FLOOR);
		expect(fn?.halstead.difficulty).toBeGreaterThan(HALSTEAD_DIFFICULTY_CEILING);
		expect(maintainabilityCheck(src, "x.ts")).toEqual([]);
	});

	// test-contract: boundary — volume>=FLOOR is an INCLUSIVE bound: a function
	// whose volume lands exactly on HALSTEAD_VOLUME_FLOOR (200) must still fire
	// (a `>` mutant would wrongly silence it).
	it("fires when volume lands exactly on the floor", () => {
		// n1=15 (=> plus these 14 ops), n2=1; a leading unary "-" plus 9 extra
		// "+ID" repeats lands length=50 exactly (vocab=16, log2=4) — verified
		// against the real module in scratch/w6-probe-maintainability.mts.
		const ops = ["+", "-", "*", "/", "%", "**", "&", "|", "^", "<<", ">>", ">>>", "&&", "||"];
		const body = `-${ID}${ops.map((op) => op + ID).join("")}${`+${ID}`.repeat(9)}`;
		const src = `const dense200 = ${ID} => ${body};`;
		const fn = fnNamed(src, "dense200");
		expect(fn?.halstead.volume).toBe(HALSTEAD_VOLUME_FLOOR);
		expect(fn?.halstead.difficulty).toBeGreaterThan(HALSTEAD_DIFFICULTY_CEILING);
		expect(maintainabilityCheck(src, "x.ts")).toHaveLength(1);
	});

	// test-contract: boundary — difficulty>CEILING is an EXCLUSIVE bound: a
	// function whose difficulty lands exactly on HALSTEAD_DIFFICULTY_CEILING (80)
	// must stay silent (a `>=` mutant would wrongly fire on it).
	it("stays silent when difficulty lands exactly on the ceiling", () => {
		const body = ID + `+${ID}`.repeat(78);
		const src = `const diff80 = ${ID} => ${body};`;
		const fn = fnNamed(src, "diff80");
		expect(fn?.halstead.difficulty).toBe(HALSTEAD_DIFFICULTY_CEILING);
		expect(fn?.halstead.volume).toBeGreaterThanOrEqual(HALSTEAD_VOLUME_FLOOR);
		expect(maintainabilityCheck(src, "x.ts")).toEqual([]);
	});
});

describe("maintainabilityIndex — the volume and loc log-guards", () => {
	// test-contract: boundary — volume>0 gates whether Math.log(volume) runs; at
	// volume=0 the ternary must use 0, not Math.log(0)=-Infinity, which would
	// swamp `raw` to +Infinity and clamp the result to 100 instead of the true,
	// cyclomatic/loc-driven score of 0.
	it("does not let a zero volume dominate the formula via -Infinity", () => {
		expect(maintainabilityIndex(0, 200, 5000)).toBe(0);
	});

	// test-contract: boundary — loc>0 gates whether Math.log(loc) runs; same
	// -Infinity hazard as volume, isolated to the loc term this time.
	it("does not let a zero loc dominate the formula via -Infinity", () => {
		expect(maintainabilityIndex(1e9, 2000, 0)).toBe(0);
	});
});

describe("tallyTokens — the empty-text guard", () => {
	// test-contract: invariant — a function with an empty parameter list produces
	// an empty SyntaxList leaf (zero children, text ""); the `!text` guard must
	// skip it rather than tallying an operator keyed by the empty string (which
	// would inflate unique_operators by one).
	it("does not tally the empty parameter-list SyntaxList as an operator", () => {
		const fn = fnNamed("function f() { return 1; }", "f");
		expect(fn?.halstead.unique_operators).toBe(7);
	});
});
