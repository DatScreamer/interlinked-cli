import { describe, expect, it } from "vitest";
import { envCommand } from "./env.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("env command module", () => {
	it("exports envCommand as a function", () => {
		expect(typeof envCommand).toBe("function");
	});
});
