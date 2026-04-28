// Tests for `ubs_eval_input_tainted` (Plan 04 D.1 partial).
// Targets the tainted-input subset: eval/Function/exec/compile invoked
// with a non-string-literal first argument.

import { describe, expect, it } from "vitest";
import { checkEvalInputTainted } from "../checks/ubs-language-specific.js";

describe("checkEvalInputTainted", () => {
	it("flags JS `eval(userInput)`", () => {
		const code = "function run(userInput) { return eval(userInput); }";
		const matches = checkEvalInputTainted(code, "src/run.js");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags TS `Function(code)` constructor with a variable arg", () => {
		const code = "const fn = Function(code);";
		const matches = checkEvalInputTainted(code, "src/run.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags Python `exec(payload)`", () => {
		const code = "def runner(payload):\n    exec(payload)\n";
		const matches = checkEvalInputTainted(code, "src/run.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag `eval('1 + 1')` (string literal first arg)", () => {
		const code = "const result = eval('1 + 1');";
		expect(checkEvalInputTainted(code, "src/run.js")).toEqual([]);
	});

	it("does NOT flag `eval(\"x\")` (double-quoted literal)", () => {
		const code = 'const result = eval("x");';
		expect(checkEvalInputTainted(code, "src/run.js")).toEqual([]);
	});

	it("does NOT fire on Rust files (cross-language gate)", () => {
		const code = "let x = eval(input);";
		expect(checkEvalInputTainted(code, "src/run.rs")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "eval(payload);";
		expect(checkEvalInputTainted(code, "src/foo.test.ts")).toEqual([]);
	});
});
