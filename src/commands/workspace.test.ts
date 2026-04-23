import { describe, expect, it } from "vitest";
import { workspaceListCommand, workspaceSwitchCommand } from "./workspace.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("workspace command module", () => {
	it("exports workspaceListCommand as a function", () => {
		expect(typeof workspaceListCommand).toBe("function");
	});

	it("exports workspaceSwitchCommand as a function", () => {
		expect(typeof workspaceSwitchCommand).toBe("function");
	});
});
