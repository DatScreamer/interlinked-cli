// Tests for `ubs_defer_in_loop` (Plan 04 D.1 backlog).

import { describe, expect, it } from "vitest";
import { checkDeferInLoop } from "../checks/ubs-language-specific.js";

describe("checkDeferInLoop", () => {
	it("flags `defer` inside a for loop", () => {
		const code =
			"func process(paths []string) {\n  for _, p := range paths {\n    f, _ := os.Open(p)\n    defer f.Close()\n  }\n}\n";
		const matches = checkDeferInLoop(code, "src/main.go");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag `defer` at function top-level", () => {
		const code = "func process() {\n  f, _ := os.Open(\"x\")\n  defer f.Close()\n}\n";
		expect(checkDeferInLoop(code, "src/main.go")).toEqual([]);
	});

	it("does NOT fire on JS files", () => {
		const code = "for {\n  defer f();\n}";
		expect(checkDeferInLoop(code, "src/main.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "for _, p := range x {\n  defer cleanup()\n}";
		expect(checkDeferInLoop(code, "src/main_test.go")).toEqual([]);
	});
});
