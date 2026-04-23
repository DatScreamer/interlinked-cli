import { describe, expect, it } from "vitest";
import {
	checkpointArchiveCommand,
	checkpointCommand,
	checkpointCompareCommand,
	checkpointListCommand,
	checkpointPruneCommand,
	checkpointShowCommand,
} from "./checkpoint.js";

// Thin import-level tests: assert every exported command function is
// callable. Deep behavioral coverage requires mocking fs / network /
// subprocess, tracked separately. The import itself catches missing
// exports, syntax errors, and cyclic import failures.

describe("checkpoint command module", () => {
	it("exports checkpointCommand as a function", () => {
		expect(typeof checkpointCommand).toBe("function");
	});

	it("exports checkpointListCommand as a function", () => {
		expect(typeof checkpointListCommand).toBe("function");
	});

	it("exports checkpointShowCommand as a function", () => {
		expect(typeof checkpointShowCommand).toBe("function");
	});

	it("exports checkpointCompareCommand as a function", () => {
		expect(typeof checkpointCompareCommand).toBe("function");
	});

	it("exports checkpointPruneCommand as a function", () => {
		expect(typeof checkpointPruneCommand).toBe("function");
	});

	it("exports checkpointArchiveCommand as a function", () => {
		expect(typeof checkpointArchiveCommand).toBe("function");
	});
});
