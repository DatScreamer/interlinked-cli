import { describe, expect, it } from "vitest";
import {
	detectRemovedAssertions,
	evaluateMutationDirectedSignals,
	isMutationDirectedFile,
	type MutationDirectedProfileArgs,
	REMOVED_ASSERTION_CHECK_ID,
} from "./mutation-directed-profile.js";

const MUTATION_PATH = "src/lib/widget.mutation-kill.test.ts";
const ORDINARY_PATH = "src/lib/widget.test.ts";
const CONTRACT = "// test-contract: invariant — result must be truthy after processing";

function args(overrides: Partial<MutationDirectedProfileArgs> & { content: string }): MutationDirectedProfileArgs {
	return { filePath: MUTATION_PATH, baselineContent: null, ...overrides };
}

describe("isMutationDirectedFile", () => {
	it("P1: matches .mutation-kill., .mutation-hardening., .survivor., .survivors.", () => {
		expect(isMutationDirectedFile("a/b.mutation-kill.test.ts")).toBe(true);
		expect(isMutationDirectedFile("a/b.mutation-hardening.test.ts")).toBe(true);
		expect(isMutationDirectedFile("a/b.survivor.test.ts")).toBe(true);
		expect(isMutationDirectedFile("a/b.survivors.test.ts")).toBe(true);
	});

	it("N1: does not match an ordinary test file", () => {
		expect(isMutationDirectedFile(ORDINARY_PATH)).toBe(false);
	});
});

describe("evaluateMutationDirectedSignals — GATE 1 severity remap (reuses shipped detectors)", () => {
	it("N1: non-mutation-directed file yields no outcomes at all", () => {
		const found = evaluateMutationDirectedSignals(
			args({ filePath: ORDINARY_PATH, content: 'it("x", () => expect(1).toBeTruthy());' }),
		);
		expect(found).toEqual([]);
	});

	it("P1: a mutation-directed case with no contract marker is INTRODUCED (null baseline = strict)", () => {
		const [legitimacy] = evaluateMutationDirectedSignals(
			args({ content: 'it("covers the survivor", () => expect(render()).toEqual("Empty"));' }),
		);
		expect(legitimacy?.checkId).toBe("test_legitimacy");
		expect(legitimacy?.introduced.length).toBeGreaterThan(0);
	});

	it("N2: a receipt-missing case already on disk (identical baseline) is pre-existing, not introduced", () => {
		const content = 'it("covers the survivor", () => expect(render()).toEqual("Empty"));';
		const [legitimacy] = evaluateMutationDirectedSignals(args({ content, baselineContent: content }));
		expect(legitimacy?.introduced).toEqual([]);
		expect(legitimacy?.preexisting.length).toBeGreaterThan(0);
	});

	it("P2: test_missing_sut_import is escalated as its own introduced outcome", () => {
		const outcomes = evaluateMutationDirectedSignals(
			args({
				filePath: "src/lib/widget.mutation-kill.test.ts",
				content: `${CONTRACT}\nit("does a thing", () => expect(1).toEqual(1));`,
			}),
		);
		const sut = outcomes.find((o) => o.checkId === "test_missing_sut_import");
		expect(sut?.introduced.length).toBeGreaterThan(0);
	});

	it("P3: a toBeTruthy() that is the SOLE assertion in its test block escalates", () => {
		const content = [CONTRACT, 'it("case", () => {', "  expect(result).toBeTruthy();", "});"].join("\n");
		const [legitimacy] = evaluateMutationDirectedSignals(args({ content }));
		expect(legitimacy?.introduced.some((m) => m.text.includes("toBeTruthy"))).toBe(true);
	});

	it("N3: a toBeTruthy() alongside a real assertion in the same block does NOT escalate", () => {
		const content = [
			CONTRACT,
			'it("case", () => {',
			"  expect(result.ok).toBeTruthy();",
			"  expect(result.value).toEqual(42);",
			"});",
		].join("\n");
		const [legitimacy] = evaluateMutationDirectedSignals(args({ content }));
		expect(legitimacy?.introduced.some((m) => m.text.includes("toBeTruthy"))).toBe(false);
	});

	it("N4: an inline-ignored receipt-missing line is dropped, not introduced", () => {
		const content = [
			"// interlinked-ignore: test_legitimacy — deliberately undocumented smoke case",
			'it("smoke", () => expect(render()).toEqual("ok"));',
		].join("\n");
		const [legitimacy] = evaluateMutationDirectedSignals(args({ content }));
		expect(legitimacy?.introduced).toEqual([]);
	});
});

describe("detectRemovedAssertions — GATE 2 (new detection: assertion-removal delta)", () => {
	it("N1: non-mutation-directed file — a removed assertion is not flagged", () => {
		const baseline = 'it("x", () => {\n  expect(a).toBe(1);\n  expect(b).toBe(2);\n});';
		const proposed = 'it("x", () => {\n  expect(a).toBe(1);\n});';
		const found = detectRemovedAssertions(
			args({ filePath: ORDINARY_PATH, content: proposed, baselineContent: baseline }),
		);
		expect(found).toEqual([]);
	});

	it("N2: null baseline (new file) — nothing to have removed", () => {
		const found = detectRemovedAssertions(
			args({ content: 'it("x", () => expect(a).toBe(1));', baselineContent: null }),
		);
		expect(found).toEqual([]);
	});

	it("N3: pure addition — every baseline line survives, one new line added", () => {
		const baseline = 'it("x", () => {\n  expect(a).toBe(1);\n});';
		const proposed = 'it("x", () => {\n  expect(a).toBe(1);\n  expect(b).toBe(2);\n});';
		const found = detectRemovedAssertions(args({ content: proposed, baselineContent: baseline }));
		expect(found).toEqual([]);
	});

	it("N4: reordering two identical blocks — multiset match, nothing removed", () => {
		const baseline = [
			'it("first", () => expect(a).toBe(1));',
			'it("second", () => expect(b).toBe(2));',
		].join("\n");
		const proposed = [
			'it("second", () => expect(b).toBe(2));',
			'it("first", () => expect(a).toBe(1));',
		].join("\n");
		const found = detectRemovedAssertions(args({ content: proposed, baselineContent: baseline }));
		expect(found).toEqual([]);
	});

	it("P1: an entire test case (declaration + assertion) deleted", () => {
		const baseline = [
			'it("kept", () => expect(a).toBe(1));',
			'it("deleted", () => expect(b).toBe(2));',
		].join("\n");
		const proposed = 'it("kept", () => expect(a).toBe(1));';
		const found = detectRemovedAssertions(args({ content: proposed, baselineContent: baseline }));
		const lines = found.map((m) => m.text);
		expect(lines.some((t) => t.includes('"deleted"'))).toBe(true);
		expect(lines.some((t) => t.includes("expect(b)"))).toBe(true);
	});

	it("P2: the test survives but one of two assertion lines inside it is removed", () => {
		const baseline = 'it("x", () => {\n  expect(a).toBe(1);\n  expect(b).toBe(2);\n});';
		const proposed = 'it("x", () => {\n  expect(a).toBe(1);\n});';
		const found = detectRemovedAssertions(args({ content: proposed, baselineContent: baseline }));
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("expect(b)");
	});

	it("P3: multiset — two identical assertion lines in baseline, one survives, one reports removed", () => {
		const baseline = [
			'it("a", () => expect(shared()).toBe(1));',
			'it("b", () => expect(shared()).toBe(1));',
		].join("\n");
		const proposed = 'it("a", () => expect(shared()).toBe(1));';
		const found = detectRemovedAssertions(args({ content: proposed, baselineContent: baseline }));
		// One `it(...)` case line removed AND one of the two identical
		// `expect(shared()).toBe(1)` copies removed — the surplus copy, not
		// both (multiset semantics, mirroring splitIntroduced's own contract).
		const expectHits = found.filter((m) => m.text.includes("expect(shared())"));
		expect(expectHits).toHaveLength(1);
	});

	it("file-level suppression drops GATE 2 entirely for the file", () => {
		// projectRoot omitted ⇒ fileSuppressionsFor returns an empty set, so this
		// case only proves the REMOVED_ASSERTION_CHECK_ID constant is what a real
		// verify-suppressions.json entry would need to name; the loader itself is
		// exercised by pre-block-gate.test.ts / suppressions.test.ts.
		expect(REMOVED_ASSERTION_CHECK_ID).toBe("mutation_directed_assertion_removal");
	});
});
