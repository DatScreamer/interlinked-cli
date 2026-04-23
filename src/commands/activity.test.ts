import { describe, expect, it } from "vitest";
import { activityCommand } from "./activity.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("activity command module", () => {
	it("exports activityCommand as a function", () => {
		expect(typeof activityCommand).toBe("function");
	});
});
