import { describe, expect, it } from "vitest";
import { disableCommand } from "./disable.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("disable command module", () => {
	it("exports disableCommand as a function", () => {
		expect(typeof disableCommand).toBe("function");
	});
});
