import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	__resetCoverageFinalCache,
	type PerFileCoverage,
} from "../coverage-final-reader.js";
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

	// --- F6: line-drift tolerance (was exact name@line → false "new function") ---

	it("tolerates line drift: an unchanged function shifted down is NOT a false riser", () => {
		// Pre-edit foo@10, score 100. The edit inserts 30 lines above, so foo is
		// now at line 40 with the SAME score. Exact name@line keying would miss
		// (foo@40 != foo@10), call it a brand-new function, and fire a false riser.
		const baseline = new Map([["src/a.ts", new Map([["foo@10", 100]])]]);
		const findings = [mkFinding({ file: "src/a.ts", fn: "foo", line: 40, score: 100 })];
		expect(filterToRisers(findings, baseline)).toEqual([]);
	});

	it("tolerates line drift but still flags a genuine score rise", () => {
		const baseline = new Map([["src/a.ts", new Map([["foo@10", 100]])]]);
		const findings = [mkFinding({ file: "src/a.ts", fn: "foo", line: 40, score: 150 })];
		const risers = filterToRisers(findings, baseline);
		expect(risers).toHaveLength(1);
		expect(risers[0].crap_score).toBe(150);
	});

	// --- priorScoreFor drift-loop internals (reached via filterToRisers) ---

	it("matches a baseline key that has NO line suffix (treated as line 0)", () => {
		// A malformed/bare baseline key "foo" (no "@line") must still match a
		// finding for `foo`: parseBaselineKey falls back to line 0, the name
		// matches, and the drift fallback adopts that prior score. The exact
		// `foo@5` lookup misses, forcing the name-keyed fallback path.
		const baseline = new Map([["src/a.ts", new Map([["foo", 100]])]]);
		const rose = filterToRisers(
			[mkFinding({ file: "src/a.ts", fn: "foo", line: 5, score: 150 })],
			baseline,
		);
		const flat = filterToRisers(
			[mkFinding({ file: "src/a.ts", fn: "foo", line: 5, score: 80 })],
			baseline,
		);
		expect(rose).toHaveLength(1); // 150 > 100 (bare-key prior) → kept
		expect(flat).toEqual([]); // 80 < 100 → dropped, so the bare key matched
	});

	it("matches a baseline key whose line part is non-numeric (NaN → 0)", () => {
		// Key "foo@bar": lastIndexOf("@") succeeds but Number("bar") is NaN, so
		// the `|| 0` fallback yields line 0. The name still matches and the prior
		// score is honoured (proving the fallback didn't discard the entry).
		const baseline = new Map([["src/a.ts", new Map([["foo@bar", 100]])]]);
		const rose = filterToRisers(
			[mkFinding({ file: "src/a.ts", fn: "foo", line: 5, score: 150 })],
			baseline,
		);
		const flat = filterToRisers(
			[mkFinding({ file: "src/a.ts", fn: "foo", line: 5, score: 80 })],
			baseline,
		);
		expect(rose).toHaveLength(1);
		expect(flat).toEqual([]);
	});

	it("picks the NEAREST same-named baseline entry when several drift candidates exist", () => {
		// Two same-named priors at line 10 (score 50) and line 100 (score 99).
		// A finding at line 12 has no exact `foo@12` key, so the drift loop runs:
		// foo@10 is delta 2 (nearest), foo@100 is delta 88 (farther, must be
		// skipped). The comparison therefore baselines against 50, NOT 99.
		const baseline = new Map([
			[
				"src/a.ts",
				new Map([
					["foo@10", 50],
					["foo@100", 99],
				]),
			],
		]);
		// 50 ties the nearest prior → not a rise → dropped (would survive if the
		// loop had wrongly latched onto the farther 99 < 50-vs-50 logic).
		const tied = filterToRisers(
			[mkFinding({ file: "src/a.ts", fn: "foo", line: 12, score: 50 })],
			baseline,
		);
		// 60 > nearest prior (50) → kept; this is < the farther prior (99), so a
		// "nearest" pick is the only way it surfaces.
		const rose = filterToRisers(
			[mkFinding({ file: "src/a.ts", fn: "foo", line: 12, score: 60 })],
			baseline,
		);
		expect(tied).toEqual([]);
		expect(rose).toHaveLength(1);
		expect(rose[0].crap_score).toBe(60);
	});
});

// ==================================================================
// computeCrapRisers (coverage-hole alarm)
// ==================================================================

describe("computeCrapRisers", () => {
	// A function with cyclomatic complexity 7 and ~20% statement coverage scores
	// CRAP = 7² · (1 − 0.20)³ + 7 = 32.088, which clears the hardcoded threshold
	// of 30 inside computeCrapRisers — so it surfaces as a finding.
	const GNARLY_SRC = `export function gnarly(x) {
	if (x > 0) return 1;
	if (x < 0) return -1;
	if (x === 0) return 0;
	for (let i = 0; i < x; i++) { if (i % 2) return i; }
	return x && x;
}
`;

	let tmpDirs: string[] = [];

	afterEach(() => {
		for (const d of tmpDirs) {
			rmSync(d, { recursive: true, force: true });
		}
		tmpDirs = [];
		// The coverage-final reader caches by abs-path+mtime; clear it so each
		// fixture (which reuses the OS tmp namespace) reads its own file fresh.
		__resetCoverageFinalCache();
	});

	/** Write a minimal istanbul coverage-final.json scoring `gnarly` at ~20%. */
	function writeGnarlyCoverage(dir: string, srcAbsPath: string): void {
		const covDir = join(dir, "coverage");
		mkdirSync(covDir, { recursive: true });
		const final = {
			[srcAbsPath]: {
				path: srcAbsPath,
				fnMap: {
					"0": {
						name: "gnarly",
						decl: { start: { line: 1 }, end: { line: 1 } },
						loc: { start: { line: 1 }, end: { line: 7 } },
					},
				},
				f: { "0": 1 },
				statementMap: {
					"0": { start: { line: 2 }, end: { line: 2 } },
					"1": { start: { line: 3 }, end: { line: 3 } },
					"2": { start: { line: 4 }, end: { line: 4 } },
					"3": { start: { line: 5 }, end: { line: 5 } },
					"4": { start: { line: 6 }, end: { line: 6 } },
				},
				// 1 of 5 statements covered → 20% → CRAP 32.088.
				s: { "0": 1, "1": 0, "2": 0, "3": 0, "4": 0 },
			},
		};
		writeFileSync(join(covDir, "coverage-final.json"), JSON.stringify(final));
	}

	/** Fresh isolated repo dir with `src/<rel>` written to disk. */
	function mkRepo(relSrc: string, content: string): { dir: string; abs: string } {
		const dir = mkdtempSync(join(tmpdir(), "crap-risers-"));
		tmpDirs.push(dir);
		const abs = join(dir, relSrc);
		mkdirSync(join(dir, relSrc, ".."), { recursive: true });
		writeFileSync(abs, content);
		return { dir, abs };
	}

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

	it("surfaces a high-CRAP riser when coverage exists and baseline is empty", () => {
		const { dir, abs } = mkRepo("src/mod.ts", GNARLY_SRC);
		writeGnarlyCoverage(dir, abs);

		const risers = computeCrapRisers({
			content: GNARLY_SRC,
			absFilePath: abs,
			cwd: dir,
			baseline: new Map(),
		});

		expect(risers).toHaveLength(1);
		const r = risers[0];
		expect(r.function).toBe("gnarly");
		expect(r.file).toBe("src/mod.ts");
		expect(r.complexity).toBe(7);
		expect(r.coverage_pct).toBe(20);
		expect(r.crap_score).toBeCloseTo(32.088, 2);
	});

	it("returns [] when the edited file is absent from the coverage report", () => {
		// Coverage exists but only for src/other.ts. The edited file src/mod.ts has
		// no per-file entry, so coverageForFile misses and the alarm stays silent.
		const dir = mkdtempSync(join(tmpdir(), "crap-risers-"));
		tmpDirs.push(dir);
		const otherAbs = join(dir, "src", "other.ts");
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(otherAbs, GNARLY_SRC);
		writeGnarlyCoverage(dir, otherAbs);
		const modAbs = join(dir, "src", "mod.ts");
		writeFileSync(modAbs, GNARLY_SRC);

		const risers = computeCrapRisers({
			content: GNARLY_SRC,
			absFilePath: modAbs,
			cwd: dir,
			baseline: new Map(),
		});

		expect(risers).toEqual([]);
	});

	it("applies the baseline filter: a pre-existing higher score is NOT re-surfaced", () => {
		// Same file + coverage, but the pre-edit baseline already recorded gnarly
		// at a higher CRAP (999). The post-edit score (32.088) is a DROP, so
		// filterToRisers removes it — proving computeCrapRisers wires the baseline
		// comparison through, not just the raw computeCrapForFile output.
		const { dir, abs } = mkRepo("src/mod.ts", GNARLY_SRC);
		writeGnarlyCoverage(dir, abs);

		const baseline = new Map([["src/mod.ts", new Map([["gnarly@1", 999]])]]);
		const risers = computeCrapRisers({
			content: GNARLY_SRC,
			absFilePath: abs,
			cwd: dir,
			baseline,
		});

		expect(risers).toEqual([]);
	});

	it("keeps the riser when the baseline score is LOWER than the post-edit score", () => {
		// Baseline recorded gnarly at 10; the post-edit score (32.088) is a rise,
		// so it survives the filter — the complementary case to the drop above.
		const { dir, abs } = mkRepo("src/mod.ts", GNARLY_SRC);
		writeGnarlyCoverage(dir, abs);

		const baseline = new Map([["src/mod.ts", new Map([["gnarly@1", 10]])]]);
		const risers = computeCrapRisers({
			content: GNARLY_SRC,
			absFilePath: abs,
			cwd: dir,
			baseline,
		});

		expect(risers).toHaveLength(1);
		expect(risers[0].crap_score).toBeCloseTo(32.088, 2);
	});
});
