import { describe, expect, it } from "vitest";
import {
	checkAssertionFreeTest,
	checkMockingTheSUT,
	checkPrivateMemberTestAccess,
	checkTautologicalAssertion,
} from "./taste-checks-test-assertions.js";

const TEST = "/repo/widget.test.ts";
const finding = (line: number, text: string) => [{ line, text }];

describe("tautological assertion survivor contracts", () => {
	// test-contract: invariant — all whitespace positions accepted by the public truthiness detector must produce
	// the exact source line. The `assert.ok` spelling is fixed (no spaces around the member dot — the detector's
	// `assert(?:\.ok)?` alternative is deliberately tight there); whitespace is accepted inside the call parens.
	it("flags whitespace-separated truthiness forms and assert.ok", () => {
		const content = [
			"expect ( true ) . toBeTruthy ( )",
			"expect ( false ) . toBeFalsy ( )",
			"assert.ok ( true )",
		].join("\n");
		expect(checkTautologicalAssertion(content, TEST)).toEqual([
			{ line: 1, text: "expect ( true ) . toBeTruthy ( )" },
			{ line: 2, text: "expect ( false ) . toBeFalsy ( )" },
			{ line: 3, text: "assert.ok ( true )" },
		]);
	});

	// test-contract: boundary — only exact same literals are tautological; opposite truthiness values remain clean.
	it("distinguishes equal and unequal literal operands", () => {
		const content = [
			'expect ( "same" ) . toEqual ( "same" )',
			"assert.deepEqual ( actual, actual )",
			"expect ( true ) . toBe ( false )",
			"assert.ok ( false )",
		].join("\n");
		expect(checkTautologicalAssertion(content, TEST)).toEqual([
			{ line: 1, text: 'expect ( "same" ) . toEqual ( "same" )' },
			{ line: 2, text: "assert.deepEqual ( actual, actual )" },
		]);
	});

	// test-contract: boundary — a non-test path is outside this detector's public contract even when input is a perfect tautology.
	it("returns no findings for non-test files", () => {
		expect(checkTautologicalAssertion("expect(true).toBeTruthy()", "/repo/widget.ts")).toEqual([]);
	});

	// test-contract: boundary — the detector has a hard ten-finding cap and must not emit an eleventh line.
	it("stops at exactly ten tautological lines", () => {
		const content = Array.from({ length: 11 }, (_, i) => `expect(v${i}).toBe(v${i})`).join("\n");
		expect(checkTautologicalAssertion(content, TEST)).toHaveLength(10);
		expect(checkTautologicalAssertion(content, TEST)[9]).toEqual(finding(10, "expect(v9).toBe(v9)")[0]);
	});
});

describe("mocking-the-SUT survivor contracts", () => {
	// test-contract: boundary — only test/spec files with a recognized terminal extension are eligible for SUT mocking findings.
	it("rejects non-test names and test-like names with trailing suffixes", () => {
		expect(checkMockingTheSUT('vi.mock("./widget")', "/repo/widget.ts")).toEqual([]);
		expect(checkMockingTheSUT('vi.mock("./widget")', "/repo/widget.test.ts.bak")).toEqual([]);
		expect(checkMockingTheSUT('vi.mock("./widget")', "/repo/widget.test.tsx")).toEqual(finding(1, 'vi.mock("./widget")'));
	});

	// test-contract: invariant — a same-directory relative import is the SUT, while parent and nested paths with the same basename are not.
	it("anchors same-directory matching at ./ and excludes other directories", () => {
		const content = [
			'vi.mock("./widget.js")',
			'vi.mock("../widget.js")',
			'vi.mock("./nested/widget.js")',
			'vi.mock("./widget.js?raw")',
		].join("\n");
		expect(checkMockingTheSUT(content, "/repo/widget.test.ts")).toEqual([finding(1, 'vi.mock("./widget.js")')[0]]);
	});

	// test-contract: boundary — the static mock scan preserves source line boundaries and reports the exact matching line.
	it("does not join adjacent lines into a false mock call", () => {
		const content = "vi\n.mock(\"./widget\")";
		expect(checkMockingTheSUT(content, TEST)).toEqual([]);
	});

	// test-contract: boundary — five is the inclusive maximum number of mock findings, with the sixth omitted.
	it("stops at exactly five mock findings", () => {
		const content = Array.from({ length: 6 }, () => 'jest.mock("./widget")').join("\n");
		const result = checkMockingTheSUT(content, TEST);
		expect(result).toHaveLength(5);
		expect(result[4]).toEqual(finding(5, 'jest.mock("./widget")')[0]);
	});
});

describe("private-member access survivor contracts", () => {
	// test-contract: boundary — test-file and JS/TS eligibility are both required; a production file and a non-JS test file are clean.
	it("requires both a test path and a JavaScript-family extension", () => {
		const source = "(service as any).privateField";
		expect(checkPrivateMemberTestAccess(source, "/repo/widget.ts")).toEqual([]);
		expect(checkPrivateMemberTestAccess(source, "/repo/widget.test.py")).toEqual([]);
		expect(checkPrivateMemberTestAccess(source, "/repo/widget.test.ts")).toEqual(finding(1, source));
	});

	// test-contract: invariant — unknown casts only violate when an accessor follows the cast, and the accessor tail determines exemptions.
	it("requires a post-cast accessor and preserves mock/global exemptions", () => {
		const content = [
			"const value = (service as unknown as Service)",
			"(service as unknown as Service).privateField",
			"(globalThis as unknown as GlobalThis).fetch",
			"(fetchMock as unknown as Mock).mock.calls",
		].join("\n");
		expect(checkPrivateMemberTestAccess(content, TEST)).toEqual([finding(2, "(service as unknown as Service).privateField")[0]]);
	});

	// test-contract: bug — only characters after the cast's closing parenthesis are considered for the accessor and exemption decision.
	it("does not let cast text before the close hide a private accessor", () => {
		const source = "(service as unknown as { mock: unknown }).privateField";
		expect(checkPrivateMemberTestAccess(source, TEST)).toEqual(finding(1, source));
	});

	// test-contract: boundary — ten private-access findings are reported and an eleventh is excluded at the exact cap.
	it("stops at exactly ten private-access findings", () => {
		const content = Array.from({ length: 11 }, (_, i) => `(service${i} as any).privateField`).join("\n");
		const result = checkPrivateMemberTestAccess(content, TEST);
		expect(result).toHaveLength(10);
		expect(result[9]).toEqual(finding(10, "(service9 as any).privateField")[0]);
	});
});

describe("assertion-free test survivor contracts", () => {
	// test-contract: boundary — the assertion-free detector has a strict ten-finding cap and must retain the tenth source line.
	it("stops at exactly ten assertion-free tests", () => {
		const content = Array.from({ length: 11 }, (_, i) => `it("case${i}", () => { work${i}(); });`).join("\n");
		const result = checkAssertionFreeTest(content, TEST);
		expect(result).toHaveLength(10);
		expect(result[9]).toEqual(finding(10, 'it("case9", () => { work9(); });')[0]);
	});

	// test-contract: invariant — multiline bodies are reconstructed with newline separators so a bare assert remains a recognized assertion.
	it("preserves a word boundary across multiline assertion bodies", () => {
		const content = ['it("asserted", () => {', "const value = 1", "assert(value)", "});"].join("\n");
		expect(checkAssertionFreeTest(content, TEST)).toEqual([]);
	});

	// test-contract: boundary — a smoke exemption is read from a chained test modifier with whitespace before its opening paren.
	it("reads smoke names through spaced modifier chains", () => {
		const content = ["test.concurrent (", '  "smoke test",', "  () => { setup(); }", ");"].join("\n");
		expect(checkAssertionFreeTest(content, TEST)).toEqual([]);
	});
});
