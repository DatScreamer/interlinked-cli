import { describe, expect, it } from "vitest";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import type { CrapFinding } from "./crap.js";
import { computeCrapRisers, filterToRisers, snapshotCrap } from "./crap-baseline.js";

// ==================================================================
// Helpers
// ==================================================================

function mkCov(
	filePath: string,
	mtime: number,
	fns: Array<{ name: string; line: number; statement_pct: number }>,
): PerFileCoverage {
	return {
		filePath,
		mtime,
		functions: fns.map((f) => ({
			name: f.name,
			line: f.line,
			endLine: f.line + 10,
			hits: f.statement_pct > 0 ? 1 : 0,
			statement_pct: f.statement_pct,
		})),
	};
}

interface MkFindingInput {
	file: string;
	fn: string;
	line: number;
	score: number;
}

function mkFinding(input: MkFindingInput): CrapFinding {
	return {
		file: input.file,
		function: input.fn,
		line: input.line,
		complexity: 10,
		coverage_pct: 0,
		crap_score: input.score,
		stale: false,
	};
}

// ==================================================================
// snapshotCrap
// ==================================================================

describe("snapshotCrap", () => {
	it("returns an empty map when coverage is undefined", () => {
		const baseline = snapshotCrap({
			preContent: "function foo() { if (x) return 1; return 0; }",
			filePath: "src/foo.ts",
			coverage: undefined,
			fileMtime: 1000,
			threshold: 30,
		});
		expect(baseline.size).toBe(0);
	});

	it("captures scores for every function in the file, not just risky ones", () => {
		const preContent = `function safe() {
			return 1;
		}
		function risky(x: number) {
			if (x > 0) return 1;
			if (x < 0) return -1;
			if (x === 0) return 0;
			return NaN;
		}`;
		const coverage = mkCov("src/foo.ts", 1000, [
			{ name: "safe", line: 1, statement_pct: 100 },
			{ name: "risky", line: 4, statement_pct: 0 },
		]);

		const baseline = snapshotCrap({
			preContent,
			filePath: "src/foo.ts",
			coverage,
			fileMtime: 1000,
			threshold: 30,
		});

		const fileMap = baseline.get("src/foo.ts");
		expect(fileMap).toBeDefined();
		// Both `safe` and `risky` should be captured even though `safe` is
		// far below threshold — otherwise a post-edit tiny bump on `safe`
		// would look like a brand-new high-risk function.
		expect(fileMap?.size).toBeGreaterThanOrEqual(2);
	});
});

// ==================================================================
// filterToRisers
// ==================================================================

describe("filterToRisers", () => {
	it("returns all findings when baseline is empty", () => {
		const findings = [
			mkFinding({ file: "src/a.ts", fn: "foo", line: 1, score: 100 }),
		];
		expect(filterToRisers(findings, new Map())).toEqual(findings);
	});

	it("drops findings where score stayed the same", () => {
		const baseline = new Map([["src/a.ts", new Map([["foo@1", 100]])]]);
		const findings = [
			mkFinding({ file: "src/a.ts", fn: "foo", line: 1, score: 100 }),
		];
		expect(filterToRisers(findings, baseline)).toEqual([]);
	});

	it("drops findings where score dropped", () => {
		const baseline = new Map([["src/a.ts", new Map([["foo@1", 100]])]]);
		const findings = [
			mkFinding({ file: "src/a.ts", fn: "foo", line: 1, score: 80 }),
		];
		expect(filterToRisers(findings, baseline)).toEqual([]);
	});

	it("keeps findings where score rose", () => {
		const baseline = new Map([["src/a.ts", new Map([["foo@1", 100]])]]);
		const findings = [
			mkFinding({ file: "src/a.ts", fn: "foo", line: 1, score: 140 }),
		];
		expect(filterToRisers(findings, baseline)).toHaveLength(1);
	});

	it("keeps findings for brand-new functions (not in baseline)", () => {
		const baseline = new Map([["src/a.ts", new Map([["foo@1", 100]])]]);
		const findings = [
			mkFinding({ file: "src/a.ts", fn: "newFn", line: 50, score: 80 }),
		];
		expect(filterToRisers(findings, baseline)).toHaveLength(1);
	});

	it("keeps findings when the file is absent from baseline (new file)", () => {
		const baseline = new Map([["src/other.ts", new Map([["foo@1", 100]])]]);
		const findings = [
			mkFinding({ file: "src/newFile.ts", fn: "foo", line: 1, score: 80 }),
		];
		expect(filterToRisers(findings, baseline)).toHaveLength(1);
	});

	it("distinguishes same-named functions at different lines", () => {
		const baseline = new Map([
			["src/a.ts", new Map([["handler@10", 50]])],
		]);
		const findings = [
			mkFinding({ file: "src/a.ts", fn: "handler", line: 10, score: 50 }),
			mkFinding({ file: "src/a.ts", fn: "handler", line: 40, score: 80 }),
		];
		const risers = filterToRisers(findings, baseline);
		expect(risers).toHaveLength(1);
		expect(risers[0].line).toBe(40);
	});

	it("handles a renamed function as new (baseline keyed by name)", () => {
		const baseline = new Map([
			["src/a.ts", new Map([["oldName@10", 100]])],
		]);
		const findings = [
			mkFinding({ file: "src/a.ts", fn: "newName", line: 10, score: 80 }),
		];
		// Rename looks like a new function to filterToRisers — surfaced even
		// if the score dropped. Acceptable behaviour: agents should see the
		// post-rename CRAP, not silently inherit the old identity.
		expect(filterToRisers(findings, baseline)).toHaveLength(1);
	});
});

// ==================================================================
// computeCrapRisers (coverage-hole alarm)
// ==================================================================

describe("computeCrapRisers", () => {
	it("fails open (returns []) when no coverage report exists", () => {
		// No coverage/ dir under the cwd → loadCoverageFinal returns null →
		// CRAP can't be scored, so the alarm stays silent rather than throwing.
		const risers = computeCrapRisers({
			content: "export function f(): number {\n\treturn 1;\n}\n",
			absFilePath: "/nonexistent-interlinked/repo/src/f.ts",
			cwd: "/nonexistent-interlinked/repo",
			baseline: new Map(),
		});
		expect(risers).toEqual([]);
	});
});
