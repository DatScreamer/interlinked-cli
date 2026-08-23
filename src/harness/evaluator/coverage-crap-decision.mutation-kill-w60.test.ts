import { describe, expect, it } from "vitest";
import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import type { HarnessDecision } from "../types.js";
import { decideCrap, hasPerLineData } from "./coverage-crap-decision.js";
import type { CrapInput, CyclomaticAnalyzer } from "./coverage-crap-decision.js";

// Fail-open callback: none of these tests expect it to fire (an analyzer is
// always supplied), so a call is itself a signal something is wrong.
function onDegrade(relPath: string, why: string): HarnessDecision {
	return { decision: "allow", reason: `unexpected-degrade:${relPath}:${why}` };
}

function fn(
	name: string,
	line: number,
	endLine: number,
	cyclomatic: number,
): FunctionComplexityEntry {
	return { name, line, endLine, cyclomatic, language: "js_ts" };
}

function analyzerReturning(entries: FunctionComplexityEntry[]): CyclomaticAnalyzer {
	return () => entries;
}

function perLineCoverage(covered: number[], uncovered: number[]): PerFileCoverage {
	return {
		filePath: "x.py",
		mtime: 0,
		functions: [],
		coveredLines: new Set(covered),
		uncoveredLines: new Set(uncovered),
	};
}

function baseInput(overrides: Partial<CrapInput>): CrapInput {
	return {
		relPath: "x.py",
		proposed: "irrelevant-content",
		cov: perLineCoverage([], []),
		editedLines: undefined,
		threshold: 30,
		analyzer: analyzerReturning([]),
		...overrides,
	};
}

describe("hasPerLineData — mutant 23c342d6 (coveredLines !== undefined -> false)", () => {
	it("is true when only coveredLines is set (uncoveredLines absent)", () => {
		const cov: PerFileCoverage = { filePath: "x", mtime: 0, functions: [], coveredLines: new Set([1]) };
		expect(hasPerLineData(cov)).toBe(true);
	});

	it("is false when neither line set is present", () => {
		const cov: PerFileCoverage = { filePath: "x", mtime: 0, functions: [] };
		expect(hasPerLineData(cov)).toBe(false);
	});
});

describe("crapTouches (via decideCrap) — single-line function edited", () => {
	// Kills: c5c0f99e (ln<=endLine->false), bee554cc (ln<endLine), 9485f66b
	// (ln>endLine), 979dc960 (block body emptied), 6f36265d (has()->false).
	// With a single-line function (line === endLine) every one of those
	// mutations makes the loop never register the edited line, so
	// crapTouches falsely returns false and decideCrap returns null instead
	// of blocking.
	it("blocks when the edited line matches the function's single line", () => {
		const decision = decideCrap(
			baseInput({
				editedLines: new Set([5]),
				analyzer: analyzerReturning([fn("targetFn", 5, 5, 5)]),
				cov: perLineCoverage([], [5]), // 0% coverage -> score = 25 + 5 = 30
				threshold: 30,
			}),
			onDegrade,
		);
		expect(decision).not.toBeNull();
		expect(decision?.decision).toBe("block");
	});

	it("does not block when the edited lines never touch the function", () => {
		const decision = decideCrap(
			baseInput({
				editedLines: new Set([999]),
				analyzer: analyzerReturning([fn("targetFn", 5, 5, 5)]),
				cov: perLineCoverage([], [5]),
				threshold: 30,
			}),
			onDegrade,
		);
		expect(decision).toBeNull();
	});
});

describe("countInRange (via crapViolationsPerLine)", () => {
	// Kills d5c7ff0f: `ln >= start` -> `ln > start`. At ln === start === end,
	// the covered line stops being counted, executable drops to 0, and the
	// function is skipped entirely instead of scoring 35 (>= threshold 30).
	it("counts a covered line exactly at the range start (>= boundary)", () => {
		const decision = decideCrap(
			baseInput({
				editedLines: undefined,
				analyzer: analyzerReturning([fn("edgeFn", 1, 1, 35)]),
				cov: perLineCoverage([1], []),
				threshold: 30,
			}),
			onDegrade,
		);
		expect(decision).not.toBeNull();
	});

	// Kills f2fa8cd3: `ln >= start` -> `true` (drops the lower bound, so a
	// line below `start` gets wrongly counted). Function range is [5,5];
	// an uncovered line at 2 (below start) must NOT count toward the
	// function's executable-line total, so coverage stays 100%.
	it("does not count a line below the range start", () => {
		const decision = decideCrap(
			baseInput({
				editedLines: undefined,
				analyzer: analyzerReturning([fn("boundFn", 5, 5, 10)]),
				cov: perLineCoverage([5], [2]),
				threshold: 1,
			}),
			onDegrade,
		);
		expect(decision).not.toBeNull();
		expect(decision?.reason).toContain("coverage 100%");
	});
});

describe("crapViolationsPerLine — executable/threshold boundaries", () => {
	// Kills 25b493711 (`executable === 0` -> false). With no covered or
	// uncovered lines inside the function's range, the original code skips
	// the function (no measurable coverage -> no finding). The mutant lets
	// it through, computing NaN coverage/score and still emitting a block.
	it("does not report a function with zero measurable lines in range", () => {
		const decision = decideCrap(
			baseInput({
				editedLines: undefined,
				analyzer: analyzerReturning([fn("unmeasuredFn", 100, 100, 5)]),
				cov: perLineCoverage([], []), // nothing at line 100
				threshold: 30,
			}),
			onDegrade,
		);
		expect(decision).toBeNull();
	});

	// Kills 49a03711 (`score < threshold` -> `score <= threshold`). Function
	// scores exactly 30 (cyclomatic 5, 0% coverage: 5^2*1^3+5 = 30) against
	// threshold 30. Original: 30 < 30 is false -> NOT skipped -> violation.
	// Mutant: 30 <= 30 is true -> skipped -> no violation.
	it("reports a violation when the score exactly equals the threshold", () => {
		const decision = decideCrap(
			baseInput({
				editedLines: undefined,
				analyzer: analyzerReturning([fn("boundaryFn", 1, 1, 5)]),
				cov: perLineCoverage([], [1]),
				threshold: 30,
			}),
			onDegrade,
		);
		expect(decision).not.toBeNull();
	});
});

describe("crapViolationsPerLine — worst-first sort", () => {
	// Kills 6b270cb2 (sort() call dropped), ab65e2af (comparator - -> +),
	// and 2ec04e01 (comparator -> () => undefined). All three change which
	// violation ends up first (worst), and blockForCrap always reports the
	// function at index 0. With three violations of clearly different CRAP
	// scores (30, 56, 110), only a correct descending sort puts the
	// highest-scoring function ("bFn", score 110) first.
	it("blocks on the highest-CRAP function, not push order", () => {
		const decision = decideCrap(
			baseInput({
				editedLines: undefined,
				analyzer: analyzerReturning([
					fn("aFn", 1, 1, 5), // score 30
					fn("bFn", 2, 2, 10), // score 110
					fn("cFn", 3, 3, 7), // score 56
				]),
				cov: perLineCoverage([], [1, 2, 3]), // all 0% covered
				threshold: 1,
			}),
			onDegrade,
		);
		expect(decision).not.toBeNull();
		expect(decision?.reason).toContain("`bFn`");
		expect(decision?.reason).not.toContain("`aFn`");
		expect(decision?.reason).not.toContain("`cFn`");
	});
});

describe("blockForCrap message content", () => {
	// One block scenario; kills the StringLiteral mutants that blank out
	// pieces of the message text, plus the severity/category literals.
	it("includes every fixed message segment and the medium/coverage tags", () => {
		const decision = decideCrap(
			baseInput({
				editedLines: new Set([5]),
				analyzer: analyzerReturning([fn("targetFn", 5, 5, 5)]),
				cov: perLineCoverage([], [5]),
				threshold: 30,
			}),
			onDegrade,
		);
		expect(decision).not.toBeNull();
		const reason = decision?.reason ?? "";
		expect(reason).toContain(
			"under-covered. CRAP = cyclomatic² · (1 − coverage)³ + cyclomatic, checked after ",
		);
		expect(reason).toContain(
			"the coverage gate. Reduce complexity (decompose the function) OR add coverage ",
		);
		expect(reason).toContain("(exercise its branches), then retry.\n");
		expect(reason).toContain(
			"This CRAP threshold is per-repo configurable: `interlinked caps set crap <n>` ",
		);
		expect(reason).toContain("(`interlinked caps explain crap` for what it measures).");
		expect(decision?.severity).toBe("medium");
		expect(decision?.category).toBe("coverage");
	});
});
