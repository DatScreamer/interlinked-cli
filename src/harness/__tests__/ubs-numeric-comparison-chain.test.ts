// Tests for `ubs_numeric_comparison_chain` (Plan 04 D.1 backlog).

import { describe, expect, it } from "vitest";
import { checkNumericComparisonChain } from "../checks/ubs-language-specific.js";

describe("checkNumericComparisonChain", () => {
	it("flags 3+ consecutive `instanceof` lines", () => {
		const code =
			"if (x instanceof A) { return 1; }\nif (x instanceof B) { return 2; }\nif (x instanceof C) { return 3; }\n";
		const matches = checkNumericComparisonChain(code, "src/Foo.java");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag a single `instanceof`", () => {
		const code = "if (x instanceof A) { return 1; }\n";
		expect(checkNumericComparisonChain(code, "src/Foo.java")).toEqual([]);
	});

	it("does NOT fire on JS files", () => {
		const code =
			"if (x instanceof A) { return 1; }\nif (x instanceof B) { return 2; }\nif (x instanceof C) { return 3; }\n";
		expect(checkNumericComparisonChain(code, "src/foo.ts")).toEqual([]);
	});
});
