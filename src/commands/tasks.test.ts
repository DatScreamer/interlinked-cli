import { describe, expect, it } from "vitest";
import { tasksCreateCommand, tasksListCommand } from "./tasks.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("tasks command module", () => {
	it("exports tasksListCommand as a function", () => {
		expect(typeof tasksListCommand).toBe("function");
	});

	it("exports tasksCreateCommand as a function", () => {
		expect(typeof tasksCreateCommand).toBe("function");
	});
});
