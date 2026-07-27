// Tests for property-test candidate detection.
//
// Labeled per the Check Evidence Contract — a new check ships with its
// MUST-FIRE / MUST-NOT-FIRE cases and gets no grandfathering.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	companionTestPaths,
	findPropertyCandidates,
	looksImpure,
	PROPERTY_CANDIDATE_MIN_CYCLOMATIC,
	propertyCandidateCheck,
	usesPropertyTesting,
} from "./property-candidate.js";

let root: string;

function write(rel: string, content: string): string {
	const full = join(root, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content, "utf8");
	return full;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "prop-cand-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Pure, 2 args, 9 branches — a textbook property-test candidate. */
const ALGORITHMIC = `
export function classify(a: number, b: number): string {
	if (a < 0) return "neg-a";
	if (b < 0) return "neg-b";
	if (a === b) return "equal";
	if (a > b) return a % 2 === 0 ? "a-even" : "a-odd";
	if (b > a) return b % 2 === 0 ? "b-even" : "b-odd";
	for (let i = 0; i < a; i++) {
		if (i === b) return "crossed";
	}
	return "none";
}
`;

const PLAIN_TEST = 'import { classify } from "./m.js";\nit("works", () => { classify(1, 2); });';
const PROPERTY_TEST = 'import fc from "fast-check";\nit("holds", () => fc.assert(fc.property(fc.integer(), () => true)));';

describe("usesPropertyTesting", () => {
	it("detects fast-check imports", () => {
		expect(usesPropertyTesting('import fc from "fast-check";')).toBe(true);
	});

	it("detects fc.property usage without the import line", () => {
		expect(usesPropertyTesting("fc.property(gen, fn)")).toBe(true);
	});

	it("is false for an ordinary example-based test", () => {
		expect(usesPropertyTesting(PLAIN_TEST)).toBe(false);
	});
});

describe("looksImpure", () => {
	it("flags filesystem access", () => {
		expect(looksImpure("const x = readFileSync(p);")).toBe(true);
	});

	it("flags nondeterminism", () => {
		expect(looksImpure("return Math.random();")).toBe(true);
		expect(looksImpure("return Date.now();")).toBe(true);
	});

	it("is false for arithmetic", () => {
		expect(looksImpure("return a + b;")).toBe(false);
	});
});

describe("companionTestPaths", () => {
	it("covers the repo's test-file conventions", () => {
		const paths = companionTestPaths("src/harness/m.ts");
		expect(paths).toContain("src/harness/m.test.ts");
		expect(paths).toContain("src/harness/m.spec.ts");
		expect(paths).toContain("src/harness/m.integration.test.ts");
	});
});

describe("findPropertyCandidates", () => {
	it("finds a pure multi-arg branchy exported function", () => {
		const found = findPropertyCandidates(ALGORITHMIC, "src/m.ts");
		expect(found).toHaveLength(1);
		expect(found[0]?.name).toBe("classify");
		expect(found[0]?.cyclomatic).toBeGreaterThanOrEqual(PROPERTY_CANDIDATE_MIN_CYCLOMATIC);
	});

	it("ignores a non-exported function", () => {
		expect(findPropertyCandidates(ALGORITHMIC.replace("export ", ""), "src/m.ts")).toEqual([]);
	});
});

describe("propertyCandidateCheck — positive (must fire)", () => {
	it("P1: fires on a pure algorithmic function whose tests use no properties", () => {
		const src = write("src/m.ts", ALGORITHMIC);
		write("src/m.test.ts", PLAIN_TEST);
		const found = propertyCandidateCheck(ALGORITHMIC, src);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toMatch(/classify — pure, 2 args, \d+ branches/);
	});

	it("P2: anchors the finding at the function's line", () => {
		const src = write("src/m.ts", ALGORITHMIC);
		write("src/m.test.ts", PLAIN_TEST);
		expect(propertyCandidateCheck(ALGORITHMIC, src)[0]?.line).toBe(2);
	});

	it("P3: reports each qualifying function separately", () => {
		const two = `${ALGORITHMIC}\n${ALGORITHMIC.replace("classify", "classifyTwo")}`;
		const src = write("src/m.ts", two);
		write("src/m.test.ts", PLAIN_TEST);
		expect(propertyCandidateCheck(two, src)).toHaveLength(2);
	});

	it("P4: accepts an .integration.test companion as the module's tests", () => {
		const src = write("src/m.ts", ALGORITHMIC);
		write("src/m.integration.test.ts", PLAIN_TEST);
		expect(propertyCandidateCheck(ALGORITHMIC, src)).toHaveLength(1);
	});
});

describe("propertyCandidateCheck — negative (must NOT fire)", () => {
	it("N1: silent when the module's tests already use property testing", () => {
		const src = write("src/m.ts", ALGORITHMIC);
		write("src/m.test.ts", PROPERTY_TEST);
		expect(propertyCandidateCheck(ALGORITHMIC, src)).toEqual([]);
	});

	it("N2: silent when the module has no companion test at all", () => {
		// That is `no_test_file`'s finding; reporting it here double-counts.
		const src = write("src/m.ts", ALGORITHMIC);
		expect(propertyCandidateCheck(ALGORITHMIC, src)).toEqual([]);
	});

	it("N3: silent for an impure function", () => {
		const impure = `
export function loadAndClassify(a: number, b: number): string {
	const raw = readFileSync("/tmp/x", "utf8");
	if (a < 0) return "neg";
	if (b < 0) return "neg";
	if (a === b) return "eq";
	if (a > b) return "gt";
	if (raw.length > 3) return "long";
	if (raw.length > 2) return "mid";
	for (let i = 0; i < a; i++) if (i === b) return "x";
	return "none";
}
`;
		const src = write("src/m.ts", impure);
		write("src/m.test.ts", PLAIN_TEST);
		expect(propertyCandidateCheck(impure, src)).toEqual([]);
	});

	it("N4: silent for a simple function below the branch threshold", () => {
		const simple = "export function add(a: number, b: number): number { return a + b; }";
		const src = write("src/m.ts", simple);
		write("src/m.test.ts", PLAIN_TEST);
		expect(propertyCandidateCheck(simple, src)).toEqual([]);
	});

	it("N5: silent for a single-argument function", () => {
		const oneArg = ALGORITHMIC.replace("(a: number, b: number)", "(a: number)").replace(/b/g, "a");
		const src = write("src/m.ts", oneArg);
		write("src/m.test.ts", PLAIN_TEST);
		expect(propertyCandidateCheck(oneArg, src)).toEqual([]);
	});

	it("N6: silent on a test file itself", () => {
		const src = write("src/m.test.ts", ALGORITHMIC);
		expect(propertyCandidateCheck(ALGORITHMIC, src)).toEqual([]);
	});

	it("N7: silent on a non-JS/TS file", () => {
		const src = write("src/m.py", ALGORITHMIC);
		expect(propertyCandidateCheck(ALGORITHMIC, src)).toEqual([]);
	});
});
