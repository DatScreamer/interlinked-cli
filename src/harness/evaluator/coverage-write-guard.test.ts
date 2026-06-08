import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PerFileCoverage } from "../coverage-final-reader.js";
import type { FunctionComplexityEntry } from "../checks/cyclomatic.js";
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
		// CRAP is OFF in these tests (block_on_crap unset) so the analyzer is never
		// called; default to "no functions" so it can never block by accident.
		cyclomaticFor: () => () => [],
	};
}

/**
 * Deps with an injected cyclomatic analyzer for the CRAP tests. The analyzer is a
 * pure stub returning fixed per-function complexity entries — no TS load, no
 * radon spawn. `null` entries model an UNAVAILABLE analyzer (typescript/radon
 * absent), which the CRAP gate fail-opens on.
 */
function depsWithCyclomatic(
	runner: CoverageRunner,
	entries: FunctionComplexityEntry[] | null,
): CoverageWriteDeps {
	return {
		runnerFor: () => runner,
		createOverlay: stubOverlay(),
		clock: () => 0,
		cyclomaticFor: () => () => entries,
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

describe("default config — all gates are ON (enforce by default unless opted out)", () => {
	it("DEFAULT_CONFIG.per_edit_coverage.block_on_test_failure is true", () => {
		expect(DEFAULT_CONFIG.per_edit_coverage?.block_on_test_failure).toBe(true);
	});

	it("DEFAULT_CONFIG.per_edit_coverage.block_on_crap is true (CRAP gate ON by default)", () => {
		expect(DEFAULT_CONFIG.per_edit_coverage?.block_on_crap).toBe(true);
	});

	it("DEFAULT_CONFIG.per_edit_coverage.crap_threshold defaults to 30", () => {
		expect(DEFAULT_CONFIG.per_edit_coverage?.crap_threshold).toBe(30);
	});

	it("the whole coverage feature is ON by default (enabled === true)", () => {
		// Enforced on every repo out of the box; opt out in guard-rules.local.json.
		expect(DEFAULT_CONFIG.per_edit_coverage?.enabled).toBe(true);
	});

	it("running the guard with the SHIPPED default config DOES run the gate (runner called)", async () => {
		// With the default flipped ON, the shipped config no longer short-circuits:
		// the overlay runner actually runs. The single function is covered + the
		// suite is green, so the decision is still allow — but the runner DID run,
		// which is the observable difference from the old default-OFF behavior.
		const { runner, ran } = stubRunner(
			coverageResult("src/a.ts", [{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }]),
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export function f() {\n  return 1;\n}\n"),
			DEFAULT_CONFIG,
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(true);
	});

	it("OPT-OUT: shipped default with enabled:false is a pure no-op (runner never called)", async () => {
		// Proves opt-out still gives ZERO behavior change: clone the shipped config
		// and flip just `enabled` off — the guard short-circuits before any runner,
		// even with a red suite that the default-ON gates would otherwise block on.
		const optedOut: GuardRulesConfig = {
			...DEFAULT_CONFIG,
			per_edit_coverage: { ...DEFAULT_CONFIG.per_edit_coverage, enabled: false },
		} as GuardRulesConfig;
		const { runner, ran } = stubRunner(
			coverageResult("src/a.ts", [], 1000, { testsPassed: false }),
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", "export const a = 1;\n"),
			optedOut,
			deps(runner),
		);
		expect(decision).toBeNull();
		expect(ran()).toBe(false);
	});
});

describe("checkCoverageWrite — red-bar (block_on_test_failure)", () => {
	const GREEN_COVERED = (relPath: string): CoverageRunResult =>
		coverageResult(relPath, [{ name: "f", line: 1, endLine: 3, hits: 5, statement_pct: 100 }]);

	it("OFF (sub-flag unset): a RED suite does NOT block — fail-open, coverage-only behavior", async () => {
		// testsPassed:false but block_on_test_failure unset in the passed config →
		// the red bar is inert (the gate logic treats an unset sub-flag as opt-out,
		// independent of the shipped default). The single function is covered, so the
		// coverage path also allows → null.
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

describe("checkCoverageWrite — CRAP block (block_on_crap)", () => {
	// A function the cyclomatic analyzer reports for the edited file. Helper keeps
	// the per-language entry construction terse.
	function fn(
		name: string,
		line: number,
		endLine: number,
		cyclomatic: number,
		language: FunctionComplexityEntry["language"] = "js_ts",
	): FunctionComplexityEntry {
		return { name, line, endLine, cyclomatic, language };
	}

	// JS source whose single function spans lines 1..3 (Write ⇒ all lines edited
	// ⇒ the function is TOUCHED). The coverage stub controls its statement_pct.
	const JS_SRC = "export function big() {\n  return 1;\n}\n";

	it("ON + added function complex AND under-covered (CRAP ≥ 30) → BLOCKS, naming the function + CRAP", async () => {
		// cyclomatic 10 @ 20% coverage → CRAP = 100·(0.8)³ + 10 ≈ 61.2 (≥30). The
		// function is partially covered (hits>0, statement_pct>0) so the COVERAGE
		// gate allows and the CRAP gate is what fires.
		const result = coverageResult("src/a.ts", [
			{ name: "big", line: 1, endLine: 3, hits: 3, statement_pct: 20 },
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", JS_SRC),
			rules({ block_on_crap: true }),
			depsWithCyclomatic(stubRunner(result).runner, [fn("big", 1, 3, 10)]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/CRAP score of 61/);
		expect(decision?.reason).toMatch(/`big`/);
		expect(decision?.reason).toMatch(/cyclomatic 10/);
		expect(decision?.reason).toMatch(/coverage 20%/);
		expect(decision?.reason).toMatch(/reduce complexity|add coverage/i);
		expect(decision?.rule_id).toBe("per-edit-coverage");
	});

	it("ON + the SAME function fully covered (CRAP ≈ cyclomatic < 30) → ALLOWS", async () => {
		// cyclomatic 10 @ 100% coverage → CRAP = 10 (< 30). Complexity alone, with
		// full coverage, is not a CRAP block.
		const result = coverageResult("src/a.ts", [
			{ name: "big", line: 1, endLine: 3, hits: 5, statement_pct: 100 },
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", JS_SRC),
			rules({ block_on_crap: true }),
			depsWithCyclomatic(stubRunner(result).runner, [fn("big", 1, 3, 10)]),
		);
		expect(decision).toBeNull();
	});

	it("OFF (sub-flag unset) → no CRAP block even for a complex, under-covered function", async () => {
		// Same CRAPpy shape as the blocking case, but block_on_crap unset in the
		// passed config → the CRAP gate is inert (the gate logic treats an unset
		// sub-flag as opt-out, independent of the shipped default). The function is
		// partially covered so coverage allows → null.
		const result = coverageResult("src/a.ts", [
			{ name: "big", line: 1, endLine: 3, hits: 3, statement_pct: 20 },
		]);
		const { runner } = stubRunner(result);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", JS_SRC),
			rules(), // block_on_crap not set
			depsWithCyclomatic(runner, [fn("big", 1, 3, 10)]),
		);
		expect(decision).toBeNull();
	});

	it("OFF (explicit false) → identical to unset (no CRAP block)", async () => {
		const result = coverageResult("src/a.ts", [
			{ name: "big", line: 1, endLine: 3, hits: 3, statement_pct: 20 },
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", JS_SRC),
			rules({ block_on_crap: false }),
			depsWithCyclomatic(stubRunner(result).runner, [fn("big", 1, 3, 10)]),
		);
		expect(decision).toBeNull();
	});

	it("ON but the CRAPpy function is UNTOUCHED by the edit → no CRAP block", async () => {
		// Edit touches only line 2 (`b = 2`), but the CRAPpy function lives at lines
		// 40..60 — outside the edited set, so crapTouches() excludes it. A covered
		// function at the edited lines keeps the coverage gate happy.
		const base = "const a = 1;\nconst b = 1;\nconst c = 1;\n";
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src/u.ts"), base, "utf-8");
		const result = coverageResult("src/u.ts", [
			{ name: "edited", line: 2, endLine: 2, hits: 5, statement_pct: 100 },
			{ name: "faraway", line: 40, endLine: 60, hits: 1, statement_pct: 10 },
		]);
		const editEvent: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "sess-1",
			agent_source: "claude",
			tool_name: "Edit",
			tool_input: {
				file_path: join(root, "src/u.ts"),
				old_string: "const b = 1;",
				new_string: "const b = 2;",
			},
			timestamp: "2026-06-07T00:00:00.000Z",
			cwd: root,
		};
		const decision = await checkCoverageWrite(
			editEvent,
			rules({ block_on_crap: true }),
			depsWithCyclomatic(stubRunner(result).runner, [
				fn("edited", 2, 2, 1),
				fn("faraway", 40, 60, 12), // complex + 10% covered → high CRAP, but untouched
			]),
		);
		expect(decision).toBeNull();
	});

	it("ON + Python function path → BLOCKS on per-line CRAP (radon ranges ∩ coverage.py lines)", async () => {
		// Base .py on disk; an Edit touches only line 3 (covered). The function spans
		// lines 1..6; covered={3}, uncovered={4,5,6} ⇒ per-function coverage 25%.
		// cyclomatic 10 @ 25% → CRAP = 100·(0.75)³ + 10 ≈ 52.2 (≥30). The uncovered
		// lines are OUTSIDE the edited set {3}, so the coverage gate allows and CRAP
		// is what fires.
		const pyBase =
			"def big():\n    a = 1\n    b = a + 1\n    c = b + 2\n    d = c + 3\n    return d\n";
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src/p.py"), pyBase, "utf-8");
		const result = pyCoverageResult("src/p.py", [3], [4, 5, 6]);
		const editEvent: HarnessEvent = {
			hook_event: "PreToolUse",
			session_id: "sess-1",
			agent_source: "claude",
			tool_name: "Edit",
			tool_input: {
				file_path: join(root, "src/p.py"),
				old_string: "    b = a + 1",
				new_string: "    b = a + 1",
			},
			timestamp: "2026-06-07T00:00:00.000Z",
			cwd: root,
		};
		const decision = await checkCoverageWrite(
			editEvent,
			rules({ languages: ["js", "ts", "python"], block_on_crap: true }),
			depsWithCyclomatic(stubRunner(result).runner, [fn("big", 1, 6, 10, "python")]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/CRAP score of 52/);
		expect(decision?.reason).toMatch(/`big`/);
		expect(decision?.reason).toMatch(/coverage 25%/);
	});

	it("ON + cyclomatic analyzer UNAVAILABLE (null) → fail-open (loud-degrade, no CRAP block)", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		// Covered function ⇒ coverage gate allows; analyzer returns null (typescript/
		// radon absent) ⇒ CRAP fail-opens with a stderr warning.
		const result = coverageResult("src/a.ts", [
			{ name: "big", line: 1, endLine: 3, hits: 5, statement_pct: 100 },
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", JS_SRC),
			rules({ block_on_crap: true }),
			depsWithCyclomatic(stubRunner(result).runner, null),
		);
		expect(decision).toBeNull();
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});

	it("ON + runner unavailable (ok:false) → fail-open, never a CRAP block", async () => {
		const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const failing: CoverageRunner = {
			run: async () => ({ suiteMs: 10, perFile: new Map(), ok: false, error: "boom", testsPassed: null }),
		};
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", JS_SRC),
			rules({ block_on_crap: true }),
			depsWithCyclomatic(failing, [fn("big", 1, 3, 10)]),
		);
		expect(decision).toBeNull();
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});

	it("custom crap_threshold raises the bar: a CRAP-61 function passes a threshold of 100", async () => {
		const result = coverageResult("src/a.ts", [
			{ name: "big", line: 1, endLine: 3, hits: 3, statement_pct: 20 },
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", JS_SRC),
			rules({ block_on_crap: true, crap_threshold: 100 }),
			depsWithCyclomatic(stubRunner(result).runner, [fn("big", 1, 3, 10)]),
		);
		expect(decision).toBeNull();
	});
});

describe("checkCoverageWrite — block ordering (red bar → coverage → CRAP)", () => {
	const JS_SRC = "export function big() {\n  return 1;\n}\n";

	it("a RED suite blocks FIRST — before coverage and CRAP", async () => {
		// Red suite + an uncovered+CRAPpy function: the RED-bar block wins.
		const result = coverageResult(
			"src/a.ts",
			[{ name: "big", line: 1, endLine: 3, hits: 0, statement_pct: 0 }],
			1000,
			{ testsPassed: false, failingTests: ["boom"] },
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", JS_SRC),
			rules({ block_on_test_failure: true, block_on_crap: true }),
			depsWithCyclomatic(stubRunner(result).runner, [fn("big", 1, 3, 10)]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/RED/);
		expect(decision?.reason).not.toMatch(/CRAP/);
	});

	it("coverage blocks SECOND — an uncovered added line wins over CRAP", async () => {
		// Green suite, fully-uncovered function (statement_pct 0): the COVERAGE
		// uncovered-added-line block fires before CRAP would.
		const result = coverageResult("src/a.ts", [
			{ name: "big", line: 1, endLine: 3, hits: 0, statement_pct: 0 },
		]);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", JS_SRC),
			rules({ block_on_test_failure: true, block_on_crap: true }),
			depsWithCyclomatic(stubRunner(result).runner, [fn("big", 1, 3, 10)]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/uncovered/i);
		expect(decision?.reason).not.toMatch(/CRAP/);
	});

	it("CRAP blocks LAST — green suite, coverage passes, but a touched function is CRAPpy", async () => {
		// Green + partially-covered (so coverage allows) + complex ⇒ only CRAP fires.
		const result = coverageResult(
			"src/a.ts",
			[{ name: "big", line: 1, endLine: 3, hits: 3, statement_pct: 20 }],
			1000,
			{ testsPassed: true },
		);
		const decision = await checkCoverageWrite(
			writeEvent("src/a.ts", JS_SRC),
			rules({ block_on_test_failure: true, block_on_crap: true }),
			depsWithCyclomatic(stubRunner(result).runner, [fn("big", 1, 3, 10)]),
		);
		expect(decision?.decision).toBe("block");
		expect(decision?.reason).toMatch(/CRAP/);
		expect(decision?.reason).not.toMatch(/RED/);
	});

	// Shared with the CRAP describe — duplicated locally to keep the block self-contained.
	function fn(
		name: string,
		line: number,
		endLine: number,
		cyclomatic: number,
		language: FunctionComplexityEntry["language"] = "js_ts",
	): FunctionComplexityEntry {
		return { name, line, endLine, cyclomatic, language };
	}
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
			cyclomaticFor: () => () => [],
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
