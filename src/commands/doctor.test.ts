import { describe, expect, it } from "vitest";
import { doctorCommand } from "./doctor.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("doctor command module", () => {
	it("exports doctorCommand as a function", () => {
		expect(typeof doctorCommand).toBe("function");
	});
});
