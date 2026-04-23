import { describe, expect, it } from "vitest";
import { updateCommand } from "./update.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("update command module", () => {
	it("exports updateCommand as a function", () => {
		expect(typeof updateCommand).toBe("function");
	});
});
