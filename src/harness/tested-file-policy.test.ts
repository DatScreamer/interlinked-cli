import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	DEFAULT_MIN_COVERAGE_PCT,
	evaluateTestedFile,
	hasCompanionTest,
	isTestableSourceFile,
	loadUntestedFilesBaseline,
	minCoverageFor,
	resetUntestedFilesBaselineCache,
	type UntestedFilesBaseline,
} from "./tested-file-policy.js";

describe("DEFAULT_MIN_COVERAGE_PCT", () => {
	it("is the canonical 60% threshold", () => {
		expect(DEFAULT_MIN_COVERAGE_PCT).toBe(60);
	});

	// Single source of truth: the in-code default and the committed baseline's
	// min_coverage_pct MUST be the same number, so the enforced threshold is never
	// two values depending on whether a baseline loaded. Ratcheting the threshold
	// means changing BOTH together; this test fails the moment they drift apart.
	it("equals the committed baseline's min_coverage_pct (no drift)", () => {
		const baselinePath = join(
			process.cwd(),
			".interlinked",
			"untested-files-baseline.json",
		);
		const committed = JSON.parse(readFileSync(baselinePath, "utf-8")) as {
			min_coverage_pct: number;
		};
		expect(committed.min_coverage_pct).toBe(DEFAULT_MIN_COVERAGE_PCT);
	});
});

describe("isTestableSourceFile", () => {
	it("flags hand-written source modules across adapter languages", () => {
		expect(isTestableSourceFile("src/harness/server.ts")).toBe(true);
		expect(isTestableSourceFile("src/lib/config.ts")).toBe(true);
		expect(isTestableSourceFile("pkg/handler.go")).toBe(true);
		expect(isTestableSourceFile("app/main.py")).toBe(true);
		expect(isTestableSourceFile("crate/src/lib.rs")).toBe(true);
	});

	it("exempts test/spec files, declarations, and landing/static dirs", () => {
		expect(isTestableSourceFile("src/foo.test.ts")).toBe(false);
		expect(isTestableSourceFile("src/foo.spec.tsx")).toBe(false);
		expect(isTestableSourceFile("src/harness/__tests__/evaluator.test.ts")).toBe(false);
		expect(isTestableSourceFile("src/api.d.ts")).toBe(false);
		expect(isTestableSourceFile("landing/index.ts")).toBe(false);
		expect(isTestableSourceFile("scripts/build.ts")).toBe(false);
	});

	it("exempts non-source extensions", () => {
		expect(isTestableSourceFile("docs/guide.md")).toBe(false);
		expect(isTestableSourceFile("config/data.json")).toBe(false);
	});
});

describe("evaluateTestedFile", () => {
	const baseline: UntestedFilesBaseline = {
		version: 1,
		min_coverage_pct: 60,
		files: new Set(["src/legacy/old.ts"]),
	};

	it("flags an untested, non-grandfathered file (no companion, coverage below threshold)", () => {
		const verdict = evaluateTestedFile({
			input: { relPath: "src/new.ts", hasCompanion: false, coveragePct: 10 },
			baseline,
		});
		expect(verdict.untested).toBe(true);
		expect(verdict.grandfathered).toBe(false);
	});

	it("flags an untested file when coverage is null (file absent from the report)", () => {
		const verdict = evaluateTestedFile({
			input: { relPath: "src/orphan.ts", hasCompanion: false, coveragePct: null },
			baseline,
		});
		expect(verdict.untested).toBe(true);
		expect(verdict.grandfathered).toBe(false);
	});

	it("passes a file with a companion test regardless of coverage", () => {
		const withNullCov = evaluateTestedFile({
			input: { relPath: "src/tested.ts", hasCompanion: true, coveragePct: null },
			baseline,
		});
		expect(withNullCov.untested).toBe(false);
		const withLowCov = evaluateTestedFile({
			input: { relPath: "src/tested.ts", hasCompanion: true, coveragePct: 3 },
			baseline,
		});
		expect(withLowCov.untested).toBe(false);
	});

	it("passes a companion-less file whose coverage is at/above the threshold", () => {
		const atThreshold = evaluateTestedFile({
			input: { relPath: "src/covered.ts", hasCompanion: false, coveragePct: 60 },
			baseline,
		});
		expect(atThreshold.untested).toBe(false);
		const aboveThreshold = evaluateTestedFile({
			input: { relPath: "src/covered.ts", hasCompanion: false, coveragePct: 92 },
			baseline,
		});
		expect(aboveThreshold.untested).toBe(false);
	});

	it("grandfathers a baselined untested file (does not fail the gate)", () => {
		const verdict = evaluateTestedFile({
			input: { relPath: "src/legacy/old.ts", hasCompanion: false, coveragePct: null },
			baseline,
		});
		expect(verdict.untested).toBe(true);
		expect(verdict.grandfathered).toBe(true);
	});

	it("falls back to DEFAULT_MIN_COVERAGE_PCT when no baseline is loaded", () => {
		// 50% is below the default 60% threshold and there is no grandfather list.
		const verdict = evaluateTestedFile({
			input: { relPath: "src/x.ts", hasCompanion: false, coveragePct: 50 },
			baseline: null,
		});
		expect(verdict.untested).toBe(true);
		expect(verdict.grandfathered).toBe(false);
	});
});

describe("hasCompanionTest", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "tfp-companion-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("is true when a sibling *.test.ts exists", () => {
		writeFileSync(join(dir, "svc.ts"), "export const x = 1;\n");
		writeFileSync(join(dir, "svc.test.ts"), "import './svc.js';\n");
		expect(hasCompanionTest("svc.ts", dir)).toBe(true);
	});

	it("is true when a __tests__/*.test.ts exists", () => {
		writeFileSync(join(dir, "svc.ts"), "export const x = 1;\n");
		mkdirSync(join(dir, "__tests__"), { recursive: true });
		writeFileSync(join(dir, "__tests__", "svc.test.ts"), "import '../svc.js';\n");
		expect(hasCompanionTest("svc.ts", dir)).toBe(true);
	});

	it("is false when no companion exists", () => {
		writeFileSync(join(dir, "lonely.ts"), "export const x = 1;\n");
		expect(hasCompanionTest("lonely.ts", dir)).toBe(false);
	});
});

describe("loadUntestedFilesBaseline + minCoverageFor", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "tfp-"));
		resetUntestedFilesBaselineCache();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		resetUntestedFilesBaselineCache();
	});

	it("returns null + the default threshold when no baseline file exists", () => {
		expect(loadUntestedFilesBaseline(dir)).toBeNull();
		expect(minCoverageFor(dir)).toBe(DEFAULT_MIN_COVERAGE_PCT);
	});

	it("loads min_coverage_pct and the grandfather set", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(dir, ".interlinked", "untested-files-baseline.json"),
			JSON.stringify({ version: 1, min_coverage_pct: 70, files: ["src/a.ts", "src/b.ts"] }),
		);
		resetUntestedFilesBaselineCache();
		const baseline = loadUntestedFilesBaseline(dir);
		expect(baseline?.min_coverage_pct).toBe(70);
		expect(baseline?.files.has("src/a.ts")).toBe(true);
		expect(baseline?.files.has("src/b.ts")).toBe(true);
		expect(minCoverageFor(dir)).toBe(70);
	});

	it("fails soft to the default threshold on malformed JSON", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(join(dir, ".interlinked", "untested-files-baseline.json"), "{ not json");
		resetUntestedFilesBaselineCache();
		expect(loadUntestedFilesBaseline(dir)).toBeNull();
		expect(minCoverageFor(dir)).toBe(DEFAULT_MIN_COVERAGE_PCT);
	});

	it("fails soft when min_coverage_pct is missing or non-numeric", () => {
		mkdirSync(join(dir, ".interlinked"), { recursive: true });
		writeFileSync(
			join(dir, ".interlinked", "untested-files-baseline.json"),
			JSON.stringify({ version: 1, files: ["src/a.ts"] }),
		);
		resetUntestedFilesBaselineCache();
		expect(loadUntestedFilesBaseline(dir)).toBeNull();
	});
});
