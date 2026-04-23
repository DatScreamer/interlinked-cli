import { describe, expect, it } from "vitest";
import { registerIndexCommand } from "./index-cmd.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("index-cmd command module", () => {
	it("exports registerIndexCommand as a function", () => {
		expect(typeof registerIndexCommand).toBe("function");
	});
});
