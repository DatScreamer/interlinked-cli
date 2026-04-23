import { describe, expect, it } from "vitest";
import { handoffCommand } from "./handoff.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("handoff command module", () => {
	it("exports handoffCommand as a function", () => {
		expect(typeof handoffCommand).toBe("function");
	});
});
