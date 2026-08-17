// Tests for the portability lint family (Plan 25 lane 6,
// docs/plans/25-refactor-readiness-program.md). See portability.ts for the
// detectors' design rationale, including the deliberate overlap with the
// pre_block `eval_usage` hard rail.

import { describe, expect, it } from "vitest";
import {
	detectBuiltinPrototypeMutation,
	detectDynamicCodeExecution,
	detectFloatEqualityComparison,
} from "./portability.js";

// A path outside harness/checks|rules|check-registry so isTestFile's
// harness-internal-data exemption never masks a positive case.
const SRC = "src/example.ts";
const TEST_SRC = "src/example.test.ts";

describe("detectDynamicCodeExecution", () => {
	it("P1: eval( with a variable argument fires", () => {
		const matches = detectDynamicCodeExecution("function run(cmd) {\n  return eval(cmd);\n}\n", SRC);
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0]?.text).toContain("dynamic_code_execution");
	});

	it("P2: new Function( fires", () => {
		const matches = detectDynamicCodeExecution(
			"const fn = new Function('a', 'b', 'return a + b');\n",
			SRC,
		);
		expect(matches.length).toBeGreaterThan(0);
	});

	it("P3: require( with a non-literal argument fires", () => {
		const matches = detectDynamicCodeExecution(
			"function load(modulePath) {\n  return require(modulePath);\n}\n",
			SRC,
		);
		expect(matches.length).toBeGreaterThan(0);
	});

	it("P4: import( with a computed argument fires", () => {
		const matches = detectDynamicCodeExecution(
			"async function load(name) {\n  return import(`./plugins/${name}.js`);\n}\n",
			SRC,
		);
		expect(matches.length).toBeGreaterThan(0);
	});

	it("N1: require( with a plain string literal does not fire", () => {
		const matches = detectDynamicCodeExecution(
			"const utils = require('./utils.js');\n",
			SRC,
		);
		expect(matches).toEqual([]);
	});

	it("N2: import( with a plain string literal does not fire", () => {
		const matches = detectDynamicCodeExecution(
			"async function load() {\n  return import('./utils.js');\n}\n",
			SRC,
		);
		expect(matches).toEqual([]);
	});

	it("N3: a method named eval on a receiver does not fire", () => {
		const matches = detectDynamicCodeExecution(
			"const result = mathParser.eval(expression);\n",
			SRC,
		);
		expect(matches).toEqual([]);
	});

	it("N4: eval( mentioned only in a comment does not fire", () => {
		const matches = detectDynamicCodeExecution(
			"// legacy code used to call eval(userInput) here, removed\nconst x = 1;\n",
			SRC,
		);
		expect(matches).toEqual([]);
	});

	it("N5: a non-JS/TS file does not fire regardless of content", () => {
		const matches = detectDynamicCodeExecution("eval(userInput)\n", "notes.md");
		expect(matches).toEqual([]);
	});

	it("N6: a test file does not fire (sandboxed-eval fixtures are common)", () => {
		const matches = detectDynamicCodeExecution(
			"it('sandboxes eval', () => {\n  expect(eval(trustedExpr)).toBe(2);\n});\n",
			TEST_SRC,
		);
		expect(matches).toEqual([]);
	});
});

describe("detectBuiltinPrototypeMutation", () => {
	it("P1: Array.prototype.<method> = fires", () => {
		const matches = detectBuiltinPrototypeMutation(
			"Array.prototype.flatMap = function flatMap() {};\n",
			SRC,
		);
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0]?.text).toContain("builtin_prototype_mutation");
	});

	it("P2: String.prototype.<method> = fires", () => {
		const matches = detectBuiltinPrototypeMutation(
			"String.prototype.pad = function pad() {};\n",
			SRC,
		);
		expect(matches.length).toBeGreaterThan(0);
	});

	it("P3: bare reassignment of a global builtin (Array = ) fires", () => {
		const matches = detectBuiltinPrototypeMutation("Array = polyfillArray;\n", SRC);
		expect(matches.length).toBeGreaterThan(0);
	});

	it("P4: globalThis.<Builtin> = fires", () => {
		const matches = detectBuiltinPrototypeMutation("globalThis.JSON = customJSON;\n", SRC);
		expect(matches.length).toBeGreaterThan(0);
	});

	it("N1: Object.prototype.toString.call(x) (a read, not an assignment) does not fire", () => {
		const matches = detectBuiltinPrototypeMutation(
			"const tag = Object.prototype.toString.call(x);\n",
			SRC,
		);
		expect(matches).toEqual([]);
	});

	it("N2: constructing a builtin (new Array()) does not fire", () => {
		const matches = detectBuiltinPrototypeMutation("const arr = new Array();\n", SRC);
		expect(matches).toEqual([]);
	});

	it("N3: a property literally named Array on a non-global receiver does not fire", () => {
		const matches = detectBuiltinPrototypeMutation("myObj.Array = someArrayLikeThing;\n", SRC);
		expect(matches).toEqual([]);
	});

	it("N4: Array used as a type reference (not an assignment target) does not fire", () => {
		const matches = detectBuiltinPrototypeMutation("type Foo = Array<string>;\n", SRC);
		expect(matches).toEqual([]);
	});

	it("N5: a strict-equality comparison against Array does not fire", () => {
		const matches = detectBuiltinPrototypeMutation("Array === globalThis.Array;\n", SRC);
		expect(matches).toEqual([]);
	});

	it("N6: Array = mentioned only in a comment does not fire", () => {
		const matches = detectBuiltinPrototypeMutation(
			"// Array = polyfill (considered and rejected)\nconst x = 1;\n",
			SRC,
		);
		expect(matches).toEqual([]);
	});
});

describe("detectFloatEqualityComparison", () => {
	it("P1: === against a float literal on the right fires", () => {
		const matches = detectFloatEqualityComparison("if (ratio === 0.1) {}\n", SRC);
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0]?.text).toContain("float_equality_comparison");
	});

	it("P2: !== against a float literal on the left fires", () => {
		const matches = detectFloatEqualityComparison("if (3.14 !== pi) {}\n", SRC);
		expect(matches.length).toBeGreaterThan(0);
	});

	it("P3: a leading-dot float literal (.5) fires", () => {
		const matches = detectFloatEqualityComparison("if (.5 === ratio) {}\n", SRC);
		expect(matches.length).toBeGreaterThan(0);
	});

	it("N1: === against an integer literal does not fire", () => {
		const matches = detectFloatEqualityComparison("if (count === 0) {}\n", SRC);
		expect(matches).toEqual([]);
	});

	it("N2: === against a multi-digit integer literal does not fire", () => {
		const matches = detectFloatEqualityComparison("if (status === 100) {}\n", SRC);
		expect(matches).toEqual([]);
	});

	it("N3: .toBe( in a test assertion does not fire (no === token)", () => {
		const matches = detectFloatEqualityComparison("expect(ratio).toBe(0.1);\n", SRC);
		expect(matches).toEqual([]);
	});

	it("N4: === against a string literal that looks like a float does not fire", () => {
		const matches = detectFloatEqualityComparison('if (version === "3.14") {}\n', SRC);
		expect(matches).toEqual([]);
	});

	it("N5: an epsilon-tolerant comparison (no === involved) does not fire", () => {
		const matches = detectFloatEqualityComparison(
			"const close = Math.abs(a - b) < Number.EPSILON;\n",
			SRC,
		);
		expect(matches).toEqual([]);
	});
});
