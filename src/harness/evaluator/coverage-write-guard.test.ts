import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import {
	readFileCoverageBaseline,
	readRuntimeEstimateMs,
	updateRuntimeEstimateMs,
	writeFileCoverageBaseline,
} from "../coverage-obligation-ledger.js";
import type { CoverageOverlay } from "../coverage-overlay.js";
import type { CoverageRunResult, CoverageRunner } from "../coverage-runner.js";
import type { GuardRulesConfig, HarnessEvent } from "../types.js";
import { DEFAULT_CONFIG } from "../rules/default-config.js";
import {
	checkCoverageWrite,
	type CoverageWriteDeps,
} from "./coverage-write-guard.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "interlinked-cov-guard-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function rules(overrides?: Partial<NonNullable<GuardRulesConfig["per_edit_coverage"]>>): GuardRulesConfig {
	return {
		per_edit_coverage: {
			enabled: true,
			mode: "block",
			budget_ms: 25_000,
			languages: ["js", "ts"],
			...overrides,
		},
	} as unknown as GuardRulesConfig;
}

function writeEvent(relPath: string, content: string): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		tool_name: "Write",
		tool_input: { file_path: join(root, relPath), content },
		timestamp: "2026-06-07T00:00:00.000Z",
		cwd: root,
	};
}

/** A coverage result for the edited file with the given function rows. Defaults
 *  to a GREEN suite (`testsPassed: true`) so the coverage-decision tests are
 *  unaffected by the red-bar gate; red-bar tests pass an explicit override. */
function coverageResult(
	relPath: string,
	functions: PerFileCoverage["functions"],
	suiteMs = 1000,
	overrides: Partial<CoverageRunResult> = {},
): CoverageRunResult {
	const perFile = new Map<string, PerFileCoverage>();
	perFile.set(relPath, { filePath: relPath, mtime: 0, functions });
	return { suiteMs, perFile, ok: true, testsPassed: true, ...overrides };
}

/**
 * A coverage result carrying PER-LINE data (the coverage.py / Python shape):
 * empty `functions`, populated `coveredLines` / `uncoveredLines`. The gate
 * prefers the per-line fields whenever they are present.
 */
function pyCoverageResult(
	relPath: string,
	covered: number[],
	uncovered: number[],
	suiteMs = 1000,
	overrides: Partial<CoverageRunResult> = {},
): CoverageRunResult {
	const perFile = new Map<string, PerFileCoverage>();
	perFile.set(relPath, {
		filePath: relPath,
		mtime: 0,
		functions: [],
		coveredLines: new Set(covered),
		uncoveredLines: new Set(uncovered),
	});
	return { suiteMs, perFile, ok: true, testsPassed: true, ...overrides };
}

/** A stub runner that records whether it ran and returns a fixed result. */
function stubRunner(result: CoverageRunResult): { runner: CoverageRunner; ran: () => boolean } {
	let called = false;
	const runner: CoverageRunner = {
		run: async () => {
			called = true;
			return result;
		},
	};
	return { runner, ran: () => called };
}

/** A stub overlay factory — never touches the real tree. */
function stubOverlay(): CoverageWriteDeps["createOverlay"] {
	return (projectRoot, editedRelPath): CoverageOverlay => ({
		overlayRoot: join(projectRoot, ".interlinked", ".cov-overlay-stub"),
		editedFileInOverlay: join(projectRoot, ".interlinked", ".cov-overlay-stub", editedRelPath),
		cleanup: () => {},
	});
}

function deps(runner: CoverageRunner): CoverageWriteDeps {
	return {
		runnerFor: () => runner,
		createOverlay: stubOverlay(),
		clock: () => 0,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkCoverageWrite — gating", () => {
	it("is a pure no-op when disabled (runner never called)", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/a.ts", []));
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			rules({ enabled: false }),
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
	});

	it("is a no-op when per_edit_coverage config is entirely absent", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/a.ts", []));
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			{} as GuardRulesConfig,
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
	});

	it("is a no-op in warn mode (runner never called — warn gate is inert today)", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/a.ts", []));
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			rules({ mode: "warn" }),
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
	});

	it("is a no-op for a non-code / unsupported-language file (.md)", async () => {
		const { runner, ran } = stubRunner(coverageResult("README.md", []));
		const decision = await checkCoverageWrite(
			writeEvent("README.md", "# hi\n"),
			rules(),
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
	});

	it("is a no-op for a test file (test files are not the unit under coverage)", async () => {
		const { runner, ran } = stubRunner(coverageResult("src/a.test.ts", []));
		const decision = await checkCoverageWrite(
			writeEvent("src/a.test.ts", "it('x', () => {});\n"),
			rules(),
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
	});
});

describe("checkCoverageWrite — block / allow decisions", () => {
	it("BLOCKS when the edit adds an uncovered executable line, naming the line", async () => {
		// The edited function overlaps the added lines and is fully uncovered.
		const result = coverageResult("src/a.ts", [
			{ name: "added", line: 1, endLine: 3, hits: 0, statement_pct: 0 },
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function added() {\n  return 1;\n}\n"),
			rules(),
			deps(stubRunner(result).runner),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/uncovered/i);
		expect(decision?.reason).toMatch(/line \d+/i);
		expect(decision?.reason).toMatch(/MultiEdit/);
	});

	it("ALLOWS when the edited line is covered (stub reports it covered)", async () => {
		const result = coverageResult("src/a.ts", [
			{ name: "added", line: 1, endLine: 3, hits: 5, statement_pct: 100 },
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function added() {\n  return 1;\n}\n"),
			rules(),
			deps(stubRunner(result).runner),
		);
		expect(decision).toBeNull();
	});

	it("ALLOWS when coverage is unchanged (no edited function uncovered, no drop)", async () => {
		// Pre-seed a baseline equal to what the overlay will report → no drop.
		writeFileCoverageBaseline(root, "src/a.ts", 1);
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 },
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules(),
			deps(stubRunner(result).runner),
		);
		expect(decision).toBeNull();
	});

	it("BLOCKS on a per-file coverage drop vs the prior baseline (even off the edited lines)", async () => {
		// Baseline was fully covered; overlay reports a covered function that does
		// not overlap the edit, plus an uncovered one elsewhere → fraction drops.
		writeFileCoverageBaseline(root, "src/a.ts", 1);
		const result = coverageResult("src/a.ts", [
			{ name: "stillCovered", line: 1, endLine: 2, hits: 5, statement_pct: 100 },
			{ name: "nowUncovered", line: 40, endLine: 42, hits: 0, statement_pct: 0 },
		]);
		// Edit touches only line 1 (covered) — so the BLOCK must come from the drop,
		// not the added-line check.
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function stillCovered() { return 1; }\n"),
			rules(),
			deps(stubRunner(result).runner),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/drop|decreas/i);
	});

	it("refreshes the per-file baseline after an allowed edit", async () => {
		const result = coverageResult("src/a.ts", [
			{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 },
		]);
		await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules(),
			deps(stubRunner(result).runner),
		);
		expect(readFileCoverageBaseline(root, "src/a.ts")).toBe(1);
	});
});

describe("default config — red-bar is OFF (zero behavior change unless opted in)", () => {
	it("DEFAULT_CONFIG.per_edit_coverage.block_on_test_failure is false", () => {
		expect(DEFAULT_CONFIG.per_edit_coverage?.block_on_test_failure).toBe(false);
	});

	it("the whole coverage feature is OFF by default (enabled === false)", () => {
		// Doubly proves zero cost: the guard short-circuits before any runner.
		expect(DEFAULT_CONFIG.per_edit_coverage?.enabled).toBe(false);
	});

	it("running the guard with the SHIPPED default config is a no-op (runner never called)", async () => {
		const { runner, ran } = stubRunner(
			coverageResult("src/a.ts", [], 1000, { testsPassed: false }),
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			DEFAULT_CONFIG,
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
	});
});

describe("checkCoverageWrite — red-bar (block_on_test_failure)", () => {
	const GREEN_COVERED = (relPath: string): CoverageRunResult =>
		coverageResult(relPath, [{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }]);

	it("OFF (default): a RED suite does NOT block — fail-open, coverage-only behavior", async () => {
		// testsPassed:false but block_on_test_failure unset → the red bar is inert.
		// The single function is covered, so the coverage path also allows → null.
		const result = coverageResult(
			"src/a.ts",
			[{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }],
			1000,
			{ testsPassed: false, failingTests: ["t > boom"] },
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules(), // block_on_test_failure not set
			deps(stubRunner(result).runner),
		);
		expect(decision).toBeNull();
	});

	it("OFF (explicit false): identical to unset — RED does not block", async () => {
		const result = coverageResult(
			"src/a.ts",
			[{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }],
			1000,
			{ testsPassed: false },
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules({ block_on_test_failure: false }),
			deps(stubRunner(result).runner),
		);
		expect(decision).toBeNull();
	});

	it("ON + testsPassed:false → BLOCKS, naming the failing test", async () => {
		const result = coverageResult(
			"src/a.ts",
			[{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }],
			1000,
			{ testsPassed: false, failingTests: ["adds two numbers", "handles empty input"] },
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules({ block_on_test_failure: true }),
			deps(stubRunner(result).runner),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/RED/);
		expect(decision?.reason).toMatch(/adds two numbers/);
		expect(decision?.reason).toMatch(/MultiEdit/);
	});

	it("ON + testsPassed:false with NO failingTests → still BLOCKS with a generic phrase", async () => {
		const result = coverageResult(
			"src/a.ts",
			[{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }],
			1000,
			{ testsPassed: false },
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules({ block_on_test_failure: true }),
			deps(stubRunner(result).runner),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/one or more tests are failing/);
	});

	it("ON + testsPassed:true + covered → ALLOWS (green, no coverage gap)", async () => {
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules({ block_on_test_failure: true }),
			deps(stubRunner(GREEN_COVERED("src/a.ts")).runner),
		);
		expect(decision).toBeNull();
	});

	it("ON + testsPassed:true + UNCOVERED added line → coverage still BLOCKS (red bar doesn't mask it)", async () => {
		// Green suite, but the edited function is uncovered → the coverage block
		// fires. Proves the red-bar check doesn't swallow the coverage decision.
		const result = coverageResult(
			"src/a.ts",
			[{ name: "added", line: 1, endLine: 3, hits: 0, statement_pct: 0 }],
			1000,
			{ testsPassed: true },
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function added() {\n  return 1;\n}\n"),
			rules({ block_on_test_failure: true }),
			deps(stubRunner(result).runner),
		);
		expect(decision?.decision).toBe("block");
		// The coverage (not red-bar) reason: it names the uncovered line, not "RED".
		expect(decision?.reason).toMatch(/uncovered/i);
		expect(decision?.reason).not.toMatch(/RED/);
	});

	it("ON + testsPassed:null (runner unavailable / indeterminate) → fail-open (no red-bar block)", async () => {
		// testsPassed null on an ok report with a covered function → the red bar
		// abstains (fail-open on pass/fail) and the coverage path allows.
		const result = coverageResult(
			"src/a.ts",
			[{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }],
			1000,
			{ testsPassed: null },
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules({ block_on_test_failure: true }),
			deps(stubRunner(result).runner),
		);
		expect(decision).toBeNull();
	});

	it("ON + a FAILED coverage run (ok:false) → loud-degrade allow, never a red-bar block", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const failing: CoverageRunner = {
			run: async () => ({ suiteMs: 10, perFile: new Map(), ok: false, error: "boom", testsPassed: null }),
		};
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			rules({ block_on_test_failure: true }),
			deps(failing),
		);
		expect(decision).toBeNull();
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});

	it("ON but per_edit_coverage disabled → pure no-op (runner never called, no red-bar)", async () => {
		const { runner, ran } = stubRunner(
			coverageResult("src/a.ts", [], 1000, { testsPassed: false }),
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			rules({ enabled: false, block_on_test_failure: true }),
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
	});

	it("ON + Python red suite → BLOCKS on the red bar (per-line shape, testsPassed:false)", async () => {
		const PY_SRC = "def added():\n    return 1\n";
		const result = pyCoverageResult("src/a.py", [1, 2], [], 1000, {
			testsPassed: false,
			failingTests: ["tests/test_a.py::test_added"],
		});
		const decision = await checkCoverageWrite(
			writeEvent("src/a.py", PY_SRC),
			rules({ languages: ["js", "ts", "python"], block_on_test_failure: true }),
			deps(stubRunner(result).runner),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/RED/);
		expect(decision?.reason).toMatch(/test_added/);
	});
});

describe("checkCoverageWrite — Python per-line path (coverage.py shape)", () => {
	// Python content: 5 lines so the Write's edited-line set is {1..5}.
	const PY_SRC = "def added():\n    x = 1\n    y = 2\n    z = 3\n    return x + y + z\n";

	it("BLOCKS when an added .py line is uncovered (missing_lines), naming the line", async () => {
		// Line 4 is executable but missing → uncovered on an edited line.
		const result = pyCoverageResult("src/a.py", [1, 2, 3, 5], [4]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.py", PY_SRC),
			rules({ languages: ["js", "ts", "python"] }),
			deps(stubRunner(result).runner),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/uncovered/i);
		expect(decision?.reason).toMatch(/line 4/);
		expect(decision?.reason).toMatch(/MultiEdit/);
	});

	it("ALLOWS when every executable .py line is covered (zero uncovered lines)", async () => {
		const result = pyCoverageResult("src/a.py", [1, 2, 3, 4, 5], []);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.py", PY_SRC),
			rules({ languages: ["js", "ts", "python"] }),
			deps(stubRunner(result).runner),
		);
		expect(decision).toBeNull();
	});

	it("BLOCKS on a per-file coverage drop vs the prior baseline (uncovered off the edited lines)", async () => {
		// Baseline fully covered; overlay reports an uncovered line (40) OUTSIDE the
		// edited set {1..5}, so the added-line check passes and the BLOCK is the drop.
		writeFileCoverageBaseline(root, "src/a.py", 1);
		const result = pyCoverageResult("src/a.py", [1, 2, 3, 4, 5], [40]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.py", PY_SRC),
			rules({ languages: ["js", "ts", "python"] }),
			deps(stubRunner(result).runner),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/drop|decreas/i);
	});

	it("is a no-op when python is not in the configured languages (runner never called)", async () => {
		const { runner, ran } = stubRunner(pyCoverageResult("src/a.py", [1], []));
		const decision = await checkCoverageWrite(
			writeEvent("src/a.py", PY_SRC),
			rules(), // default languages: js, ts — no python
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
	});
});

describe("checkCoverageWrite — budget gate", () => {
	it("does NOT run the suite when the estimate >= budget; records an obligation and allows", async () => {
		// Seed a rolling estimate above the budget so the gate defers.
		writeRuntimeEstimateAbove(root, 30_000);
		const { runner, ran } = stubRunner(coverageResult("src/a.ts", []));
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			rules({ budget_ms: 25_000 }),
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
		// An obligation row was appended.
		const lines = readObligations(root);
		expect(lines.length).toBe(1);
		expect(lines[0]).toMatchObject({ kind: "coverage", reason: "budget_exceeded", file: "src/a.ts" });
	});

	it("runs the suite and updates the estimate when under budget", async () => {
		const { runner, ran } = stubRunner(
			coverageResult("src/a.ts", [{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }], 1500),
		);
		await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			rules(),
			deps(runner),
		);
		expect(ran()).toBe(true);
		expect(readRuntimeEstimateMs(root)).toBe(1500);
	});
});

describe("checkCoverageWrite — loud-degrade", () => {
	it("allows (returns null) and warns when the runner errors", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const failing: CoverageRunner = {
			run: async () => ({ suiteMs: 10, perFile: new Map(), ok: false, error: "boom", testsPassed: null }),
		};
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			rules(),
			deps(failing),
		);
		expect(decision).toBeNull();
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});

	it("allows and warns when the overlay factory throws (never crashes the pipeline)", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const throwingDeps: CoverageWriteDeps = {
			runnerFor: () => stubRunner(coverageResult("src/a.ts", [])).runner,
			createOverlay: () => {
				throw new Error("overlay failed");
			},
			clock: () => 0,
		};
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			rules(),
			throwingDeps,
		);
		expect(decision).toBeNull();
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// Local helpers that poke persisted state for assertions
// ---------------------------------------------------------------------------

function writeRuntimeEstimateAbove(projectRoot: string, ms: number): void {
	// Reuse the public updater twice so the EWMA settles at/above `ms`.
	updateRuntimeEstimateMs(projectRoot, ms, () => 0);
	updateRuntimeEstimateMs(projectRoot, ms, () => 0);
}

function readObligations(projectRoot: string): Array<Record<string, unknown>> {
	const path = join(projectRoot, ".interlinked", "coverage-obligations.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l: string) => JSON.parse(l) as Record<string, unknown>);
}
