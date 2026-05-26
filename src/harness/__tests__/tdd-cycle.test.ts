import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkTddCommitGate,
	checkTddCycleViolation,
	checkTddGreenConfirmation,
	checkTddRegression,
} from "../behavioral-checks.js";
import type { SessionTrajectory, TddCycle } from "../types.js";

// ===========================================
// Helpers
// ===========================================

// Deterministic fixtures.
const FIXED_NOW = 1_700_000_000_000;
const FIXED_TIMESTAMP = new Date(FIXED_NOW).toISOString();

function makeSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	return {
		session_id: "test-session",
		agent_name: "test-agent",
		started_at: FIXED_TIMESTAMP,
		tool_call_count: 10,
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

function makeCycle(overrides: Partial<TddCycle> = {}): TddCycle {
	return {
		source_file: "/project/src/parser.ts",
		test_file: "/project/src/parser.test.ts",
		state: "no_test",
		impl_edits_before_test: 0,
		...overrides,
	};
}

// ===========================================
// checkTddCycleViolation
// ===========================================

describe("checkTddCycleViolation", () => {
	it("fires when 3+ impl edits with no test interaction", () => {
		const session = makeSession();
		const cycle = makeCycle({ impl_edits_before_test: 3, state: "no_test" });
		session.tdd_cycles.set(cycle.source_file, cycle);

		const result = checkTddCycleViolation(session, cycle.source_file);
		expect(result).not.toBeNull();
		expect(result!.name).toBe("tdd_cycle_violation");
		expect(result!.severity).toBe("warning");
		expect(result!.message).toContain("3 implementation edits");
	});

	it("mentions missing test file when none exists", () => {
		const session = makeSession();
		const cycle = makeCycle({
			impl_edits_before_test: 4,
			state: "no_test",
			test_file: null,
		});
		session.tdd_cycles.set(cycle.source_file, cycle);

		const result = checkTddCycleViolation(session, cycle.source_file);
		expect(result).not.toBeNull();
		expect(result!.message).toContain("no test file");
	});

	it("fires when tests are red and agent keeps editing", () => {
		const session = makeSession();
		const cycle = makeCycle({
			state: "red",
			impl_edits_before_test: 2,
			red_at: 5,
		});
		session.tdd_cycles.set(cycle.source_file, cycle);

		const result = checkTddCycleViolation(session, cycle.source_file);
		expect(result).not.toBeNull();
		expect(result!.message).toContain("RED");
	});

	it("does NOT fire when fewer than 3 edits with no_test", () => {
		const session = makeSession();
		const cycle = makeCycle({ impl_edits_before_test: 2, state: "no_test" });
		session.tdd_cycles.set(cycle.source_file, cycle);

		expect(checkTddCycleViolation(session, cycle.source_file)).toBeNull();
	});

	it("does NOT fire when tests are green", () => {
		const session = makeSession();
		const cycle = makeCycle({ state: "green", impl_edits_before_test: 5 });
		session.tdd_cycles.set(cycle.source_file, cycle);

		expect(checkTddCycleViolation(session, cycle.source_file)).toBeNull();
	});

	it("does NOT fire for test files (cycle violation branch)", () => {
		const session = makeSession();
		const testPath = "/project/src/parser.test.ts";
		const cycle = makeCycle({
			source_file: testPath,
			impl_edits_before_test: 5,
			state: "no_test",
		});
		session.tdd_cycles.set(testPath, cycle);

		expect(checkTddCycleViolation(session, testPath)).toBeNull();
	});

	it("does NOT fire when red but only 1 impl edit", () => {
		const session = makeSession();
		const cycle = makeCycle({ state: "red", impl_edits_before_test: 1 });
		session.tdd_cycles.set(cycle.source_file, cycle);

		expect(checkTddCycleViolation(session, cycle.source_file)).toBeNull();
	});
});

// ===========================================
// checkTddRegression
// ===========================================

describe("checkTddRegression", () => {
	it("fires when green→regression transition detected", () => {
		const session = makeSession();
		const cycle = makeCycle({
			state: "regression",
			previous_state: "green",
		});
		session.tdd_cycles.set(cycle.source_file, cycle);

		const result = checkTddRegression(session, cycle.source_file);
		expect(result).not.toBeNull();
		expect(result!.name).toBe("tdd_regression");
		expect(result!.severity).toBe("error");
		expect(result!.message).toContain("GREEN");
		expect(result!.message).toContain("FAILING");
	});

	it("does NOT fire when regression from no_test (not a green→red transition)", () => {
		const session = makeSession();
		const cycle = makeCycle({
			state: "regression",
			previous_state: "no_test",
		});
		session.tdd_cycles.set(cycle.source_file, cycle);

		expect(checkTddRegression(session, cycle.source_file)).toBeNull();
	});

	it("does NOT fire when state is red (not regression)", () => {
		const session = makeSession();
		const cycle = makeCycle({ state: "red", previous_state: "no_test" });
		session.tdd_cycles.set(cycle.source_file, cycle);

		expect(checkTddRegression(session, cycle.source_file)).toBeNull();
	});

	it("does NOT fire for test files (regression branch)", () => {
		const session = makeSession();
		const testPath = "/project/src/parser.test.ts";
		const cycle = makeCycle({
			source_file: testPath,
			state: "regression",
			previous_state: "green",
		});
		session.tdd_cycles.set(testPath, cycle);

		expect(checkTddRegression(session, testPath)).toBeNull();
	});
});

// ===========================================
// checkTddGreenConfirmation
// ===========================================

describe("checkTddGreenConfirmation", () => {
	it("fires on red→green transition", () => {
		const session = makeSession();
		const cycle = makeCycle({
			state: "green",
			previous_state: "red",
			green_at: 8,
		});
		session.tdd_cycles.set(cycle.source_file, cycle);

		const result = checkTddGreenConfirmation(session, cycle.source_file);
		expect(result).not.toBeNull();
		expect(result!.name).toBe("tdd_green_confirmation");
		expect(result!.severity).toBe("info");
		expect(result!.message).toContain("Red→green cycle complete");
	});

	it("does NOT fire when green→green (already was green)", () => {
		const session = makeSession();
		const cycle = makeCycle({
			state: "green",
			previous_state: "green",
		});
		session.tdd_cycles.set(cycle.source_file, cycle);

		expect(checkTddGreenConfirmation(session, cycle.source_file)).toBeNull();
	});

	it("does NOT fire when no_test→green (no red phase)", () => {
		const session = makeSession();
		const cycle = makeCycle({
			state: "green",
			previous_state: "no_test",
		});
		session.tdd_cycles.set(cycle.source_file, cycle);

		expect(checkTddGreenConfirmation(session, cycle.source_file)).toBeNull();
	});

	it("does NOT fire for test files (green-confirmation branch)", () => {
		const session = makeSession();
		const testPath = "/project/src/__tests__/parser.test.ts";
		const cycle = makeCycle({
			source_file: testPath,
			state: "green",
			previous_state: "red",
		});
		session.tdd_cycles.set(testPath, cycle);

		expect(checkTddGreenConfirmation(session, testPath)).toBeNull();
	});
});

// ===========================================
// checkTddCommitGate
// ===========================================

describe("checkTddCommitGate", () => {
	// Disk-realization scratch dir: the no_test branch of the gate
	// short-circuits when the source file is missing (refinement
	// 2026-05). Severity-mapping tests that need a real `.ts` file on
	// disk write into here; tests on the red/regression branches still
	// use synthetic paths because those branches don't hit the disk check.
	let gateTmp: string;
	beforeEach(() => {
		gateTmp = mkdtempSync(join(tmpdir(), "tdd-gate-"));
	});
	afterEach(() => {
		rmSync(gateTmp, { recursive: true, force: true });
	});

	it("reports failing tests in enforce mode as errors", () => {
		const session = makeSession();
		session.tdd_cycles.set(
			"/project/src/parser.ts",
			makeCycle({ state: "red", source_file: "/project/src/parser.ts" }),
		);

		const results = checkTddCommitGate(session, "enforce");
		expect(results.length).toBe(1);
		expect(results[0].severity).toBe("error");
		expect(results[0].message).toContain("FAILING");
	});

	it("reports regression as error in enforce mode", () => {
		const session = makeSession();
		session.tdd_cycles.set(
			"/project/src/auth.ts",
			makeCycle({
				state: "regression",
				source_file: "/project/src/auth.ts",
			}),
		);

		const results = checkTddCommitGate(session, "enforce");
		expect(results.length).toBe(1);
		expect(results[0].severity).toBe("error");
		expect(results[0].message).toContain("REGRESSING");
	});

	it("reports untested files in enforce mode as warnings (not errors)", () => {
		const sourceFile = join(gateTmp, "utils.ts");
		writeFileSync(sourceFile, "export function utils() { return 1; }\n");
		const session = makeSession();
		session.tdd_cycles.set(
			sourceFile,
			makeCycle({
				state: "no_test",
				source_file: sourceFile,
				impl_edits_before_test: 3,
			}),
		);

		const results = checkTddCommitGate(session, "enforce");
		expect(results.length).toBe(1);
		expect(results[0].severity).toBe("warning");
		expect(results[0].message).toContain("No tests");
	});

	it("reports as warnings in warn mode", () => {
		const session = makeSession();
		session.tdd_cycles.set(
			"/project/src/parser.ts",
			makeCycle({ state: "red", source_file: "/project/src/parser.ts" }),
		);

		const results = checkTddCommitGate(session, "warn");
		expect(results.length).toBe(1);
		expect(results[0].severity).toBe("warning");
	});

	it("reports as info in nudge mode", () => {
		const session = makeSession();
		session.tdd_cycles.set(
			"/project/src/parser.ts",
			makeCycle({ state: "red", source_file: "/project/src/parser.ts" }),
		);

		const results = checkTddCommitGate(session, "nudge");
		expect(results.length).toBe(1);
		expect(results[0].severity).toBe("info");
	});

	it("returns empty for green cycles", () => {
		const session = makeSession();
		session.tdd_cycles.set(
			"/project/src/parser.ts",
			makeCycle({ state: "green", source_file: "/project/src/parser.ts" }),
		);

		expect(checkTddCommitGate(session, "enforce")).toEqual([]);
	});

	it("returns empty when no cycles tracked", () => {
		const session = makeSession();
		expect(checkTddCommitGate(session, "enforce")).toEqual([]);
	});

	it("reports multiple files", () => {
		// Only b.ts (no_test branch) is gated by the disk-existence
		// refinement; a.ts (red) and c.ts (green) are not. Realize b.ts
		// so the multi-file aggregation test still asserts what it intends.
		const aFile = "/project/src/a.ts"; // red branch — no disk check
		const bFile = join(gateTmp, "b.ts"); // no_test branch — disk-realized
		const cFile = "/project/src/c.ts"; // green branch — skipped anyway
		writeFileSync(bFile, "export function b() { return 1; }\n");

		const session = makeSession();
		session.tdd_cycles.set(aFile, makeCycle({ state: "red", source_file: aFile }));
		session.tdd_cycles.set(
			bFile,
			makeCycle({ state: "no_test", source_file: bFile, impl_edits_before_test: 2 }),
		);
		session.tdd_cycles.set(cFile, makeCycle({ state: "green", source_file: cFile }));

		const results = checkTddCommitGate(session, "enforce");
		// a.ts = red (error), b.ts = no_test with edits (warning), c.ts = green (skip)
		expect(results.length).toBe(2);
		expect(results.map((r) => r.file).sort()).toEqual([aFile, bFile].sort());
	});

	it("does NOT report no_test files with zero edits", () => {
		const session = makeSession();
		session.tdd_cycles.set(
			"/project/src/utils.ts",
			makeCycle({
				state: "no_test",
				source_file: "/project/src/utils.ts",
				impl_edits_before_test: 0,
			}),
		);

		expect(checkTddCommitGate(session, "enforce")).toEqual([]);
	});
});

// ===========================================
// checkTddCycleViolation — type-only module exemption (FP refinement)
// ===========================================
// These need a real file on disk: the exemption reads the file to decide
// whether it is a pure type-definition module. The positive case (runtime
// code in the same tmpdir) guards the negative — if it still fires, the
// null result above is the type-only gate, not some unrelated path exemption.

describe("checkTddCycleViolation — type-only module exemption", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "tdd-typeonly-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("does NOT fire for a pure type-definition module", () => {
		const filePath = join(tmpDir, "shapes.ts");
		writeFileSync(
			filePath,
			["export interface Config {", "  enabled: boolean;", "}"].join("\n"),
		);
		const session = makeSession();
		session.tdd_cycles.set(
			filePath,
			makeCycle({
				source_file: filePath,
				test_file: null,
				state: "no_test",
				impl_edits_before_test: 4,
			}),
		);
		expect(checkTddCycleViolation(session, filePath)).toBeNull();
	});

	it("STILL fires for a module that has runtime code", () => {
		const filePath = join(tmpDir, "engine.ts");
		writeFileSync(
			filePath,
			["export interface Config { enabled: boolean; }", "export function run(): void {}"].join(
				"\n",
			),
		);
		const session = makeSession();
		session.tdd_cycles.set(
			filePath,
			makeCycle({
				source_file: filePath,
				test_file: null,
				state: "no_test",
				impl_edits_before_test: 4,
			}),
		);
		const result = checkTddCycleViolation(session, filePath);
		expect(result).not.toBeNull();
		expect(result!.name).toBe("tdd_cycle_violation");
	});
});
