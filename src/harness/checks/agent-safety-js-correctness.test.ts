import { describe, expect, it } from "vitest";
import {
	checkBroadObjectTypes,
	checkConstantCondition,
	checkEvalUsage,
	checkInnerHtmlUsage,
	checkJsLooseEquality,
	checkMagicLiteralInConditional,
	checkNanComparison,
	checkNonNullAssertions,
	checkNumberPrecisionLoss,
	checkUnsafeOptionalChaining,
} from "./agent-safety-js-correctness.js";

// Smoke-test coverage for the agent-safety JS/TS type-safety and correctness
// check family. Deeper coverage lives in `src/harness/__tests__/` (e.g.
// `ubs-js-loose-equality.test.ts`, `generic-checks-extended-*.test.ts`) — this
// file satisfies the harness's per-source-file test rule and guards the shape
// of the exported check functions.

describe("agent-safety js-correctness check surface — smoke", () => {
	it("checkNonNullAssertions returns an array", () => {
		expect(Array.isArray(checkNonNullAssertions("", "a.ts"))).toBe(true);
	});

	it("checkMagicLiteralInConditional returns an array", () => {
		expect(Array.isArray(checkMagicLiteralInConditional("", "a.ts"))).toBe(true);
	});

	it("checkBroadObjectTypes returns an array", () => {
		expect(Array.isArray(checkBroadObjectTypes("", "a.ts"))).toBe(true);
	});

	it("checkEvalUsage returns an array", () => {
		expect(Array.isArray(checkEvalUsage("", "a.ts"))).toBe(true);
	});

	it("checkInnerHtmlUsage returns an array", () => {
		expect(Array.isArray(checkInnerHtmlUsage("", "a.ts"))).toBe(true);
	});

	it("checkNanComparison returns an array", () => {
		expect(Array.isArray(checkNanComparison("", "a.ts"))).toBe(true);
	});

	it("checkJsLooseEquality returns an array", () => {
		expect(Array.isArray(checkJsLooseEquality("", "a.ts"))).toBe(true);
	});

	it("checkConstantCondition returns an array", () => {
		expect(Array.isArray(checkConstantCondition("", "a.ts"))).toBe(true);
	});

	it("checkUnsafeOptionalChaining returns an array", () => {
		expect(Array.isArray(checkUnsafeOptionalChaining("", "a.ts"))).toBe(true);
	});

	it("checkNumberPrecisionLoss returns an array", () => {
		expect(Array.isArray(checkNumberPrecisionLoss("", "a.ts"))).toBe(true);
	});
});

describe("checkNonNullAssertions", () => {
	it("flags a non-null assertion before property access", () => {
		const out = checkNonNullAssertions("const x = foo!.bar;\n", "src/x.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("does NOT flag loose-inequality `!==`", () => {
		const out = checkNonNullAssertions("if (a !== b) doThing();\n", "src/x.ts");
		expect(out).toEqual([]);
	});

	it("does NOT run on test files", () => {
		const out = checkNonNullAssertions("const x = foo!.bar;\n", "src/x.test.ts");
		expect(out).toEqual([]);
	});
});

describe("checkMagicLiteralInConditional", () => {
	it("flags an opaque numeric comparison literal", () => {
		const out = checkMagicLiteralInConditional("if (status === 42) {}\n", "src/x.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("does NOT flag the `typeof x === \"string\"` narrowing idiom", () => {
		const out = checkMagicLiteralInConditional(
			'if (typeof x === "string") {}\n',
			"src/x.ts",
		);
		expect(out).toEqual([]);
	});

	it("does NOT flag a self-describing identifier-like string token", () => {
		const out = checkMagicLiteralInConditional(
			'if (runner === "codex") {}\n',
			"src/x.ts",
		);
		expect(out).toEqual([]);
	});
});

describe("checkBroadObjectTypes", () => {
	it("flags Record<string, any>", () => {
		const out = checkBroadObjectTypes("const x: Record<string, any> = {};\n", "src/x.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags a bare Function type annotation", () => {
		const out = checkBroadObjectTypes("let cb: Function;\n", "src/x.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("does NOT run on generated files", () => {
		const out = checkBroadObjectTypes(
			"// auto-generated\nconst x: Record<string, any> = {};\n",
			"src/x.ts",
		);
		expect(out).toEqual([]);
	});
});

describe("checkEvalUsage", () => {
	it("flags a direct eval() call", () => {
		const out = checkEvalUsage("eval(userInput);\n", "src/x.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags setTimeout with a string argument (implied eval)", () => {
		const out = checkEvalUsage('setTimeout("doThing()", 100);\n', "src/x.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});
});

describe("checkInnerHtmlUsage", () => {
	it("flags direct innerHTML assignment", () => {
		const out = checkInnerHtmlUsage("el.innerHTML = userHtml;\n", "src/x.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("flags dangerouslySetInnerHTML", () => {
		const out = checkInnerHtmlUsage(
			"<div dangerouslySetInnerHTML={{ __html: x }} />\n",
			"src/x.tsx",
		);
		expect(out.length).toBeGreaterThanOrEqual(1);
	});
});

describe("checkNanComparison", () => {
	it("flags `x === NaN`", () => {
		const out = checkNanComparison("if (x === NaN) {}\n", "src/x.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("does NOT flag Number.isNaN(x)", () => {
		const out = checkNanComparison("if (Number.isNaN(x)) {}\n", "src/x.ts");
		expect(out).toEqual([]);
	});
});

describe("checkJsLooseEquality", () => {
	it("flags loose `==`", () => {
		const out = checkJsLooseEquality("if (a == b) {}\n", "src/x.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("does NOT flag the `x == null` idiom", () => {
		const out = checkJsLooseEquality("if (a == null) {}\n", "src/x.ts");
		expect(out).toEqual([]);
	});

	it("does NOT flag strict `===`", () => {
		const out = checkJsLooseEquality("if (a === b) {}\n", "src/x.ts");
		expect(out).toEqual([]);
	});
});

describe("checkConstantCondition", () => {
	it("flags `if (true)`", () => {
		const out = checkConstantCondition("if (true) {}\n", "src/x.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("does NOT flag `if (x === false)`", () => {
		const out = checkConstantCondition("if (x === false) {}\n", "src/x.ts");
		expect(out).toEqual([]);
	});
});

describe("checkUnsafeOptionalChaining", () => {
	it("flags `(obj?.foo).bar`", () => {
		const out = checkUnsafeOptionalChaining("const y = (obj?.foo).bar;\n", "src/x.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("does NOT flag `(obj?.foo ?? d).bar`", () => {
		const out = checkUnsafeOptionalChaining("const y = (obj?.foo ?? d).bar;\n", "src/x.ts");
		expect(out).toEqual([]);
	});
});

describe("checkNumberPrecisionLoss", () => {
	it("flags an integer literal beyond MAX_SAFE_INTEGER", () => {
		const out = checkNumberPrecisionLoss("const id = 9007199254740993;\n", "src/x.ts");
		expect(out.length).toBeGreaterThanOrEqual(1);
	});

	it("does NOT flag a small integer literal", () => {
		const out = checkNumberPrecisionLoss("const id = 42;\n", "src/x.ts");
		expect(out).toEqual([]);
	});
});
