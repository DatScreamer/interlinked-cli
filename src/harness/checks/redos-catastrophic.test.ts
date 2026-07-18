import { describe, expect, it } from "vitest";
import { checkRedosCatastrophic } from "./redos-catastrophic.js";

describe("checkRedosCatastrophic — positive cases", () => {
	it("flags a JS regex literal with nested quantifier (a+)+", () => {
		const m = checkRedosCatastrophic("const re = /(a+)+$/;\n", "src/v.ts");
		expect(m).toHaveLength(1);
		expect(m[0]?.line).toBe(1);
	});

	it("flags new RegExp('(\\\\d*)*')", () => {
		const m = checkRedosCatastrophic('const r = new RegExp("(\\\\d*)*");\n', "src/v.js");
		expect(m).toHaveLength(1);
	});

	it("flags Python re.compile with ([a-z]+)*", () => {
		const m = checkRedosCatastrophic('p = re.compile(r"([a-z]+)*")\n', "svc/val.py");
		expect(m).toHaveLength(1);
	});

	it("flags an outer {2,}-bounded re-quantified group (x+){2,}", () => {
		expect(checkRedosCatastrophic('re.match("(x+){2,}", s)\n', "svc/v.py")).toHaveLength(1);
	});

	it("does NOT flag a single quantified group with no outer quantifier (x+)", () => {
		expect(checkRedosCatastrophic('re.match("(x+)", s)\n', "svc/v.py")).toHaveLength(0);
	});
});

describe("checkRedosCatastrophic — negative cases (must NOT fire)", () => {
	it("does NOT flag arithmetic (x+1)*2 (not a regex body)", () => {
		expect(checkRedosCatastrophic("const y = (x + 1) * 2;\n", "src/v.ts")).toHaveLength(0);
	});

	it("does NOT flag a single-quantifier regex /a+/ (linear)", () => {
		expect(checkRedosCatastrophic("const re = /[a-z]+@[a-z]+/;\n", "src/v.ts")).toHaveLength(0);
	});

	it("does NOT flag a division expression a / (b+1) / c", () => {
		expect(checkRedosCatastrophic("const q = a / (b + 1) / c;\n", "src/v.ts")).toHaveLength(0);
	});

	it("does NOT fire in a test file", () => {
		expect(checkRedosCatastrophic("const re = /(a+)+/;\n", "src/v.test.ts")).toHaveLength(0);
	});

	it("does NOT fire on a non-JS/Python file", () => {
		expect(checkRedosCatastrophic("re = /(a+)+/\n", "Makefile")).toHaveLength(0);
	});

	it("respects a # noqa suppression (Python)", () => {
		expect(checkRedosCatastrophic('p = re.compile(r"(a+)+")  # noqa\n', "svc/v.py")).toHaveLength(0);
	});
});
