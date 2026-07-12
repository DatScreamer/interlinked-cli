// Direct companion for the extracted per-edit coverage decision helpers. The
// guard's own suite exercises these end-to-end; this file pins the pure
// decision surface in isolation (per-function vs per-line shape, baseline
// drop, red-bar message rendering).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import { writeFileCoverageBaseline } from "../coverage-obligation-ledger.js";
import { resetMetricCapsCache } from "../metric-caps.js";
import { blockForRedBar, decideFromCoverage, failingTestPhrase } from "./coverage-write-decision.js";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cov-decision-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function fnCov(over: Partial<PerFileCoverage["functions"][number]> = {}): PerFileCoverage["functions"][number] {
	return { name: "f", line: 1, endLine: 3, hits: 2, statement_pct: 100, ...over };
}

describe("decideFromCoverage — per-function (istanbul) shape", () => {
	it("blocks on an uncovered added function, naming file and line", () => {
		const cov: PerFileCoverage = { filePath: "src/m.ts", mtime: 0, functions: [fnCov({ hits: 0, statement_pct: 0 })] };
		const out: { now?: number } = {};
		const d = decideFromCoverage(root, "src/m.ts", cov, new Set([1]), out);
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("src/m.ts line 1");
		expect(out.now).toBeUndefined(); // a block never hands back a fraction
	});

	it("allows a covered function and hands back the fraction WITHOUT persisting it", () => {
		const cov: PerFileCoverage = { filePath: "src/m.ts", mtime: 0, functions: [fnCov()] };
		const out: { now?: number } = {};
		expect(decideFromCoverage(root, "src/m.ts", cov, new Set([1]), out)).toBeNull();
		expect(out.now).toBe(1);
	});

	it("blocks a coverage DROP versus the persisted baseline", () => {
		writeFileCoverageBaseline(root, "src/m.ts", 1);
		const cov: PerFileCoverage = {
			filePath: "src/m.ts",
			mtime: 0,
			// covered overall but at 50% → below the 100% baseline
			functions: [fnCov({ statement_pct: 50 })],
		};
		const d = decideFromCoverage(root, "src/m.ts", cov, new Set([99]), {});
		expect(d?.decision).toBe("block");
		expect(d?.reason).toMatch(/drops src\/m\.ts coverage/);
	});

	it("tolerates a sub-epsilon wobble that holds at the baseline (the 100%→100% false-block fix)", () => {
		writeFileCoverageBaseline(root, "src/m.ts", 1);
		const cov: PerFileCoverage = {
			filePath: "src/m.ts",
			mtime: 0,
			// 99.7% — an affected-subset/measurement wobble that still rounds to 100%.
			functions: [fnCov({ statement_pct: 99.7 })],
		};
		const out: { now?: number } = {};
		expect(decideFromCoverage(root, "src/m.ts", cov, new Set([99]), out)).toBeNull();
	});

	it("still blocks a real drop beyond the noise tolerance", () => {
		writeFileCoverageBaseline(root, "src/m.ts", 1);
		const cov: PerFileCoverage = {
			filePath: "src/m.ts",
			mtime: 0,
			functions: [fnCov({ statement_pct: 99 })], // 1% drop > epsilon
		};
		const d = decideFromCoverage(root, "src/m.ts", cov, new Set([99]), {});
		expect(d?.decision).toBe("block");
	});

	it("blocks a file below the configured min_coverage floor", () => {
		mkdirSync(join(root, ".interlinked"), { recursive: true });
		writeFileSync(join(root, ".interlinked", "metric-caps.json"), JSON.stringify({ min_coverage: 90 }));
		resetMetricCapsCache();
		const cov: PerFileCoverage = { filePath: "src/m.ts", mtime: 0, functions: [fnCov({ statement_pct: 80 })] };
		const d = decideFromCoverage(root, "src/m.ts", cov, new Set([99]), {});
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("below the");
		resetMetricCapsCache();
	});

	it("allows below 100% when no floor is set (floor defaults to 0 = off)", () => {
		const cov: PerFileCoverage = { filePath: "src/m.ts", mtime: 0, functions: [fnCov({ statement_pct: 80 })] };
		expect(decideFromCoverage(root, "src/m.ts", cov, new Set([99]), {})).toBeNull();
	});
});

describe("decideFromCoverage — per-line (coverage.py) shape", () => {
	it("blocks on an uncovered ADDED line (line-precise)", () => {
		const cov: PerFileCoverage = {
			filePath: "src/m.py",
			mtime: 0,
			functions: [],
			coveredLines: new Set([1, 2]),
			uncoveredLines: new Set([3]),
		};
		const d = decideFromCoverage(root, "src/m.py", cov, new Set([3]), {});
		expect(d?.decision).toBe("block");
		expect(d?.reason).toContain("line 3");
	});

	it("ignores a pre-existing uncovered line the edit did not touch", () => {
		const cov: PerFileCoverage = {
			filePath: "src/m.py",
			mtime: 0,
			functions: [],
			coveredLines: new Set([1, 2]),
			uncoveredLines: new Set([3]),
		};
		const out: { now?: number } = {};
		expect(decideFromCoverage(root, "src/m.py", cov, new Set([1]), out)).toBeNull();
		expect(out.now).toBeCloseTo(2 / 3);
	});
});

describe("red-bar message rendering", () => {
	it("failingTestPhrase lists up to three tests with an ellipsis", () => {
		expect(failingTestPhrase(undefined)).toBe("one or more tests are failing");
		expect(failingTestPhrase(["a"])).toBe("failing test(s): a");
		expect(failingTestPhrase(["a", "b", "c", "d"])).toBe("failing test(s): a, b, c, …");
	});

	it("blockForRedBar names the edited file and carries the gate rule id", () => {
		const d = blockForRedBar("src/m.ts", ["t1"]);
		expect(d.decision).toBe("block");
		expect(d.reason).toContain("src/m.ts");
		expect(d.reason).toContain("t1");
		expect(d.rule_id).toBe("per-edit-coverage");
	});

	it("blockForRedBar attaches failing test FILES as structured evidence (debt-mode's cone seed)", () => {
		const d = blockForRedBar("src/m.ts", ["t1"], ["lib/counts.test.ts"]);
		expect(d.failing_test_files).toEqual(["lib/counts.test.ts"]);
	});

	it("blockForRedBar keeps the field absent when no files parsed (exactOptionalPropertyTypes)", () => {
		expect("failing_test_files" in blockForRedBar("src/m.ts", ["t1"])).toBe(false);
		expect("failing_test_files" in blockForRedBar("src/m.ts", ["t1"], [])).toBe(false);
	});
});
