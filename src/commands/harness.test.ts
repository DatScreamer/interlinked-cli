import { describe, expect, it } from "vitest";
import { harnessStartCommand, isHarnessRunning } from "./harness.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("harness command module", () => {
	it("exports isHarnessRunning as a function", () => {
		expect(typeof isHarnessRunning).toBe("function");
	});

	it("exports harnessStartCommand as a function", () => {
		expect(typeof harnessStartCommand).toBe("function");
	});
});
