import { describe, expect, it } from "vitest";
import { sendCommand } from "./send.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("send command module", () => {
	it("exports sendCommand as a function", () => {
		expect(typeof sendCommand).toBe("function");
	});
});
