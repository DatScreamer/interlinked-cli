// ===========================================
// behavioral-checks-tdd.ts — mutation-kill companion (PASS-1, fleet-r3 W6)
// ===========================================
// Exact-observable-invariant tests targeting the 2026-08-17 surviving-mutant
// inventory (122 mutants) for src/harness/behavioral-checks-tdd.ts. Every
// case asserts a precise value (toEqual/toBe on full result objects, exact
// argv arrays for the mocked git subprocess) rather than loose containment,
// per CONTRACT-W6 LEAN MODE §"decide the OBSERVABLE behavior ... assert it
// precisely". node:child_process is mocked so getStagedDiff / checkTppLeapfrog
// never spawn a real process (sandbox-safety: no subprocess spawns).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));

import {
	checkProdDeltaWithoutTestDelta,
	checkTddCommitGate,
	checkTddCycleViolation,
	checkTddGreenConfirmation,
	checkTddRegression,
	checkTppLeapfrog,
	getStagedDiff,
} from "./behavioral-checks-tdd.js";
import type { SessionTrajectory, TddCycle } from "./types.js";

// ---- Shared session factory (mirrors __tests__/behavioral-checks-tdd.integration.test.ts) ----

const FIXED_NOW = 1_700_000_000_000;
const FIXED_SESSION_STARTED_AT = new Date(FIXED_NOW - 60_000).toISOString();

function makeSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		session_id: "test-session",
		agent_name: "test-agent",
		started_at: FIXED_SESSION_STARTED_AT,
		tool_call_count: 0,
		error_count: 0,
		files_read: new Set(),
		files_written: new Set(),
		commands_run: [],
		curl_localhost_count: {},
		mcp_tools_used: 0,
		local_tools_used: 0,
		file_write_times: new Map(),
		failed_files: new Map(),
		pending_completions: new Map(),
		file_read_at: new Map(),
		tool_sequence: [],
		sensitivity_level: "Public",
		taint_sources: [],
		step_limit: Number.POSITIVE_INFINITY,
		consecutive_pattern: null,
		suggested_permissions: new Set(),
		acknowledged_checks: new Set(),
		fired_reminders: new Set(),
		soft_blocks: new Set(),
		injection_detected_steps: [],
		pii_detected_steps: [],
		last_coordination_at: 0,
		last_coordination_ts: FIXED_NOW,
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
		assertion_counts: new Map(),
		...overrides,
	};
}

function freshDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

// ===========================================
// getStagedDiff — mocked spawnSync, exact argv + exact fallback semantics
// ===========================================

describe("getStagedDiff — spawnSync boundary (mocked child_process)", () => {
	afterEach(() => {
		mocks.spawnSync.mockReset();
	});

	// test-contract: public-api — getStagedDiff must prefer `git diff --cached` and must NOT fall back when it already has a clean, non-empty result.
	it("G1: returns the cached-diff stdout verbatim and calls spawnSync exactly once with the exact cached-diff argv", () => {
		const file = "/repo/src/foo.ts";
		mocks.spawnSync.mockReturnValueOnce({ status: 0, stdout: "PRIMARY_DIFF_CONTENT" });
		const result = getStagedDiff(file);
		expect(result).toBe("PRIMARY_DIFF_CONTENT");
		expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
		// interlinked-ignore: test_legitimacy — the git argv IS the contract here: every string-literal and array-literal mutant in the cached-diff spawnSync call changes this exact array.
		expect(mocks.spawnSync).toHaveBeenNthCalledWith(
			1,
			"git",
			["-C", dirname(file), "diff", "--cached", "HEAD", "--", file],
			{ encoding: "utf-8", timeout: 2000 },
		);
	});

	// test-contract: public-api — a nonzero exit from the cached diff must trigger the unstaged fallback regardless of whatever text the failing call printed.
	it("G2: falls back to `git diff HEAD` on a nonzero cached-diff status even when stdout is non-empty, returning the fallback content with the exact fallback argv", () => {
		const file = "/repo/src/bar.ts";
		mocks.spawnSync
			.mockReturnValueOnce({ status: 1, stdout: "garbage-should-be-ignored" })
			.mockReturnValueOnce({ status: 0, stdout: "FALLBACK_DIFF" });
		const result = getStagedDiff(file);
		expect(result).toBe("FALLBACK_DIFF");
		expect(mocks.spawnSync).toHaveBeenCalledTimes(2);
		expect(mocks.spawnSync).toHaveBeenNthCalledWith(
			2,
			"git",
			["-C", dirname(file), "diff", "HEAD", "--", file],
			{ encoding: "utf-8", timeout: 2000 },
		);
	});

	// test-contract: public-api — a failing fallback must produce "", not whatever text a nonzero-exit git process happened to write to stdout.
	it("G3: returns empty string (never the failing fallback's stdout) when the fallback command ALSO fails, even if it printed something", () => {
		const file = "/repo/src/baz.ts";
		mocks.spawnSync
			.mockReturnValueOnce({ status: 1, stdout: "" })
			.mockReturnValueOnce({ status: 128, stdout: "phantom-diff-content" });
		expect(getStagedDiff(file)).toBe("");
	});

	// test-contract: public-api — getStagedDiff is a best-effort probe; a thrown spawn error must degrade to "", never a sentinel string.
	it("G4: returns empty string (not a literal placeholder) when spawnSync itself throws", () => {
		const file = "/repo/src/qux.ts";
		mocks.spawnSync.mockImplementationOnce(() => {
			throw new Error("git binary not found");
		});
		expect(getStagedDiff(file)).toBe("");
	});
});

// ===========================================
// checkTppLeapfrog — HEAVY_CONSTRUCTS detection + module-regex boundaries
// ===========================================

describe("checkTppLeapfrog — HEAVY_CONSTRUCTS detection + module-regex boundaries (mocked spawnSync)", () => {
	afterEach(() => {
		mocks.spawnSync.mockReset();
	});

	function diffAdding(file: string, ...addedLines: string[]): void {
		const text = [
			`diff --git a${file} b${file}`,
			"index 000..111 100644",
			`--- a${file}`,
			`+++ b${file}`,
			"@@ -1,1 +1,1 @@",
			"-old",
			...addedLines.map((l) => `+${l}`),
		].join("\n");
		mocks.spawnSync.mockReturnValueOnce({ status: 0, stdout: text });
	}

	// test-contract: public-api — the TPP-leapfrog message must name every heavy construct introduced, in stable order, using the singular label at count 1.
	it("T1: detects all five heavy constructs at zero-width whitespace boundaries, joined in HEAVY_CONSTRUCTS array order with singular names", () => {
		const file = "/repo/src/allc.ts";
		diffAdding(file, "while(x) {}", "for(x of y) {}", "class Widget {}", "switch(x) {}", "function*gen() {}");
		const session = makeSession({ files_written: new Set([file]) });
		expect(checkTppLeapfrog(session)).toEqual([
			{
				source: "structural",
				name: "tpp_leapfrog",
				severity: "info",
				message:
					"allc.ts adds while loop + for loop + class + switch + generator function without a prior red→green cycle. Consider splitting into smaller transformations (Transformation Priority Premise).",
				file,
				determinism: "heuristic",
			},
		]);
	});

	// test-contract: public-api — `class Widget` (canonical single-space, uppercase) must count as a "class" construct.
	it("T2: the class regex still matches with exactly one space before an uppercase name (rejects the negated-class and \\S+ mutants)", () => {
		const file = "/repo/src/ca.ts";
		diffAdding(file, "class Widget {}", "switch(x) {}");
		const session = makeSession({ files_written: new Set([file]) });
		const results = checkTppLeapfrog(session);
		expect(results.length).toBe(1);
		expect(results[0]?.message).toBe(
			"ca.ts adds class + switch without a prior red→green cycle. Consider splitting into smaller transformations (Transformation Priority Premise).",
		);
	});

	// test-contract: public-api — `class  Widget` (extra interior whitespace) must still count as a "class" construct.
	it("T3: the class regex still matches with MULTIPLE interior spaces before the name (rejects the exactly-one-whitespace mutant)", () => {
		const file = "/repo/src/cb.ts";
		diffAdding(file, "class  Widget {}", "switch(x) {}");
		const session = makeSession({ files_written: new Set([file]) });
		const results = checkTppLeapfrog(session);
		expect(results.length).toBe(1);
		expect(results[0]?.message).toContain("class + switch");
	});

	// test-contract: public-api — `function *gen` (space before the star) must still count as a "generator function" construct.
	it("T4: the generator-function regex matches `function *name` WITH a space (rejects the \\S* mutant, which only survives at zero-width)", () => {
		const file = "/repo/src/fs.ts";
		diffAdding(file, "function *gen() {}", "for(x) {}");
		const session = makeSession({ files_written: new Set([file]) });
		const results = checkTppLeapfrog(session);
		expect(results.length).toBe(1);
		expect(results[0]?.message).toContain("for loop + generator function");
	});

	// test-contract: public-api — suppression requires an ACTUAL green state; a leftover red_at on a non-green cycle must not exempt the file.
	it("T5: does NOT suppress on a non-green cycle even when a stale red_at is still recorded", () => {
		const file = "/repo/src/sa.ts";
		diffAdding(file, "while(x) {}", "for(x) {}");
		const cycle: TddCycle = {
			source_file: file,
			test_file: null,
			state: "no_test",
			red_at: 5,
			impl_edits_before_test: 0,
		};
		const session = makeSession({ files_written: new Set([file]), tdd_cycles: new Map([[file, cycle]]) });
		expect(checkTppLeapfrog(session).length).toBe(1);
	});

	// test-contract: public-api — suppression requires evidence of an actual red→green cycle; a green state with no red_at is not that evidence.
	it("T6: does NOT suppress a green cycle that never recorded a red_at", () => {
		const file = "/repo/src/sb.ts";
		diffAdding(file, "while(x) {}", "for(x) {}");
		const cycle: TddCycle = { source_file: file, test_file: null, state: "green", impl_edits_before_test: 0 };
		const session = makeSession({ files_written: new Set([file]), tdd_cycles: new Map([[file, cycle]]) });
		expect(checkTppLeapfrog(session).length).toBe(1);
	});
});

// ===========================================
// checkTddCycleViolation — exact result shape + extension-gate boundaries
// ===========================================

describe("checkTddCycleViolation — exact result shape + extension-gate boundaries", () => {
	// test-contract: public-api — the no-test-file wording and every field of the finding must match exactly.
	it("TCV1: no-test-file message, exact object", () => {
		const filePath = "src/widgets/foo.ts";
		const cycle: TddCycle = { source_file: filePath, test_file: null, state: "no_test", impl_edits_before_test: 3 };
		const session = makeSession({ tdd_cycles: new Map([[filePath, cycle]]) });
		expect(checkTddCycleViolation(session, filePath)).toEqual({
			source: "structural",
			name: "tdd_cycle_violation",
			severity: "warning",
			message:
				"3 implementation edits to foo.ts with no test file. Write a failing test that captures the expected behavior, then make it pass.",
			file: filePath,
			determinism: "partially_deterministic",
		});
	});

	// test-contract: public-api — when test_file IS recorded, the message must say "without running its test", not "with no test file".
	it("TCV2: a recorded test_file switches the message to the other ternary branch", () => {
		const filePath = "src/widgets/foo.ts";
		const cycle: TddCycle = {
			source_file: filePath,
			test_file: "src/widgets/foo.test.ts",
			state: "no_test",
			impl_edits_before_test: 5,
		};
		const session = makeSession({ tdd_cycles: new Map([[filePath, cycle]]) });
		expect(checkTddCycleViolation(session, filePath)?.message).toBe(
			"5 implementation edits to foo.ts without running its test. Run the test first to establish a baseline.",
		);
	});

	// test-contract: public-api — the red-state wording and every field of the finding must match exactly.
	it("TCV3: red-state message, exact object", () => {
		const filePath = "src/widgets/foo.ts";
		const cycle: TddCycle = { source_file: filePath, test_file: null, state: "red", impl_edits_before_test: 2 };
		const session = makeSession({ tdd_cycles: new Map([[filePath, cycle]]) });
		expect(checkTddCycleViolation(session, filePath)).toEqual({
			source: "structural",
			name: "tdd_cycle_violation",
			severity: "warning",
			message: "Tests for foo.ts are RED (failing). Focus on making them green before making more changes.",
			file: filePath,
			determinism: "partially_deterministic",
		});
	});

	// test-contract: public-api — TDD-cycle tracking is about CODE; a markdown file must never produce this finding.
	it("TCV4: a non-source extension (.md) is exempt even with a violating cycle recorded", () => {
		const filePath = "notes.md";
		const cycle: TddCycle = { source_file: filePath, test_file: null, state: "no_test", impl_edits_before_test: 5 };
		const session = makeSession({ tdd_cycles: new Map([[filePath, cycle]]) });
		expect(checkTddCycleViolation(session, filePath)).toBeNull();
	});

	// test-contract: public-api — plain .js files must be tracked by the TDD cycle checks, the same as .jsx.
	it("TCV5: a bare .js file IS a recognized source extension (rejects the jsx?-loses-its-`?` mutant)", () => {
		const filePath = "app.js";
		const cycle: TddCycle = { source_file: filePath, test_file: null, state: "no_test", impl_edits_before_test: 5 };
		const session = makeSession({ tdd_cycles: new Map([[filePath, cycle]]) });
		expect(checkTddCycleViolation(session, filePath)?.name).toBe("tdd_cycle_violation");
	});

	// test-contract: public-api — the extension must be the actual suffix of the path, not merely a substring somewhere inside it.
	it("TCV6: a valid extension buried mid-path does NOT count as a source file (rejects the dropped-$-anchor extension mutant)", () => {
		const filePath = "app.js.bak";
		const cycle: TddCycle = { source_file: filePath, test_file: null, state: "no_test", impl_edits_before_test: 5 };
		const session = makeSession({ tdd_cycles: new Map([[filePath, cycle]]) });
		expect(checkTddCycleViolation(session, filePath)).toBeNull();
	});
});

// ===========================================
// checkTddRegression — exact result shape + guard boundaries
// ===========================================

describe("checkTddRegression — exact result shape + guard boundaries", () => {
	// test-contract: public-api — every field of the regression finding must match exactly, including basename() reducing a multi-segment path to its final component.
	it("TR1: exact object on a green→red regression (also covers basename's multi-segment reduction)", () => {
		const filePath = "src/widgets/bar.ts";
		const cycle: TddCycle = {
			source_file: filePath,
			test_file: null,
			state: "regression",
			previous_state: "green",
			impl_edits_before_test: 0,
		};
		const session = makeSession({ tdd_cycles: new Map([[filePath, cycle]]) });
		expect(checkTddRegression(session, filePath)).toEqual({
			source: "structural",
			name: "tdd_regression",
			severity: "error",
			message:
				"Tests for bar.ts were GREEN but are now FAILING (regression). Your last edit broke something — fix before continuing.",
			file: filePath,
			determinism: "partially_deterministic",
		});
	});

	// test-contract: public-api — regression tracking is about the SOURCE under test; a test file must never flag itself.
	it("TR2: a test file itself is exempt even with a matching regression cycle recorded (rejects the TEST_FILE_RE-guard-forced-false mutant)", () => {
		const filePath = "foo.test.ts";
		const cycle: TddCycle = {
			source_file: filePath,
			test_file: null,
			state: "regression",
			previous_state: "green",
			impl_edits_before_test: 0,
		};
		const session = makeSession({ tdd_cycles: new Map([[filePath, cycle]]) });
		expect(checkTddRegression(session, filePath)).toBeNull();
	});

	// test-contract: public-api — both fields (state AND previous_state) must independently gate the finding.
	it("TR3: a green cycle whose previous_state also happens to be green is NOT a regression (rejects the state==='regression'-forced-true mutant)", () => {
		const filePath = "src/widgets/baz.ts";
		const cycle: TddCycle = {
			source_file: filePath,
			test_file: null,
			state: "green",
			previous_state: "green",
			impl_edits_before_test: 0,
		};
		const session = makeSession({ tdd_cycles: new Map([[filePath, cycle]]) });
		expect(checkTddRegression(session, filePath)).toBeNull();
	});
});

// ===========================================
// checkTddGreenConfirmation — exact result shape + TEST_FILE_RE anchor
// ===========================================

describe("checkTddGreenConfirmation — exact result shape + TEST_FILE_RE anchor boundary", () => {
	// test-contract: public-api — every field of the confirmation finding must match exactly.
	it("TGC1: exact object on a red→green transition", () => {
		const filePath = "src/widgets/qux.ts";
		const cycle: TddCycle = {
			source_file: filePath,
			test_file: null,
			state: "green",
			previous_state: "red",
			impl_edits_before_test: 0,
		};
		const session = makeSession({ tdd_cycles: new Map([[filePath, cycle]]) });
		expect(checkTddGreenConfirmation(session, filePath)).toEqual({
			source: "structural",
			name: "tdd_green_confirmation",
			severity: "info",
			message: "Tests passing for qux.ts. Red→green cycle complete.",
			file: filePath,
			determinism: "fully_deterministic",
		});
	});

	// test-contract: public-api — both fields must independently gate the finding; there is no other route to "confirmed".
	it("TGC2: a green state whose previous_state is also green is NOT a fresh confirmation (rejects the state==='green'-forced-true mutant)", () => {
		const filePath = "src/widgets/quux.ts";
		const cycle: TddCycle = {
			source_file: filePath,
			test_file: null,
			state: "no_test",
			previous_state: "red",
			impl_edits_before_test: 0,
		};
		const session = makeSession({ tdd_cycles: new Map([[filePath, cycle]]) });
		expect(checkTddGreenConfirmation(session, filePath)).toBeNull();
	});

	// test-contract: public-api — TEST_FILE_RE's bare test./spec. alternative is anchored to the END of the path; extra trailing characters must disqualify it.
	it("TGC3: a path that merely STARTS WITH a test-like prefix is not a test file (rejects the dropped-$-anchor TEST_FILE_RE mutant)", () => {
		const filePath = "test.ts.bak";
		const cycle: TddCycle = {
			source_file: filePath,
			test_file: null,
			state: "green",
			previous_state: "red",
			impl_edits_before_test: 0,
		};
		const session = makeSession({ tdd_cycles: new Map([[filePath, cycle]]) });
		expect(checkTddGreenConfirmation(session, filePath)?.name).toBe("tdd_green_confirmation");
	});
});

// ===========================================
// checkTddCommitGate — no_test branch boundary conditions + redCycleEntry
// ===========================================

describe("checkTddCommitGate — no_test branch boundary conditions", () => {
	let dir: string;

	beforeEach(() => {
		dir = freshDir("cg-");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: public-api — impl_edits_before_test must be POSITIVE, not merely present, before the commit gate has anything to say.
	it("CG1: does NOT fire on a fresh no_test cycle with zero implementation edits (rejects the ||, second-clause-forced-true, and >=0 mutants)", () => {
		const sourceFile = join(dir, "foo.ts");
		writeFileSync(sourceFile, "export function foo() { return 1; }\n");
		const cycle: TddCycle = { source_file: sourceFile, test_file: null, state: "no_test", impl_edits_before_test: 0 };
		const session = makeSession({ tdd_cycles: new Map([[sourceFile, cycle]]) });
		expect(checkTddCommitGate(session, "warn")).toEqual([]);
	});

	// test-contract: public-api — the no_test branch requires state === "no_test"; a green cycle's edit count is irrelevant to it.
	it("CG2: does NOT fire on a green cycle even with many implementation edits recorded (rejects the whole-condition-true and first-clause-forced-true mutants)", () => {
		const sourceFile = join(dir, "bar.ts");
		writeFileSync(sourceFile, "export function bar() { return 1; }\n");
		const cycle: TddCycle = { source_file: sourceFile, test_file: null, state: "green", impl_edits_before_test: 5 };
		const session = makeSession({ tdd_cycles: new Map([[sourceFile, cycle]]) });
		expect(checkTddCommitGate(session, "warn")).toEqual([]);
	});

	// test-contract: public-api — under "nudge" the pushed severity must stay "info" (never forced to "warning"), and every other field must match exactly.
	it("CG3: exact pushed-finding shape under nudge mode (rejects the source/determinism string mutants and the severity-ternary-forced-true mutant)", () => {
		const sourceFile = join(dir, "baz.ts");
		writeFileSync(sourceFile, "export function baz() { return 1; }\n");
		const cycle: TddCycle = { source_file: sourceFile, test_file: null, state: "no_test", impl_edits_before_test: 2 };
		const session = makeSession({ tdd_cycles: new Map([[sourceFile, cycle]]) });
		expect(checkTddCommitGate(session, "nudge")).toEqual([
			{
				source: "structural",
				name: "tdd_commit_gate",
				severity: "info",
				message: "No tests written or run for baz.ts (edited 2 times). Verify changes before committing.",
				file: sourceFile,
				determinism: "partially_deterministic",
			},
		]);
	});

	// test-contract: public-api — cycle.test_file, once recorded, is authoritative; a real sibling test file discoverable on disk must not silently substitute for a stale/bogus recorded path.
	it("CG4: an explicitly recorded (but non-existent) test_file is NOT rescued by re-deriving via findTestFilePath (rejects the ??-to-&& mutant)", () => {
		const sourceFile = join(dir, "qux.ts");
		writeFileSync(sourceFile, "export function qux() { return 1; }\n");
		writeFileSync(join(dir, "qux.test.ts"), "it('placeholder', () => {});\n"); // real sibling — must be ignored
		const cycle: TddCycle = {
			source_file: sourceFile,
			test_file: "/nonexistent/fake.test.ts", // recorded, but does not exist on disk
			state: "no_test",
			impl_edits_before_test: 1,
		};
		const session = makeSession({ tdd_cycles: new Map([[sourceFile, cycle]]) });
		expect(checkTddCommitGate(session, "warn").length).toBe(1);
	});
});

describe("checkTddCommitGate → redCycleEntry — stale-red exact shape", () => {
	// test-contract: public-api — staleness downgrades wording AND keeps severity at its input value; every field must match exactly.
	it("CG5: a red 190 tool calls old reads as stale-evidence wording even under nudge severity (rejects source/determinism strings + the softened-severity-ternary-forced-true mutant)", () => {
		const sourceFile = "/repo/src/stale.ts";
		const cycle: TddCycle = {
			source_file: sourceFile,
			test_file: null,
			state: "red",
			red_at: 10,
			impl_edits_before_test: 0,
		};
		const session = makeSession({ tool_call_count: 200, tdd_cycles: new Map([[sourceFile, cycle]]) });
		expect(checkTddCommitGate(session, "nudge")).toEqual([
			{
				source: "structural",
				name: "tdd_commit_gate",
				severity: "info",
				message:
					"stale.ts has been red since step 10 — 190 tool calls ago — and nothing has re-run its tests since (last failing run at step 10). That is no longer evidence about the current tree; re-run its tests to confirm or clear it.",
				file: sourceFile,
				determinism: "partially_deterministic",
			},
		]);
	});
});

// ===========================================
// findTestFilePath (reached via checkTddCommitGate's disk-reality check)
// ===========================================

describe("findTestFilePath — candidate-path boundaries", () => {
	let dir: string;

	beforeEach(() => {
		dir = freshDir("ft-");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: public-api — a companion test under __tests__/ must be found even with no sibling *.test.ts next to the source.
	it('FT1: discovers a test file living ONLY under __tests__/ with the .test suffix (rejects one "__tests__" literal + the endsWith/startsWith(.test) mutant + the ||-to-&& mutant)', () => {
		const sourceFile = join(dir, "gamma.ts");
		writeFileSync(sourceFile, "export function gamma() { return 1; }\n");
		mkdirSync(join(dir, "__tests__"));
		writeFileSync(join(dir, "__tests__", "gamma.test.ts"), "it('x', () => {});\n");
		const cycle: TddCycle = { source_file: sourceFile, test_file: null, state: "no_test", impl_edits_before_test: 1 };
		const session = makeSession({ tdd_cycles: new Map([[sourceFile, cycle]]) });
		expect(checkTddCommitGate(session, "warn")).toEqual([]);
	});

	// test-contract: public-api — a companion test under __tests__/ must be found via the .spec candidate too, independent of the .test candidate.
	it('FT2: discovers a test file living ONLY under __tests__/ with the .spec suffix (rejects the other "__tests__" literal + the endsWith/startsWith(.spec) mutant)', () => {
		const sourceFile = join(dir, "delta.ts");
		writeFileSync(sourceFile, "export function delta() { return 1; }\n");
		mkdirSync(join(dir, "__tests__"));
		writeFileSync(join(dir, "__tests__", "delta.spec.ts"), "it('x', () => {});\n");
		const cycle: TddCycle = { source_file: sourceFile, test_file: null, state: "no_test", impl_edits_before_test: 1 };
		const session = makeSession({ tdd_cycles: new Map([[sourceFile, cycle]]) });
		expect(checkTddCommitGate(session, "warn")).toEqual([]);
	});

	// test-contract: bug — findTestFilePath must refuse to search for a companion OF a file that is itself already test-shaped; a same-named decoy candidate must not be found.
	// (.js, not .ts: isTddExemptPath's own `.test.tsx?$` pattern would otherwise
	// exempt a `.test.ts` path before findTestFilePath's guard is ever reached.)
	it("FT3: a source file whose own basename already ends in .test does NOT get a companion search (rejects endsWith(.test)->startsWith + the ||->&& mutant)", () => {
		const sourceFile = join(dir, "weird.test.js");
		writeFileSync(sourceFile, "export function weird() { return 1; }\n");
		writeFileSync(join(dir, "weird.test.test.js"), "it('x', () => {});\n"); // decoy candidate, must be ignored
		const cycle: TddCycle = { source_file: sourceFile, test_file: null, state: "no_test", impl_edits_before_test: 1 };
		const session = makeSession({ tdd_cycles: new Map([[sourceFile, cycle]]) });
		expect(checkTddCommitGate(session, "warn").length).toBe(1);
	});

	// test-contract: bug — same guard, isolated to the .spec-suffix clause specifically (.js for the same isTddExemptPath reason as FT3).
	it("FT4: a source file whose own basename already ends in .spec does NOT get a companion search (rejects endsWith(.spec)->startsWith mutant)", () => {
		const sourceFile = join(dir, "omega.spec.js");
		writeFileSync(sourceFile, "export function omega() { return 1; }\n");
		writeFileSync(join(dir, "omega.spec.test.js"), "it('x', () => {});\n"); // decoy candidate, must be ignored
		const cycle: TddCycle = { source_file: sourceFile, test_file: null, state: "no_test", impl_edits_before_test: 1 };
		const session = makeSession({ tdd_cycles: new Map([[sourceFile, cycle]]) });
		expect(checkTddCommitGate(session, "warn").length).toBe(1);
	});

	// test-contract: bug — an emptied template inside path.join collapses the __tests__ segment away, resolving to a bare directory that existsSync would wrongly treat as a hit.
	it("FT5: an empty __tests__/ directory is not itself a discovered test file (rejects both __tests__-candidate template-literal-to-empty-string mutants)", () => {
		const sourceFile = join(dir, "beta.ts");
		writeFileSync(sourceFile, "export function beta() { return 1; }\n");
		mkdirSync(join(dir, "__tests__")); // exists, but empty — no beta.test.ts/beta.spec.ts inside
		const cycle: TddCycle = { source_file: sourceFile, test_file: null, state: "no_test", impl_edits_before_test: 1 };
		const session = makeSession({ tdd_cycles: new Map([[sourceFile, cycle]]) });
		expect(checkTddCommitGate(session, "warn").length).toBe(1);
	});

	// test-contract: public-api — the plain (non-__tests__) .spec candidate must independently resolve.
	it("FT6: finds a sibling .spec.ts file when no .test.ts sibling exists (rejects the plain .spec candidate template-literal-to-empty-string mutant)", () => {
		const sourceFile = join(dir, "alpha.ts");
		writeFileSync(sourceFile, "export function alpha() { return 1; }\n");
		writeFileSync(join(dir, "alpha.spec.ts"), "it('x', () => {});\n");
		const cycle: TddCycle = { source_file: sourceFile, test_file: null, state: "no_test", impl_edits_before_test: 1 };
		const session = makeSession({ tdd_cycles: new Map([[sourceFile, cycle]]) });
		expect(checkTddCommitGate(session, "warn")).toEqual([]);
	});
});

// ===========================================
// checkProdDeltaWithoutTestDelta — exact result shape + guard boundaries
// ===========================================

describe("checkProdDeltaWithoutTestDelta — exact result shape + guard boundaries", () => {
	let dir: string;

	beforeEach(() => {
		dir = freshDir("pd-");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: public-api — every field of the prod-delta finding must match exactly.
	it("PD1: exact pushed-finding shape", () => {
		const prodFile = join(dir, "widget.ts");
		writeFileSync(prodFile, "export function widget() { return 1; }\n");
		writeFileSync(join(dir, "widget.test.ts"), "it('placeholder', () => {});\n"); // exists, NOT edited this session
		const session = makeSession({ files_written: new Set([prodFile]) });
		expect(checkProdDeltaWithoutTestDelta(session)).toEqual([
			{
				source: "structural",
				name: "prod_delta_no_test_delta",
				severity: "warning",
				message: "Edited widget.ts but no corresponding test was updated (expected widget.test.ts).",
				file: prodFile,
				determinism: "heuristic",
			},
		]);
	});

	// test-contract: bug — a file living under __tests__/ is test infrastructure; disabling the exemption check must not make it demand a companion test for itself.
	it("PD2: an edited __tests__/ file is itself exempt, not treated as prod code needing its own companion (rejects the file-loop TEST_FILE_RE.test(file)->false mutant)", () => {
		const testDir = join(dir, "__tests__");
		mkdirSync(testDir);
		const helper = join(testDir, "helper.ts"); // matches TEST_FILE_RE via the __tests__/ path, no .test/.spec suffix
		writeFileSync(helper, "export const unused = 1;\n");
		writeFileSync(join(testDir, "helper.test.ts"), "it('x', () => {});\n"); // a real companion — must never be consulted
		const session = makeSession({ files_written: new Set([helper]) });
		expect(checkProdDeltaWithoutTestDelta(session)).toEqual([]);
	});

	// test-contract: bug — findTestFilePath's own extension guard must run before any candidate construction; disabling it must not let a stray directory-join candidate rescue an extensionless file.
	it("PD3: an extensionless file with a discoverable __tests__/ candidate is still exempt (rejects the !ext->false mutant)", () => {
		const file = join(dir, "Rakefile");
		writeFileSync(file, "task :default\n");
		mkdirSync(join(dir, "__tests__"));
		writeFileSync(join(dir, "__tests__", "Rakefile.test"), "decoy\n");
		const session = makeSession({ files_written: new Set([file]) });
		expect(checkProdDeltaWithoutTestDelta(session)).toEqual([]);
	});

	// test-contract: bug — exportedSymbolsOf's unreadable-file fallback must be genuinely empty, or the sentinel value could accidentally satisfy the barrel-coverage regex.
	it("PD4: a missing source file contributes zero export-suppression symbols, not a phantom placeholder (rejects the catch-block ArrayDeclaration mutant)", () => {
		const ghostSource = join(dir, "ghost.ts"); // never written
		writeFileSync(join(dir, "ghost.test.ts"), "it('placeholder', () => {});\n");
		const barrelTest = join(dir, "ghost-consumer.test.ts");
		writeFileSync(barrelTest, "// Stryker was here — an unrelated comment\nit('y', () => {});\n");
		const session = makeSession({ files_written: new Set([ghostSource, barrelTest]) });
		expect(checkProdDeltaWithoutTestDelta(session).length).toBe(1);
	});

	// test-contract: bug — a basename containing a literal regex-special character (".") must be matched LITERALLY in an import path, not have the character silently deleted from the search pattern.
	// (basename ends in a word char "bar" so the source's own `\b...\b` wrapper
	// has a real word/non-word transition on both edges against "./foo.bar.js".)
	it("PD5: escapeRe correctly escapes regex-special characters in the source basename (rejects the escape-string-to-empty mutant)", () => {
		const prodFile = join(dir, "foo.bar.ts");
		writeFileSync(prodFile, "export const unused = 1;\n");
		writeFileSync(join(dir, "foo.bar.test.ts"), "it('placeholder', () => {});\n");
		const editedTest = join(dir, "other.test.ts");
		writeFileSync(editedTest, 'import { z } from "./foo.bar.js";\nit(\'y\', () => {});\n');
		const session = makeSession({ files_written: new Set([prodFile, editedTest]) });
		expect(checkProdDeltaWithoutTestDelta(session)).toEqual([]);
	});
});

// ===========================================
// checkProdDeltaWithoutTestDelta → exportedSymbolsOf — regex boundaries
// ===========================================
// runExportCase returns the result array (no assertion inside it) so every
// `expect(...)` call stays textually inside its own `it()` block.

describe("checkProdDeltaWithoutTestDelta → exportedSymbolsOf — export-declaration regex boundaries", () => {
	let dir: string;
	let n = 0;

	beforeAll(() => {
		dir = freshDir("exp-bound-");
	});
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function runExportCase(
		exportDecl: string,
		barrelContent: string,
	): ReturnType<typeof checkProdDeltaWithoutTestDelta> {
		n += 1;
		const prodFile = join(dir, `p${n}.ts`);
		writeFileSync(prodFile, `${exportDecl}\n`);
		writeFileSync(join(dir, `p${n}.test.ts`), "it('placeholder', () => {});\n");
		const barrelTest = join(dir, `t${n}.test.ts`);
		writeFileSync(barrelTest, barrelContent);
		const session = makeSession({ files_written: new Set([prodFile, barrelTest]) });
		return checkProdDeltaWithoutTestDelta(session);
	}

	// test-contract: public-api — extra interior whitespace in a real export declaration must not defeat symbol extraction.
	it("EX1: two spaces after `export` still parses the declaration (rejects export\\s+ -> \\s exactly-one)", () => {
		expect(
			runExportCase(
				"export  function Widget() {}",
				'import { Widget } from "./barrel.js";\nit(\'x\', () => { Widget(); });\n',
			),
		).toEqual([]);
	});

	// test-contract: public-api — extra interior whitespace around `async` must not defeat symbol extraction.
	it("EX2: two spaces after `async` still parses the declaration (rejects async\\s+ -> \\s exactly-one)", () => {
		expect(
			runExportCase(
				"export async  function Widget() {}",
				'import { Widget } from "./barrel.js";\nit(\'x\', () => { Widget(); });\n',
			),
		).toEqual([]);
	});

	// test-contract: public-api — extra interior whitespace around `default` must not defeat symbol extraction.
	it("EX3: two spaces after `default` still parses the declaration (rejects default\\s+ -> \\s exactly-one)", () => {
		expect(
			runExportCase(
				"export default  function Widget() {}",
				'import { Widget } from "./barrel.js";\nit(\'x\', () => { Widget(); });\n',
			),
		).toEqual([]);
	});

	// test-contract: public-api — the everyday single-space form must keep working; \\S+ cannot span a literal space.
	it("EX4: a plain single-spaced `export default function` still parses (rejects default\\s+ -> \\S+)", () => {
		expect(
			runExportCase(
				"export default function Widget() {}",
				'import { Widget } from "./barrel.js";\nit(\'x\', () => { Widget(); });\n',
			),
		).toEqual([]);
	});

	// test-contract: public-api — the everyday single-space async form must keep working.
	it("EX5: a plain single-spaced `export async function` still parses (rejects async\\s+ -> \\S+)", () => {
		expect(
			runExportCase(
				"export async function Widget() {}",
				'import { Widget } from "./barrel.js";\nit(\'x\', () => { Widget(); });\n',
			),
		).toEqual([]);
	});

	// test-contract: public-api — extra interior whitespace immediately before the identifier must not defeat symbol extraction.
	it("EX6: two spaces before the declared name still parses (rejects the final \\s+ -> \\s exactly-one mutant)", () => {
		expect(
			runExportCase("export const  Widget = 1;", 'import { Widget } from "./barrel.js";\nit(\'x\', () => { Widget(); });\n'),
		).toEqual([]);
	});

	// test-contract: public-api — the list-export form must not require whitespace before the opening brace.
	it("EX7: `export{ ... }` with zero whitespace before the brace still parses (rejects export\\s*{ -> \\s{ exactly-one)", () => {
		expect(
			runExportCase("const zz = 1;\nexport{zz as ZeroSpace}", "// references ZeroSpace here\nit('x', () => {});\n"),
		).toEqual([]);
	});

	// test-contract: public-api — extra interior whitespace around the `as` alias keyword must not defeat parsing.
	it("EX8: an alias split by MULTIPLE spaces on both sides of `as` still parses (rejects both \\s+as\\s+ boundary mutants)", () => {
		expect(
			runExportCase(
				"const w = 1;\nexport { w  as  DoubleSpace };",
				"// references DoubleSpace here\nit('x', () => {});\n",
			),
		).toEqual([]);
	});

	// test-contract: bug — the exported-name validity check requires the FIRST character to be a letter/_/$, not merely some valid suffix.
	it("EX9: a digit-leading alias (`123Bad`) is correctly REJECTED as an invalid identifier (rejects the dropped-^-anchor validity mutant)", () => {
		expect(
			runExportCase("const x = 1;\nexport { x as 123Bad };", "// references 123Bad here\nit('x', () => {});\n")
				.length,
		).toBe(1);
	});

	// test-contract: bug — the exported-name validity check requires the WHOLE string to be a valid identifier, not merely a valid prefix.
	it("EX10: a hyphenated alias (`Good-Bad`) is correctly REJECTED as an invalid identifier (rejects the dropped-$-anchor validity mutant)", () => {
		expect(
			runExportCase("const y = 1;\nexport { y as Good-Bad };", "// references Good-Bad here\nit('x', () => {});\n")
				.length,
		).toBe(1);
	});

	// test-contract: bug — the validity regex must actually gate names.add, not be bypassed entirely.
	it("EX11: a numeric-only alias (`1234`) is correctly REJECTED regardless of length (rejects the validity-check-forced-true and &&-to-|| mutants)", () => {
		expect(
			runExportCase("const z = 1;\nexport { z as 1234 };", "// references 1234 here\nit('x', () => {});\n").length,
		).toBe(1);
	});
});

// ===========================================
// anyEditedTestUsesSourceExports — length filter boundary
// ===========================================

describe("checkProdDeltaWithoutTestDelta → anyEditedTestUsesSourceExports — length filter boundary", () => {
	let dir: string;

	beforeEach(() => {
		dir = freshDir("lf-");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// test-contract: public-api — the length>=4 filter exists specifically to avoid over-suppressing on incidental short-token matches; a 1-char export must be excluded.
	it("LF1: a 1-char exported symbol must NOT suppress the finding (rejects removing .filter entirely AND forcing the predicate to always-true)", () => {
		const prodFile = join(dir, "short.ts");
		writeFileSync(prodFile, "export const x = 1;\n");
		writeFileSync(join(dir, "short.test.ts"), "it('placeholder', () => {});\n");
		const barrelTest = join(dir, "consumer.test.ts");
		writeFileSync(barrelTest, "// references x somewhere\nit('y', () => {});\n");
		const session = makeSession({ files_written: new Set([prodFile, barrelTest]) });
		expect(checkProdDeltaWithoutTestDelta(session).length).toBe(1);
	});

	// test-contract: public-api — the length filter is >=4 (4 is included), not >4.
	it("LF2: an exported symbol of EXACTLY 4 characters DOES qualify (rejects the >=4-to->4 boundary mutant)", () => {
		const prodFile = join(dir, "exactfour.ts");
		writeFileSync(prodFile, "export const Name = 1;\n");
		writeFileSync(join(dir, "exactfour.test.ts"), "it('placeholder', () => {});\n");
		const barrelTest = join(dir, "consumer2.test.ts");
		writeFileSync(barrelTest, 'import { Name } from "./barrel.js";\nit(\'y\', () => { Name; });\n');
		const session = makeSession({ files_written: new Set([prodFile, barrelTest]) });
		expect(checkProdDeltaWithoutTestDelta(session)).toEqual([]);
	});
});
