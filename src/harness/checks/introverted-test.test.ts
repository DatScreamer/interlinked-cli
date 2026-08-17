import { describe, expect, it, vi } from "vitest";
import { checkIntrovertedTest } from "./introverted-test.js";

// `checkIntrovertedTest` flags test blocks whose assertions never trace to the
// system under test (introverted). Fixtures are passed as `content` strings to
// the SUT call below — so each assertion here is grounded in `checkIntrovertedTest`
// (or its degradation path), and this file does not flag itself once live.

function run(content: string, path = "cart.test.ts"): ReturnType<typeof checkIntrovertedTest> {
	return checkIntrovertedTest(content, path);
}

const CART = `import { calcTotal } from "./cart";\n`;
const MOCK_PRICING = `vi.mock("./pricing");\nimport { priceOf } from "./pricing";\n${CART}`;

describe("checkIntrovertedTest — positive (flags introverted)", () => {
	it("flags a literal-only assertion", () => {
		const found = run(`${CART}it("adds", () => { expect(3).toBe(3); });`);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).toContain("introverted test");
	});

	it("flags an assertion on test-local data", () => {
		expect(run(`${CART}it("counts", () => { const xs = [1, 2, 3]; expect(xs.length).toBe(3); });`)).toHaveLength(1);
	});

	it("flags an assertion on a MOCKED dependency return value (the money case)", () => {
		expect(run(`${MOCK_PRICING}it("prices", () => { expect(priceOf("x")).toBe(9.99); });`)).toHaveLength(1);
	});

	it("flags a mocked return read through a let binding", () => {
		expect(run(`${MOCK_PRICING}it("prices", () => { const p = priceOf("x"); expect(p).toBe(9.99); });`)).toHaveLength(1);
	});

	it("flags a parameterized it.each block", () => {
		expect(run(`${CART}it.each([[1], [2]])("case %i", () => { expect(7).toBe(7); });`)).toHaveLength(1);
	});

	it("flags an introverted assert.equal", () => {
		expect(run(`${CART}it("asserts", () => { assert.equal(3, 3); });`)).toHaveLength(1);
	});

	it("flags a bare reference to a mocked symbol", () => {
		expect(run(`${MOCK_PRICING}it("def", () => { expect(priceOf).toBeDefined(); });`)).toHaveLength(1);
	});

	// test-contract: public-api — every documented non-SUT global remains a literal-only assertion source
	it("flags assertions on all documented known non-SUT globals", () => {
		for (const expression of [
			"Math.PI", "JSON.stringify({})", "Object.keys({})", "Array.isArray([])", "String(1)",
			"Number(1)", "Boolean(1)", "Date.now()", "RegExp", "/x/.test(\"x\")", "new Map()", "new Set()",
			"WeakMap", "WeakSet", "Symbol(\"x\")", "Promise.resolve(1)", "BigInt(1)", "Error",
			"parseInt(\"1\")", "parseFloat(\"1\")", "isNaN(1)", "isFinite(1)",
			"structuredClone({})", "console", "expect",
		]) {
			expect(run(`${CART}it("global", () => { expect(${expression}).toBeDefined(); });`), expression).toHaveLength(1);
		}
	});

	// test-contract: boundary — primitive and template assertion subjects are recognized as test-local values
	it("flags every supported primitive literal shape", () => {
		for (const expression of ["\"text\"", "true", "false", "null", "/pattern/", "`template`"]) {
			expect(run(`${CART}it("literal", () => { expect(${expression}).toBeDefined(); });`), expression).toHaveLength(1);
		}
	});

	// test-contract: boundary — dynamically importing a bare dependency does not ground an assertion in the companion
	it("flags a dynamic import of a non-relative dependency", () => {
		expect(run(`${CART}it("dependency", async () => { expect(import("lodash")).toBeDefined(); });`)).toHaveLength(1);
	});

	// test-contract: public-api — the checker truncates the published finding name to its documented eighty characters
	it("truncates an overlong test name in the finding", () => {
		const suffix = "z".repeat(81);
		const found = run(`${CART}it("${suffix}", () => { expect(3).toBe(3); });`);
		expect(found).toHaveLength(1);
		expect(found[0]?.text).not.toContain(suffix);
	});

	it("caps the number of findings per file", () => {
		const many = CART + Array.from({ length: 12 }, (_, i) => `it("t${i}", () => { expect(${i}).toBe(${i}); });`).join("\n");
		expect(run(many)).toHaveLength(10);
	});
});

describe("checkIntrovertedTest — negative (stays silent)", () => {
	it("does not flag a direct SUT call", () => {
		expect(run(`${CART}it("adds", () => { expect(calcTotal([1, 2])).toBe(3); });`)).toEqual([]);
	});

	it("does not flag a SUT result through a let binding", () => {
		expect(run(`${CART}it("adds", () => { const r = calcTotal([1]); expect(r).toBe(1); });`)).toEqual([]);
	});

	it("does not flag an object-destructured SUT result", () => {
		expect(run(`${CART}it("adds", () => { const { total } = calcTotal([1]); expect(total).toBe(1); });`)).toEqual([]);
	});

	it("does not flag an array-destructured SUT result", () => {
		expect(run(`${CART}it("adds", () => { const [first] = calcTotal([1]); expect(first).toBe(1); });`)).toEqual([]);
	});

	it("does not flag a default-import SUT call", () => {
		expect(run(`import calc from "./cart";\nit("adds", () => { expect(calc([1])).toBe(1); });`)).toEqual([]);
	});

	// test-contract: public-api — a default-import companion is recognized even when its value is only asserted literally
	it("flags a literal assertion in a default-import companion test", () => {
		expect(run(`import calc from "./cart";\nit("noop", () => { expect(3).toBe(3); });`)).toHaveLength(1);
	});

	it("does not flag a namespace-import SUT call", () => {
		expect(run(`import * as cart from "./cart";\nit("adds", () => { expect(cart.calcTotal([1])).toBe(1); });`)).toEqual([]);
	});

	// test-contract: public-api — a non-mocked namespace import is a companion even before one of its exports is called
	it("flags a literal assertion in a namespace-import companion test", () => {
		expect(run(`import * as cart from "./cart";\nit("noop", () => { expect(3).toBe(3); });`)).toHaveLength(1);
	});

	it("does not flag a dynamic import of the SUT", () => {
		expect(run(`${CART}it("adds", async () => { const m = await import("./cart"); expect(m.calcTotal([1])).toBe(1); });`)).toEqual([]);
	});

	it("does not flag a bare reference to a SUT symbol", () => {
		expect(run(`${CART}it("def", () => { expect(calcTotal).toBeDefined(); });`)).toEqual([]);
	});

	it("does not flag when the SUT is called in the body (out-param / effect)", () => {
		expect(run(`${CART}it("x", () => { const out = []; calcTotal(out); expect(out).toEqual([1]); });`)).toEqual([]);
	});

	it("does not flag a literal assertion when a namespace SUT is used in the body", () => {
		expect(run(`import * as cart from "./cart";\nit("x", () => { cart.calcTotal([1]); expect(3).toBe(3); });`)).toEqual([]);
	});

	it("does not flag when the SUT is reached through a local factory function", () => {
		expect(
			run(`${CART}function makeSvc() { return { run: (o) => o.push(calcTotal([1])) }; }\nit("x", () => { const out = []; makeSvc().run(out); expect(out).toEqual([1]); });`),
		).toEqual([]);
	});

	it("does not flag when the SUT is reached through a local factory arrow", () => {
		expect(
			run(`${CART}const seed = () => { calcTotal([1]); };\nit("x", () => { const out = []; seed(); expect(out).toEqual([]); });`),
		).toEqual([]);
	});

	// test-contract: public-api — a file-local function expression that calls the companion counts as SUT exercise
	it("does not flag when the SUT is reached through a function-expression helper", () => {
		expect(
			run(`${CART}const seed = function () { calcTotal([1]); };\nit("x", () => { seed(); expect(3).toBe(3); });`),
		).toEqual([]);
	});

	it("bails on a meta-test whose only relative import is a utility (no companion SUT)", () => {
		expect(
			run(`import { nonNull } from "../../lib/non-null.js";\nit("x", () => { const missing = []; expect(missing).toEqual([]); });`, "check-pipeline-parity.test.ts"),
		).toEqual([]);
	});

	it("does not flag an extroverted assert() identifier form", () => {
		expect(run(`${CART}it("asserts", () => { assert(calcTotal([1]) === 1); });`)).toEqual([]);
	});

	// test-contract: public-api — property-form assertion APIs trace every SUT-valued argument
	it("does not flag a property-form assert around a SUT result", () => {
		expect(run(`${CART}it("asserts", () => { assert.deepEqual(calcTotal([1]), 1); });`)).toEqual([]);
	});

	// test-contract: boundary — assertion APIs with no subjects remain outside the introverted-test check
	it("ignores no-argument expect and assert calls", () => {
		expect(run(`${CART}it("empty", () => { expect(); assert(); assert.equal(); });`)).toEqual([]);
	});

	// test-contract: boundary — an assertion-like function name is not treated as the standard assert API
	it("ignores a similarly named non-assert function call", () => {
		expect(run(`${CART}it("lookalike", () => { assertion(3, 3); });`)).toEqual([]);
	});

	it("stays silent on an unresolved local helper", () => {
		expect(run(`${CART}it("adds", () => { const build = () => ({ total: 3 }); expect(build().total).toBe(3); });`)).toEqual([]);
	});

	it("stays silent on an unresolved free identifier", () => {
		expect(run(`${CART}it("adds", () => { expect(EXPECTED).toBe(3); });`)).toEqual([]);
	});

	it("stays silent past the binding-depth cap", () => {
		expect(run(`${CART}it("deep", () => { const d = 3; const c = d; const b = c; const a = b; expect(a).toBe(3); });`)).toEqual([]);
	});

	// test-contract: public-api — renamed object destructuring preserves the SUT provenance of its bound value
	it("does not flag a renamed object-destructured SUT result", () => {
		expect(run(`${CART}it("renamed", () => { const { total: amount } = calcTotal([1]); expect(amount).toBe(1); });`)).toEqual([]);
	});

	it("does not flag when at least one assertion reaches the SUT", () => {
		expect(run(`${CART}it("adds", () => { expect(3).toBe(3); expect(calcTotal([1])).toBe(1); });`)).toEqual([]);
	});

	// test-contract: invariant — a reached assertion remains sufficient when it precedes a literal-only assertion
	it("preserves SUT reachability when the grounded assertion comes first", () => {
		expect(run(`${CART}it("adds", () => { expect(calcTotal([1])).toBe(1); expect(3).toBe(3); });`)).toEqual([]);
	});

	it("bails when the file imports no SUT source", () => {
		expect(run(`import _ from "lodash";\nit("noop", () => { expect(2).toBe(2); });`)).toEqual([]);
	});

	// test-contract: boundary — a bare import with the companion basename is still a dependency, not an in-project SUT
	it("does not treat a bare companion-named import as the SUT", () => {
		expect(run(`import { calcTotal } from "cart";\nit("noop", () => { expect(2).toBe(2); });`)).toEqual([]);
	});

	// test-contract: boundary — a side-effect-only companion import has no symbol surface to trace
	it("does not invent a SUT symbol for a side-effect-only import", () => {
		expect(run(`import "./cart";\nit("noop", () => { expect(2).toBe(2); });`)).toEqual([]);
	});

	// test-contract: boundary — an asset import with the companion basename is excluded from SUT classification
	it("does not treat a companion-named JSON import as source code", () => {
		expect(run(`import data from "./cart.json";\nit("noop", () => { expect(2).toBe(2); });`)).toEqual([]);
	});

	it("ignores skipped tests", () => {
		expect(run(`${CART}it.skip("adds", () => { expect(3).toBe(3); });`)).toEqual([]);
	});

	it("ignores assertion-free blocks", () => {
		expect(run(`${CART}it("setup", () => { const r = calcTotal([1]); });`)).toEqual([]);
	});

	// test-contract: boundary — assertion-free blocks without any SUT reference remain a separate check's responsibility
	it("ignores assertion-free blocks that do not call the SUT", () => {
		expect(run(`${CART}it("setup", () => { const value = 1; void value; });`)).toEqual([]);
	});

	it("ignores non-test files", () => {
		expect(run(`${CART}it("adds", () => { expect(3).toBe(3); });`, "src/cart.ts")).toEqual([]);
	});

	it("ignores non-JS/TS test files", () => {
		expect(run(`it("adds", () => { expect(3).toBe(3); });`, "foo_test.go")).toEqual([]);
	});

	// test-contract: boundary — a strict test filename with an unsupported extension is ignored by the JS/TS-only checker
	it("ignores a non-JS/TS strict test filename", () => {
		expect(run(`${CART}it("adds", () => { expect(3).toBe(3); });`, "cart.test.css")).toEqual([]);
	});

	// test-contract: public-api — a relative parent import is a valid in-project companion source
	it("recognizes a parent-relative companion import", () => {
		expect(run(`import { calcTotal } from "../cart";\nit("adds", () => { expect(3).toBe(3); });`, "src/cart.test.ts")).toHaveLength(1);
	});

	// test-contract: public-api — a companion test in a nested directory still reports the documented source line
	it("reports the one-based line of a nested companion test", () => {
		const found = run(`${CART}\nit("adds", () => { expect(3).toBe(3); });`, "src/cart.test.ts");
		expect(found[0]?.line).toBe(3);
	});
});

describe("checkIntrovertedTest — file extensions", () => {
	it("parses a .tsx test file", () => {
		expect(run(`${CART}it("adds", () => { expect(3).toBe(3); });`, "cart.test.tsx")).toHaveLength(1);
	});
	it("parses a .jsx test file", () => {
		expect(run(`${CART}it("adds", () => { expect(3).toBe(3); });`, "cart.test.jsx")).toHaveLength(1);
	});
	it("parses a .js test file", () => {
		expect(run(`${CART}it("adds", () => { expect(3).toBe(3); });`, "cart.test.js")).toHaveLength(1);
	});

	// test-contract: boundary — the remaining strict test module extensions use the same public finding behavior
	it("parses mjs and cjs test files", () => {
		for (const extension of ["mjs", "cjs"]) {
			expect(run(`${CART}it("adds", () => { expect(3).toBe(3); });`, `cart.test.${extension}`), extension).toHaveLength(1);
		}
	});

	// test-contract: boundary — a JavaScript companion import with an explicit extension still matches its test basename
	it("matches an explicitly extended companion import", () => {
		expect(run(`import { calcTotal } from "./cart.js";\nit("adds", () => { expect(3).toBe(3); });`)).toHaveLength(1);
	});
});

describe("checkIntrovertedTest — runner and mock boundaries", () => {
	// test-contract: public-api — test, specify, and each variants are recognized as executable test blocks
	it("recognizes test and specify blocks alongside it", () => {
		for (const declaration of [
			`test("case", () => { expect(3).toBe(3); });`,
			`specify("case", () => { expect(3).toBe(3); });`,
			`test.each([[1]])("case", () => { expect(3).toBe(3); });`,
			`specify.each([[1]])("case", () => { expect(3).toBe(3); });`,
		]) {
			expect(run(`${CART}${declaration}`), declaration).toHaveLength(1);
		}
	});

	// test-contract: boundary — every documented skip modifier suppresses analysis of its test body
	it("ignores every skipped test modifier", () => {
		for (const modifier of ["skip", "todo", "failing", "skipIf", "runIf"]) {
			expect(run(`${CART}it.${modifier}("case", () => { expect(3).toBe(3); });`), modifier).toEqual([]);
		}
	});

	// test-contract: boundary — non-test callbacks such as describe are not reported as executable test blocks
	it("does not treat a describe callback as a test", () => {
		expect(run(`${CART}describe("suite", () => { expect(3).toBe(3); });`)).toEqual([]);
	});

	// test-contract: boundary — a dynamic test name is outside the string-named test-block contract
	it("ignores a test whose name is not a string literal", () => {
		expect(run(`${CART}const name = "case"; it(name, () => { expect(3).toBe(3); });`)).toEqual([]);
	});

	// test-contract: public-api — jest.mock marks a dependency result as mocked just like vi.mock
	it("flags a jest-mocked dependency result", () => {
		expect(run(`jest.mock("./pricing");\nimport { priceOf } from "./pricing";\n${CART}it("prices", () => { expect(priceOf("x")).toBe(9.99); });`)).toHaveLength(1);
	});

	// test-contract: boundary — an extension-normalized mock specifier matches the unextended import
	it("matches a mocked dependency with an explicit extension", () => {
		expect(run(`vi.mock("./pricing.js");\nimport { priceOf } from "./pricing";\n${CART}it("prices", () => { expect(priceOf("x")).toBe(9.99); });`)).toHaveLength(1);
	});

	// test-contract: boundary — a non-literal mock specifier does not suppress analysis of a real companion import
	it("ignores a variable mock specifier while retaining the companion import", () => {
		expect(run(`${CART}const moduleName = "./pricing"; vi.mock(moduleName);\nit("noop", () => { expect(3).toBe(3); });`)).toHaveLength(1);
	});
});

describe("checkIntrovertedTest — degradation", () => {
	it("returns [] when the typescript dep is unavailable", async () => {
		vi.resetModules();
		vi.doMock("node:module", () => ({
			createRequire: () => () => {
				throw new Error("Cannot find module 'typescript'");
			},
		}));
		const fresh = await import("./introverted-test.js");
		const out = fresh.checkIntrovertedTest(`${CART}it("x", () => { expect(3).toBe(3); });`, "cart.test.ts");
		vi.doUnmock("node:module");
		vi.resetModules();
		expect(out).toEqual([]);
	});
});
