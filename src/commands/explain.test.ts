import { describe, expect, it } from "vitest";
import { explainCommand } from "./explain.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("explain command module", () => {
	it("exports explainCommand as a function", () => {
		expect(typeof explainCommand).toBe("function");
	});
});
