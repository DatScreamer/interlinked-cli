import { describe, expect, it } from "vitest";
import {
	MAX_REPORTED_FAILURES,
	type SuiteRunner,
	extractFailureLines,
	probeScopedSuite,
	redSuiteMessage,
	sawTestSession,
} from "./baseline-suite.js";

/** A runner that records what it was asked to do and returns a fixed result. */
function stubRunner(
	result: { exitCode: number; stdout?: string; stderr?: string },
	calls: Array<{ tests: string[]; cwd: string }> = [],
): SuiteRunner {
	return async ({ tests, cwd }) => {
		calls.push({ tests, cwd });
		return { exitCode: result.exitCode, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	};
}

describe("probeScopedSuite — green", () => {
	it("reports green when the runner exits 0", async () => {
		const probe = await probeScopedSuite({
			tests: ["a.test.ts"],
			cwd: "/repo",
			run: stubRunner({ exitCode: 0 }),
		});
		expect(probe.status).toBe("green");
		expect(probe.testCount).toBe(1);
		expect(probe.failures).toEqual([]);
	});

	it("passes the test list and cwd through to the runner verbatim", async () => {
		const calls: Array<{ tests: string[]; cwd: string }> = [];
		await probeScopedSuite({
			tests: ["a.test.ts", "b.test.ts"],
			cwd: "/repo",
			run: stubRunner({ exitCode: 0 }, calls),
		});
		expect(calls).toEqual([{ tests: ["a.test.ts", "b.test.ts"], cwd: "/repo" }]);
	});
});

describe("probeScopedSuite — red", () => {
	it("reports red on a nonzero exit from a run that reported on tests", async () => {
		const probe = await probeScopedSuite({
			tests: ["a.test.ts"],
			cwd: "/repo",
			run: stubRunner({ exitCode: 1, stdout: "Tests  1 failed | 2 passed (3)" }),
		});
		expect(probe.status).toBe("red");
	});

	it("treats any nonzero exit as red, not just 1", async () => {
		const probe = await probeScopedSuite({
			tests: ["a.test.ts"],
			cwd: "/repo",
			run: stubRunner({ exitCode: 137, stdout: "Tests  1 failed (1)" }),
		});
		expect(probe.status).toBe("red");
	});

	it("collects failing lines from stdout and stderr together", async () => {
		const probe = await probeScopedSuite({
			tests: ["a.test.ts"],
			cwd: "/repo",
			run: stubRunner({
				exitCode: 1,
				stdout: "Test Files  1 failed (1)\nFAIL src/a.test.ts",
				stderr: "× parses a named import",
			}),
		});
		expect(probe.failures).toEqual(["FAIL src/a.test.ts", "× parses a named import"]);
	});
});

describe("probeScopedSuite — a runner that never ran tests is not a red suite", () => {
	// Regression: the first live run passed `--reporter=basic`, removed in
	// vitest 4. vitest exited nonzero before running anything and the probe
	// called a clean 140/140 file RED. A nonzero exit is only a verdict about
	// the suite if a test session actually happened.
	it("skips when the runner exits nonzero with no test-session output", async () => {
		const probe = await probeScopedSuite({
			tests: ["a.test.ts"],
			cwd: "/repo",
			run: stubRunner({ exitCode: 1, stderr: "Error: Unknown reporter 'basic'" }),
		});
		expect(probe.status).toBe("skipped");
		expect(probe.skipReason).toContain("without running tests");
	});

	it("still reds when a session ran and reported failures", async () => {
		const probe = await probeScopedSuite({
			tests: ["a.test.ts"],
			cwd: "/repo",
			run: stubRunner({ exitCode: 1, stdout: "Tests  1 failed | 4 passed (5)" }),
		});
		expect(probe.status).toBe("red");
	});

	it("reds on a `Test Files` summary too, not only `Tests`", async () => {
		const probe = await probeScopedSuite({
			tests: ["a.test.ts"],
			cwd: "/repo",
			run: stubRunner({ exitCode: 1, stdout: "  Test Files  1 failed (1)" }),
		});
		expect(probe.status).toBe("red");
	});

	it("treats an explicit no-test-files exit as a session, not a runner crash", async () => {
		const probe = await probeScopedSuite({
			tests: ["a.test.ts"],
			cwd: "/repo",
			run: stubRunner({ exitCode: 1, stderr: "No test files found, exiting with code 1" }),
		});
		expect(probe.status).toBe("red");
	});
});

describe("sawTestSession", () => {
	it("recognizes the vitest Test Files summary", () => {
		expect(sawTestSession(" Test Files  3 passed (3)")).toBe(true);
	});

	it("recognizes the Tests summary", () => {
		expect(sawTestSession("      Tests  19 passed (19)")).toBe(true);
	});

	it("rejects a bare crash with no summary", () => {
		expect(sawTestSession("Error: Unknown reporter 'basic'\n  at Vitest._setServer")).toBe(false);
	});

	it("rejects empty output", () => {
		expect(sawTestSession("")).toBe(false);
	});

	it("does not match the words mid-sentence", () => {
		expect(sawTestSession("the Tests(x) helper threw")).toBe(false);
	});
});

describe("probeScopedSuite — skipped is never green", () => {
	// The whole point of the module: "nothing ran" must not read as "it passed".
	it("skips (does not pass) when no tests are selected", async () => {
		const probe = await probeScopedSuite({ tests: [], cwd: "/repo", run: stubRunner({ exitCode: 0 }) });
		expect(probe.status).toBe("skipped");
		expect(probe.skipReason).toMatch(/no tests selected/);
	});

	it("does not invoke the runner at all when the test list is empty", async () => {
		const calls: Array<{ tests: string[]; cwd: string }> = [];
		await probeScopedSuite({ tests: [], cwd: "/repo", run: stubRunner({ exitCode: 0 }, calls) });
		expect(calls).toEqual([]);
	});

	it("skips — not reds — when the runner cannot be started", async () => {
		const probe = await probeScopedSuite({
			tests: ["a.test.ts"],
			cwd: "/repo",
			run: async () => {
				throw new Error("spawn ENOENT");
			},
		});
		expect(probe.status).toBe("skipped");
		expect(probe.skipReason).toContain("spawn ENOENT");
	});
});

describe("extractFailureLines", () => {
	it("recognizes both the FAIL-path and ×-name conventions", () => {
		expect(extractFailureLines("FAIL src/a.test.ts\n× does a thing")).toEqual([
			"FAIL src/a.test.ts",
			"× does a thing",
		]);
	});

	it("accepts the ✕ and ✗ failure glyph variants", () => {
		expect(extractFailureLines("✕ one\n✗ two")).toEqual(["✕ one", "✗ two"]);
	});

	it("ignores passing lines and blank lines", () => {
		expect(extractFailureLines("✓ passes\n\n  \nTest Files  1 passed")).toEqual([]);
	});

	it("does not match FAILURE or FAILED — the convention is `FAIL ` exactly", () => {
		expect(extractFailureLines("FAILED to connect\nFAILURE: nope")).toEqual([]);
	});

	it("trims leading indentation so nested reporter output still matches", () => {
		expect(extractFailureLines("   × indented name")).toEqual(["× indented name"]);
	});

	it(`caps output at ${MAX_REPORTED_FAILURES} lines`, () => {
		const many = Array.from({ length: MAX_REPORTED_FAILURES + 8 }, (_, i) => `× t${i}`).join("\n");
		expect(extractFailureLines(many)).toHaveLength(MAX_REPORTED_FAILURES);
	});

	it("returns nothing for empty output", () => {
		expect(extractFailureLines("")).toEqual([]);
	});
});

describe("redSuiteMessage", () => {
	it("states that the run would be meaningless, not merely that tests failed", () => {
		const msg = redSuiteMessage({ status: "red", testCount: 3, failures: [] });
		expect(msg).toContain("meaningless");
		expect(msg).toContain("reported KILLED");
	});

	it("reports the selected test count", () => {
		expect(redSuiteMessage({ status: "red", testCount: 3, failures: [] })).toContain("3 test file(s)");
	});

	it("lists the failing tests when they are known", () => {
		const msg = redSuiteMessage({ status: "red", testCount: 1, failures: ["× parses a named import"] });
		expect(msg).toContain("Failing:");
		expect(msg).toContain("× parses a named import");
	});

	it("omits the Failing section entirely when no lines were extracted", () => {
		expect(redSuiteMessage({ status: "red", testCount: 1, failures: [] })).not.toContain("Failing:");
	});
});
