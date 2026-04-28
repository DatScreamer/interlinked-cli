// Tests for `ubs_large_function` (Plan 04 D.1 backlog).

import { describe, expect, it } from "vitest";
import { checkLargeFunction } from "../checks/ubs-language-specific.js";

describe("checkLargeFunction", () => {
	it("flags a JS/TS function with 80+ body lines", () => {
		const body = Array(82).fill("  doStuff();").join("\n");
		const code = `function huge() {\n${body}\n}\n`;
		const matches = checkLargeFunction(code, "src/lib/huge.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags a Python `def` with 80+ body lines", () => {
		const body = Array(82).fill("    do_stuff()").join("\n");
		const code = `def huge():\n${body}\n`;
		const matches = checkLargeFunction(code, "src/lib/huge.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag a 30-line function", () => {
		const body = Array(30).fill("  doStuff();").join("\n");
		const code = `function smol() {\n${body}\n}\n`;
		expect(checkLargeFunction(code, "src/lib/smol.ts")).toEqual([]);
	});

	it("does NOT fire on test files", () => {
		const body = Array(82).fill("  it('test', () => {});").join("\n");
		const code = `describe('a', () => {\n${body}\n});\n`;
		expect(checkLargeFunction(code, "src/foo.test.ts")).toEqual([]);
	});
});
