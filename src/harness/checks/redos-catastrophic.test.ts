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

// A JSDoc block `/** … */` has the exact shape of a regex literal — leading
// slash, body, closing slash — so the literal scanner read prose as a pattern.
// Found by the 2026-08-04 corpus dogfood run: 5 of the check's 37 tree-wide
// hits were comments, none of them regexes. Noise is a detector bug.
describe("comments are not regex literals", () => {
	describe("— negative (must not fire)", () => {
		it("N1: ignores a single-line JSDoc whose prose parses as a nested quantifier", () => {
			const src = "/** Nested quantifier inside a group: `(a+)*`, `(a*b)+`. */\nexport const X = 1;\n";
			expect(checkRedosCatastrophic(src, "src/v.ts")).toHaveLength(0);
		});

		it("N2: ignores prose with parens and a star that is multiplication, not repetition", () => {
			const src = "/** Whether errors are accelerating (last hour > average rate * 3) */\nconst y = 2;\n";
			expect(checkRedosCatastrophic(src, "src/v.ts")).toHaveLength(0);
		});

		it("N3: ignores a continuation line inside a multi-line block comment", () => {
			const src = "/**\n * Documents the bad shape `(\\w+\\d*)*` for readers.\n */\nconst z = 3;\n";
			expect(checkRedosCatastrophic(src, "src/v.ts")).toHaveLength(0);
		});

		it("N4: ignores a `//` line comment describing a pattern", () => {
			const src = "// avoid /(a+)+/ here — catastrophic\nconst w = 4;\n";
			expect(checkRedosCatastrophic(src, "src/v.ts")).toHaveLength(0);
		});
	});

	describe("— positive (must fire)", () => {
		it("P1: still fires on a real regex literal on a normal code line", () => {
			expect(checkRedosCatastrophic("const re = /(a+)+/;\n", "src/v.ts")).toHaveLength(1);
		});

		it("P2: still fires on real code that FOLLOWS a closed block comment", () => {
			const src = "/** harmless (a+)* prose */\nconst re = /(x+)+/;\n";
			const out = checkRedosCatastrophic(src, "src/v.ts");
			expect(out).toHaveLength(1);
			expect(out[0]?.line).toBe(2);
		});

		it("P3: still fires on a regex sharing a line with a trailing comment", () => {
			const out = checkRedosCatastrophic("const re = /(a+)+/; // note\n", "src/v.ts");
			expect(out).toHaveLength(1);
		});
	});
});
