// Mutation-kill companion for supermodel-analyses.ts's two execFileSync
// call sites: isSupermodelCliAvailable and runSupermodelDeadCode. The
// sibling supermodel-analyses.test.ts exercises the real graceful-skip path
// against a binary that genuinely doesn't exist on the test machine; this
// file mocks node:child_process so the exact argv/options construction can
// be pinned without ever spawning a real subprocess.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execFileSync: mocks.execFileSync,
}));

import { isSupermodelCliAvailable, runSupermodelDeadCode } from "../supermodel-analyses.js";

/** The exact options object runSupermodelDeadCode passes to execFileSync,
 *  given a cwd and an optional timeout override. */
function baseOpts(cwd: string, timeout = 300_000) {
	return {
		cwd,
		encoding: "utf-8",
		timeout,
		maxBuffer: 16 * 1024 * 1024,
		stdio: ["ignore", "pipe", "ignore"],
	};
}

// A fixed mocked stdout + its expected parse, reused across
// runSupermodelDeadCode call variants so each test's return-value assertion
// proves the mocked execFileSync output actually flows through
// parseDeadCodeJson end to end, not just that execFileSync was invoked.
const SAMPLE_STDOUT = JSON.stringify({
	deadCodeCandidates: [{ file: "a.ts", name: "fn", line: 3, confidence: "high", reason: "r" }],
	metadata: { totalDeclarations: 9 },
});
const SAMPLE_ANALYSIS = {
	candidates: [{ file: "a.ts", name: "fn", line: 3, confidence: "high", reason: "r" }],
	totalDeclarations: 9,
};

describe("isSupermodelCliAvailable — mutation-kill (mocked execFileSync)", () => {
	beforeEach(() => {
		mocks.execFileSync.mockReset();
	});

	// test-contract: public-api — default binary is "supermodel", with the exact argv and options
	it("invokes execFileSync with the default binary, exact args, and exact options", () => {
		mocks.execFileSync.mockReturnValue("");
		const result = isSupermodelCliAvailable();
		expect(mocks.execFileSync).toHaveBeenCalledWith("supermodel", ["version"], {
			stdio: "ignore",
			timeout: 5000,
		});
		expect(result).toBe(true);
	});

	// test-contract: public-api — a caller-supplied binary name is passed through verbatim
	it("passes a custom binary name through to execFileSync", () => {
		mocks.execFileSync.mockReturnValue("");
		const result = isSupermodelCliAvailable("my-custom-binary");
		expect(mocks.execFileSync).toHaveBeenCalledWith("my-custom-binary", ["version"], {
			stdio: "ignore",
			timeout: 5000,
		});
		expect(result).toBe(true);
	});
});

describe("runSupermodelDeadCode — mutation-kill (mocked execFileSync)", () => {
	beforeEach(() => {
		mocks.execFileSync.mockReset();
		mocks.execFileSync.mockReturnValue(SAMPLE_STDOUT);
	});

	// test-contract: public-api — the base argv and options, with no optional opts, are exact,
	// and the mocked stdout still flows through parseDeadCodeJson into the return value
	it("builds the exact base argv and options when no optional opts are given", () => {
		const result = runSupermodelDeadCode("/repo");
		expect(mocks.execFileSync).toHaveBeenCalledWith(
			"supermodel",
			["dead-code", "--output", "json"],
			baseOpts("/repo"),
		);
		expect(result).toEqual(SAMPLE_ANALYSIS);
	});

	// test-contract: public-api — minConfidence appends --min-confidence <value> to argv
	it("appends --min-confidence when opts.minConfidence is set", () => {
		const result = runSupermodelDeadCode("/repo", { minConfidence: "high" });
		expect(mocks.execFileSync).toHaveBeenCalledWith(
			"supermodel",
			["dead-code", "--output", "json", "--min-confidence", "high"],
			baseOpts("/repo"),
		);
		expect(result).toEqual(SAMPLE_ANALYSIS);
	});

	// test-contract: public-api — a valid positive limit appends --limit <value> to argv
	it("appends --limit when opts.limit is a positive number", () => {
		const result = runSupermodelDeadCode("/repo", { limit: 5 });
		expect(mocks.execFileSync).toHaveBeenCalledWith(
			"supermodel",
			["dead-code", "--output", "json", "--limit", "5"],
			baseOpts("/repo"),
		);
		expect(result).toEqual(SAMPLE_ANALYSIS);
	});

	// test-contract: boundary — limit=0 is a number but not > 0, so it must NOT be appended
	// (typeof opts.limit === "number" && opts.limit > 0, not ||, not >=)
	it("does not append --limit when opts.limit is 0", () => {
		const result = runSupermodelDeadCode("/repo", { limit: 0 });
		expect(mocks.execFileSync).toHaveBeenCalledWith(
			"supermodel",
			["dead-code", "--output", "json"],
			baseOpts("/repo"),
		);
		expect(result).toEqual(SAMPLE_ANALYSIS);
	});

	// test-contract: boundary — a numeric-looking string limit must be rejected even though
	// "5" > 0 coerces to true in JS; the typeof guard exists for exactly this untyped-caller
	// case (the cast simulates a JS/JSON caller that doesn't respect the `number` type).
	it("does not append --limit when opts.limit is a numeric-looking string", () => {
		// SAFETY: deliberately violates RunDeadCodeOptions.limit's `number` type to exercise
		// the runtime typeof guard, simulating an untyped JS caller.
		const result = runSupermodelDeadCode("/repo", { limit: "5" as unknown as number });
		expect(mocks.execFileSync).toHaveBeenCalledWith(
			"supermodel",
			["dead-code", "--output", "json"],
			baseOpts("/repo"),
		);
		expect(result).toEqual(SAMPLE_ANALYSIS);
	});

	// test-contract: public-api — opts.binary overrides the "supermodel" default even though
	// it's truthy (nullish-coalescing, not a truthiness check, must select the override)
	it("passes a custom binary through as the execFileSync command", () => {
		const result = runSupermodelDeadCode("/repo", { binary: "custom-binary" });
		expect(mocks.execFileSync).toHaveBeenCalledWith(
			"custom-binary",
			["dead-code", "--output", "json"],
			baseOpts("/repo"),
		);
		expect(result).toEqual(SAMPLE_ANALYSIS);
	});

	// test-contract: public-api — opts.timeoutMs overrides the 300_000ms default even for a
	// small truthy value (nullish-coalescing, not a truthiness check, must select the override)
	it("passes a custom timeoutMs through as the timeout option", () => {
		const result = runSupermodelDeadCode("/repo", { timeoutMs: 1234 });
		expect(mocks.execFileSync).toHaveBeenCalledWith(
			"supermodel",
			["dead-code", "--output", "json"],
			baseOpts("/repo", 1234),
		);
		expect(result).toEqual(SAMPLE_ANALYSIS);
	});

	// test-contract: public-api — a successful call actually invokes execFileSync exactly once
	// (the try-block body is not a no-op)
	it("invokes execFileSync exactly once on success", () => {
		const result = runSupermodelDeadCode("/repo");
		expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
		expect(result).toEqual(SAMPLE_ANALYSIS);
	});

	// test-contract: boundary — a throwing execFileSync yields null, not a propagated exception
	it("returns null (not throw) when execFileSync throws", () => {
		mocks.execFileSync.mockImplementation(() => {
			throw new Error("ENOENT");
		});
		expect(() => runSupermodelDeadCode("/repo")).not.toThrow();
		expect(runSupermodelDeadCode("/repo")).toBeNull();
	});
});
