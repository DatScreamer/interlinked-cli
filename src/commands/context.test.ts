import { describe, expect, it } from "vitest";
import { contextCommand } from "./context.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("context command module", () => {
	it("exports contextCommand as a function", () => {
		expect(typeof contextCommand).toBe("function");
	});
});
