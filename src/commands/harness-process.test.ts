import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	collectAncestorPids,
	isHarnessRunning,
	readActiveHarnessPid,
	reapOrphanHarnesses,
} from "./harness-process.js";

// Import-level tests: assert every exported process/orphan utility is
// callable. The import itself catches missing exports, syntax errors, and
// cyclic import failures.

describe("harness-process module", () => {
	it("exports isHarnessRunning as a function", () => {
		expect(typeof isHarnessRunning).toBe("function");
	});

	it("exports reapOrphanHarnesses as a function", () => {
		expect(typeof reapOrphanHarnesses).toBe("function");
	});

	it("exports collectAncestorPids as a function", () => {
		expect(typeof collectAncestorPids).toBe("function");
	});

	it("exports readActiveHarnessPid as a function", () => {
		expect(typeof readActiveHarnessPid).toBe("function");
	});
});

// Behavioral coverage for the missing-state failure paths — these are the
// branches every caller relies on when no daemon has ever started in a cwd.
describe("harness-process — absent-state handling", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = join(
			tmpdir(),
			`harness-process-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
		);
		mkdirSync(join(workDir, ".interlinked"), { recursive: true });
	});

	afterEach(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	it("readActiveHarnessPid returns null when no pid file exists", () => {
		expect(readActiveHarnessPid(workDir)).toBeNull();
	});

	it("readActiveHarnessPid returns null for a non-numeric pid file", () => {
		writeFileSync(join(workDir, ".interlinked", "harness.pid"), "not-a-number");
		expect(readActiveHarnessPid(workDir)).toBeNull();
	});

	it("isHarnessRunning reports not running when no pid file exists", () => {
		expect(isHarnessRunning(workDir).running).toBe(false);
	});

	it("reapOrphanHarnesses dry-run never reports any killed PIDs", () => {
		const result = reapOrphanHarnesses(workDir, { dryRun: true });
		expect(result.dryRun).toBe(true);
		expect(result.killed).toEqual([]);
	});
});
