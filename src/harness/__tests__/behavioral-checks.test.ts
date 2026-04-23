import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkDomainSensitiveTestNudge,
	checkPersistentWarningEscalation,
	checkProdDeltaWithoutTestDelta,
	checkProdTestLocRatio,
	checkRepeatedEditWithoutTest,
	checkSuppressionAsWorkaround,
	checkTppLeapfrog,
} from "../behavioral-checks.js";
import type { SessionTrajectory, TddCycle } from "../types.js";

// ===========================================
// Helpers
// ===========================================

// Fixed, deterministic timestamps. Session start is 60s before "now";
// last_coordination is "now". Values are arbitrary but stable.
const FIXED_NOW = 1_700_000_000_000; // 2023-11-14T22:13:20Z
const FIXED_SESSION_STARTED_AT = new Date(FIXED_NOW - 60_000).toISOString();
const FIXED_RECORDED_AT = new Date(FIXED_NOW - 30_000).toISOString();

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
		last_coordination_at: 0,
		last_coordination_ts: FIXED_NOW,
		test_runs: new Map(),
		file_edit_counts: new Map(),
		warnings_issued: new Map(),
		tdd_cycles: new Map(),
		consecutive_tool_failures: new Map(),
		silent_failure_warned: new Set(),
		bloat_warned: new Set(),
		...overrides,
	};
}

// ===========================================
// 1. checkRepeatedEditWithoutTest
// ===========================================

describe("checkRepeatedEditWithoutTest", () => {
	it("fires when file_edit_counts >= 3 and no test_runs", () => {
		const edits = new Map([["src/utils/parser.ts", 3]]);
		const session = makeSession({ file_edit_counts: edits });

		const result = checkRepeatedEditWithoutTest(session, "src/utils/parser.ts");
		expect(result).not.toBeNull();
		expect(result!.name).toBe("repeated_edit_without_test");
		expect(result!.severity).toBe("warning");
		expect(result!.message).toContain("3 times");
	});

	it("does NOT fire when file_edit_counts < 3", () => {
		const edits = new Map([["src/utils/parser.ts", 2]]);
		const session = makeSession({ file_edit_counts: edits });

		const result = checkRepeatedEditWithoutTest(session, "src/utils/parser.ts");
		expect(result).toBeNull();
	});

	it("does NOT fire when test_runs has entries", () => {
		const edits = new Map([["src/utils/parser.ts", 5]]);
		const tests = new Map([
			["src/utils/parser.test.ts", { status: "pass" as const, at_step: 2 }],
		]);
		const session = makeSession({ file_edit_counts: edits, test_runs: tests });

		const result = checkRepeatedEditWithoutTest(session, "src/utils/parser.ts");
		expect(result).toBeNull();
	});

	it("does NOT fire for test files (path contains .test.)", () => {
		const edits = new Map([["src/utils/parser.test.ts", 5]]);
		const session = makeSession({ file_edit_counts: edits });

		const result = checkRepeatedEditWithoutTest(session, "src/utils/parser.test.ts");
		expect(result).toBeNull();
	});
});

// ===========================================
// 2. checkSuppressionAsWorkaround
// ===========================================

describe("checkSuppressionAsWorkaround", () => {
	it("fires when currentSuppression > previousSuppression AND file in failed_files", () => {
		const failed = new Map([
			[
				"src/index.ts",
				{
					failure_count: 1,
					checks: ["typescript"],
					recorded_at: FIXED_RECORDED_AT,
					tool_call_count: 3,
				},
			],
		]);
		const session = makeSession({ failed_files: failed });

		const result = checkSuppressionAsWorkaround(session, "src/index.ts", 2, 0);
		expect(result).not.toBeNull();
		expect(result!.name).toBe("suppression_as_workaround");
		expect(result!.severity).toBe("warning");
		expect(result!.message).toContain("2 suppression");
	});

	it("does NOT fire when currentSuppression <= previousSuppression", () => {
		const failed = new Map([
			[
				"src/index.ts",
				{
					failure_count: 1,
					checks: ["typescript"],
					recorded_at: FIXED_RECORDED_AT,
					tool_call_count: 3,
				},
			],
		]);
		const session = makeSession({ failed_files: failed });

		const result = checkSuppressionAsWorkaround(session, "src/index.ts", 1, 1);
		expect(result).toBeNull();
	});

	it("does NOT fire when file NOT in failed_files", () => {
		const session = makeSession({ failed_files: new Map() });

		const result = checkSuppressionAsWorkaround(session, "src/index.ts", 3, 1);
		expect(result).toBeNull();
	});
});

// ===========================================
// 3. checkDomainSensitiveTestNudge
// ===========================================

describe("checkDomainSensitiveTestNudge", () => {
	it("fires for path like src/auth/login.ts with empty test_runs", () => {
		const session = makeSession();

		const result = checkDomainSensitiveTestNudge(session, "src/auth/login.ts");
		expect(result).not.toBeNull();
		expect(result!.name).toBe("domain_sensitive_test_nudge");
		expect(result!.severity).toBe("warning");
		expect(result!.message).toContain("auth");
	});

	it("fires for src/crypto/aes.c", () => {
		const session = makeSession();

		const result = checkDomainSensitiveTestNudge(session, "src/crypto/aes.c");
		expect(result).not.toBeNull();
		expect(result!.message).toContain("crypto");
	});

	it("does NOT fire for src/ui/button.ts", () => {
		const session = makeSession();

		const result = checkDomainSensitiveTestNudge(session, "src/ui/button.ts");
		expect(result).toBeNull();
	});

	it("does NOT fire when test_runs has entries", () => {
		const tests = new Map([["src/auth/auth.test.ts", { status: "pass" as const, at_step: 1 }]]);
		const session = makeSession({ test_runs: tests });

		const result = checkDomainSensitiveTestNudge(session, "src/auth/login.ts");
		expect(result).toBeNull();
	});
});

// ===========================================
// 4. checkPersistentWarningEscalation
// ===========================================

describe("checkPersistentWarningEscalation", () => {
	it("escalates when warnings_issued has matching file::check entry", () => {
		const warnings = new Map([
			[
				"src/foo.ts::typescript",
				{
					check_name: "typescript",
					issue_count: 1,
					first_issued_at: 2,
					last_issued_at: 4,
					resolved: false,
				},
			],
		]);
		const session = makeSession({ warnings_issued: warnings });

		const results = checkPersistentWarningEscalation(session, "src/foo.ts", ["typescript"]);
		expect(results).toHaveLength(1);
		expect(results[0].severity).toBe("error");
		expect(results[0].name).toBe("persistent_warning_escalation");
		expect(results[0].message).toContain("typescript");
	});

	it("does NOT escalate for checks not previously issued", () => {
		const session = makeSession({ warnings_issued: new Map() });

		const results = checkPersistentWarningEscalation(session, "src/foo.ts", ["typescript"]);
		expect(results).toHaveLength(0);
	});

	it("does NOT escalate for different files", () => {
		const warnings = new Map([
			[
				"src/bar.ts::typescript",
				{
					check_name: "typescript",
					issue_count: 2,
					first_issued_at: 1,
					last_issued_at: 3,
					resolved: false,
				},
			],
		]);
		const session = makeSession({ warnings_issued: warnings });

		const results = checkPersistentWarningEscalation(session, "src/foo.ts", ["typescript"]);
		expect(results).toHaveLength(0);
	});
});

// ===========================================
// 6. checkProdDeltaWithoutTestDelta (git commit gate)
// ===========================================

describe("checkProdDeltaWithoutTestDelta", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prod-delta-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("flags prod file edited with existing but un-edited test file", () => {
		const prodFile = join(dir, "foo.ts");
		const testFile = join(dir, "foo.test.ts");
		writeFileSync(prodFile, "export const x = 1;\n");
		writeFileSync(testFile, "it('x', () => {});\n");
		const session = makeSession({ files_written: new Set([prodFile]) });
		const results = checkProdDeltaWithoutTestDelta(session);
		expect(results.length).toBe(1);
		expect(results[0].name).toBe("prod_delta_no_test_delta");
	});

	it("passes when prod and test are both edited", () => {
		const prodFile = join(dir, "foo.ts");
		const testFile = join(dir, "foo.test.ts");
		writeFileSync(prodFile, "export const x = 1;\n");
		writeFileSync(testFile, "it('x', () => {});\n");
		const session = makeSession({ files_written: new Set([prodFile, testFile]) });
		expect(checkProdDeltaWithoutTestDelta(session)).toEqual([]);
	});

	it("ignores prod files with no corresponding test on disk", () => {
		const prodFile = join(dir, "bar.ts");
		writeFileSync(prodFile, "export const x = 1;\n");
		const session = makeSession({ files_written: new Set([prodFile]) });
		expect(checkProdDeltaWithoutTestDelta(session)).toEqual([]);
	});

	it("ignores test files themselves", () => {
		const testFile = join(dir, "foo.test.ts");
		writeFileSync(testFile, "it('x', () => {});\n");
		const session = makeSession({ files_written: new Set([testFile]) });
		expect(checkProdDeltaWithoutTestDelta(session)).toEqual([]);
	});
});

// ===========================================
// 7. checkProdTestLocRatio (git commit gate)
// ===========================================

describe("checkProdTestLocRatio", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "loc-ratio-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("warns when ratio exceeds 5:1", () => {
		const prodFile = join(dir, "foo.ts");
		const testFile = join(dir, "foo.test.ts");
		writeFileSync(prodFile, "a\n".repeat(60));
		writeFileSync(testFile, "a\n".repeat(10));
		const session = makeSession({ files_written: new Set([prodFile, testFile]) });
		const results = checkProdTestLocRatio(session);
		expect(results.length).toBe(1);
		expect(results[0].message).toMatch(/\d+\.\d+:1/);
	});

	it("passes when ratio is healthy", () => {
		const prodFile = join(dir, "foo.ts");
		const testFile = join(dir, "foo.test.ts");
		writeFileSync(prodFile, "a\n".repeat(30));
		writeFileSync(testFile, "a\n".repeat(20));
		const session = makeSession({ files_written: new Set([prodFile, testFile]) });
		expect(checkProdTestLocRatio(session)).toEqual([]);
	});

	it("warns when prod code exists but no tests were written", () => {
		const prodFile = join(dir, "foo.ts");
		writeFileSync(prodFile, "a\n".repeat(30));
		const session = makeSession({ files_written: new Set([prodFile]) });
		const results = checkProdTestLocRatio(session);
		expect(results.length).toBe(1);
		expect(results[0].message).toMatch(/no tests written/);
	});

	it("is silent when no files were written", () => {
		const session = makeSession({ files_written: new Set() });
		expect(checkProdTestLocRatio(session)).toEqual([]);
	});
});

// ===========================================
// 8. checkTppLeapfrog (git diff based)
// ===========================================

function initGitRepo(dir: string): void {
	execSync("git init -q -b main", { cwd: dir });
	execSync("git config user.email test@example.com", { cwd: dir });
	execSync("git config user.name test", { cwd: dir });
}

function commitInitial(dir: string, file: string, content: string): void {
	writeFileSync(join(dir, file), content);
	execSync(`git add ${file}`, { cwd: dir });
	execSync('git commit -q -m "initial"', { cwd: dir });
}

function stageUpdate(dir: string, file: string, content: string): void {
	writeFileSync(join(dir, file), content);
	execSync(`git add ${file}`, { cwd: dir });
}

describe("checkTppLeapfrog", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "tpp-"));
		initGitRepo(dir);
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("flags commit adding ≥2 heavy constructs without a TDD cycle", () => {
		const file = "foo.ts";
		const abs = join(dir, file);
		commitInitial(dir, file, "export const x = 1;\n");
		stageUpdate(
			dir,
			file,
			`export const x = 1;
export function run(items: number[]) {
	const out = [];
	for (const i of items) {
		while (i > 0) { out.push(i); }
	}
	return out;
}
`,
		);
		const session = makeSession({ files_written: new Set([abs]) });
		const results = checkTppLeapfrog(session);
		expect(results.length).toBe(1);
		expect(results[0].name).toBe("tpp_leapfrog");
		expect(results[0].severity).toBe("info");
	});

	it("does not flag when only one heavy construct was added", () => {
		const file = "foo.ts";
		const abs = join(dir, file);
		commitInitial(dir, file, "export const x = 1;\n");
		stageUpdate(
			dir,
			file,
			`export const x = 1;
export function run(items: number[]) {
	for (const i of items) { console.log(i); }
}
`,
		);
		const session = makeSession({ files_written: new Set([abs]) });
		expect(checkTppLeapfrog(session)).toEqual([]);
	});

	it("suppresses when a disciplined red→green TDD cycle occurred", () => {
		const file = "foo.ts";
		const abs = join(dir, file);
		commitInitial(dir, file, "export const x = 1;\n");
		stageUpdate(
			dir,
			file,
			`export const x = 1;
export class Widget {
	constructor() {}
	run() { while (true) break; for (;;) break; }
}
`,
		);
		const cycle: TddCycle = {
			source_file: abs,
			test_file: join(dir, "foo.test.ts"),
			state: "green",
			red_at: 3,
			green_at: 5,
			impl_edits_before_test: 0,
			previous_state: "red",
		};
		const session = makeSession({
			files_written: new Set([abs]),
			tdd_cycles: new Map([[abs, cycle]]),
		});
		expect(checkTppLeapfrog(session)).toEqual([]);
	});

	it("ignores test files", () => {
		const file = "foo.test.ts";
		const abs = join(dir, file);
		commitInitial(dir, file, "it('x', () => {});\n");
		stageUpdate(
			dir,
			file,
			`it('x', () => {
	for (const a of xs) { while (a > 0) { break; } }
	class C {}
});
`,
		);
		const session = makeSession({ files_written: new Set([abs]) });
		expect(checkTppLeapfrog(session)).toEqual([]);
	});
});
