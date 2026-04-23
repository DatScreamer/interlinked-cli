import { describe, expect, it } from "vitest";
import { gitContextCommand, gitLinkCheckpointCommand } from "./git.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("git command module", () => {
	it("exports gitContextCommand as a function", () => {
		expect(typeof gitContextCommand).toBe("function");
	});

	it("exports gitLinkCheckpointCommand as a function", () => {
		expect(typeof gitLinkCheckpointCommand).toBe("function");
	});
});
