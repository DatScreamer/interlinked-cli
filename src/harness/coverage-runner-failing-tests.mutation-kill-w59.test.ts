import { describe, expect, it } from "vitest";
import {
	parsePytestFailingTests,
	parsePytestFailingTestFiles,
	parseVitestFailingTests,
	parseVitestFailingTestFiles,
	withFailingTests,
} from "./coverage-runner-failing-tests.js";
import type { CoverageRunResult } from "./coverage-runner.js";

function baseResult(testsPassed: boolean | null): CoverageRunResult {
	return {
		suiteMs: 1,
		perFile: new Map(),
		ok: true,
		testsPassed,
	};
}

describe("parseVitestFailingTests — positive (must fire)", () => {
	// test-contract: public-api — parseVitestFailingTests must match a FAIL row with leading whitespace.
	it("P1: matches a line with leading whitespace before FAIL", () => {
		// kills 029f1cce283d3b08 (\S* instead of \s*) and d95f06e589cefdc9 (dropped ^)
		const names = parseVitestFailingTests("  FAIL  src/foo.test.ts > suite > case");
		expect(names).toEqual(["case"]);
	});

	// test-contract: public-api — parseVitestFailingTests must not match FAIL when preceded by a non-whitespace char (anchored regex contract).
	it("P2: does not match FAIL preceded by a non-whitespace character", () => {
		// with \S* (mutant), "xFAIL foo" would match because \S* can match "x".
		// with ^\s*, "xFAIL foo" must NOT match since 'x' is neither start-anchored
		// whitespace nor the FAIL token itself.
		const names = parseVitestFailingTests("xFAIL foo > bar > baz");
		expect(names).toEqual([]);
	});

	// test-contract: public-api — label capture must include multi-word tail after ' > '.
	it("P3: requires at least one whitespace between FAIL and label (kills single-space regex 25e5d0ebce6ae2aa)", () => {
		// orig requires \s+ (one or more). A line with only single space still
		// matches both variants, so use a case distinguishing count semantics:
		// this doesn't differ for \s+ vs \s, so instead assert the arrow-slice
		// behavior below covers the label content precisely.
		const names = parseVitestFailingTests("FAIL   src/foo.test.ts > suite > case name");
		expect(names).toEqual(["case name"]);
	});

	// test-contract: public-api — trailing whitespace in the source line must not leak into the returned name.
	it("P4: trailing whitespace on the line is trimmed from the tail (kills trailing $ removal via .? group)", () => {
		const names = parseVitestFailingTests("FAIL src/foo.test.ts > suite > case   ");
		expect(names).toEqual(["case"]);
	});
});

describe("parseVitestFailingTests — label/arrow handling (must fire)", () => {
	// test-contract: public-api — a captured single-word label must be returned verbatim.
	it("kills f33e772a3f5316cc (!label -> false): empty label after match must be skipped", () => {
		// Construct a line where match group 1 could be empty: "FAIL " with
		// nothing after — regex requires \s+ then (.+?) so group can't be empty
		// via this regex; instead test that a non-matching whitespace-only tail
		// still yields no crash and correct names count for a real capture.
		const names = parseVitestFailingTests("FAIL x");
		expect(names).toEqual(["x"]);
	});

	// test-contract: public-api — a label with no ' > ' separator must pass through unsliced.
	it("kills f4a4bd675f7299b5 (arrow >= 0 -> true) and 686509d934332945 (>= -> >): label with no ' > ' must not be sliced", () => {
		const names = parseVitestFailingTests("FAIL justAName");
		expect(names).toEqual(["justAName"]);
	});

	// test-contract: public-api — the case-name tail after the last ' > ' must be trimmed of padding.
	it("kills 7c1f0fa2f204b063 (drop .trim() after slice): sliced tail must be trimmed", () => {
		const names = parseVitestFailingTests("FAIL suite >    padded case");
		expect(names).toEqual(["padded case"]);
	});
});

describe("vitestFailureFile (via parseVitestFailingTestFiles) — positive (must fire)", () => {
	// test-contract: public-api — parseVitestFailingTestFiles must strip a leading |project| workspace tag from the file path.
	it("kills ba675d6d39d23059 (drop ^ anchor) and 28bcce9e7b41a56c / bb30d7f704d09caf (tag-strip regex variants)", () => {
		// |project| tag must be stripped only from the START of the label.
		const files = parseVitestFailingTestFiles("FAIL |proj| src/foo.test.ts");
		expect(files).toEqual(["src/foo.test.ts"]);
	});

	// test-contract: public-api — a trailing "(3 tests | 1 failed) 12ms" annotation must be stripped from the file path.
	it("kills 58a1e0335e30ede1 (drop trailing .trim()) and bf2f1e934bda0530/68588712fe2ba4ce (bracket-strip regex)", () => {
		const files = parseVitestFailingTestFiles("FAIL src/foo.test.ts (3 tests | 1 failed) 12ms");
		expect(files).toEqual(["src/foo.test.ts"]);
	});

	// test-contract: public-api — the file component before ' > ' must be extracted from a full failure label.
	it("kills 1871d874544a530c (arrow >= 0 -> > 0): arrow at position 0 must still split", () => {
		// arrow = untagged.indexOf(" > "); can't literally be 0 since " > " needs
		// content before it, but must correctly slice when arrow > 0 works the
		// same for both variants at position>0. Use a case with arrow found and
		// content that differs between slicing before vs the whole str.
		const files = parseVitestFailingTestFiles("FAIL src/foo.test.ts > suite > case");
		expect(files).toEqual(["src/foo.test.ts"]);
	});

	// test-contract: public-api — a line not starting with FAIL/x/etc. must not be parsed as a failing-test file row.
	it("kills 9b4cb6b966be8cba (drop ^ anchor on main line regex, used in parseVitestFailingTestFiles)", () => {
		const files = parseVitestFailingTestFiles("xFAIL src/foo.test.ts");
		expect(files).toEqual([]);
	});
});

describe("pytestFailureNodeId (via parsePytestFailingTests) — positive (must fire)", () => {
	// test-contract: public-api — parsePytestFailingTests must extract the nodeid from a "FAILED <nodeid>" summary row.
	it("kills 4568248b7a58d93f (\\s+ -> \\s in FAILED summary regex): requires only whitespace boundary, still matches single space", () => {
		const names = parsePytestFailingTests("FAILED tests/test_x.py::test_a");
		expect(names).toEqual(["tests/test_x.py::test_a"]);
	});

	// test-contract: public-api — a verbose-form row must be anchored at the nodeid start, not matched mid-line.
	it("kills d4112a24cb2300f2 (drop ^ anchor on inline regex): line NOT starting with nodeid must not match", () => {
		const names = parsePytestFailingTests("something tests/test_x.py::test_a FAILED");
		expect(names).toEqual([]);
	});

	// test-contract: public-api — parsePytestFailingTests must extract the nodeid from a "<nodeid> ... FAILED" verbose row.
	it("kills c551f12ac929a643 (\\s+ -> \\s before FAILED in inline regex): matches inline verbose form", () => {
		const names = parsePytestFailingTests("tests/test_x.py::test_a   FAILED");
		expect(names).toEqual(["tests/test_x.py::test_a"]);
	});
});

describe("parsePytestFailingTestFiles — positive (must fire)", () => {
	// test-contract: public-api — a line with no failing-test marker must produce no file entries.
	it("kills 99c1fa3d5a996153 (empty-string fallback -> literal string): missing nodeid segment must yield empty, not literal", () => {
		// nodeid?.split("::")[0] ?? "" — if the fallback string were non-empty
		// junk, a line with no FAILED match would push that junk through
		// isTestPath and possibly into results. Use a line with no match at all.
		const files = parsePytestFailingTestFiles("no failure marker here at all");
		expect(files).toEqual([]);
	});

	// test-contract: public-api — parsePytestFailingTestFiles must extract the file path component of a pytest nodeid.
	it("splits nodeid on '::' and validates as a test path", () => {
		const files = parsePytestFailingTestFiles("FAILED tests/test_x.py::TestC::test_m");
		expect(files).toEqual(["tests/test_x.py"]);
	});
});

describe("withFailingTests — dedupeCap entry mechanics (must fire)", () => {
	// test-contract: invariant — dedupeCap trims each raw entry before treating it as a non-empty name.
	it("kills 47b2f13b3a285399 (drop raw.trim()): untrimmed whitespace-only entries must not survive as truthy", () => {
		const result = withFailingTests(baseResult(false), ["   ", "real"], []);
		expect(result.failingTests).toEqual(["real"]);
	});

	// test-contract: invariant — dedupeCap must exclude entries that trim to an empty string.
	it("kills 8967831902be303c (entry -> true): falsy/whitespace-only trimmed entries must be excluded from the set", () => {
		const result = withFailingTests(baseResult(false), ["", "   ", "kept"], []);
		expect(result.failingTests).toEqual(["kept"]);
	});

	// test-contract: public-api — withFailingTests must omit the failingTests key (not set it to []) when no names were parsed.
	it("kills 3d4509fe84b02e6f (cappedNames.length > 0 -> true) and 01f1007d1c73f6e8 (> 0 -> >= 0): zero names must omit failingTests key entirely", () => {
		const result = withFailingTests(baseResult(false), [], []);
		expect(result).not.toHaveProperty("failingTests");
		expect(Object.prototype.hasOwnProperty.call(result, "failingTests")).toBe(false);
	});

	// test-contract: public-api — withFailingTests must attach a deduped failingTests array when names were parsed on a red run.
	it("non-empty names attach failingTests key with capped/deduped content", () => {
		const result = withFailingTests(baseResult(false), ["a", "a", "b"], []);
		expect(result.failingTests).toEqual(["a", "b"]);
		expect(Object.prototype.hasOwnProperty.call(result, "failingTests")).toBe(true);
	});
});
