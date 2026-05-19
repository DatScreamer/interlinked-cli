// Smoke tests for the generic quality/smell UBS detectors. The exhaustive
// red/green suites live in src/harness/__tests__/ubs-*.test.ts and exercise
// these via the ubs-language-specific.ts barrel; this colocated file covers
// the module surface directly and satisfies the colocation gate.

import { describe, expect, it } from "vitest";
import {
	checkDeeplyNestedCallback,
	checkLargeFunction,
	checkMagicNumberNoConst,
	checkNumericComparisonChain,
	checkPrintDebugLeak,
	checkTimeFormatLocaleDep,
	checkUbsStringConcatInLoop,
} from "./quality-smell-checks.js";

describe("ubs-language-specific/quality-smell-checks", () => {
	it("checkMagicNumberNoConst flags a 3+ digit literal in an expression", () => {
		expect(checkMagicNumberNoConst("x = foo + 4096;", "a.ts").length).toBeGreaterThan(0);
		expect(checkMagicNumberNoConst("const N = 4096;", "a.ts")).toEqual([]);
	});

	it("checkLargeFunction flags a function body over the line limit", () => {
		const body = Array.from({ length: 90 }, (_, i) => `  const x${i} = ${i};`).join("\n");
		const code = `function big() {\n${body}\n}`;
		expect(checkLargeFunction(code, "a.ts").length).toBeGreaterThan(0);
	});

	it("checkDeeplyNestedCallback flags 4-level callback nesting", () => {
		const code =
			"a(() => {\n  b(() => {\n    c(() => {\n      d(() => {\n        e();\n      });\n    });\n  });\n});\n";
		expect(checkDeeplyNestedCallback(code, "a.js").length).toBeGreaterThan(0);
	});

	it("checkTimeFormatLocaleDep flags toLocaleString() with no args", () => {
		expect(checkTimeFormatLocaleDep("d.toLocaleString()", "a.js").length).toBeGreaterThan(0);
	});

	it("checkNumericComparisonChain flags 3+ instanceof lines", () => {
		const code = "if (a instanceof X) {}\nif (a instanceof Y) {}\nif (a instanceof Z) {}";
		expect(checkNumericComparisonChain(code, "a.java").length).toBeGreaterThan(0);
	});

	it("checkUbsStringConcatInLoop flags `s += chunk` inside a loop", () => {
		const code = "for (let i = 0; i < n; i++) {\n  s += chunk;\n}";
		expect(checkUbsStringConcatInLoop(code, "a.js").length).toBeGreaterThan(0);
	});

	it("checkPrintDebugLeak flags console.log in non-test source", () => {
		expect(checkPrintDebugLeak("console.log(x)", "src/lib/a.ts").length).toBeGreaterThan(0);
	});
});
