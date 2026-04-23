import { describe, expect, it } from "vitest";
import { enableCommand } from "./enable.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("enable command module", () => {
	it("exports enableCommand as a function", () => {
		expect(typeof enableCommand).toBe("function");
	});
});
