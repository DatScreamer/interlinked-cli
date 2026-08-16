// Evidence for the three SessionEnd baseline folds.
//
// Labeled per the Check Evidence Contract: each describe names a direction,
// so every `it()` inside inherits it.
//   positive (must fold)     — a genuine tighten lands on disk
//   negative (must not fold) — a would-be LOOSENING is refused, a dry run
//                              writes nothing, absent inputs are silent

import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findCoverageSummary,
	foldCoverage,
	foldLargeFiles,
	foldUntestedFiles,
	isCoverageReportFresh,
	planExemptionDrops,
	planGrandfatherShrink,
	toRepoRelative,
} from "./baseline-autofold-folds.js";
import { resetLargeFileBaselineCache } from "./large-file-policy.js";
import { resetUntestedFilesBaselineCache } from "./tested-file-policy.js";

let cwd = "";
/** Deterministic stand-in for a session start: far in the future, so any
 *  report on disk is older than it. Never the real clock — see the
 *  test_nondeterminism check. */
const FIXED_SESSION_START_MS = 4_000_000_000_000;
/** Deterministic fixture-dir suffix (no Math.random — same reason). */
let fixtureSeq = 0;

function write(rel: string, body: string): string {
	const abs = join(cwd, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, body, "utf-8");
	return abs;
}

function writeCoverageBaseline(files: Record<string, { lines_pct: number; branches_pct: number }>) {
	write(
		".interlinked/coverage-baseline.json",
		JSON.stringify({ version: 1, updated_at: new Date(0).toISOString(), files }),
	);
}

function readCoverageBaseline(): { files: Record<string, { lines_pct: number }> } {
	const raw: unknown = JSON.parse(readFileSync(join(cwd, ".interlinked/coverage-baseline.json"), "utf-8"));
	// SAFETY: this test wrote the file through writeCoverageBaseline / foldCoverage,
	// both of which emit the CoverageBaseline shape.
	return raw as { files: Record<string, { lines_pct: number }> };
}

function writeCoverageReport(files: Record<string, number>, mtimeSec?: number) {
	const summary: Record<string, unknown> = {};
	for (const [file, pct] of Object.entries(files)) {
		summary[file] = { lines: { pct }, branches: { pct }, statements: { pct }, functions: { pct } };
	}
	const abs = write("coverage/coverage-summary.json", JSON.stringify(summary));
	if (mtimeSec !== undefined) utimesSync(abs, mtimeSec, mtimeSec);
}

function writeUntestedBaseline(files: string[]) {
	write(
		".interlinked/untested-files-baseline.json",
		JSON.stringify({ version: 1, min_coverage_pct: 60, files }),
	);
	resetUntestedFilesBaselineCache();
}

function readUntestedFiles(): string[] {
	const raw: unknown = JSON.parse(
		readFileSync(join(cwd, ".interlinked/untested-files-baseline.json"), "utf-8"),
	);
	// SAFETY: written above / by saveUntestedFilesBaseline — `files` is a string[].
	return (raw as { files: string[] }).files;
}

function writeLargeFileBaseline(maxLines: number, files: Record<string, number>) {
	write(".interlinked/large-files-baseline.json", JSON.stringify({ version: 1, max_lines: maxLines, files }));
	resetLargeFileBaselineCache();
}

function readLargeFiles(): Record<string, number> {
	const raw: unknown = JSON.parse(
		readFileSync(join(cwd, ".interlinked/large-files-baseline.json"), "utf-8"),
	);
	// SAFETY: written above / by saveLargeFileBaseline — `files` is path→count.
	return (raw as { files: Record<string, number> }).files;
}

beforeEach(() => {
	fixtureSeq += 1;
	cwd = join(tmpdir(), `autofold-folds-${process.pid}-${fixtureSeq}`);
	mkdirSync(join(cwd, ".interlinked"), { recursive: true });
});

afterEach(() => {
	resetUntestedFilesBaselineCache();
	resetLargeFileBaselineCache();
	rmSync(cwd, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────
describe("coverage fold — positive (must fold)", () => {
	it("P1: raises a per-file high-water that increased", () => {
		writeCoverageBaseline({ "src/a.ts": { lines_pct: 40, branches_pct: 40 } });
		writeCoverageReport({ "src/a.ts": 90 });
		const out = foldCoverage({ cwd, interlinkedDir: join(cwd, ".interlinked"), sessionStartMs: 0, dryRun: false });
		expect(out.changed).toBe(1);
		expect(readCoverageBaseline().files["src/a.ts"]?.lines_pct).toBe(90);
	});

	it("P2: reports the report path it selected", () => {
		writeCoverageReport({ "src/a.ts": 10 });
		expect(findCoverageSummary(cwd)).toBe(join(cwd, "coverage/coverage-summary.json"));
	});

	it("P3: a report newer than the baseline counts as fresh", () => {
		expect(isCoverageReportFresh({ reportMtimeMs: 200, baselineMtimeMs: 100, sessionStartMs: 9e12 })).toBe(true);
	});
});

describe("coverage fold — negative (must not fold)", () => {
	it("N1: refuses to LOWER a high-water that dropped", () => {
		writeCoverageBaseline({ "src/a.ts": { lines_pct: 90, branches_pct: 90 } });
		writeCoverageReport({ "src/a.ts": 10 });
		const out = foldCoverage({ cwd, interlinkedDir: join(cwd, ".interlinked"), sessionStartMs: 0, dryRun: false });
		expect(out.changed).toBe(0);
		expect(readCoverageBaseline().files["src/a.ts"]?.lines_pct).toBe(90);
	});

	it("N2: writes nothing on a dry run", () => {
		writeCoverageBaseline({ "src/a.ts": { lines_pct: 40, branches_pct: 40 } });
		writeCoverageReport({ "src/a.ts": 90 });
		const out = foldCoverage({ cwd, interlinkedDir: join(cwd, ".interlinked"), sessionStartMs: 0, dryRun: true });
		expect(out.dryRun).toBe(true);
		expect(readCoverageBaseline().files["src/a.ts"]?.lines_pct).toBe(40);
	});

	it("N3: is silent when no coverage report exists", () => {
		const out = foldCoverage({ cwd, interlinkedDir: join(cwd, ".interlinked"), sessionStartMs: 0, dryRun: false });
		expect(out.skipped).toBe("no-input");
		expect(out.changed).toBe(0);
	});

	it("N4: skips a report older than both the session and the baseline", () => {
		writeCoverageBaseline({ "src/a.ts": { lines_pct: 40, branches_pct: 40 } });
		writeCoverageReport({ "src/a.ts": 90 }, 1_000_000);
		const out = foldCoverage({
			cwd,
			interlinkedDir: join(cwd, ".interlinked"),
			sessionStartMs: FIXED_SESSION_START_MS,
			dryRun: false,
		});
		expect(out.skipped).toBe("stale-report");
		expect(readCoverageBaseline().files["src/a.ts"]?.lines_pct).toBe(40);
	});

	it("N5: a report older than the session AND the baseline is not fresh", () => {
		expect(isCoverageReportFresh({ reportMtimeMs: 50, baselineMtimeMs: 100, sessionStartMs: 80 })).toBe(false);
	});
});

// ───────────────────────────────────────────────────────────────────
describe("untested-files fold — positive (must fold)", () => {
	it("P1: drops an exemption once the file gains a companion test", () => {
		writeUntestedBaseline(["src/a.ts", "src/b.ts"]);
		write("src/a.ts", "export const a = 1;\n");
		write("src/a.test.ts", "it('x', () => {});\n");
		const out = foldUntestedFiles({ cwd, touched: ["src/a.ts"], dryRun: false });
		expect(out.changed).toBe(1);
		expect(readUntestedFiles()).toEqual(["src/b.ts"]);
	});

	it("P2: the planner removes only the tested touched entry", () => {
		const plan = planExemptionDrops({
			baseline: { version: 1, min_coverage_pct: 60, files: new Set(["x.ts", "y.ts"]) },
			touched: ["x.ts", "y.ts"],
			hasTest: (rel) => rel === "x.ts",
		});
		expect([...plan.files]).toEqual(["y.ts"]);
		expect(plan.dropped).toEqual(["x.ts"]);
	});
});

describe("untested-files fold — negative (must not fold)", () => {
	it("N1: never ADDS a new exemption for an untested touched file", () => {
		const plan = planExemptionDrops({
			baseline: { version: 1, min_coverage_pct: 60, files: new Set(["x.ts"]) },
			touched: ["brand-new.ts"],
			hasTest: () => false,
		});
		expect(plan.files.has("brand-new.ts")).toBe(false);
		expect(plan.dropped).toEqual([]);
	});

	it("N2: keeps the exemption when no companion test exists", () => {
		writeUntestedBaseline(["src/a.ts"]);
		write("src/a.ts", "export const a = 1;\n");
		const out = foldUntestedFiles({ cwd, touched: ["src/a.ts"], dryRun: false });
		expect(out.skipped).toBe("no-change");
		expect(readUntestedFiles()).toEqual(["src/a.ts"]);
	});

	it("N3: writes nothing on a dry run", () => {
		writeUntestedBaseline(["src/a.ts"]);
		write("src/a.ts", "export const a = 1;\n");
		write("src/a.test.ts", "it('x', () => {});\n");
		const out = foldUntestedFiles({ cwd, touched: ["src/a.ts"], dryRun: true });
		expect(out.changed).toBe(1);
		expect(readUntestedFiles()).toEqual(["src/a.ts"]);
	});

	it("N4: is silent when no baseline file exists", () => {
		write("src/a.ts", "export const a = 1;\n");
		const out = foldUntestedFiles({ cwd, touched: ["src/a.ts"], dryRun: false });
		expect(out.skipped).toBe("no-baseline");
	});

	it("N5: is silent when the session wrote nothing", () => {
		writeUntestedBaseline(["src/a.ts"]);
		expect(foldUntestedFiles({ cwd, touched: [], dryRun: false }).skipped).toBe("no-input");
	});
});

// ───────────────────────────────────────────────────────────────────
describe("large-files fold — positive (must fold)", () => {
	it("P1: drops a grandfather entry once the file is back under the cap", () => {
		writeLargeFileBaseline(10, { "src/big.ts": 40 });
		write("src/big.ts", "a\n".repeat(5));
		const out = foldLargeFiles({ cwd, touched: ["src/big.ts"], dryRun: false });
		expect(out.changed).toBe(1);
		expect(readLargeFiles()).toEqual({});
	});

	it("P2: lowers a recorded count when the file shrank but is still over cap", () => {
		writeLargeFileBaseline(10, { "src/big.ts": 40 });
		write("src/big.ts", "a\n".repeat(20)); // 20 newlines => countLines 21
		foldLargeFiles({ cwd, touched: ["src/big.ts"], dryRun: false });
		expect(readLargeFiles()["src/big.ts"]).toBe(21);
	});
});

describe("large-files fold — negative (must not fold)", () => {
	it("N1: never RAISES a recorded count when the file grew", () => {
		const plan = planGrandfatherShrink({
			baseline: { version: 1, max_lines: 10, files: { "big.ts": 40 } },
			touched: ["big.ts"],
			lineCountOf: () => 900,
		});
		expect(plan.files["big.ts"]).toBe(40);
		expect(plan.tightened).toEqual([]);
	});

	it("N2: refuses to ADD a new over-cap file to the grandfather list", () => {
		const plan = planGrandfatherShrink({
			baseline: { version: 1, max_lines: 10, files: {} },
			touched: ["new-offender.ts"],
			lineCountOf: () => 900,
		});
		expect(plan.files["new-offender.ts"]).toBeUndefined();
		expect(plan.refused).toBe(1);
	});

	it("N3: writes nothing on a dry run", () => {
		writeLargeFileBaseline(10, { "src/big.ts": 40 });
		write("src/big.ts", "a\n".repeat(5));
		const out = foldLargeFiles({ cwd, touched: ["src/big.ts"], dryRun: true });
		expect(out.changed).toBe(1);
		expect(readLargeFiles()).toEqual({ "src/big.ts": 40 });
	});

	it("N4: is silent when no baseline file exists", () => {
		write("src/big.ts", "a\n");
		expect(foldLargeFiles({ cwd, touched: ["src/big.ts"], dryRun: false }).skipped).toBe("no-baseline");
	});

	it("N5: leaves an unreadable/missing touched file alone", () => {
		writeLargeFileBaseline(10, { "src/gone.ts": 40 });
		const out = foldLargeFiles({ cwd, touched: ["src/gone.ts"], dryRun: false });
		expect(out.skipped).toBe("no-change");
		expect(readLargeFiles()).toEqual({ "src/gone.ts": 40 });
	});
});

// ───────────────────────────────────────────────────────────────────
describe("toRepoRelative — positive (must normalize)", () => {
	it("P1: converts absolute in-repo paths to repo-relative POSIX", () => {
		expect(toRepoRelative("/repo", ["/repo/src/a.ts", "src/b.ts"])).toEqual(["src/a.ts", "src/b.ts"]);
	});
});

describe("toRepoRelative — negative (must drop)", () => {
	it("N1: drops paths outside the repo and empty entries", () => {
		expect(toRepoRelative("/repo", ["/elsewhere/a.ts", "", "/repo"])).toEqual([]);
	});
});

// A file the folds rely on existing for the untested-fold companion lookup.
it("sanity: the tmp fixture root is created", () => {
	expect(existsSync(cwd)).toBe(true);
});
