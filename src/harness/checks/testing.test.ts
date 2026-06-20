// Behavioral tests for the testing-specific inline checks:
// - checkSnapshotOveruse (5+ snapshot assertions in a test file)
// - checkTestImportingTest (test importing from another test file)
// - checkExcessiveUseEffect (6+ useEffect hooks in a React component)
//
// Each detector is driven with code-string fixtures and asserted against
// the real findings it returns. Every branch (test-file gate, extension
// gate, the toMatchSnapshot/toMatchInlineSnapshot OR, the count threshold,
// the tsx/jsx AND) is exercised positive + negative.

import { describe, expect, it } from "vitest";
import {
	checkExcessiveUseEffect,
	checkSnapshotOveruse,
	checkTestImportingTest,
} from "./testing.js";
import { nonNull } from "../../lib/non-null.js";

// A genuine JS/TS test path that isStrictTestFile recognizes, but which is
// NOT under any harness-internal data tree, so the broad/strict split is
// irrelevant for these fixtures.
const TEST_TS = "src/feature/widget.test.ts";
const TEST_JS = "src/feature/widget.test.js";
const SPEC_TSX = "src/feature/widget.spec.tsx";

// =====================================================================
// checkSnapshotOveruse
// =====================================================================
describe("checkSnapshotOveruse", () => {
	function fiveSnapshots(call: string): string {
		return Array.from({ length: 5 }, (_, i) => `\texpect(v${i}).${call}();`).join("\n");
	}

	it("fires once with the count + first-line anchor at exactly 5 toMatchSnapshot calls", () => {
		const content = fiveSnapshots("toMatchSnapshot");
		const matches = checkSnapshotOveruse(content, TEST_TS);
		expect(matches).toHaveLength(1);
		// Anchored on the FIRST snapshot line (line 1 here).
		expect(nonNull(matches[0]).line).toBe(1);
		expect(nonNull(matches[0]).text).toContain("5 snapshot assertions");
		expect(nonNull(matches[0]).text).toContain("Use explicit assertions");
		// The first matching line's trimmed text is appended after the bracket.
		expect(nonNull(matches[0]).text).toContain("expect(v0).toMatchSnapshot();");
	});

	it("fires for toMatchInlineSnapshot (the second arm of the || )", () => {
		const content = fiveSnapshots("toMatchInlineSnapshot");
		const matches = checkSnapshotOveruse(content, TEST_TS);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("5 snapshot assertions");
	});

	it("counts a mix of toMatchSnapshot and toMatchInlineSnapshot toward the threshold", () => {
		const content = [
			"expect(a).toMatchSnapshot();",
			"expect(b).toMatchInlineSnapshot();",
			"expect(c).toMatchSnapshot();",
			"expect(d).toMatchInlineSnapshot();",
			"expect(e).toMatchSnapshot();",
		].join("\n");
		const matches = checkSnapshotOveruse(content, TEST_TS);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("5 snapshot assertions");
	});

	it("reports a higher count and anchors on the true first occurrence (later line)", () => {
		const content = [
			"// header comment, no snapshot",
			"const setup = 1;",
			"expect(a).toMatchSnapshot();", // line 3 — first occurrence
			"expect(b).toMatchSnapshot();",
			"expect(c).toMatchSnapshot();",
			"expect(d).toMatchSnapshot();",
			"expect(e).toMatchSnapshot();",
			"expect(f).toMatchSnapshot();",
		].join("\n");
		const matches = checkSnapshotOveruse(content, TEST_TS);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).line).toBe(3);
		expect(nonNull(matches[0]).text).toContain("6 snapshot assertions");
	});

	it("does NOT fire below the threshold (4 snapshots)", () => {
		const content = Array.from(
			{ length: 4 },
			(_, i) => `expect(v${i}).toMatchSnapshot();`,
		).join("\n");
		expect(checkSnapshotOveruse(content, TEST_TS)).toEqual([]);
	});

	it("returns [] for a non-test file even with many snapshots", () => {
		const content = fiveSnapshots("toMatchSnapshot");
		// Plain source path — isStrictTestFile is false and it's not under a
		// harness-internal data tree, so isTestFile is false.
		expect(checkSnapshotOveruse(content, "src/feature/widget.ts")).toEqual([]);
	});

	it("returns [] for a test file with a non-JS/TS extension", () => {
		const content = fiveSnapshots("toMatchSnapshot");
		// test_*.py is a recognized test file, but .py is not in JS_TS_ALL_EXTS.
		expect(checkSnapshotOveruse(content, "tests/test_widget.py")).toEqual([]);
	});

	it("truncates the appended anchor text to 150 chars", () => {
		// The line is `expect(<x...>).toMatchSnapshot();`. The anchor is the
		// FIRST matching line trimmed and sliced to 150 chars, so only the
		// leading 150 chars of that line survive (here `expect(` + 143 x's).
		const long = `expect(${"x".repeat(400)}).toMatchSnapshot();`;
		const content = Array.from({ length: 5 }, () => long).join("\n");
		const matches = checkSnapshotOveruse(content, TEST_TS);
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("5 snapshot assertions");
		// The appended snippet starts with "expect(" then x's, capped so the
		// whole sliced line is 150 chars (143 x's). 144 x's must NOT appear.
		expect(nonNull(matches[0]).text.includes(`expect(${"x".repeat(143)}`)).toBe(true);
		expect(nonNull(matches[0]).text.includes("x".repeat(144))).toBe(false);
	});

	it("returns [] for a test file with no snapshot calls at all", () => {
		const content = "expect(value).toBe(1);\nexpect(other).toEqual({});";
		expect(checkSnapshotOveruse(content, TEST_TS)).toEqual([]);
	});
});

// =====================================================================
// checkTestImportingTest
// =====================================================================
describe("checkTestImportingTest", () => {
	// BEHAVIORAL REALITY: the detector regex
	//   /(?:import|require)\s*\(?['"]\S*\.(?:test|spec)\./
	// is matched against the line AFTER stripCommentsAndStrings(), which
	// blanks the *contents* of every string literal. So `import "./x.test.js"`
	// becomes `import ""` and `require("./x.test.js")` becomes `require("")`
	// before the regex ever sees it — the `.test.`/`.spec.` token never
	// survives stripping. The detector therefore returns [] for ALL inputs
	// that reach the scan. The tests below assert that real behavior and the
	// two early-return gates (non-test file, non-JS/TS extension).
	//
	// (See "Note on untestable lines" in the task report: the scanLinesStripped
	// match arm is unreachable through this caller because of string stripping.)
	it("returns [] for a would-be-positive import — the path is stripped before the regex", () => {
		const content = `import "./other.test.js";\nconst x = 1;`;
		expect(checkTestImportingTest(content, TEST_TS)).toEqual([]);
	});

	it("returns [] for require() of a .test file — string contents are stripped", () => {
		const content = `const h = require("./fixtures.test.js");`;
		expect(checkTestImportingTest(content, TEST_JS)).toEqual([]);
	});

	it("returns [] for a named import from a .test file", () => {
		const content = `import { helper } from "./other.test.js";`;
		expect(checkTestImportingTest(content, TEST_TS)).toEqual([]);
	});

	it("returns [] for a side-effect import of a normal (non-test) module", () => {
		const content = `import "./module.js";\nimport "./other.ts";`;
		expect(checkTestImportingTest(content, TEST_TS)).toEqual([]);
	});

	it("returns [] when the .test reference is inside a comment (stripped first)", () => {
		const content = `// import "./old.test.js"\nconst y = 2;`;
		expect(checkTestImportingTest(content, TEST_TS)).toEqual([]);
	});

	it("returns [] for a non-test file (first gate)", () => {
		const content = `import "./other.test.js";`;
		expect(checkTestImportingTest(content, "src/feature/widget.ts")).toEqual([]);
	});

	it("returns [] for a test file with a non-JS/TS extension (second gate)", () => {
		const content = `require("./other.test.js")`;
		expect(checkTestImportingTest(content, "tests/widget_test.go")).toEqual([]);
	});
});

// =====================================================================
// checkExcessiveUseEffect
// =====================================================================
describe("checkExcessiveUseEffect", () => {
	function nEffects(n: number): string {
		const body = Array.from(
			{ length: n },
			(_, i) => `\tuseEffect(() => { doThing(${i}); }, []);`,
		).join("\n");
		return `function Component() {\n${body}\n\treturn null;\n}`;
	}

	it("fires at exactly 6 useEffect hooks in a .tsx file", () => {
		const matches = checkExcessiveUseEffect(nEffects(6), "src/Component.tsx");
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("6 useEffect hooks");
		expect(nonNull(matches[0]).text).toContain("consider custom hooks or consolidating");
	});

	it("anchors on the FIRST useEffect line and reports it only once", () => {
		const matches = checkExcessiveUseEffect(nEffects(7), "src/Component.tsx");
		expect(matches).toHaveLength(1);
		// function line is 1, first useEffect is line 2.
		expect(nonNull(matches[0]).line).toBe(2);
		expect(nonNull(matches[0]).text).toContain("7 useEffect hooks");
	});

	it("fires on .jsx files too (the second arm of the ext check)", () => {
		const matches = checkExcessiveUseEffect(nEffects(6), "src/Component.jsx");
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("6 useEffect hooks");
	});

	it("does NOT fire below the threshold (5 useEffect hooks)", () => {
		expect(checkExcessiveUseEffect(nEffects(5), "src/Component.tsx")).toEqual([]);
	});

	it("does NOT fire on zero useEffect hooks", () => {
		const content = `function Component() { return null; }`;
		expect(checkExcessiveUseEffect(content, "src/Component.tsx")).toEqual([]);
	});

	it("returns [] for a non-tsx/jsx extension even with many useEffect calls", () => {
		// .ts is not .tsx/.jsx — the ext gate returns [].
		expect(checkExcessiveUseEffect(nEffects(6), "src/Component.ts")).toEqual([]);
	});

	it("returns [] for a test file (test-file gate wins before the ext check)", () => {
		// A .tsx test file with 6+ useEffect — isTestFile short-circuits.
		expect(checkExcessiveUseEffect(nEffects(6), SPEC_TSX)).toEqual([]);
	});

	it("truncates the appended anchor text to 100 chars", () => {
		const longCall = `\tuseEffect(() => { ${"z".repeat(300)} }, []);`;
		const body = Array.from({ length: 6 }, () => longCall).join("\n");
		const content = `function C() {\n${body}\n}`;
		const matches = checkExcessiveUseEffect(content, "src/Component.tsx");
		expect(matches).toHaveLength(1);
		expect(nonNull(matches[0]).text).toContain("6 useEffect hooks");
		// The appended snippet is sliced to 100 chars.
		expect(nonNull(matches[0]).text.includes("z".repeat(101))).toBe(false);
	});
});
