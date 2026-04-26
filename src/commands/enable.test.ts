import { describe, expect, it } from "vitest";
import { buildPostEnableNotes, enableCommand } from "./enable.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("enable command module", () => {
	it("exports enableCommand as a function", () => {
		expect(typeof enableCommand).toBe("function");
	});

	it("notes that Codex needs a fresh session after enable", () => {
		expect(buildPostEnableNotes(["codex"])).toContain(
			"Restart Codex or open a new Codex session to load updated hooks.",
		);
	});

	it("omits the Codex restart note for other clients", () => {
		expect(buildPostEnableNotes(["claude", "gemini"])).toEqual([]);
	});
});
