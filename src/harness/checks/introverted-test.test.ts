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

	it("does not flag a namespace-import SUT call", () => {
		expect(run(`import * as cart from "./cart";\nit("adds", () => { expect(cart.calcTotal([1])).toBe(1); });`)).toEqual([]);
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

	it("bails on a meta-test whose only relative import is a utility (no companion SUT)", () => {
		expect(
			run(`import { nonNull } from "../../lib/non-null.js";\nit("x", () => { const missing = []; expect(missing).toEqual([]); });`, "check-pipeline-parity.test.ts"),
		).toEqual([]);
	});

	it("does not flag an extroverted assert() identifier form", () => {
		expect(run(`${CART}it("asserts", () => { assert(calcTotal([1]) === 1); });`)).toEqual([]);
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

	it("does not flag when at least one assertion reaches the SUT", () => {
		expect(run(`${CART}it("adds", () => { expect(3).toBe(3); expect(calcTotal([1])).toBe(1); });`)).toEqual([]);
	});

	it("bails when the file imports no SUT source", () => {
		expect(run(`import _ from "lodash";\nit("noop", () => { expect(2).toBe(2); });`)).toEqual([]);
	});

	it("ignores skipped tests", () => {
		expect(run(`${CART}it.skip("adds", () => { expect(3).toBe(3); });`)).toEqual([]);
	});

	it("ignores assertion-free blocks", () => {
		expect(run(`${CART}it("setup", () => { const r = calcTotal([1]); });`)).toEqual([]);
	});

	it("ignores non-test files", () => {
		expect(run(`${CART}it("adds", () => { expect(3).toBe(3); });`, "src/cart.ts")).toEqual([]);
	});

	it("ignores non-JS/TS test files", () => {
		expect(run(`it("adds", () => { expect(3).toBe(3); });`, "foo_test.go")).toEqual([]);
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
