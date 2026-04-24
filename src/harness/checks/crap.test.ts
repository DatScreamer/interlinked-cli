import { describe, expect, it } from "vitest";
import type { FunctionCoverage } from "../coverage-final-reader.js";
import { computeCrap, computeCrapForFile, crapScore } from "./crap.js";
import type { FunctionComplexityEntry } from "./cyclomatic.js";

// ==================================================================
// Fixture builders
// ==================================================================

function mkFn(
	name: string,
	line: number,
	cyclomatic: number,
): FunctionComplexityEntry {
	return {
		name,
		line,
		endLine: line + 10,
		cyclomatic,
		language: "js_ts",
	};
}

function mkCov(name: string, line: number, statement_pct: number): FunctionCoverage {
	return {
		name,
		line,
		endLine: line + 10,
		hits: statement_pct > 0 ? 1 : 0,
		statement_pct,
	};
}

// ==================================================================
// crapScore — the formula
// ==================================================================

describe("crapScore", () => {
	it("returns complexity when coverage is 100%", () => {
		// comp=10, cov=100 → 100 * 0³ + 10 = 10
		expect(crapScore(10, 100)).toBe(10);
	});

	it("returns comp² + comp when coverage is 0%", () => {
		// comp=10, cov=0 → 100 * 1 + 10 = 110
		expect(crapScore(10, 0)).toBe(110);
	});

	it("returns baseline 1 for trivial, fully-covered code", () => {
		expect(crapScore(1, 100)).toBe(1);
	});

	it("is monotonically decreasing in coverage", () => {
		const a = crapScore(8, 0);
		const b = crapScore(8, 50);
		const c = crapScore(8, 100);
		expect(a).toBeGreaterThan(b);
		expect(b).toBeGreaterThan(c);
	});

	it("is monotonically increasing in complexity at fixed coverage", () => {
		expect(crapScore(5, 40)).toBeLessThan(crapScore(10, 40));
		expect(crapScore(10, 40)).toBeLessThan(crapScore(20, 40));
	});

	it("crosses the Sonar risky cutoff (30) at the expected places", () => {
		// comp=5, cov=0 → 25 + 5 = 30 (exactly at threshold)
		expect(crapScore(5, 0)).toBe(30);
		// comp=5, cov=50 → 25 * 0.125 + 5 ≈ 8.1 (safe)
		expect(crapScore(5, 50)).toBeLessThan(30);
	});
});

// ==================================================================
// computeCrap — the pipeline
// ==================================================================

describe("computeCrap", () => {
	it("returns empty array when coverage is undefined (language without reader)", () => {
		const findings = computeCrap({
			complexities: [mkFn("foo", 1, 20)],
			coverage: undefined,
			filePath: "src/foo.ts",
			fileMtime: 1000,
			coverageMtime: null,
			threshold: 30,
			staleTolerance: "tag",
		});
		expect(findings).toEqual([]);
	});

	it("returns empty array when stale and staleTolerance is `skip`", () => {
		const findings = computeCrap({
			complexities: [mkFn("foo", 1, 20)],
			coverage: [mkCov("foo", 1, 0)],
			filePath: "src/foo.ts",
			fileMtime: 2000, // newer than coverage
			coverageMtime: 1000,
			threshold: 30,
			staleTolerance: "skip",
		});
		expect(findings).toEqual([]);
	});

	it("reports only findings at or above the threshold", () => {
		const findings = computeCrap({
			complexities: [
				mkFn("safe", 1, 2), // comp=2, cov=100 → 2 (below threshold)
				mkFn("risky", 20, 10), // comp=10, cov=0 → 110 (above threshold)
			],
			coverage: [mkCov("safe", 1, 100), mkCov("risky", 20, 0)],
			filePath: "src/foo.ts",
			fileMtime: 1000,
			coverageMtime: 1000,
			threshold: 30,
			staleTolerance: "tag",
		});
		expect(findings).toHaveLength(1);
		expect(findings[0].function).toBe("risky");
	});

	it("sorts findings by crap_score descending", () => {
		const findings = computeCrap({
			complexities: [
				mkFn("hot", 1, 12), // comp=12, cov=0 → 156
				mkFn("warm", 20, 8), // comp=8, cov=0 → 72
			],
			coverage: [mkCov("hot", 1, 0), mkCov("warm", 20, 0)],
			filePath: "src/foo.ts",
			fileMtime: 1000,
			coverageMtime: 1000,
			threshold: 30,
			staleTolerance: "tag",
		});
		expect(findings.map((f) => f.function)).toEqual(["hot", "warm"]);
	});

	it("honours maxFindings cap", () => {
		const complexities: FunctionComplexityEntry[] = [];
		const coverage: FunctionCoverage[] = [];
		for (let i = 0; i < 10; i++) {
			complexities.push(mkFn(`f${i}`, i * 20 + 1, 10 + i));
			coverage.push(mkCov(`f${i}`, i * 20 + 1, 0));
		}

		const findings = computeCrap({
			complexities,
			coverage,
			filePath: "src/foo.ts",
			fileMtime: 1000,
			coverageMtime: 1000,
			threshold: 30,
			staleTolerance: "tag",
			maxFindings: 3,
		});
		expect(findings).toHaveLength(3);
	});

	it("matches functions by name within ±3 lines of slack", () => {
		const findings = computeCrap({
			complexities: [mkFn("foo", 10, 10)],
			coverage: [mkCov("foo", 12, 100)], // 2-line drift
			filePath: "src/foo.ts",
			fileMtime: 1000,
			coverageMtime: 1000,
			threshold: 1,
			staleTolerance: "tag",
		});
		// Should match the coverage entry even though line drifted by 2.
		expect(findings[0].coverage_pct).toBe(100);
	});

	it("treats unmatched functions as cov=0 (worst-case CRAP)", () => {
		const findings = computeCrap({
			complexities: [mkFn("newFn", 42, 10)],
			coverage: [mkCov("oldFn", 1, 100)], // no name match, no line match
			filePath: "src/foo.ts",
			fileMtime: 1000,
			coverageMtime: 1000,
			threshold: 1,
			staleTolerance: "tag",
		});
		expect(findings[0].coverage_pct).toBe(0);
		expect(findings[0].crap_score).toBe(110); // comp=10, cov=0
	});

	it("falls back to line-slack match (name-agnostic) after a rename", () => {
		const findings = computeCrap({
			complexities: [mkFn("renamedFn", 10, 10)],
			coverage: [mkCov("oldName", 10, 80)],
			filePath: "src/foo.ts",
			fileMtime: 1000,
			coverageMtime: 1000,
			threshold: 1,
			staleTolerance: "tag",
		});
		// Line-slack fallback triggers → picks up the 80% coverage.
		expect(findings[0].coverage_pct).toBe(80);
	});

	it("sets stale=true when file is newer than coverage", () => {
		const findings = computeCrap({
			complexities: [mkFn("foo", 1, 10)],
			coverage: [mkCov("foo", 1, 0)],
			filePath: "src/foo.ts",
			fileMtime: 3000,
			coverageMtime: 1000,
			threshold: 1,
			staleTolerance: "tag",
		});
		expect(findings[0].stale).toBe(true);
	});

	it("sets stale=false when file is older than coverage", () => {
		const findings = computeCrap({
			complexities: [mkFn("foo", 1, 10)],
			coverage: [mkCov("foo", 1, 0)],
			filePath: "src/foo.ts",
			fileMtime: 500,
			coverageMtime: 1000,
			threshold: 1,
			staleTolerance: "tag",
		});
		expect(findings[0].stale).toBe(false);
	});

	it("reports findings with stale=true when staleTolerance is `include`", () => {
		const findings = computeCrap({
			complexities: [mkFn("foo", 1, 10)],
			coverage: [mkCov("foo", 1, 0)],
			filePath: "src/foo.ts",
			fileMtime: 3000,
			coverageMtime: 1000,
			threshold: 1,
			staleTolerance: "include",
		});
		expect(findings).toHaveLength(1);
		expect(findings[0].stale).toBe(true);
	});
});

// ==================================================================
// computeCrapForFile — convenience wrapper
// ==================================================================

describe("computeCrapForFile", () => {
	it("passes through to computeCrap with perFile unpacked", () => {
		const findings = computeCrapForFile({
			complexities: [mkFn("foo", 1, 10)],
			perFile: {
				filePath: "src/foo.ts",
				mtime: 1000,
				functions: [mkCov("foo", 1, 0)],
			},
			filePath: "src/foo.ts",
			fileMtime: 1000,
			threshold: 30,
			staleTolerance: "tag",
		});
		expect(findings).toHaveLength(1);
		expect(findings[0].function).toBe("foo");
	});

	it("returns empty when perFile is undefined", () => {
		const findings = computeCrapForFile({
			complexities: [mkFn("foo", 1, 10)],
			perFile: undefined,
			filePath: "src/foo.ts",
			fileMtime: 1000,
			threshold: 30,
			staleTolerance: "tag",
		});
		expect(findings).toEqual([]);
	});
});
