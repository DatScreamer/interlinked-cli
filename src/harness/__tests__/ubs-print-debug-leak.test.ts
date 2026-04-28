// Tests for `ubs_print_debug_leak` (Plan 04 D.1 backlog).

import { describe, expect, it } from "vitest";
import { checkPrintDebugLeak } from "../checks/ubs-language-specific.js";

describe("checkPrintDebugLeak", () => {
	it("flags `console.log` in a non-test, non-CLI file", () => {
		const code = "function process() {\n  console.log('debug');\n}\n";
		const matches = checkPrintDebugLeak(code, "src/lib/process.ts");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags Python `print(...)` outside test files", () => {
		const code = "def calc(x):\n    print(x)\n    return x * 2\n";
		const matches = checkPrintDebugLeak(code, "src/lib/calc.py");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("flags Go `fmt.Println(...)`", () => {
		const code = "func process() {\n  fmt.Println(\"x\")\n}\n";
		const matches = checkPrintDebugLeak(code, "src/lib/proc.go");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT fire on test files", () => {
		const code = "console.log('debug');";
		expect(checkPrintDebugLeak(code, "src/foo.test.ts")).toEqual([]);
	});

	it("does NOT fire on /commands/ entry-point files", () => {
		const code = "console.log('hello');";
		expect(checkPrintDebugLeak(code, "src/commands/foo.ts")).toEqual([]);
	});
});
