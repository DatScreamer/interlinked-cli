import { describe, expect, it } from "vitest";
import { structureInitCommand, structureScanCommand } from "./structure.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("structure command module", () => {
	it("exports structureInitCommand as a function", () => {
		expect(typeof structureInitCommand).toBe("function");
	});

	it("exports structureScanCommand as a function", () => {
		expect(typeof structureScanCommand).toBe("function");
	});
});
