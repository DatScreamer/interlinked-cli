import { describe, expect, it } from "vitest";
import { syncCommand } from "./sync.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("sync command module", () => {
	it("exports syncCommand as a function", () => {
		expect(typeof syncCommand).toBe("function");
	});
});
