// Direct companion for the extracted per-edit coverage decision helpers. The
// guard's own suite exercises these end-to-end; this file pins the pure
// decision surface in isolation (per-function vs per-line shape, baseline
// drop, red-bar message rendering).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import { writeFileCoverageBaseline } from "../coverage-obligation-ledger.js";
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
});
