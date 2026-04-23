import { describe, expect, it } from "vitest";
import { resetCommand } from "./reset.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("reset command module", () => {
	it("exports resetCommand as a function", () => {
		expect(typeof resetCommand).toBe("function");
	});
});
