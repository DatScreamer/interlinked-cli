// Tests for `ubs_magic_number_no_const` (Plan 04 D.1 backlog).

import { describe, expect, it } from "vitest";
import { checkMagicNumberNoConst } from "../checks/ubs-language-specific.js";

describe("checkMagicNumberNoConst", () => {
	it("flags `setTimeout(fn, 5000)` (large bare numeric)", () => {
		const code = "function delay() {\n  setTimeout(fn, 5000);\n}\n";
		const matches = checkMagicNumberNoConst(code, "src/lib/foo.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag `const X = 1000;` (named constant)", () => {
		const code = "const TIMEOUT_MS = 1000;\n";
		expect(checkMagicNumberNoConst(code, "src/lib/foo.ts")).toEqual([]);
	});

	it("does NOT flag small numbers like `i + 1`", () => {
		const code = "const next = i + 1;\n";
		expect(checkMagicNumberNoConst(code, "src/lib/foo.ts")).toEqual([]);
	});

	it("does NOT fire on test files", () => {
		const code = "setTimeout(fn, 5000);";
		expect(checkMagicNumberNoConst(code, "src/foo.test.ts")).toEqual([]);
	});
});
