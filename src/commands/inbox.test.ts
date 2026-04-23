import { describe, expect, it } from "vitest";
import { inboxCommand } from "./inbox.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("inbox command module", () => {
	it("exports inboxCommand as a function", () => {
		expect(typeof inboxCommand).toBe("function");
	});
});
