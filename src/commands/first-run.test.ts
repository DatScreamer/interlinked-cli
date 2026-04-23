import { describe, expect, it } from "vitest";
import { handleImplicitEntry } from "./first-run.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("first-run command module", () => {
	it("exports handleImplicitEntry as a function", () => {
		expect(typeof handleImplicitEntry).toBe("function");
	});
});
