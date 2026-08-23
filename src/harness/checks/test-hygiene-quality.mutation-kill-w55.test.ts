import { describe, expect, it } from "vitest";
import {
	checkDuplicateTestNames,
	checkMockingTheSutSelf,
	checkTestMissingSutImport,
} from "./test-hygiene-quality.js";

describe("checkMockingTheSutSelf — positive (must fire)", () => {
	// test-contract: public-api — checkMockingTheSutSelf must flag vi.mock of
	// the sibling SUT resolved via mockTargetIsSut's extension-stripped compare.
	it("flags vi.mock of a sibling SUT with a JS extension in the specifier", () => {
		const content = 'vi.mock("./foo.js");\nit("x", () => {});';
		const result = checkMockingTheSutSelf(content, "foo.test.ts");
		expect(result).toHaveLength(1);
		expect(result[0]?.text).toContain("./foo.js");
	});

	// test-contract: public-api — same behavior with a .ts extension SUT.
	it("flags vi.mock of the sibling SUT with a .ts extension", () => {
		const content = 'vi.mock("./widget.ts");\nit("renders", () => {});';
		const result = checkMockingTheSutSelf(content, "widget.test.ts");
		expect(result).toHaveLength(1);
	});
});

describe("checkMockingTheSutSelf — negative (must not fire)", () => {
	// test-contract: boundary — the returned array must be genuinely empty
	// (length 0), not an array pre-seeded with a placeholder element; kills
	// an ArrayDeclaration mutant on the `matches` accumulator's initializer.
	it("returns exactly [] (not a truthy placeholder) when the mock target is a different module", () => {
		const content = 'vi.mock("./bar.js");\nit("x", () => {});';
		const result = checkMockingTheSutSelf(content, "foo.test.ts");
		expect(result).toEqual([]);
		expect(result).toHaveLength(0);
	});

	// test-contract: boundary — same emptiness guarantee with zero mock calls
	// present at all, isolating the accumulator's initial state.
	it("returns exactly [] when the file has no mock calls at all", () => {
		const content = 'it("x", () => { expect(1).toBe(1); });';
		const result = checkMockingTheSutSelf(content, "foo.test.ts");
		expect(result).toEqual([]);
		expect(result).toHaveLength(0);
	});

	// test-contract: bug — regression for the 2026-06-12 basename-only FP:
	// mockTargetIsSut must treat "../commands/foo.js" as NOT the sibling
	// "./foo.ts" SUT (rel.includes("/") guard against cross-directory paths).
	it("distinguishes a same-name module in a different directory from the true sibling SUT", () => {
		const content = 'vi.mock("../commands/foo.js");\nit("x", () => {});';
		const result = checkMockingTheSutSelf(content, "foo.test.ts");
		expect(result).toEqual([]);
	});
});

describe("checkMockingTheSutSelf — positive (must fire), extension normalization", () => {
	// test-contract: invariant — mockTargetIsSut's extension-stripping replace
	// must remove the extension entirely (empty replacement), not append
	// literal text: "foo.js" must reduce to exactly "foo" to match sutBase.
	it("the extension-stripping replace produces an exact basename match, not a suffix-appended one", () => {
		const content = 'jest.mock("./foo.js");\nit("x", () => {});';
		const result = checkMockingTheSutSelf(content, "foo.test.ts");
		expect(result).toHaveLength(1);
		expect(result[0]?.text).toContain("test mocks the system under test");
	});
});

describe("checkDuplicateTestNames — positive (must fire)", () => {
	// test-contract: public-api — two it() blocks sharing a name in the same
	// describe scope are flagged as duplicates.
	it("flags two it() blocks with the same name in the same describe scope", () => {
		const content =
			'describe("A", () => { it("x", () => {}); it("x", () => {}); });';
		const result = checkDuplicateTestNames(content, "foo.test.ts");
		expect(result).toHaveLength(1);
		expect(result[0]?.text).toContain('duplicate test name "x"');
	});
});

describe("checkDuplicateTestNames — negative (must not fire)", () => {
	// test-contract: boundary — distinct names in one scope must yield a
	// genuinely empty array, not a pre-seeded placeholder element.
	it("returns exactly [] when a describe scope has two differently-named cases", () => {
		const content =
			'describe("A", () => { it("x", () => {}); it("y", () => {}); });';
		const result = checkDuplicateTestNames(content, "foo.test.ts");
		expect(result).toEqual([]);
		expect(result).toHaveLength(0);
	});

	// test-contract: invariant — sibling describe scopes may reuse the same
	// test name (vitest reports "A > x" vs "B > x" unambiguously).
	it("returns exactly [] when the same test name appears in two sibling describe scopes", () => {
		const content =
			'describe("A", () => { it("x", () => {}); });\n' +
			'describe("B", () => { it("x", () => {}); });';
		const result = checkDuplicateTestNames(content, "foo.test.ts");
		expect(result).toEqual([]);
		expect(result).toHaveLength(0);
	});
});

describe("checkTestMissingSutImport — negative (must not fire)", () => {
	// test-contract: public-api — a test file importing its own SUT is clear.
	it("returns exactly [] when the file imports its SUT", () => {
		const content = 'import { foo } from "./foo.js";\nit("x", () => { foo(); });';
		const result = checkTestMissingSutImport(content, "foo.test.ts");
		expect(result).toEqual([]);
	});
});

describe("checkTestMissingSutImport — positive (must fire)", () => {
	// test-contract: public-api — a test file with no import resembling its
	// SUT basename, and no other project-source import, must be flagged.
	it("flags a test file that imports nothing resembling its SUT", () => {
		const content = "const x = 1;";
		const result = checkTestMissingSutImport(content, "foo.test.ts");
		expect(result).toHaveLength(1);
		expect(result[0]?.text).toContain("./foo");
	});
});
