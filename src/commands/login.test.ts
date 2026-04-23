import { describe, expect, it } from "vitest";
import { loginCommand } from "./login.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("login command module", () => {
	it("exports loginCommand as a function", () => {
		expect(typeof loginCommand).toBe("function");
	});
});
