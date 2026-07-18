import { describe, expect, it } from "vitest";
import type { SpawnOutcome } from "./coverage-runner.js";
import { failure, spawnText, testsPassedFromStatus } from "./coverage-run-helpers.js";

describe("failure", () => {
	it("builds a not-measured result that fails open", () => {
		const r = failure(120, "boom");
		expect(r.ok).toBe(false);
		expect(r.error).toBe("boom");
		expect(r.testsPassed).toBeNull();
		expect(r.perFile.size).toBe(0);
		expect(r.suiteMs).toBe(120);
	});
});

describe("spawnText", () => {
	it("concatenates stdout and stderr", () => {
		const o = { stdout: "out", stderr: "err", status: 0 } as SpawnOutcome;
		expect(spawnText(o)).toBe("out\nerr");
	});
	it("tolerates missing streams", () => {
		expect(spawnText({ status: 0 } as SpawnOutcome)).toBe("\n");
	});
});

describe("testsPassedFromStatus", () => {
	it("0 → passed, failExit → failed, else null (fail-open)", () => {
		expect(testsPassedFromStatus(0, 1)).toBe(true);
		expect(testsPassedFromStatus(1, 1)).toBe(false);
		expect(testsPassedFromStatus(2, 1)).toBeNull();
		expect(testsPassedFromStatus(null, 1)).toBeNull();
	});
});
