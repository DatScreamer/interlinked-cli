// Tests for `ubs_goroutine_no_waitgroup` (Plan 04 D.1 backlog).

import { describe, expect, it } from "vitest";
import { checkGoroutineNoWaitgroup } from "../checks/ubs-language-specific.js";

describe("checkGoroutineNoWaitgroup", () => {
	it("flags fire-and-forget `go func`", () => {
		const code = "func main() {\n  go func() {\n    work()\n  }()\n}\n";
		const matches = checkGoroutineNoWaitgroup(code, "src/main.go");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does NOT flag `go func` paired with `wg.Done()`", () => {
		const code =
			"var wg sync.WaitGroup\nwg.Add(1)\ngo func() {\n  defer wg.Done()\n  work()\n}()\nwg.Wait()\n";
		expect(checkGoroutineNoWaitgroup(code, "src/main.go")).toEqual([]);
	});

	it("does NOT fire on JS files", () => {
		const code = "go func() {}();";
		expect(checkGoroutineNoWaitgroup(code, "src/main.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "go func() { work() }()";
		expect(checkGoroutineNoWaitgroup(code, "src/main_test.go")).toEqual([]);
	});
});
