import { describe, expect, it } from "vitest";
import { statusCommand } from "./status.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("status command module", () => {
	it("exports statusCommand as a function", () => {
		expect(typeof statusCommand).toBe("function");
	});
});
