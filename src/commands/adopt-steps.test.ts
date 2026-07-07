// ===========================================
// adopt-steps — unit tests for the individual bootstrap steps
// ===========================================
// The end-to-end flow (walk → all five steps → summary) is covered by
// adopt.test.ts; these tests pin each step's direction rules and
// only-if-absent semantics in isolation, with hand-built scan inputs.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoverageRunner, CoverageRunResult } from "../harness/coverage-runner.js";
import { DEFAULT_MAX_LINES, resetLargeFileBaselineCache } from "../harness/large-file-policy.js";
import { resetMetricCapsCache } from "../harness/metric-caps.js";
import { readSuiteBaseline } from "../harness/suite-baseline.js";
import {
	DEFAULT_MIN_COVERAGE_PCT,
	resetUntestedFilesBaselineCache,
} from "../harness/tested-file-policy.js";
import {
	largeFilesStep,
	metricCapsStep,
	type RepoScan,
	suiteBaselineStep,
	untestedFilesStep,
} from "./adopt-steps.js";

let cwd: string;

/** A RepoScan with the given offenders and default thresholds. */
function scanWith(overrides: Partial<RepoScan> = {}): RepoScan {
	return {
		maxLines: DEFAULT_MAX_LINES,
		minCoveragePct: DEFAULT_MIN_COVERAGE_PCT,
		overCap: new Map(),
		untested: [],
		...overrides,
	};
}

function readJson(rel: string): Record<string, unknown> {
	// SAFETY: test-owned fixture files written by the steps under test; the
	// asserted keys are validated by the expects below.
	return JSON.parse(readFileSync(join(cwd, rel), "utf-8")) as Record<string, unknown>;
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "interlinked-adopt-steps-"));
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	resetLargeFileBaselineCache();
	resetUntestedFilesBaselineCache();
	resetMetricCapsCache();
});

describe("largeFilesStep", () => {
	it("grandfathers each over-cap file at its current line count", () => {
		const scan = scanWith({ overCap: new Map([["src/a.ts", 700]]) });
		const result = largeFilesStep(cwd, scan, false);
		expect(result.action).toBe("written");
		const baseline = readJson(".interlinked/large-files-baseline.json");
		expect(baseline.files).toEqual({ "src/a.ts": 700 });
		expect(baseline.max_lines).toBe(DEFAULT_MAX_LINES);
	});

	it("keeps the tighter recorded count when the file grew (never loosens)", () => {
		largeFilesStep(cwd, scanWith({ overCap: new Map([["src/a.ts", 600]]) }), false);
		const result = largeFilesStep(cwd, scanWith({ overCap: new Map([["src/a.ts", 650]]) }), false);
		expect(result.kept_tighter).toBe(1);
		const baseline = readJson(".interlinked/large-files-baseline.json");
		expect(baseline.files).toEqual({ "src/a.ts": 600 });
	});

	it("refreshes downward and drops entries no longer over cap", () => {
		largeFilesStep(
			cwd,
			scanWith({
				overCap: new Map([
					["src/a.ts", 700],
					["src/b.ts", 800],
				]),
			}),
			false,
		);
		largeFilesStep(cwd, scanWith({ overCap: new Map([["src/a.ts", 620]]) }), false);
		const baseline = readJson(".interlinked/large-files-baseline.json");
		expect(baseline.files).toEqual({ "src/a.ts": 620 });
	});

	it("does NOT grow the grandfather set on a re-run: a newly-over-cap file is refused", () => {
		// First adoption grandfathers the current over-cap file.
		largeFilesStep(cwd, scanWith({ overCap: new Map([["src/a.ts", 700]]) }), false);
		// b.ts went over cap AFTER the first adoption — grandfathering it would
		// pre-authorize a new over-cap file (the loosening the baseline-integrity
		// gate blocks on the agent path). A re-run REFUSES it instead of growing.
		const result = largeFilesStep(
			cwd,
			scanWith({
				overCap: new Map([
					["src/a.ts", 700],
					["src/b.ts", 900],
				]),
			}),
			false,
		);
		const baseline = readJson(".interlinked/large-files-baseline.json");
		expect(baseline.files).toEqual({ "src/a.ts": 700 }); // b.ts NOT grandfathered
		expect(result.detail).toContain("REFUSED");
	});

	it("writes nothing under dry-run", () => {
		const result = largeFilesStep(cwd, scanWith({ overCap: new Map([["src/a.ts", 700]]) }), true);
		expect(result.action).toBe("would-write");
		expect(existsSync(join(cwd, ".interlinked/large-files-baseline.json"))).toBe(false);
	});
});

describe("untestedFilesStep", () => {
	it("exempts the scanned untested files, sorted", () => {
		untestedFilesStep(cwd, scanWith({ untested: ["src/z.ts", "src/a.ts"] }), false);
		const baseline = readJson(".interlinked/untested-files-baseline.json");
		expect(baseline.files).toEqual(["src/a.ts", "src/z.ts"]);
		expect(baseline.min_coverage_pct).toBe(DEFAULT_MIN_COVERAGE_PCT);
	});

	it("does NOT grow the exemption list on a re-run: keeps still-untested exemptions, refuses new offenders", () => {
		// First adoption bootstraps the current offenders.
		untestedFilesStep(cwd, scanWith({ untested: ["src/keep.ts", "src/fixed.ts"] }), false);
		// Re-run: keep.ts is still untested (stays); fixed.ts gained a test (drops
		// off — a safe shrink); new.ts became untested AFTER the first adoption.
		// Exempting a newly-appeared offender loosens the coverage floor, so the
		// re-run REFUSES it — the list may shrink but never grow. (adopt writes via
		// plain fs and bypasses the baseline-integrity gate, so the rule lives here.)
		const result = untestedFilesStep(
			cwd,
			scanWith({ untested: ["src/keep.ts", "src/new.ts"] }),
			false,
		);
		const baseline = readJson(".interlinked/untested-files-baseline.json");
		expect(baseline.files).toEqual(["src/keep.ts"]); // new.ts NOT added; fixed.ts dropped
		expect(result.detail).toContain("(0 new, 1 dropped)");
		expect(result.detail).toContain("1 new offender(s) REFUSED");
	});

	it("preserves an existing threshold verbatim", () => {
		writeFileSync(
			join(cwd, ".interlinked-seed.json"),
			"", // placeholder so mkdtemp dir is non-empty before the step creates .interlinked/
		);
		untestedFilesStep(cwd, scanWith({ untested: [] }), false);
		// hand-tighten the threshold, then refresh
		writeFileSync(
			join(cwd, ".interlinked/untested-files-baseline.json"),
			`${JSON.stringify({ version: 1, min_coverage_pct: 80, files: [] })}\n`,
		);
		resetUntestedFilesBaselineCache();
		untestedFilesStep(cwd, scanWith({ untested: ["src/a.ts"] }), false);
		const baseline = readJson(".interlinked/untested-files-baseline.json");
		expect(baseline.min_coverage_pct).toBe(80);
	});
});

describe("metricCapsStep", () => {
	it("writes shipped defaults when metric-caps.json is absent", () => {
		const result = metricCapsStep(cwd, false);
		expect(result.action).toBe("written");
		const caps = readJson(".interlinked/metric-caps.json");
		expect(caps.max_lines).toBe(DEFAULT_MAX_LINES);
		expect(caps.version).toBe(1);
	});

	it("respects an existing metric-caps.json (only-if-absent)", () => {
		metricCapsStep(cwd, false);
		writeFileSync(
			join(cwd, ".interlinked/metric-caps.json"),
			`${JSON.stringify({ version: 1, max_lines: 400 })}\n`,
		);
		resetMetricCapsCache();
		const result = metricCapsStep(cwd, false);
		expect(result.action).toBe("unchanged");
		expect(readJson(".interlinked/metric-caps.json").max_lines).toBe(400);
	});

	it("writes nothing under dry-run", () => {
		const result = metricCapsStep(cwd, true);
		expect(result.action).toBe("would-write");
		expect(existsSync(join(cwd, ".interlinked/metric-caps.json"))).toBe(false);
	});
});

describe("suiteBaselineStep (opt-in step 6)", () => {
	const BASELINE_REL = ".interlinked/suite-baseline.json";

	/** A repo whose profile detects a js runner (vitest in devDependencies). */
	function writeVitestManifest(): void {
		writeFileSync(
			join(cwd, "package.json"),
			JSON.stringify({ name: "fixture", devDependencies: { vitest: "^3.0.0" } }),
			"utf-8",
		);
	}

	function stubRunner(result: Partial<CoverageRunResult>): CoverageRunner {
		const full: CoverageRunResult = {
			suiteMs: 5,
			perFile: new Map(),
			ok: true,
			testsPassed: true,
			...result,
		};
		return { id: "stub", run: async () => full };
	}

	it("records a GREEN suite (empty failing set)", async () => {
		writeVitestManifest();
		const result = await suiteBaselineStep(cwd, false, () => stubRunner({ testsPassed: true }));
		expect(result.action).toBe("written");
		const baseline = readSuiteBaseline(cwd);
		expect(baseline?.green).toBe(true);
		expect(baseline?.failing_tests).toEqual([]);
		expect(baseline?.language).toBe("ts");
	});

	it("records a RED suite with its pre-existing failing tests", async () => {
		writeVitestManifest();
		const result = await suiteBaselineStep(cwd, false, () =>
			stubRunner({ testsPassed: false, failingTests: ["a.test.ts > breaks", "b.test.ts > also"] }),
		);
		expect(result.action).toBe("written");
		expect(result.detail).toContain("2 pre-existing failing test(s)");
		const baseline = readSuiteBaseline(cwd);
		expect(baseline?.green).toBe(false);
		expect(baseline?.failing_tests).toEqual(["a.test.ts > breaks", "b.test.ts > also"]);
	});

	it("does NOT record when the runner could not establish a result (ok: false)", async () => {
		writeVitestManifest();
		const result = await suiteBaselineStep(cwd, false, () =>
			stubRunner({ ok: false, error: "vitest not launchable", testsPassed: null }),
		);
		expect(result.action).toBe("failed");
		expect(readSuiteBaseline(cwd)).toBeNull();
	});

	it("skips (unchanged) when no supported runner is detected — never spawns", async () => {
		// Bare tmp dir: no package.json, no pytest markers → profile finds nothing.
		let resolverCalled = false;
		const result = await suiteBaselineStep(cwd, false, () => {
			resolverCalled = true;
			return stubRunner({});
		});
		expect(result.action).toBe("unchanged");
		expect(resolverCalled).toBe(false);
		expect(readSuiteBaseline(cwd)).toBeNull();
	});

	it("writes nothing under dry-run even with a runner present", async () => {
		writeVitestManifest();
		const result = await suiteBaselineStep(cwd, true, () => stubRunner({}));
		expect(result.action).toBe("would-write");
		expect(readSuiteBaseline(cwd)).toBeNull();
	});
});
