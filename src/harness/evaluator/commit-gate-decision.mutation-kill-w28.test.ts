import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import type { ChangedSource, Violation } from "./commit-gate-scan.js";

// test-contract: mocked-collaborator — commit-gate-scan.js is mocked so
// scanFile's own branching (analyzer-null degrade path) is tested in
// isolation from the real coverage/cyclomatic/crap violation builders.
const { mockCoverageViolation, mockCyclomaticViolation, mockCrapViolation } = vi.hoisted(() => ({
	mockCoverageViolation: vi.fn(),
	mockCyclomaticViolation: vi.fn(),
	mockCrapViolation: vi.fn(),
}));
vi.mock("./commit-gate-scan.js", () => ({
	coverageViolation: mockCoverageViolation,
	crapViolation: mockCrapViolation,
	cyclomaticViolation: mockCyclomaticViolation,
	isTypeOnlySource: vi.fn(),
	missingCoverageViolation: vi.fn(),
}));

// test-contract: mocked-collaborator — suite-baseline.js reads a real file
// off `projectRoot`; mocked so decideRedBar's own branch logic is tested
// without touching the filesystem.
const { mockReadSuiteBaseline, mockNewFailures } = vi.hoisted(() => ({
	mockReadSuiteBaseline: vi.fn(),
	mockNewFailures: vi.fn(),
}));
vi.mock("../suite-baseline.js", () => ({
	readSuiteBaseline: mockReadSuiteBaseline,
	newFailures: mockNewFailures,
}));

import {
	blockForRedBar,
	blockForViolations,
	decideRedBar,
	degradeWithWarnings,
	failingTestPhrase,
	loudDegrade,
	scanFile,
} from "./commit-gate-decision.js";

function source(relPath = "foo.ts"): ChangedSource {
	return { relPath, language: "ts" };
}

function violation(i: number): Violation {
	return { kind: "uncovered", file: `f${i}.ts`, detail: `d${i}` };
}

describe("commit-gate-decision mutation kill (wave 28)", () => {
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		stderrSpy.mockRestore();
	});

	describe("scanFile — analyzer-null degrade path (positive — must fire)", () => {
		// test-contract: public-api — scanFile (exported): analyzer===null must
		// short-circuit via loudDegrade and skip cyclomatic/CRAP, per its own
		// doc comment "those two checks are skipped for this file".
		it("P1: returns early and skips cyclomatic/CRAP when analyzer is null", () => {
			mockCoverageViolation.mockReturnValueOnce(null);
			const cov: PerFileCoverage = { filePath: "foo.ts", mtime: 1, functions: [] };
			const result = scanFile({
				source: source("foo.ts"),
				cov,
				content: "x",
				analyzer: null,
				crapThreshold: 25,
				blockOnCrap: true,
			});

			expect(result).toEqual([]);
			expect(mockCyclomaticViolation).not.toHaveBeenCalled();
			expect(mockCrapViolation).not.toHaveBeenCalled();
			expect(stderrSpy).toHaveBeenCalledWith(
				"[interlinked:commit-gate] WARNING: commit-time quality gate degraded " +
					"(no cyclomatic analysis for foo.ts — CRAP / cyclomatic checks skipped) — " +
					"allowing the commit (fail-open). The quality bar was NOT enforced for this commit.\n",
			);
		});
	});

	describe("loudDegrade (positive — must fire)", () => {
		// test-contract: public-api — loudDegrade (exported): fail-open degrade
		// must write the exact documented warning text and return null.
		it("P1: writes the exact fixed warning text and returns null", () => {
			const result = loudDegrade("some reason");
			expect(result).toBeNull();
			expect(stderrSpy).toHaveBeenCalledWith(
				"[interlinked:commit-gate] WARNING: commit-time quality gate degraded (some reason) — " +
					"allowing the commit (fail-open). The quality bar was NOT enforced for this commit.\n",
			);
		});
	});

	describe("failingTestPhrase (positive — must fire)", () => {
		// test-contract: public-api — failingTestPhrase (exported): the
		// documented empty-list fallback phrase.
		it("P1: empty list returns the generic phrase", () => {
			expect(failingTestPhrase([])).toBe("one or more tests are failing");
		});

		// test-contract: public-api — failingTestPhrase (exported): the
		// documented truncate-to-3-plus-ellipsis behavior when count exceeds 3.
		it("P2: more than 3 failures truncates with an ellipsis suffix", () => {
			expect(failingTestPhrase(["a", "b", "c", "d", "e"])).toBe("failing test(s): a, b, c, …");
		});

		// test-contract: public-api — failingTestPhrase (exported): boundary
		// where shown count equals total, so no ellipsis suffix is appended.
		it("P3: exactly the shown count omits the suffix", () => {
			expect(failingTestPhrase(["a", "b"])).toBe("failing test(s): a, b");
		});
	});

	describe("blockForRedBar (positive — must fire)", () => {
		// test-contract: public-api — blockForRedBar (exported): the exact
		// documented red-bar block reason/severity/category, and withWarnings'
		// contract of adding no `warnings` key for an empty warnings array.
		it("P1: exact reason/severity/category, no warnings key when none passed", () => {
			const result = blockForRedBar(["t1"], []);
			expect(result).toEqual({
				decision: "block",
				reason:
					"[interlinked:commit-gate] BLOCKED: the full test suite is RED on the working tree " +
					"you are about to commit — failing test(s): t1. " +
					"Fix the failing test(s) before committing — a commit must not capture a red bar.",
				rule_id: "commit-gate",
				severity: "high",
				category: "coverage",
			});
			expect(result.warnings).toBeUndefined();
		});
	});

	describe("decideRedBar / blockForNewRedBar (positive — must fire)", () => {
		// test-contract: public-api — decideRedBar (exported): a red baseline
		// with fresh (non-inherited) failures must block with the exact
		// documented "NEW failure(s)" reason, naming only fresh failures.
		it("P1: new failures beyond a red baseline produce the exact new-failure block", () => {
			mockReadSuiteBaseline.mockReturnValueOnce({
				recorded_at: "2026-01-01T00:00:00.000Z",
				language: "typescript",
				green: false,
				failing_tests: ["old"],
			});
			mockNewFailures.mockReturnValueOnce(["newFail"]);

			const result = decideRedBar(["old", "newFail"], [], "/fake/root");

			expect(result).toEqual({
				decision: "block",
				reason:
					"[interlinked:commit-gate] BLOCKED: the full test suite is RED with NEW " +
					"failure(s) beyond the recorded suite baseline — failing test(s): newFail. " +
					"1 pre-existing failure(s) were tolerated per the recorded " +
					"baseline. Fix the NEW failing test(s) before committing; once the suite is " +
					"green, re-record the baseline with `interlinked adopt --suite-baseline`.",
				rule_id: "commit-gate",
				severity: "high",
				category: "coverage",
			});
		});

		// test-contract: public-api — decideRedBar (exported): when every
		// current failure is inherited from the baseline, tolerate (return
		// null) and push the exact documented tolerance NOTE.
		it("P2: all-inherited red pushes the exact NOTE and tolerates (returns null)", () => {
			mockReadSuiteBaseline.mockReturnValueOnce({
				recorded_at: "2026-01-01T00:00:00.000Z",
				language: "typescript",
				green: false,
				failing_tests: ["a", "b"],
			});
			mockNewFailures.mockReturnValueOnce([]);
			const warnings: string[] = [];

			const result = decideRedBar(["a", "b"], warnings, "/fake/root");

			expect(result).toBeNull();
			expect(warnings).toEqual([
				"[interlinked:commit-gate] NOTE: the full suite is RED but all 2 " +
					"failure(s) are pre-existing per the recorded suite baseline — not blocking on the " +
					"red bar. Re-record after greening: `interlinked adopt --suite-baseline`.",
			]);
		});
	});

	describe("blockForViolations (positive — must fire)", () => {
		// test-contract: public-api — blockForViolations (exported): the
		// MAX_NAMED_VIOLATIONS=8 truncation tail and plural "issues" wording
		// when the count is above the truncation cap.
		it("P1: 9 violations truncates to 8 named + a '1 more' tail, plural issue count", () => {
			const violations = Array.from({ length: 9 }, (_, i) => violation(i));
			const result = blockForViolations(violations, []);
			const lines = violations
				.slice(0, 8)
				.map((v) => `  - [${v.kind}] ${v.file}: ${v.detail}`)
				.join("\n");
			expect(result).toEqual({
				decision: "block",
				reason:
					"[interlinked:commit-gate] BLOCKED: the working tree you are about to commit violates " +
					"the quality bar (9 issues):\n" +
					lines +
					"\n  … and 1 more" +
					"\n\nResolve these in the changed files (add coverage, decompose complex functions) " +
					"before committing — this repo enforces the quality bar at commit time because its " +
					"suite is too large for per-edit enforcement.",
				rule_id: "commit-gate",
				severity: "high",
				category: "coverage",
			});
		});

		// test-contract: public-api — blockForViolations (exported): below the
		// truncation cap the "more" tail must be absent while plural wording
		// still applies for a count that is not exactly 1.
		it("P2: exactly 2 violations — no truncation tail, plural issue count", () => {
			const violations = [violation(1), violation(2)];
			const result = blockForViolations(violations, []);
			const lines = violations.map((v) => `  - [${v.kind}] ${v.file}: ${v.detail}`).join("\n");
			expect(result).toEqual({
				decision: "block",
				reason:
					"[interlinked:commit-gate] BLOCKED: the working tree you are about to commit violates " +
					"the quality bar (2 issues):\n" +
					lines +
					"\n\nResolve these in the changed files (add coverage, decompose complex functions) " +
					"before committing — this repo enforces the quality bar at commit time because its " +
					"suite is too large for per-edit enforcement.",
				rule_id: "commit-gate",
				severity: "high",
				category: "coverage",
			});
		});

		// test-contract: public-api — blockForViolations (exported): the exact
		// singular ("1 issue", no trailing "s") wording boundary.
		it("P3: exactly 1 violation — singular issue count, no 's'", () => {
			const violations = [violation(1)];
			const result = blockForViolations(violations, []);
			const lines = violations.map((v) => `  - [${v.kind}] ${v.file}: ${v.detail}`).join("\n");
			expect(result).toEqual({
				decision: "block",
				reason:
					"[interlinked:commit-gate] BLOCKED: the working tree you are about to commit violates " +
					"the quality bar (1 issue):\n" +
					lines +
					"\n\nResolve these in the changed files (add coverage, decompose complex functions) " +
					"before committing — this repo enforces the quality bar at commit time because its " +
					"suite is too large for per-edit enforcement.",
				rule_id: "commit-gate",
				severity: "high",
				category: "coverage",
			});
		});
	});

	describe("degradeWithWarnings (positive — must fire)", () => {
		// test-contract: public-api — degradeWithWarnings (exported): a
		// non-empty warnings array must surface as an allow decision carrying
		// those warnings (not the bare-null loudDegrade no-op).
		it("P1: non-empty warnings produce an allow decision carrying them", () => {
			const result = degradeWithWarnings("some reason", ["w1"]);
			expect(result).toEqual({ decision: "allow", warnings: ["w1"] });
			expect(stderrSpy).toHaveBeenCalled();
		});
	});
});
