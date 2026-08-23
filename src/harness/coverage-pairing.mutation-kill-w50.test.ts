import { describe, expect, it } from "vitest";
import {
	TEST_INFIX_RX,
	expectedCompanionTest,
	expectedSourceOfTest,
	inSamePair,
	pairStem,
} from "./coverage-pairing.js";

describe("pairStem — positive (must fire correctly)", () => {
	it("P1: strips a co-located test infix + extension down to the shared stem", () => {
		expect(pairStem("src/foo.ts")).toBe("src/foo");
		expect(pairStem("src/foo.test.ts")).toBe("src/foo");
	});

	it("P2: does not strip a test-infix-shaped substring that is not anchored at the end", () => {
		// ".test.tsx" is followed by more chars (".orig"), so the anchored
		// regex must NOT match it — an anchor-loss mutant would strip it.
		expect(pairStem("foo.test.tsx.orig")).toBe("foo.test.tsx.orig");
	});

	it("P3: strips a .test.mjs infix (m must stay inside the optional [cm] class)", () => {
		// A negated-class mutant ([^cm]?) would fail to match ".test.mjs" and
		// leave the infix in place, only stripping the trailing extension.
		expect(pairStem("foo.test.mjs")).toBe("foo");
	});

	it("P4: does not strip an extension-shaped substring that is not anchored at the end", () => {
		expect(pairStem("foo.ts.bak")).toBe("foo.ts.bak");
	});

	it("P5: strips a .cjs extension (c must stay inside the optional [cm] class)", () => {
		expect(pairStem("foo.cjs")).toBe("foo");
	});
});

describe("TEST_INFIX_RX — positive/negative (must fire correctly)", () => {
	it("P1: does not match a .test.<ext> infix that is not anchored at the end", () => {
		expect(TEST_INFIX_RX.test("foo.test.ts.bak")).toBe(false);
	});

	it("P2: matches a .test.mjs infix (m stays inside the optional [cm] class)", () => {
		expect(TEST_INFIX_RX.test("foo.test.mjs")).toBe(true);
	});
});

describe("expectedCompanionTest — positive (must fire correctly)", () => {
	it("P1: inserts .test before the anchored extension", () => {
		expect(expectedCompanionTest("src/foo.ts")).toBe("src/foo.test.ts");
	});

	it("P2: leaves an extension-shaped substring alone when not anchored at the end", () => {
		expect(expectedCompanionTest("foo.ts.bak")).toBe("foo.ts.bak");
	});
});

describe("expectedSourceOfTest — positive/negative (must fire correctly)", () => {
	it("P1: strips the .test infix, keeping the extension", () => {
		expect(expectedSourceOfTest("src/foo.test.ts")).toBe("src/foo.ts");
	});

	it("P2: does not strip a .test infix that is not anchored at the end", () => {
		expect(expectedSourceOfTest("foo.test.ts.bak")).toBe("foo.test.ts.bak");
	});

	it("P3: strips a .test.mjs infix (m stays inside the optional [cm] class)", () => {
		expect(expectedSourceOfTest("foo.test.mjs")).toBe("foo.mjs");
	});
});

describe("inSamePair — positive/negative (must fire correctly)", () => {
	it("N1: two unrelated non-test siblings in the same dir are not paired", () => {
		expect(inSamePair("src/foo-bar.ts", "src/foo.ts")).toBe(false);
	});

	it("P1: a decomposed source is paired with its umbrella test (source first)", () => {
		expect(inSamePair("src/foo-bar.ts", "src/foo.test.ts")).toBe(true);
	});

	it("P2: a decomposed source is paired with its umbrella test (test first)", () => {
		expect(inSamePair("src/foo.test.ts", "src/foo-bar.ts")).toBe(true);
	});

	it("N2: two test files in the same dir with different stems are not paired", () => {
		expect(inSamePair("src/bar-x.test.ts", "src/bar.test.ts")).toBe(false);
	});

	it("N3: files in different directories are never paired", () => {
		expect(inSamePair("src/foo-bar.ts", "other/foo.test.ts")).toBe(false);
	});

	it("P3: a __tests__ umbrella directory pairs with its sibling directory's decomposed source", () => {
		expect(inSamePair("/__tests__/foo-extra.ts", "foo.test.ts")).toBe(true);
	});

	it("P4: bare (no-directory) decomposed source pairs with bare umbrella test", () => {
		expect(inSamePair("foo-bar.ts", "foo.test.ts")).toBe(true);
	});

	it("P5: a leading-slash source at dir-boundary pairs correctly with a bare test", () => {
		expect(inSamePair("/foo-bar.ts", "foo.test.ts")).toBe(true);
	});

	it("N4: a __tests__-shaped substring not anchored at the end of the directory must not be stripped", () => {
		// dir("foo/__tests__bar/x-y.ts") stays "foo/__tests__bar" (unanchored
		// stripping would collapse it to "foobar", coincidentally matching the
		// other side's directory and wrongly pairing them).
		expect(inSamePair("foo/__tests__bar/x-y.ts", "foobar/x.test.ts")).toBe(false);
	});
});
