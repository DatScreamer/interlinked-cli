import { describe, expect, it, vi } from "vitest";
import { computeCrap, computeCrapForFile, type ComputeCrapInput } from "./crap.js";
import type { FunctionCoverage } from "../coverage-final-reader.js";
import type { FunctionComplexityEntry } from "./cyclomatic.js";

function fn(name: string, line: number, cyclomatic = 1): FunctionComplexityEntry {
	return { name, line, endLine: line + 5, cyclomatic, language: "js_ts" };
}

function cov(name: string, line: number, statement_pct: number): FunctionCoverage {
	return { name, line, endLine: line + 5, hits: 1, statement_pct };
}

function baseInput(overrides: Partial<ComputeCrapInput>): ComputeCrapInput {
	return {
		complexities: [],
		coverage: [],
		filePath: "src/x.ts",
		fileMtime: 100,
		coverageMtime: 100,
		threshold: 0,
		staleTolerance: "include",
		maxFindings: undefined,
		...overrides,
	};
}

describe("computeCrap — stale computation (positive/negative)", () => {
	// P1: fileMtime === coverageMtime must NOT be stale (kills `>` -> `>=`)
	it("does not treat equal mtimes as stale, so skip-tolerance still reports the finding", () => {
		const result = computeCrap(
			baseInput({
				complexities: [fn("foo", 10, 5)],
				coverage: [cov("foo", 10, 0)],
				fileMtime: 100,
				coverageMtime: 100,
				staleTolerance: "skip",
				threshold: 1,
			}),
		);
		expect(result).toHaveLength(1);
		expect(result[0]?.stale).toBe(false);
	});

	// P2: null coverageMtime must NOT be stale regardless of fileMtime (kills
	// `coverageMtime !== null` -> `true`)
	it("treats a null coverageMtime as never-stale, not as a huge mtime gap", () => {
		const result = computeCrap(
			baseInput({
				complexities: [fn("foo", 10, 5)],
				coverage: [cov("foo", 10, 0)],
				fileMtime: 999_999,
				coverageMtime: null,
				staleTolerance: "skip",
				threshold: 1,
			}),
		);
		expect(result).toHaveLength(1);
		expect(result[0]?.stale).toBe(false);
	});

	// N1: a genuinely stale file with skip-tolerance drops the finding.
	it("drops findings when the file is genuinely newer than coverage and tolerance is skip", () => {
		const result = computeCrap(
			baseInput({
				complexities: [fn("foo", 10, 5)],
				coverage: [cov("foo", 10, 0)],
				fileMtime: 500,
				coverageMtime: 100,
				staleTolerance: "skip",
				threshold: 1,
			}),
		);
		expect(result).toHaveLength(0);
	});
});

describe("computeCrap — threshold boundary (kills `score < threshold` -> `<=`)", () => {
	// P: score exactly equal to threshold must be KEPT (score < threshold is false).
	it("keeps a finding whose score exactly equals the threshold", () => {
		// complexity=2, coverage=100% => crapScore = 2*2*0^3 + 2 = 2
		const result = computeCrap(
			baseInput({
				complexities: [fn("exact", 5, 2)],
				coverage: [cov("exact", 5, 100)],
				threshold: 2,
			}),
		);
		expect(result).toHaveLength(1);
		expect(result[0]?.crap_score).toBe(2);
	});

	// N: score strictly below threshold must be dropped.
	it("drops a finding whose score is strictly below threshold", () => {
		const result = computeCrap(
			baseInput({
				complexities: [fn("low", 5, 2)],
				coverage: [cov("low", 5, 100)],
				threshold: 3,
			}),
		);
		expect(result).toHaveLength(0);
	});
});

describe("computeCrap — sort by crap_score descending (sort/comparator mutants)", () => {
	it("returns findings sorted by crap_score descending, not insertion order", () => {
		// f1: complexity 2, cov 100% -> score 2
		// f2: complexity 4, cov 0%   -> score 4*4*1 + 4 = 20
		// f3: complexity 3, cov 100% -> score 3
		// insertion order f1,f2,f3 is NOT the descending order f2,f3,f1.
		const result = computeCrap(
			baseInput({
				complexities: [fn("f1", 10, 2), fn("f2", 20, 4), fn("f3", 30, 3)],
				coverage: [cov("f1", 10, 100), cov("f2", 20, 0), cov("f3", 30, 100)],
				threshold: 0,
			}),
		);
		expect(result.map((r) => r.function)).toEqual(["f2", "f3", "f1"]);
		expect(result.map((r) => r.crap_score)).toEqual([20, 3, 2]);
	});
});

describe("computeCrap — maxFindings slicing (guard-condition mutants)", () => {
	// Use a spy on Array.prototype.slice to detect whether the slice branch
	// executed at all, since some mutated conditions produce a slice() call
	// whose *result* happens to equal the unsliced array (bound >= length).
	it("does not call slice when maxFindings is undefined (kills whole-condition -> true)", () => {
		const spy = vi.spyOn(Array.prototype, "slice");
		spy.mockClear();
		const complexities = [fn("a", 1, 5), fn("b", 2, 5), fn("c", 3, 5)];
		const coverage = [cov("a", 1, 0), cov("b", 2, 0), cov("c", 3, 0)];
		const result = computeCrap(
			baseInput({ complexities, coverage, threshold: 0, maxFindings: undefined }),
		);
		expect(result).toHaveLength(3);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it("does not call slice when findings.length <= maxFindings (kills length>maxFindings -> true, and && -> ||)", () => {
		const spy = vi.spyOn(Array.prototype, "slice");
		spy.mockClear();
		const complexities = [fn("a", 1, 5), fn("b", 2, 5), fn("c", 3, 5)];
		const coverage = [cov("a", 1, 0), cov("b", 2, 0), cov("c", 3, 0)];
		const result = computeCrap(
			baseInput({ complexities, coverage, threshold: 0, maxFindings: 5 }),
		);
		expect(result).toHaveLength(3);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it("does not call slice when findings.length equals maxFindings exactly (kills > -> >=)", () => {
		const spy = vi.spyOn(Array.prototype, "slice");
		spy.mockClear();
		const complexities = [fn("a", 1, 5), fn("b", 2, 5), fn("c", 3, 5)];
		const coverage = [cov("a", 1, 0), cov("b", 2, 0), cov("c", 3, 0)];
		const result = computeCrap(
			baseInput({ complexities, coverage, threshold: 0, maxFindings: 3 }),
		);
		expect(result).toHaveLength(3);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it("truncates to maxFindings when findings.length strictly exceeds it (control case)", () => {
		const complexities = [fn("a", 1, 5), fn("b", 2, 5), fn("c", 3, 5)];
		const coverage = [cov("a", 1, 0), cov("b", 2, 0), cov("c", 3, 0)];
		const result = computeCrap(
			baseInput({ complexities, coverage, threshold: 0, maxFindings: 2 }),
		);
		expect(result).toHaveLength(2);
	});
});

describe("computeCrapForFile — mtime unwrap (kills `?? null` -> `&& null`)", () => {
	it("passes a defined perFile.mtime through as coverageMtime (not nulled)", () => {
		const result = computeCrapForFile({
			complexities: [fn("foo", 10, 5)],
			perFile: { filePath: "src/x.ts", mtime: 500, functions: [cov("foo", 10, 0)] },
			filePath: "src/x.ts",
			fileMtime: 1000,
			threshold: 1,
			staleTolerance: "skip",
		});
		// If mtime were nulled by a `&&` mutant, coverageMtime becomes null and
		// the file is never treated as stale, so skip-tolerance would NOT drop
		// this finding. With the real mtime (500) preserved, fileMtime(1000) >
		// coverageMtime(500) => stale => skip-tolerance drops it => [].
		expect(result).toHaveLength(0);
	});
});

describe("computeCrap — findCoverageMatch name/line matching", () => {
	// P: exact name match wins over a closer-by-line but wrong-named entry.
	it("prefers the name-matched entry even when a wrong-named entry has a closer line", () => {
		const result = computeCrap(
			baseInput({
				complexities: [fn("foo", 10, 1)],
				coverage: [cov("bar", 10, 11), cov("foo", 13, 77)],
				threshold: 0,
			}),
		);
		expect(result).toHaveLength(1);
		expect(result[0]?.coverage_pct).toBe(77);
	});

	// P: within the name-matched loop, a too-far entry (diff 40) is skipped in
	// favor of a within-slack (diff 2) same-name entry appearing later.
	it("skips a name-matched entry whose line is far away in favor of a closer name-matched entry", () => {
		const result = computeCrap(
			baseInput({
				complexities: [fn("foo", 10, 1)],
				coverage: [cov("foo", 50, 99), cov("foo", 12, 33)],
				threshold: 0,
			}),
		);
		expect(result).toHaveLength(1);
		expect(result[0]?.coverage_pct).toBe(33);
	});

	// P: fallback (name-agnostic) match at the exact slack boundary (diff 3) succeeds.
	it("falls back to a line-only match at exactly the slack boundary when name differs", () => {
		const result = computeCrap(
			baseInput({
				complexities: [fn("foo", 100, 1)],
				coverage: [cov("other", 103, 55)],
				threshold: 0,
			}),
		);
		expect(result).toHaveLength(1);
		expect(result[0]?.coverage_pct).toBe(55);
	});

	// N: fallback match just past the slack boundary (diff 4) fails -> no finding.
	it("does not fall back to a line-only match one line past the slack boundary", () => {
		const result = computeCrap(
			baseInput({
				complexities: [fn("foo", 100, 1)],
				coverage: [cov("other", 104, 66)],
				threshold: 0,
			}),
		);
		expect(result).toHaveLength(0);
	});

	// P: distance is genuinely abs(cov.line - fn.line), not abs(cov.line + fn.line) —
	// exercised via the name-matched loop with a decoy entry that a wrong
	// (addition-based) distance would fall through to via the fallback loop.
	it("computes line distance via subtraction, not addition, in the name-matched loop", () => {
		const result = computeCrap(
			baseInput({
				complexities: [fn("foo", 10, 1)],
				coverage: [cov("decoy", 12, 5), cov("foo", 8, 44)],
				threshold: 0,
			}),
		);
		expect(result).toHaveLength(1);
		expect(result[0]?.coverage_pct).toBe(44);
	});

	// P: distance is genuinely abs(cov.line - fn.line) in the fallback loop too —
	// name-mismatched single entry forces reliance on the fallback loop only.
	it("computes line distance via subtraction, not addition, in the fallback loop", () => {
		const result = computeCrap(
			baseInput({
				complexities: [fn("foo", 10, 1)],
				coverage: [cov("other", 8, 77)],
				threshold: 0,
			}),
		);
		expect(result).toHaveLength(1);
		expect(result[0]?.coverage_pct).toBe(77);
	});
});
