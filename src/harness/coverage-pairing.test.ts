// Direct tests for the extracted pairing primitives. (coverage-debt.test.ts
// keeps exercising them through the re-export and the debt rule itself.)
import { describe, expect, it } from "vitest";
import {
	expectedCompanionTest,
	expectedSourceOfTest,
	inSamePair,
	pairStem,
	TEST_INFIX_RX,
} from "./coverage-pairing.js";

describe("pairStem", () => {
	it("maps a source and its co-located test to the same stem", () => {
		expect(pairStem("src/foo.ts")).toBe("src/foo");
		expect(pairStem("src/foo.test.ts")).toBe("src/foo");
	});

	it("keeps unrelated files distinct", () => {
		expect(pairStem("src/foo.ts")).not.toBe(pairStem("src/bar.ts"));
	});
});

describe("inSamePair", () => {
	it("pairs a source with its sibling test", () => {
		expect(inSamePair("src/foo.ts", "src/foo.test.ts")).toBe(true);
	});

	it("pairs a decomposed sibling with its umbrella test in __tests__/", () => {
		expect(inSamePair("src/h/__tests__/guards.test.ts", "src/h/guards-quality.ts")).toBe(true);
	});

	it("pairs a decomposed sibling with a co-located umbrella test", () => {
		expect(inSamePair("src/h/guards.test.ts", "src/h/guards-quality.ts")).toBe(true);
	});

	it("does NOT pair two sources sharing only a hyphen prefix", () => {
		expect(inSamePair("src/h/guards.ts", "src/h/guards-quality.ts")).toBe(false);
	});

	it("does NOT pair across directories", () => {
		expect(inSamePair("src/a/foo.test.ts", "src/b/foo-extra.ts")).toBe(false);
	});

	it("does NOT pair unrelated files", () => {
		expect(inSamePair("src/foo.ts", "src/bar.test.ts")).toBe(false);
	});
});

describe("expected companion derivations", () => {
	it("derives the co-located test path for a source", () => {
		expect(expectedCompanionTest("src/foo.ts")).toBe("src/foo.test.ts");
		expect(expectedCompanionTest("src/foo.mjs")).toBe("src/foo.test.mjs");
	});

	it("derives the source path for a test without double-infixing", () => {
		expect(expectedSourceOfTest("src/foo.test.ts")).toBe("src/foo.ts");
		expect(expectedSourceOfTest("src/foo.spec.tsx")).toBe("src/foo.tsx");
	});

	it("TEST_INFIX_RX matches only the test side", () => {
		expect(TEST_INFIX_RX.test("src/foo.test.ts")).toBe(true);
		expect(TEST_INFIX_RX.test("src/foo.ts")).toBe(false);
	});
});
