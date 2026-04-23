import { describe, expect, it } from "vitest";
import { watchCommand } from "./watch.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("watch command module", () => {
	it("exports watchCommand as a function", () => {
		expect(typeof watchCommand).toBe("function");
	});
});
