// Mutation-kill suite (wave 35) for test-outcome-evidence.ts.
// Each test below targets specific surviving mutants recorded in
// .interlinked/mutation-manifest.json for this file. See inline notes for
// the mutantId(s) each case is designed to distinguish.

import { describe, expect, it } from "vitest";
import { isOutcomeAttributable, parseTestSummary } from "./test-outcome-evidence.js";

describe("isOutcomeAttributable — maskQuoted filler must preserve length", () => {
	// mutantId 313332fd1189986d: maskQuoted's "_".repeat(m.length) mutated to
	// "".repeat(m.length) (always ""). Deleting the quoted span instead of
	// filling it with same-length underscores can splice two adjacent
	// operator halves ("&" ... "&") into a real "&&" control operator.
	// test-contract: invariant — quoted spans must be masked, not deleted
	it("does not let deleting a quoted span splice two & halves into &&", () => {
		expect(isOutcomeAttributable('npx vitest run&"z"&')).toBe(true);
	});
});

describe("isOutcomeAttributable — no-runner-match sentinel and short-circuit", () => {
	// mutantId 1375f0e8a1271d65: initial `lastEnd = -1` mutated to `+1`.
	// mutantId eb870eef6af54fc3: the `lastEnd < 0` guard mutated to `false`.
	// Both change what happens when no runner is found: the no-runner branch
	// must return true unconditionally rather than falling through to
	// re-scan the tail of the (unmatched) command for control operators.
	// test-contract: invariant — no runner match must short-circuit to true
	it("trusts a command with no runner even when it ends in a control char", () => {
		expect(isOutcomeAttributable("foo bar;")).toBe(true);
	});
});

describe("isOutcomeAttributable — RUNNER_RE must recognize real invocations", () => {
	// mutantId ee3b60dd41add452: `(?:npx\s+)?` optional group made mandatory,
	// so a bare (no-npx) "vitest" invocation is no longer recognized as a
	// runner at all — the pipe after it then goes undetected.
	// test-contract: invariant — bare "vitest" (no npx prefix) is a runner
	it("still attributes a piped bare vitest invocation (no npx prefix)", () => {
		expect(isOutcomeAttributable("vitest run | tail")).toBe(false);
	});

	// mutantId 63f7145ef5a0105f: npm's mandatory `\s+` narrowed to `\s`
	// (exactly one whitespace char), breaking recognition of "npm  test"
	// (two spaces) as a runner invocation.
	// test-contract: invariant — extra whitespace around npm test still counts
	it("recognizes npm test with extra internal whitespace", () => {
		expect(isOutcomeAttributable("npm  test | tail")).toBe(false);
	});

	// mutantId e85d7b6ea934f575: the optional `run`'s `\s+` narrowed to `\s`,
	// breaking "npm run  test" (two spaces after run).
	// test-contract: invariant — extra whitespace after run still counts
	it("recognizes npm run test with extra whitespace after run", () => {
		expect(isOutcomeAttributable("npm run  test | tail")).toBe(false);
	});

	// mutantId f3800a31b1b5e1f9: the optional `run`'s `\s+` mutated to `\S+`
	// (non-whitespace), breaking the ordinary single-space "npm run test".
	// test-contract: invariant — standard npm run test must still attribute
	it("recognizes standard npm run test", () => {
		expect(isOutcomeAttributable("npm run test | tail")).toBe(false);
	});

	// mutantId 416831af9344f236: cargo/go/deno/bun's mandatory `\s+` narrowed
	// to `\s`, breaking "cargo  test" (two spaces).
	// test-contract: invariant — extra whitespace around cargo test still counts
	it("recognizes cargo test with extra internal whitespace", () => {
		expect(isOutcomeAttributable("cargo  test | tail")).toBe(false);
	});

	// mutantId a9dd020c5ae874b1: cargo/go/deno/bun's mandatory `\s+` mutated
	// to `\S+` (non-whitespace), breaking the ordinary "cargo test".
	// test-contract: invariant — standard cargo test must still attribute
	it("recognizes standard cargo test", () => {
		expect(isOutcomeAttributable("cargo test | tail")).toBe(false);
	});
});

describe("parseTestSummary — NO_TESTS_RE guard must actually gate", () => {
	// mutantId c640118f95f27869: `NO_TESTS_RE.test(output)` mutated to
	// `false`, so a "no tests found" message no longer short-circuits to
	// null even when a later line happens to carry a real summary.
	// test-contract: invariant — a no-tests message always wins, ignoring any summary line after it
	it("returns null for a no-tests message even with a summary line present", () => {
		expect(parseTestSummary("No tests found\nTests  5 passed (5)\n")).toBeNull();
	});
});

describe("parseTestSummary — failed/passed detail regexes", () => {
	// mutantId 12677b2809fa73e1: failed regex `\d+` narrowed to `\d`
	// (single digit), breaking multi-digit failure counts.
	// test-contract: invariant — a multi-digit failed count still reads red
	it("reads red for a multi-digit failed count", () => {
		expect(parseTestSummary("Tests  15 failed | 5 passed (20)")).toBe("red");
	});

	// mutantId f1a40c132aba176d: failed regex `\s+` narrowed to `\s`
	// (exactly one space), breaking counts separated by extra whitespace.
	// test-contract: invariant — extra whitespace before "failed" still reads red
	it("reads red when extra whitespace precedes 'failed'", () => {
		expect(parseTestSummary("Tests  3   failed")).toBe("red");
	});

	// mutantId 4fc713e83880ee10: the passed/skipped `.test(summary)` call
	// mutated to unconditional `true`, forcing green on any non-failed
	// summary text regardless of content.
	// test-contract: invariant — an unrecognized summary is null, not green
	it("returns null for a summary with no failed/passed/skipped markers", () => {
		expect(parseTestSummary("Tests  something weird")).toBeNull();
	});

	// mutantId 427979ee44550f38: passed/skipped regex `\s+` narrowed to `\s`
	// (exactly one space), breaking counts separated by extra whitespace.
	// test-contract: invariant — extra whitespace before "passed" still reads green
	it("reads green when extra whitespace precedes 'passed'", () => {
		expect(parseTestSummary("Tests   3   passed")).toBe("green");
	});
});

describe("parseTestSummary — SUMMARY_LINE_RE (Tests) must anchor correctly", () => {
	// mutantId 025ce888dbd07092: leading `^` anchor dropped, letting "Tests"
	// match mid-line instead of only at a line's own start.
	// test-contract: boundary — "Tests" embedded in another word is not a summary line
	it("does not treat 'Tests' embedded mid-line as a summary line", () => {
		expect(parseTestSummary("FooTests: 3 failed")).toBeNull();
	});

	// mutantId 7ade9bf3b02c946f: leading `\s*` mutated to `\S*`, breaking
	// lines that start with real leading whitespace before "Tests".
	// test-contract: invariant — leading whitespace before Tests is still matched
	it("reads a Tests line with leading whitespace", () => {
		expect(parseTestSummary("  Tests  5 failed")).toBe("red");
	});

	// mutantId ddf9a7402c68bc83: the `[:\s]` separator class mutated to
	// `[:\S]`, breaking the common "Tests <space>..." form (no colon).
	// test-contract: invariant — a bare space after "Tests" (no colon) still matches
	it("reads a Tests line separated by a space, no colon", () => {
		expect(parseTestSummary("Tests  5 failed")).toBe("red");
	});

	// mutantId a6ef48ef3049ace8: the trailing `\s*` before the capture group
	// mutated to mandatory `\s`, breaking "Tests:5 failed" (colon directly
	// followed by the digit, no space at all).
	// test-contract: invariant — a colon directly followed by digits still matches
	it("reads a Tests line with colon directly followed by the count", () => {
		expect(parseTestSummary("Tests:5 failed")).toBe("red");
	});
});

describe("parseTestSummary — FILES_LINE_RE (Test Files) must anchor correctly", () => {
	// mutantId f17a7677c3ceeaa7: leading `^` anchor dropped, letting
	// "Test Files" match mid-line instead of only at a line's own start.
	// test-contract: boundary — "Test Files" embedded mid-line is not a summary line
	it("does not treat 'Test Files' embedded mid-line as a summary line", () => {
		expect(parseTestSummary("XTest Files: 3 failed")).toBeNull();
	});

	// mutantId ee3079abacbac759 (^\s* -> ^\s, mandatory one leading space),
	// mutantId efb519ada0035344 ([:\s] -> [^:\s], inverted separator class),
	// mutantId aebdce69beb64180 ([:\s] -> [:\S], separator must be nonspace).
	// A "Test Files" line with zero leading whitespace and a bare space
	// separator (the common vitest form) must still match under the real
	// regex, and fails under all three of these mutated variants.
	// test-contract: invariant — zero leading whitespace + space separator still matches
	it("reads a Test Files line with no leading whitespace and a space separator", () => {
		expect(parseTestSummary("Test Files  2 failed")).toBe("red");
	});

	// mutantId 1a2a0752b278d44b: leading `\s*` mutated to `\S*`, breaking
	// lines that start with real leading whitespace before "Test Files".
	// test-contract: invariant — leading whitespace before Test Files is still matched
	it("reads a Test Files line with leading whitespace", () => {
		expect(parseTestSummary("  Test Files  4 failed")).toBe("red");
	});

	// mutantId 251285b0047ab504: the trailing `\s*` before the capture group
	// mutated to mandatory `\s`, breaking "Test Files:5 failed" (colon
	// directly followed by the digit, no space at all).
	// test-contract: invariant — a colon directly followed by digits still matches
	it("reads a Test Files line with colon directly followed by the count", () => {
		expect(parseTestSummary("Test Files:5 failed")).toBe("red");
	});

	// mutantId 78eea21a6ef76009: capture group `(.+)` narrowed to `(.)`
	// (exactly one character), truncating a multi-digit failed count so the
	// downstream "failed" regex can never match.
	// test-contract: invariant — a multi-digit count is captured in full
	it("reads a Test Files line with a multi-digit failed count", () => {
		expect(parseTestSummary("Test Files  12 failed")).toBe("red");
	});
});
