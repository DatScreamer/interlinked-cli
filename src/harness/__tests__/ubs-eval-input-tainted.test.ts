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

	// FP refinement (139-repo audit, 2026-05): respect Bandit `# noqa:
	// S307 / S102` suppression when the author has explicitly
	// acknowledged the eval pattern. Supermodel's mcpbr/custom_metrics.py
	// was the canonical case (sandboxed eval, intent comment).

	it("does NOT fire on Python `eval(...)` with `# noqa: S307`", () => {
		const code = `value = float(eval(metric_def.compute_fn, {"__builtins__": {}}, ns))  # noqa: S307`;
		expect(checkEvalInputTainted(code, "src/metrics.py")).toEqual([]);
	});

	it("does NOT fire on Python `exec(...)` with `# noqa: S102`", () => {
		const code = `def run(payload):\n    exec(payload)  # noqa: S102 -- sandboxed via __builtins__: {}`;
		expect(checkEvalInputTainted(code, "src/run.py")).toEqual([]);
	});

	it("does NOT fire on Python `eval(...)` with bare `# noqa`", () => {
		const code = `value = eval(expr)  # noqa`;
		expect(checkEvalInputTainted(code, "src/calc.py")).toEqual([]);
	});

	// Positive cases — real positives MUST still fire.

	it("STILL fires on `eval(user_input)` with no noqa", () => {
		const code = `value = eval(user_input)`;
		expect(checkEvalInputTainted(code, "src/calc.py").length).toBeGreaterThan(0);
	});

	it("STILL fires when noqa carries an unrelated code (e.g. E501)", () => {
		// E501 = line-length; not in the bandit map for eval — must NOT
		// suppress.
		const code = `value = eval(user_input)  # noqa: E501`;
		expect(checkEvalInputTainted(code, "src/calc.py").length).toBeGreaterThan(0);
	});

	it("STILL fires when noqa carries an unrelated bandit code (e.g. S301)", () => {
		// S301 = pickle; must NOT suppress an eval finding.
		const code = `value = eval(user_input)  # noqa: S301`;
		expect(checkEvalInputTainted(code, "src/calc.py").length).toBeGreaterThan(0);
	});

	// FP refinement (139-repo audit, 2026-05): cross-language gate. JS
	// `exec(cmd)` is almost always `child_process.exec` (shell-out),
	// caught by `child_process_exec_user_input`. JS `compile(...)`
	// doesn't exist as a global. Both must NOT match `ubs_eval_input_
	// tainted` in JS/TS files. Python keeps the full `eval/exec/compile`
	// set.

	it("does NOT fire on JS `exec(cmd)` (Supermodel cli/npm/install.js shape)", () => {
		// The exact shape from Supermodel install.js:86 — postinstall
		// shell-out for binary extraction. Different bug class.
		const code = [
			"const { exec } = require('child_process');",
			"function install() {",
			"  const cmd = `tar -xf ${tmpFile}`;",
			"  exec(cmd);",
			"}",
		].join("\n");
		expect(checkEvalInputTainted(code, "cli/npm/install.js")).toEqual([]);
	});

	it("does NOT fire on TS `exec(cmd)` (Node child_process)", () => {
		const code = [
			"import { exec } from 'child_process';",
			"export function run(cmd: string) {",
			"  exec(cmd);",
			"}",
		].join("\n");
		expect(checkEvalInputTainted(code, "src/runner.ts")).toEqual([]);
	});

	it("does NOT fire on JS `compile(x)` (rare — but not eval-class)", () => {
		const code = `const fn = compile(template);`;
		expect(checkEvalInputTainted(code, "src/template.js")).toEqual([]);
	});

	// Positive cases — Python still must catch all forms; JS still must
	// catch eval / Function.

	it("STILL fires on Python `exec(payload)`", () => {
		const code = `def run(payload):\n    exec(payload)`;
		expect(checkEvalInputTainted(code, "src/run.py").length).toBeGreaterThan(0);
	});

	it("STILL fires on Python `compile(src, ..., 'exec')` with identifier", () => {
		const code = `def make(src):\n    return compile(src, '<str>', 'exec')`;
		expect(checkEvalInputTainted(code, "src/run.py").length).toBeGreaterThan(0);
	});

	it("STILL fires on JS `eval(rawCode)` (the true eval-class)", () => {
		const code = "function exec(rawCode) { return eval(rawCode); }";
		expect(checkEvalInputTainted(code, "src/run.js").length).toBeGreaterThan(0);
	});

	it("STILL fires on JS `Function(srcCode)` (Function constructor — eval-class)", () => {
		const code = `const fn = Function(srcCode);`;
		expect(checkEvalInputTainted(code, "src/dyn.js").length).toBeGreaterThan(0);
	});
});
