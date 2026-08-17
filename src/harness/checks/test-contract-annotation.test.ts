// Tests for test_contract_annotation (Plan 25 lane 7,
// docs/plans/25-refactor-readiness-program.md). See
// test-contract-annotation.ts for the adoption-gate rationale, including the
// mutation-directed file-shape gate added after calibration (745 fires
// across 87 files before the fix — see that file's header for the full
// story).

import { describe, expect, it } from "vitest";
import { detectTestContractAnnotation } from "./test-contract-annotation.js";

// Matches the convention's own documented scope — session-2026-08-11-synthesis.md.
const MUTATION_KILL_FILE = "src/example.mutation-kill.test.ts";
const MUTATION_HARDENING_FILE = "src/example.mutation-hardening.test.ts";
const SURVIVORS_FILE = "src/example.survivors.test.ts";
// An ORDINARY test file — not mutation-directed — even though it IS a real test file.
const ORDINARY_TEST_FILE = "src/example.test.ts";

describe("detectTestContractAnnotation", () => {
	it("P1: an it( with no test-contract: comment in the 3 lines above it fires, once the file has adopted the convention", () => {
		const content = [
			"// test-contract: invariant — parseWindow rejects a zero-width interval",
			"it('rejects a zero-width interval', () => {",
			"  expect(parseWindow(0, 0)).toBeNull();",
			"});",
			"",
			"it('accepts a positive interval', () => {",
			"  expect(parseWindow(0, 1)).not.toBeNull();",
			"});",
		].join("\n");
		const matches = detectTestContractAnnotation(content, MUTATION_KILL_FILE);
		expect(matches.length).toBe(1);
		expect(matches[0]?.text).toContain("test_contract_annotation");
		expect(matches[0]?.text).toContain("accepts a positive interval");
	});

	it("P2: a test-shaped block with no annotation above it fires, not just it-shaped ones", () => {
		const content = [
			"// test-contract: boundary — normalize is idempotent",
			"test('normalize is idempotent', () => {",
			"  expect(normalize(normalize(x))).toEqual(normalize(x));",
			"});",
			"",
			"test('normalize trims whitespace', () => {",
			"  expect(normalize(' a ')).toBe('a');",
			"});",
		].join("\n");
		const matches = detectTestContractAnnotation(content, MUTATION_KILL_FILE);
		expect(matches.length).toBe(1);
	});

	it("P3: fires in a .mutation-hardening.test.ts file too", () => {
		const content = [
			"// test-contract: bug — regression for issue #42",
			"it('covered', () => {});",
			"",
			"",
			"",
			"it('not covered', () => {});",
		].join("\n");
		const matches = detectTestContractAnnotation(content, MUTATION_HARDENING_FILE);
		expect(matches.length).toBe(1);
	});

	it("P4: fires in a .survivors.test.ts file too", () => {
		const content = [
			"// test-contract: security — kills the >= to > mutant",
			"it('covered', () => {});",
			"",
			"",
			"",
			"it('not covered', () => {});",
		].join("\n");
		const matches = detectTestContractAnnotation(content, SURVIVORS_FILE);
		expect(matches.length).toBe(1);
	});

	it("N1: every it( block has a test-contract: comment within 3 lines above it — does not fire", () => {
		const content = [
			"// test-contract: invariant — parseWindow rejects a zero-width interval",
			"it('rejects a zero-width interval', () => {",
			"  expect(parseWindow(0, 0)).toBeNull();",
			"});",
			"",
			"// test-contract: boundary — parseWindow accepts a positive interval",
			"it('accepts a positive interval', () => {",
			"  expect(parseWindow(0, 1)).not.toBeNull();",
			"});",
		].join("\n");
		const matches = detectTestContractAnnotation(content, MUTATION_KILL_FILE);
		expect(matches).toEqual([]);
	});

	it("N2: a file that never adopted the test-contract: convention does not fire, even with bare it( blocks", () => {
		const content = [
			"it('rejects a zero-width interval', () => {",
			"  expect(parseWindow(0, 0)).toBeNull();",
			"});",
			"",
			"it('accepts a positive interval', () => {",
			"  expect(parseWindow(0, 1)).not.toBeNull();",
			"});",
		].join("\n");
		const matches = detectTestContractAnnotation(content, MUTATION_KILL_FILE);
		expect(matches).toEqual([]);
	});

	it("N3: a non-test file does not fire, even with adopted markers and bare it( blocks", () => {
		const content = [
			"// test-contract: invariant — example",
			"it('does something', () => {});",
		].join("\n");
		const matches = detectTestContractAnnotation(content, "src/example.ts");
		expect(matches).toEqual([]);
	});

	it("N4: a multi-line marker comment block (no blank line) covers the it( directly below it, regardless of the block's length — the adjacent-comment-block fix", () => {
		const content = [
			"// test-contract: public-api — the module's own doc comment explains",
			"// this at length, spanning several lines of rationale before the",
			"// actual call, exactly like this repo's real mutation-kill files do.",
			"it('is covered by a multi-line marker comment block', () => {",
			"  expect(true).toBe(true);",
			"});",
		].join("\n");
		const matches = detectTestContractAnnotation(content, MUTATION_KILL_FILE);
		expect(matches).toEqual([]);
	});

	it("P7: a blank line between the marker and the it( breaks contiguity — fires", () => {
		const content = [
			"// test-contract: invariant — separated from its block by a blank line",
			"",
			"it('is NOT covered — the blank line breaks the comment block', () => {",
			"  expect(true).toBe(true);",
			"});",
		].join("\n");
		const matches = detectTestContractAnnotation(content, MUTATION_KILL_FILE);
		expect(matches.length).toBe(1);
	});

	it("P5: a test-contract: marker 4 lines above is out of the window — fires", () => {
		const content = [
			"// test-contract: invariant — this file has adopted the convention",
			"",
			"",
			"",
			"it('is four lines below the marker', () => {",
			"  expect(true).toBe(true);",
			"});",
		].join("\n");
		const matches = detectTestContractAnnotation(content, MUTATION_KILL_FILE);
		expect(matches.length).toBe(1);
	});

	it("N8: a dotted RegExp.prototype.test call is never counted as a block opener — the dotted-test calibration fix", () => {
		const content = [
			"// test-contract: invariant — isTestFile recognizes .test.ts/.spec.ts",
			"const isTestFile = (f) => /\\.(test|spec)\\.tsx?$/.test(f);",
			"",
			"it('classifies a .test.ts path', () => {",
			"  expect(isTestFile('a.test.ts')).toBe(true);",
			"});",
		].join("\n");
		const matches = detectTestContractAnnotation(content, MUTATION_KILL_FILE);
		// Exactly ONE finding, at the REAL it() block (line 4) — not two (which
		// would mean the RegExp.prototype.test(f) call on line 2 was
		// misidentified as a second, phantom block opener).
		expect(matches.length).toBe(1);
		expect(matches[0]?.line).toBe(4);
	});

	it("N7: a file with only one marker among many it() blocks (spot usage, not systematic adoption) does not fire — the density calibration fix", () => {
		const lines: string[] = ["// test-contract: invariant — the one case that got a marker"];
		for (let i = 0; i < 10; i++) {
			lines.push(`it('case ${i}', () => {`, "  expect(true).toBe(true);", "});", "");
		}
		const matches = detectTestContractAnnotation(lines.join("\n"), MUTATION_KILL_FILE);
		expect(matches).toEqual([]);
	});

	it("P6: a file where at least half the it() blocks are marked still flags the unmarked half", () => {
		const content = [
			"// test-contract: invariant — case one",
			"it('case one', () => {",
			"  expect(true).toBe(true);",
			"});",
			"",
			"it('case two, no marker', () => {",
			"  expect(true).toBe(true);",
			"});",
		].join("\n");
		const matches = detectTestContractAnnotation(content, MUTATION_KILL_FILE);
		expect(matches.length).toBe(1);
	});

	it("N6: a prose comment that merely MENTIONS it()/test( does not count as a block opener — the calibration fix", () => {
		const content = [
			"// test-contract: invariant — every it() below is annotated per the convention",
			"// this comment mentions it() and test( in prose, not as a real call",
			"it('is covered by the marker two lines up', () => {",
			"  expect(true).toBe(true);",
			"});",
		].join("\n");
		const matches = detectTestContractAnnotation(content, MUTATION_KILL_FILE);
		expect(matches).toEqual([]);
	});

	it("N5: an ORDINARY test file (not mutation-directed) never fires, even with a marker and an unmarked block — the calibration fix", () => {
		const content = [
			"// test-contract: behavior — this file spot-uses the convention once",
			"it('is covered by the marker above', () => {});",
			"",
			"it('has no marker at all, and this file is not mutation-directed', () => {});",
		].join("\n");
		const matches = detectTestContractAnnotation(content, ORDINARY_TEST_FILE);
		expect(matches).toEqual([]);
	});
});
