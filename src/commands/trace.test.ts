import { describe, expect, it } from "vitest";
import { traceExportCommand, traceImportCommand } from "./trace.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("trace command module", () => {
	it("exports traceExportCommand as a function", () => {
		expect(typeof traceExportCommand).toBe("function");
	});

	it("exports traceImportCommand as a function", () => {
		expect(typeof traceImportCommand).toBe("function");
	});
});
