import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ALL_TESTS_SENTINEL,
	detectTestRunFile,
	findTestForSource,
	recordImplEdit,
	recordTestRunCycle,
	recordTestWrite,
	sourceFileForTest,
	updateCycleFromTestRun,
} from "./server-tdd-cycle.js";
import type { SessionTrajectory, TddCycle } from "./types.js";

let tmp = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-tdd-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function makeSession(overrides: Partial<SessionTrajectory> = {}): SessionTrajectory {
	const base: Partial<SessionTrajectory> = {
		session_id: "s",
		agent_name: "a",
		started_at: "2026-04-23T00:00:00.000Z",
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
		step_limit: 100,
		consecutive_pattern: null,
		suggested_permissions: new Set(),
		acknowledged_checks: new Set(),
		fired_reminders: new Set(),
		soft_blocks: new Set(),
		injection_detected_steps: [],
		last_coordination_at: 0,
		last_coordination_ts: 0,
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
	};
	return { ...base, ...overrides } as SessionTrajectory;
}

describe("detectTestRunFile", () => {
	it("returns null for non-test commands", () => {
		expect(detectTestRunFile("ls -la", "/r")).toBeNull();
	});

	it("returns the specific test file when vitest run targets one", () => {
		const out = detectTestRunFile("npx vitest run src/foo.test.ts", "/r");
		expect(out).toBe("/r/src/foo.test.ts");
	});

	it("returns ALL_TESTS_SENTINEL for generic npm test", () => {
		expect(detectTestRunFile("npm test", "/r")).toBe(ALL_TESTS_SENTINEL);
	});

	it("keeps absolute paths as-is", () => {
		const out = detectTestRunFile("vitest run /repo/src/foo.test.ts", "/r");
		expect(out).toBe("/repo/src/foo.test.ts");
	});

	it("returns ALL_TESTS_SENTINEL for cargo test", () => {
		expect(detectTestRunFile("cargo test", "/r")).toBe(ALL_TESTS_SENTINEL);
	});
});

describe("sourceFileForTest", () => {
	it("strips .test. from the same-dir convention", () => {
		expect(sourceFileForTest("/r/src/foo.test.ts")).toBe("/r/src/foo.ts");
	});
	it("strips .spec. too", () => {
		expect(sourceFileForTest("/r/src/foo.spec.ts")).toBe("/r/src/foo.ts");
	});
	it("handles the __tests__ convention", () => {
		expect(sourceFileForTest("/r/src/__tests__/foo.test.ts")).toBe("/r/src/foo.ts");
	});
});

describe("findTestForSource", () => {
	it("finds .test.ts next to source", () => {
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(join(tmp, "src", "foo.ts"), "");
		writeFileSync(join(tmp, "src", "foo.test.ts"), "");
		expect(findTestForSource(join(tmp, "src", "foo.ts"))).toBe(join(tmp, "src", "foo.test.ts"));
	});

	it("finds __tests__/foo.test.ts", () => {
		mkdirSync(join(tmp, "src", "__tests__"), { recursive: true });
		writeFileSync(join(tmp, "src", "foo.ts"), "");
		writeFileSync(join(tmp, "src", "__tests__", "foo.test.ts"), "");
		expect(findTestForSource(join(tmp, "src", "foo.ts"))).toBe(
			join(tmp, "src", "__tests__", "foo.test.ts"),
		);
	});

	it("returns null for files already named .test or .spec", () => {
		expect(findTestForSource("/r/foo.test.ts")).toBeNull();
	});

	it("returns null when no test file exists", () => {
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(join(tmp, "src", "lonely.ts"), "");
		expect(findTestForSource(join(tmp, "src", "lonely.ts"))).toBeNull();
	});
});

describe("getOrCreateCycle + recordImplEdit", () => {
	it("creates a fresh cycle and increments impl_edits", () => {
		const session = makeSession();
		recordImplEdit(session, "/r/src/foo.ts");
		recordImplEdit(session, "/r/src/foo.ts");
		expect(session.tdd_cycles.get("/r/src/foo.ts")?.impl_edits_before_test).toBe(2);
	});

	it("skips test files (writing a test isn't an impl edit)", () => {
		const session = makeSession();
		recordImplEdit(session, "/r/src/foo.test.ts");
		expect(session.tdd_cycles.size).toBe(0);
	});
});

describe("recordTestWrite", () => {
	it("does not create a cycle when source file doesn't exist", () => {
		const session = makeSession();
		recordTestWrite(session, "/r/missing.test.ts");
		expect(session.tdd_cycles.size).toBe(0);
	});

	it("attaches test_written_at when source exists", () => {
		mkdirSync(join(tmp, "src"), { recursive: true });
		writeFileSync(join(tmp, "src", "foo.ts"), "");
		const session = makeSession({ tool_call_count: 5 });
		recordTestWrite(session, join(tmp, "src", "foo.test.ts"));
		const cycle = session.tdd_cycles.get(join(tmp, "src", "foo.ts"));
		expect(cycle?.test_written_at).toBe(5);
	});
});

describe("updateCycleFromTestRun", () => {
	it("green after pass, red after fail", () => {
		const cycle: TddCycle = {
			source_file: "/r/foo.ts",
			test_file: null,
			state: "no_test",
			impl_edits_before_test: 3,
		};
		updateCycleFromTestRun(cycle, false, 10);
		expect(cycle.state).toBe("red");
		expect(cycle.red_at).toBe(10);

		updateCycleFromTestRun(cycle, true, 11);
		expect(cycle.state).toBe("green");
		expect(cycle.green_at).toBe(11);
		expect(cycle.impl_edits_before_test).toBe(0);
	});

	it("green → fail is a regression", () => {
		const cycle: TddCycle = {
			source_file: "/r/foo.ts",
			test_file: null,
			state: "green",
			impl_edits_before_test: 0,
		};
		updateCycleFromTestRun(cycle, false, 20);
		expect(cycle.state).toBe("regression");
	});
});

describe("recordTestRunCycle — sentinel sweeps all cycles", () => {
	it("updates every tracked cycle", () => {
		const session = makeSession();
		session.tdd_cycles.set("/r/a.ts", {
			source_file: "/r/a.ts",
			test_file: null,
			state: "no_test",
			impl_edits_before_test: 2,
		});
		session.tdd_cycles.set("/r/b.ts", {
			source_file: "/r/b.ts",
			test_file: null,
			state: "no_test",
			impl_edits_before_test: 1,
		});
		recordTestRunCycle(session, ALL_TESTS_SENTINEL, true);
		expect(session.tdd_cycles.get("/r/a.ts")?.state).toBe("green");
		expect(session.tdd_cycles.get("/r/b.ts")?.state).toBe("green");
	});
});
