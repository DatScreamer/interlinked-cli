// Tests for `ubs_python_mutable_default_arg` (Plan 04 D.1 partial).
// Detects `def f(x=[])` / `def f(x={})` — Python evaluates default values
// once at def time, sharing the mutable object across every invocation.

import { describe, expect, it } from "vitest";
import { checkPyMutableDefaultArg } from "../checks/ubs-language-specific.js";

describe("checkPyMutableDefaultArg", () => {
	it("flags `def f(x=[])`", () => {
		const code = "def f(x=[]):\n    x.append(1)\n    return x\n";
		const matches = checkPyMutableDefaultArg(code, "src/foo.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `def g(x={})`", () => {
		const code = "def g(x={}):\n    return x\n";
		const matches = checkPyMutableDefaultArg(code, "src/foo.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags `def h(x=set())`", () => {
		const code = "def h(x=set()):\n    return x\n";
		const matches = checkPyMutableDefaultArg(code, "src/foo.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags multi-arg with type annotation: `def k(a: int, x: list = [])`", () => {
		const code = "def k(a: int, x: list = []):\n    return x\n";
		const matches = checkPyMutableDefaultArg(code, "src/foo.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag `def f(x=None)`", () => {
		const code = "def f(x=None):\n    if x is None: x = []\n    return x\n";
		expect(checkPyMutableDefaultArg(code, "src/foo.py")).toEqual([]);
	});

	it("does NOT flag immutable defaults", () => {
		const code = "def f(x=0, y=False, z='', w=()):\n    return x, y, z, w\n";
		expect(checkPyMutableDefaultArg(code, "src/foo.py")).toEqual([]);
	});

	it("does NOT fire on TypeScript files", () => {
		const code = "function f(x = []) { return x; }";
		expect(checkPyMutableDefaultArg(code, "src/foo.ts")).toEqual([]);
	});
});
