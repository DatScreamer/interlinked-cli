// Tests for labeled-test-case extraction.
//
// Dogfoods the contract this module enforces: cases below are labeled in both
// directions, and the negatives pin the shapes that must NOT be counted as
// evidence (unlabeled tests, comments, nested blocks).

import { describe, expect, it } from "vitest";
import { countCases, directionFromTitle, parseLabeledCases } from "./case-parser.js";

describe("directionFromTitle — positive (must classify as positive)", () => {
	it("P1: reads an explicit P-prefix", () => {
		expect(directionFromTitle("P1: inline Date.parse with no guard")).toBe("positive");
	});

	it("P2: reads 'must fire' prose", () => {
		expect(directionFromTitle("positive (must fire)")).toBe("positive");
	});

	it("P3: reads 'detects' prose", () => {
		expect(directionFromTitle("detects a raw SQL concat")).toBe("positive");
	});
});

describe("directionFromTitle — negative (must classify as negative or null)", () => {
	it("N1: 'must not fire' is never read as positive", () => {
		expect(directionFromTitle("negative (must not fire)")).toBe("negative");
	});

	it("N2: 'does not fire' is negative even though it contains 'fire'", () => {
		expect(directionFromTitle("does not fire when guarded")).toBe("negative");
	});

	it("N3: an N-prefix wins over positive-sounding prose", () => {
		expect(directionFromTitle("N4: detects nothing when the guard is present")).toBe("negative");
	});

	it("N4: an unlabeled title yields null rather than a guess", () => {
		expect(directionFromTitle("returns an empty array for an empty file")).toBeNull();
	});
});

describe("parseLabeledCases — positive (must count)", () => {
	it("P1: counts tests inheriting a labeled describe", () => {
		const src = `
describe("checkThing — positive (must fire)", () => {
	it("inline case", () => {});
	it("two-step case", () => {});
});
describe("checkThing — negative (must not fire)", () => {
	it("guarded case", () => {});
});
`;
		const counts = countCases(parseLabeledCases(src));
		expect(counts).toEqual({ positive: 2, negative: 1 });
	});

	it("P2: counts P/N prefixes with no labeled describe at all", () => {
		const src = `
describe("checkThing", () => {
	it("P1: fires here", () => {});
	it("N1: silent here", () => {});
});
`;
		expect(countCases(parseLabeledCases(src))).toEqual({ positive: 1, negative: 1 });
	});

	it("P3: a per-test prefix overrides the enclosing describe", () => {
		const src = `
describe("positive (must fire)", () => {
	it("fires", () => {});
	it("N9: counter-example tucked inside the positive block", () => {});
});
`;
		expect(countCases(parseLabeledCases(src))).toEqual({ positive: 1, negative: 1 });
	});

	it("P4: handles it.each and test() forms", () => {
		const src = `
describe("negative (must not fire)", () => {
	it.each([1, 2])("case %i", () => {});
	test("another silent case", () => {});
});
`;
		expect(countCases(parseLabeledCases(src)).negative).toBe(2);
	});

	it("P5: records 1-based line numbers", () => {
		const src = ['describe("positive (must fire)", () => {', '\tit("a", () => {});', "});"].join("\n");
		const cases = parseLabeledCases(src);
		expect(cases[0]?.line).toBe(2);
	});
});

describe("parseLabeledCases — negative (must NOT count)", () => {
	it("N1: unlabeled tests under an unlabeled describe are ignored", () => {
		const src = `
describe("checkThing", () => {
	it("returns an array", () => {});
	it("handles empty input", () => {});
});
`;
		expect(parseLabeledCases(src)).toEqual([]);
	});

	it("N2: commented-out tests are not counted", () => {
		const src = `
describe("positive (must fire)", () => {
	// it("disabled case", () => {});
	it("real case", () => {});
});
`;
		expect(countCases(parseLabeledCases(src)).positive).toBe(1);
	});

	it("N3: a label does not leak past its describe block", () => {
		const src = `
describe("positive (must fire)", () => {
	it("inside", () => {});
});
describe("unrelated helpers", () => {
	it("outside", () => {});
});
`;
		expect(countCases(parseLabeledCases(src))).toEqual({ positive: 1, negative: 0 });
	});

	it("N4: an empty source yields no cases", () => {
		expect(parseLabeledCases("")).toEqual([]);
	});

	it("N5: a file with only helpers and imports yields no cases", () => {
		const src = `
import { thing } from "./thing.js";
function helper(x: number): number {
	return x + 1;
}
`;
		expect(parseLabeledCases(src)).toEqual([]);
	});
});

describe("countCases", () => {
	it("returns zeroes for an empty list", () => {
		expect(countCases([])).toEqual({ positive: 0, negative: 0 });
	});
});
