import { describe, expect, it } from "vitest";
import { searchCommand } from "./search.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("search command module", () => {
	it("exports searchCommand as a function", () => {
		expect(typeof searchCommand).toBe("function");
	});
});
