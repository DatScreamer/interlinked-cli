// Direct unit coverage for the CRAP-decision module extracted from
// coverage-write-guard.ts. The end-to-end CRAP behavior is also exercised through
// the guard (coverage-write-guard.test.ts → "CRAP block"); this pins the
// extracted public surface (decideCrap / hasPerLineData / DEFAULT_CRAP_THRESHOLD)
// in isolation.

import { describe, expect, it, vi } from "vitest";
import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import type { HarnessDecision } from "../types.js";
import {
	type CrapInput,
	DEFAULT_CRAP_THRESHOLD,
	decideCrap,
	hasPerLineData,
} from "./coverage-crap-decision.js";

function fn(name: string, line: number, endLine: number, cyclomatic: number): FunctionComplexityEntry {
	return { name, line, endLine, cyclomatic, language: "js_ts" };
}

function perFunctionCov(functions: PerFileCoverage["functions"]): PerFileCoverage {
	return { filePath: "src/a.ts", mtime: 0, functions };
}

function perLineCov(covered: number[], uncovered: number[]): PerFileCoverage {
	return {
		filePath: "src/a.py",
		mtime: 0,
		functions: [],
		coveredLines: new Set(covered),
		uncoveredLines: new Set(uncovered),
	};
}

/** A never-called degrade sink — asserts decideCrap did NOT fail open. */
function failIfDegraded(): (relPath: string, why: string) => HarnessDecision {
	return () => {
		throw new Error("onDegrade should not have been called");
	};
}

/** A degrade stub mirroring the guard's loud-degrade: ALLOW + an agent-visible warning. */
function allowDegrade(): (relPath: string, why: string) => HarnessDecision {
	return (relPath, why) => ({
		decision: "allow",
		warnings: [`[interlinked:coverage] WARNING: ${relPath} (${why})`],
	});
}

const baseInput = (over: Partial<CrapInput>): CrapInput => ({
	relPath: "src/a.ts",
	proposed: "export function big() {\n  return 1;\n}\n",
	cov: perFunctionCov([{ name: "big", line: 1, endLine: 3, hits: 3, statement_pct: 20 }]),
	editedLines: undefined,
	threshold: DEFAULT_CRAP_THRESHOLD,
	analyzer: () => [fn("big", 1, 3, 10)],
	...over,
});

describe("DEFAULT_CRAP_THRESHOLD", () => {
	it("is the McCabe/SonarQube cutoff of 30", () => {
		expect(DEFAULT_CRAP_THRESHOLD).toBe(30);
	});
});

describe("hasPerLineData", () => {
	it("is true when coverage carries per-line sets, false for per-function only", () => {
		expect(hasPerLineData(perLineCov([1], [2]))).toBe(true);
		expect(hasPerLineData(perFunctionCov([{ name: "f", line: 1, endLine: 2, hits: 1, statement_pct: 100 }]))).toBe(
			false,
		);
	});
});

describe("decideCrap — per-function (istanbul) shape", () => {
	it("BLOCKS a complex + under-covered touched function, naming CRAP/cyclomatic/coverage", () => {
		// cyclomatic 10 @ 20% → CRAP ≈ 61 (≥ 30).
		const decision = decideCrap(baseInput({}), failIfDegraded());
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/CRAP score of 61/);
		expect(decision?.reason).toMatch(/`big`/);
		expect(decision?.reason).toMatch(/cyclomatic 10/);
		expect(decision?.reason).toMatch(/coverage 20%/);
		expect(decision?.rule_id).toBe("per-edit-coverage");
	});

	it("ALLOWS (null) when the same function is fully covered (CRAP ≈ cyclomatic < 30)", () => {
		const decision = decideCrap(
			baseInput({ cov: perFunctionCov([{ name: "big", line: 1, endLine: 3, hits: 5, statement_pct: 100 }]) }),
			failIfDegraded(),
		);
		expect(decision).toBeNull();
	});

	it("ALLOWS (null) when no touched function exists (edited lines miss the function)", () => {
		const decision = decideCrap(baseInput({ editedLines: new Set([99]) }), failIfDegraded());
		expect(decision).toBeNull();
	});

	it("respects a raised threshold (CRAP-61 passes a threshold of 100)", () => {
		const decision = decideCrap(baseInput({ threshold: 100 }), failIfDegraded());
		expect(decision).toBeNull();
	});
});

describe("decideCrap — per-line (coverage.py) shape", () => {
	it("BLOCKS using radon ranges ∩ coverage.py lines (covered 1/4 → 25% → CRAP ≥ 30)", () => {
		// function lines 1..6; covered {3}, uncovered {4,5,6} → 25% over 4 executable.
		const decision = decideCrap(
			{
				relPath: "src/a.py",
				proposed: "def big():\n    pass\n",
				cov: perLineCov([3], [4, 5, 6]),
				editedLines: undefined,
				threshold: DEFAULT_CRAP_THRESHOLD,
				analyzer: () => [{ name: "big", line: 1, endLine: 6, cyclomatic: 10, language: "python" }],
			},
			failIfDegraded(),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/CRAP score of 52/);
		expect(decision?.reason).toMatch(/coverage 25%/);
	});
});

describe("decideCrap — fail-open", () => {
	it("calls onDegrade AND propagates its allow-decision when the analyzer is null", () => {
		const onDegrade = vi.fn(allowDegrade());
		const decision = decideCrap(baseInput({ analyzer: null }), onDegrade);
		// The degrade decision (allow + warning) is returned verbatim, not swallowed
		// into a bare null — the silent-fail-open guard at the CRAP layer.
		expect(decision?.decision).toBe("allow");
		expect((decision?.warnings ?? []).join("\n")).toMatch(/\[interlinked:coverage\]/);
		expect(onDegrade).toHaveBeenCalledOnce();
		expect(onDegrade.mock.calls[0]?.[1]).toMatch(/no cyclomatic analyzer/);
	});

	it("calls onDegrade and propagates its allow-decision when the analyzer returns null", () => {
		const onDegrade = vi.fn(allowDegrade());
		const decision = decideCrap(baseInput({ analyzer: () => null }), onDegrade);
		expect(decision?.decision).toBe("allow");
		expect((decision?.warnings ?? []).join("\n")).toMatch(/\[interlinked:coverage\]/);
		expect(onDegrade).toHaveBeenCalledOnce();
		expect(onDegrade.mock.calls[0]?.[1]).toMatch(/unavailable/);
	});
});
