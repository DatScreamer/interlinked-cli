import { describe, expect, it } from "vitest";
import { resumeCommand } from "./resume.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("resume command module", () => {
	it("exports resumeCommand as a function", () => {
		expect(typeof resumeCommand).toBe("function");
	});
});
