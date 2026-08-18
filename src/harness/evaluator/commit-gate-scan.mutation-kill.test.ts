// Mutation-kill campaign for commit-gate-scan.ts (scratch/fleet-r3, wave pass1_w23).
// Targets the ~50 mutants the manifest reported as "survived" against the existing
// companion suite (commit-gate-scan.test.ts). Two mutants proven equivalent by
// reading + fuzz-simulation are NOT retested here (see the receipt): the
// `crapHitsPerFunction` `staleTolerance` literal (dead — `coverageMtime` is
// hardcoded `null`, so the only branch that reads it never runs) and
// `countInRange`'s `n++`→`n--` (the ratio `inCovered/(inCovered+inUncovered)` is
// invariant under negating both terms, so no observable field ever differs).
import { describe, expect, it } from "vitest";
import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import {
	type ChangedSource,
	coverageViolation,
	crapViolation,
	cyclomaticViolation,
	hasPerLineData,
	isTypeOnlySource,
} from "./commit-gate-scan.js";

const SRC: ChangedSource = { relPath: "src/m.ts", language: "ts" };

function perFn(functions: PerFileCoverage["functions"]): PerFileCoverage {
	return { filePath: "src/m.ts", mtime: 0, functions };
}

describe("hasPerLineData — mutation kill", () => {
	// test-contract: boundary — kills 46b7a44333d5e4e8 (`cov.coveredLines !==
	// undefined` forced to `false`, collapsing the OR to just the uncoveredLines
	// half): coveredLines alone (uncoveredLines absent) must still read as per-line.
	it("is true when only coveredLines is present", () => {
		expect(hasPerLineData({ ...perFn([]), coveredLines: new Set([1]) })).toBe(true);
	});
});

describe("coverageViolation — mutation kill", () => {
	// test-contract: invariant — kills 5331e844a54b0dff (firstUncoveredLine's
	// `lowest===null||ln<lowest` forced to `true`, which would report the LAST
	// iterated Set member instead of the minimum) and 6eff8a585ba235c0 (the
	// per-line branch's `kind: "uncovered"` literal emptied) via a full toEqual.
	it("reports the minimum uncovered line, not merely the last one iterated", () => {
		const cov: PerFileCoverage = { ...perFn([]), uncoveredLines: new Set([1, 3]) };
		expect(coverageViolation(SRC, cov)).toEqual({
			kind: "uncovered",
			file: SRC.relPath,
			detail: "line 1 is executable but uncovered",
		});
	});

	// test-contract: boundary — kills 819aa215fc72d8b1 (`hits===0||pct===0`
	// forced to `&&`) and 74d91d598cebae78 (`hits===0` forced to `false`): a
	// function with hits=0 but a nonzero statement_pct must still be flagged.
	it("flags hits=0 even when statement_pct is nonzero", () => {
		const cov = perFn([{ name: "f", line: 2, endLine: 4, hits: 0, statement_pct: 50 }]);
		expect(coverageViolation(SRC, cov)).toEqual({
			kind: "uncovered",
			file: SRC.relPath,
			detail: "`f` (line 2) is executable but uncovered",
		});
	});

	// test-contract: boundary — kills 85c61e23971bc84a (`statement_pct===0`
	// forced to `false`): a function with statement_pct=0 but nonzero hits must
	// still be flagged.
	it("flags statement_pct=0 even when hits is nonzero", () => {
		const cov = perFn([{ name: "g", line: 6, endLine: 9, hits: 5, statement_pct: 0 }]);
		expect(coverageViolation(SRC, cov)).toEqual({
			kind: "uncovered",
			file: SRC.relPath,
			detail: "`g` (line 6) is executable but uncovered",
		});
	});
});

describe("crapViolation / countInRange (per-line path) — mutation kill", () => {
	// test-contract: boundary — kills 10 countInRange survivors at once by
	// pinning the exact range-membership count at both boundaries:
	// a9fb9e71a9c691fc (loop body emptied), 3fe3ccbaadbf33b9 / 31b2b74d4a42295c
	// (membership test forced true/false), 28be2de8a7729499 (&&→||, a tautology
	// whenever start<=end), 9d8d3dfff11aef08 (`ln>=start` forced true),
	// b679a2486a30b222 / 94b603b31a02664b (>=→>/< at the start boundary),
	// f695c0ab39798217 (`ln<=end` forced true), f10e423ba708fd3d / 9af9a55a957d83dd
	// (<=→</> at the end boundary). Also kills the crapHitsPerLine-level survivors
	// e948b055712d83af (whole loop body emptied), 8e49fda85d6bb238 (+ forced to -),
	// 90a37ca578f15092 and bb525937481bdd15 (percentage arithmetic mangled), and
	// 4dc4d5fff6171c21 / cc89d9415cd5f73f (always-skip variants) — every one of
	// these turns this deliberately-nonzero scenario into `null` or a different
	// rounded percentage/score.
	it("counts range membership exactly at both boundaries", () => {
		const fn: FunctionComplexityEntry = { name: "f", line: 10, endLine: 12, cyclomatic: 5, language: "js_ts" };
		const cov: PerFileCoverage = {
			...perFn([]),
			coveredLines: new Set([9, 10, 11, 13]), // 9 below start, 10 at start, 11 inside, 13 above end
			uncoveredLines: new Set([12]), // exactly at end
		};
		expect(crapViolation(SRC, [fn], cov, 0)).toEqual({
			kind: "crap",
			file: SRC.relPath,
			detail: "`f` (line 10) has a CRAP score of 6 (cyclomatic 5, coverage 67%)",
		});
	});

	// test-contract: boundary — kills 72b7e3527a702c5f (`executable===0`
	// forced to `false`) and cd01d435d56cb630 (===0 flipped to !==0): a function
	// with NO covered or uncovered lines in its range must be skipped entirely,
	// not turned into a NaN-laden finding.
	it("skips a function with zero executable lines in its range", () => {
		const fn: FunctionComplexityEntry = { name: "h", line: 100, endLine: 101, cyclomatic: 5, language: "js_ts" };
		const cov: PerFileCoverage = { ...perFn([]), coveredLines: new Set([1]), uncoveredLines: new Set([2]) };
		expect(crapViolation(SRC, [fn], cov, 0)).toBeNull();
	});

	// test-contract: boundary — kills 1186926fd4a9bad1 (`score<threshold`
	// forced to `<=`): a function whose CRAP score exactly EQUALS the threshold
	// must still report — the "at/above threshold" contract from the doc comment.
	it("reports a function whose CRAP score exactly equals the threshold", () => {
		const fn: FunctionComplexityEntry = { name: "eq", line: 1, endLine: 2, cyclomatic: 1, language: "js_ts" };
		const cov: PerFileCoverage = { ...perFn([]), coveredLines: new Set([1, 2]), uncoveredLines: new Set() };
		expect(crapViolation(SRC, [fn], cov, 1)).toEqual({
			kind: "crap",
			file: SRC.relPath,
			detail: "`eq` (line 1) has a CRAP score of 1 (cyclomatic 1, coverage 100%)",
		});
	});

	// test-contract: invariant — kills e77a85a133258ae7 (the worst-first
	// `.sort()` call replaced by a no-op) and 6732feb9c101312f (its comparator
	// gutted to `() => undefined`, which sort treats as "always equal" and so
	// leaves insertion order intact): `high` is pushed AFTER `low` but must still
	// sort to hits[0].
	it("orders CRAP hits worst-first, not insertion order", () => {
		const low: FunctionComplexityEntry = { name: "low", line: 1, endLine: 2, cyclomatic: 2, language: "js_ts" };
		const high: FunctionComplexityEntry = { name: "high", line: 10, endLine: 11, cyclomatic: 10, language: "js_ts" };
		const cov: PerFileCoverage = {
			...perFn([]),
			coveredLines: new Set([1, 2]),
			uncoveredLines: new Set([10, 11]),
		};
		expect(crapViolation(SRC, [low, high], cov, 1)).toEqual({
			kind: "crap",
			file: SRC.relPath,
			detail: "`high` (line 10) has a CRAP score of 110 (cyclomatic 10, coverage 0%)",
		});
	});

	// test-contract: bug — kills 30abe71e3f890000 (`cov.coveredLines ??
	// new Set()` forced to `&&`, which — since a defined Set is truthy — silently
	// discards real covered-line data in favor of a fresh empty Set).
	it("uses the real coveredLines data, not a discarded-and-replaced empty set", () => {
		const fn: FunctionComplexityEntry = { name: "f", line: 5, endLine: 6, cyclomatic: 5, language: "js_ts" };
		const cov: PerFileCoverage = { ...perFn([]), coveredLines: new Set([5, 6]), uncoveredLines: new Set() };
		expect(crapViolation(SRC, [fn], cov, 0)).toEqual({
			kind: "crap",
			file: SRC.relPath,
			detail: "`f` (line 5) has a CRAP score of 5 (cyclomatic 5, coverage 100%)",
		});
	});

	// test-contract: bug — kills 2705056b66dd05c7 (`cov.uncoveredLines ??
	// new Set()` forced to `&&`, the same discard-a-truthy-Set failure on the
	// uncovered side).
	it("uses the real uncoveredLines data, not a discarded-and-replaced empty set", () => {
		const fn: FunctionComplexityEntry = { name: "g", line: 20, endLine: 21, cyclomatic: 3, language: "js_ts" };
		const cov: PerFileCoverage = { ...perFn([]), coveredLines: new Set(), uncoveredLines: new Set([20, 21]) };
		expect(crapViolation(SRC, [fn], cov, 0)).toEqual({
			kind: "crap",
			file: SRC.relPath,
			detail: "`g` (line 20) has a CRAP score of 12 (cyclomatic 3, coverage 0%)",
		});
	});
});

describe("cyclomaticViolation / firstOverCapCyclomatic — mutation kill", () => {
	// test-contract: invariant — kills 86c919de2899c6dc (`!worst ||
	// fn.cyclomatic > worst.cyclomatic` forced to `true`): `worst` would become
	// whichever over-cap function was seen LAST instead of the one with the
	// highest cyclomatic complexity.
	it("keeps the highest-complexity over-cap function, not merely the last one seen", () => {
		const first: FunctionComplexityEntry = { name: "first", line: 1, endLine: 20, cyclomatic: 30, language: "js_ts" };
		const second: FunctionComplexityEntry = { name: "second", line: 21, endLine: 40, cyclomatic: 27, language: "js_ts" };
		expect(cyclomaticViolation(SRC, [first, second], 25)).toEqual({
			kind: "cyclomatic",
			file: SRC.relPath,
			detail: "`first` (line 1) has cyclomatic complexity 30 (cap 25)",
		});
	});
});

// THE missing-coverage EXEMPTION's detector (see commit-gate-scan.test.ts for the
// documented positive/negative baseline). These cases target survivors that need
// specific control-flow shapes (nested braces, continuation-tracking, the "| "/"& "
// starter literals) the existing suite's inputs never exercised.
describe("isTypeOnlySource — mutation kill", () => {
	// test-contract: boundary — kills 05004931321955fb (`raw.trim()` forced to
	// `raw`): an indented top-level type-only line must still be recognized once
	// leading whitespace is stripped.
	it("trims indentation before matching starters", () => {
		expect(isTypeOnlySource("\ttype X = number;\n")).toBe(true);
	});

	// test-contract: invariant — kills 53792746a339be91 (the depth `+=` inside
	// the "already inside a type body" branch forced to `-=`): a brace NESTED
	// inside an interface must still net back to depth 0 at the close.
	it("tracks nested brace depth correctly inside an already-open type body", () => {
		expect(isTypeOnlySource("interface T {\n\tnested: {\n\t\ta: number;\n\t};\n}\n")).toBe(true);
	});

	// test-contract: invariant — kills 996e599d8cf7aabd (the whole continuation
	// branch body emptied, dropping its `continue` so the line falls through to
	// the starter check) and 5d37db485bea055f (`if (continuation)` forced to
	// `if (false)`, externally identical to emptying the block): a continuation
	// line with no starter prefix of its own must still be swallowed as type-only.
	it("treats a continuation line as type-only without falling through to the starter check", () => {
		expect(isTypeOnlySource("type X =\n\tnumber;\n")).toBe(true);
	});

	// test-contract: invariant — kills cf173309e2de2000 (the depth `+=` inside
	// the continuation branch forced to `-=`): a brace opened INSIDE a
	// continuation body must still net back to depth 0 once it closes.
	it("tracks nested brace depth inside a continuation body", () => {
		expect(isTypeOnlySource("type X =\n\t{\n\t\ta: number;\n\t};\n")).toBe(true);
	});

	// test-contract: boundary — kills cab3749be2a52ad2 (`line.endsWith(";")`
	// forced to `true`) and 2029c55125db136d (the `";"` literal emptied, which
	// makes endsWith trivially always-true too): a continuation line NOT ending
	// in `;` must not end the continuation early.
	it("keeps continuation active until a line genuinely ends with a semicolon", () => {
		expect(isTypeOnlySource("type X =\n\tPart1 |\n\tPart2;\n")).toBe(true);
	});

	// test-contract: boundary — kills 07cf13b5602f3184 (`line.endsWith(";")`
	// forced to `false`), 35a86d263e7e0091 (endsWith swapped for startsWith), and
	// 656be23a75c59b68 (the `continuation = false` reset assignment forced to
	// `true`): once a continuation line genuinely ends with `;`, a LATER
	// executable statement must be detected, not swallowed forever.
	it("stops treating lines as continuation once a semicolon actually ends the alias", () => {
		expect(isTypeOnlySource("type X =\n\tnumber;\nconsole.log(1);\n")).toBe(false);
	});

	// test-contract: boundary — kills 435d4f53211e622c (the single-quote
	// side-effect-import check's `startsWith` swapped for `endsWith`): a starter
	// line that happens to END with the literal text "import '" must not be
	// misread as a side-effect import.
	it("checks the single-quote side-effect import by prefix, not by a coincidental suffix", () => {
		expect(isTypeOnlySource("type X = import '\n")).toBe(true);
	});

	// test-contract: invariant — kills 880928cf2572c589 (`depth === 0` forced
	// to `true`): a starter line whose OWN braces leave depth nonzero must not
	// start a bogus continuation that later swallows a real executable statement.
	it("only starts a type-alias continuation when the starter line's own braces net to zero", () => {
		expect(isTypeOnlySource("interface T { x =\n\tnumber;\n}\nweird_executable_call();\n")).toBe(false);
	});

	// test-contract: boundary — kills d750189e0cb56094 (`continuation = true`
	// forced to `false`), fa56da329f4899af (`depth === 0` flipped to `!== 0`), and
	// 667146a912774d19 (`line.endsWith("=")` swapped for `startsWith("=")`): a
	// simple trailing-equals alias line must still mark the NEXT line as a
	// continuation.
	it("starts a continuation for a simple trailing-equals alias line", () => {
		expect(isTypeOnlySource("type X =\n\tSomeType;\n")).toBe(true);
	});

	// test-contract: boundary — kills e77690ceeab565b5 (the "| " starter
	// literal emptied to "" — since every string startsWith(""), `.find()` still
	// "matches", but the found value is the falsy empty string, so `!starter`
	// is true anyway and the line is wrongly flagged executable).
	it("recognizes a top-level union-continuation marker via the '| ' starter", () => {
		expect(isTypeOnlySource("| standalone\n")).toBe(true);
	});

	// test-contract: boundary — kills ce9212acc142fd22 (the "& " starter
	// literal emptied to "", the same falsy-empty-match failure as above).
	it("recognizes a top-level intersection-continuation marker via the '& ' starter", () => {
		expect(isTypeOnlySource("& standalone\n")).toBe(true);
	});
});
