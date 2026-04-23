import { describe, expect, it } from "vitest";
import { logsCommand } from "./logs.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("logs command module", () => {
	it("exports logsCommand as a function", () => {
		expect(typeof logsCommand).toBe("function");
	});
});
