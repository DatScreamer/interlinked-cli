import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock spawnSync so we can control the exact { status, signal, stdout, stderr }
// shape the gate functions see, without actually running npm/tsc/vitest.
const spawnSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
	spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

import {
	checkProjectTestsClean,
	checkProjectTypecheckClean,
	resolveTestCommand,
} from "./project-typecheck-gate.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "typecheck-gate-w61-"));
	spawnSyncMock.mockReset();
	delete process.env.INTERLINKED_SKIP_PROJECT_TYPECHECK;
	delete process.env.INTERLINKED_SKIP_PROJECT_TESTS;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writePkg(scripts: Record<string, string>) {
	writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }));
}

describe("diedBySignal / describeDeath via checkProjectTypecheckClean (kills 00ee5ae4, e71208154904db01, d37bca39, 9cde69d9)", () => {
	beforeEach(() => writePkg({ typecheck: "tsc --noEmit" }));

	// test-contract: invariant — diedBySignal must treat status:null as a
	// signal death (per the doc comment above the function), and describeDeath
	// must report "no exit status" for it rather than an "exit null" fallback.
	it("status:null, signal:null is treated as died-by-signal, described as 'no exit status'", () => {
		spawnSyncMock.mockReturnValue({ status: null, signal: null, stdout: "", stderr: "" });
		const entries = checkProjectTypecheckClean(dir);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.name).toBe("project_typecheck_timed_out");
		expect(entries[0]?.message).toContain("no exit status");
	});

	// test-contract: invariant — diedBySignal's "signal !== null" clause alone
	// must trigger the signal-death path even when status doesn't independently
	// qualify (not null, not >=128), per the LogicalOperator/ConditionalExpression
	// survivors on that clause.
	it("signal set (non-null), status null (not >=128) is treated as died-by-signal, described by signal name", () => {
		spawnSyncMock.mockReturnValue({ status: 5, signal: "SIGTERM", stdout: "", stderr: "" });
		const entries = checkProjectTypecheckClean(dir);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.name).toBe("project_typecheck_timed_out");
		expect(entries[0]?.message).toContain("signal SIGTERM");
	});
});

describe("resolveTestCommand pkg?.scripts optional chaining (kills 1891c8a0)", () => {
	// test-contract: bug — a valid package.json whose content parses to the
	// JSON literal `null` must be handled via optional chaining (pkg?.scripts),
	// not crash with "Cannot read properties of null" on an unguarded pkg.scripts.
	it("returns null (not a throw) when package.json parses to JSON null", () => {
		writeFileSync(join(dir, "package.json"), "null");
		let result: ReturnType<typeof resolveTestCommand>;
		expect(() => {
			result = resolveTestCommand(dir);
		}).not.toThrow();
		expect(result!).toBeNull();
	});
});

describe("checkProjectTestsClean stderr fallback (kills 14fc0451, 765bf2b6, a587cced)", () => {
	beforeEach(() => writePkg({ test: "vitest run" }));

	// test-contract: public-api — checkProjectTestsClean must surface the
	// actual per-test failure messages parsed out of `result.stderr` (the
	// `result.stderr || ""` fallback exists only to cover a missing/empty
	// stderr, not to replace real stderr content with a boolean literal).
	it("parses real failure lines out of stderr when stdout is empty", () => {
		spawnSyncMock.mockReturnValue({
			status: 1,
			signal: null,
			stdout: "",
			stderr: "× a failing test\nFAIL src/thing.test.ts",
		});
		const entries = checkProjectTestsClean(dir);
		const messages = entries.map((e) => e.message);
		expect(messages).toContain("a failing test");
		expect(messages).toContain("src/thing.test.ts");
		expect(entries.every((e) => e.name === "project_tests_clean")).toBe(true);
		expect(entries.length).toBe(2);
	});
});
