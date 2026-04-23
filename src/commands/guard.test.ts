import { describe, expect, it } from "vitest";
import { guardCheckCommand, guardInstallCommand } from "./guard.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("guard command module", () => {
	it("exports guardInstallCommand as a function", () => {
		expect(typeof guardInstallCommand).toBe("function");
	});

	it("exports guardCheckCommand as a function", () => {
		expect(typeof guardCheckCommand).toBe("function");
	});
});
