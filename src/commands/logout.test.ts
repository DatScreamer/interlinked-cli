import { describe, expect, it } from "vitest";
import { logoutCommand } from "./logout.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("logout command module", () => {
	it("exports logoutCommand as a function", () => {
		expect(typeof logoutCommand).toBe("function");
	});
});
