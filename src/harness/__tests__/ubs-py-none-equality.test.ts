// Tests for `ubs_py_none_equality` (row 25 of Phase-1 Plan 04 phase matrix).
// Detects `x == None` / `x != None` in Python; should be `is None` / `is not None`.

import { describe, expect, it } from "vitest";
import { checkPyNoneEquality } from "../checks/ubs-language-specific.js";

describe("checkPyNoneEquality", () => {
	it("flags `if x == None:` in .py", () => {
		const code = "if x == None: return";
		const matches = checkPyNoneEquality(code, "main.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `if x != None:` in .py", () => {
		const code = "if x != None: do_thing()";
		const matches = checkPyNoneEquality(code, "lib.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `value == None` (Yoda style: `None == value`)", () => {
		const code = "if None == value: pass";
		const matches = checkPyNoneEquality(code, "main.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag `if x is None:` (PEP 8 correct form)", () => {
		const code = "if x is None: return";
		expect(checkPyNoneEquality(code, "main.py")).toEqual([]);
	});

	it("does NOT flag `if x is not None:` (PEP 8 correct form)", () => {
		const code = "if x is not None: do_thing()";
		expect(checkPyNoneEquality(code, "main.py")).toEqual([]);
	});

	it("does NOT flag `x == NoneType` (different identifier)", () => {
		const code = "if x == NoneType: return";
		expect(checkPyNoneEquality(code, "main.py")).toEqual([]);
	});

	it("does NOT flag a comment that mentions `== None`", () => {
		const code = "# never compare with == None";
		expect(checkPyNoneEquality(code, "main.py")).toEqual([]);
	});

	it("returns empty for non-Python files", () => {
		const code = "if (x == None) { return; }";
		expect(checkPyNoneEquality(code, "main.ts")).toEqual([]);
		expect(checkPyNoneEquality(code, "main.rs")).toEqual([]);
	});
});
