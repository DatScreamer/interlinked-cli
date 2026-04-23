import { describe, expect, it } from "vitest";
import { rewindCommand } from "./rewind.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("rewind command module", () => {
	it("exports rewindCommand as a function", () => {
		expect(typeof rewindCommand).toBe("function");
	});
});
