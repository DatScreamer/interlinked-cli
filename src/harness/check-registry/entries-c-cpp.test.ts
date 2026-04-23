import { describe, expect, it } from "vitest";
import { C_CPP_ENTRIES } from "./entries-c-cpp.js";

describe("C_CPP_ENTRIES", () => {
	it("is non-empty", () => {
		expect(C_CPP_ENTRIES.length).toBeGreaterThan(0);
	});

	it("every entry is in the agent_safety pipeline", () => {
		for (const c of C_CPP_ENTRIES) {
			expect(c.pipeline).toBe("agent_safety");
		}
	});

	it("every check fn is a no-op on non-C/C++ file paths (skip gate)", () => {
		for (const c of C_CPP_ENTRIES) {
			// Feeding a .ts file should return no matches — these checks only
			// fire on C/C++ extensions.
			expect(c.fn("some content", "unrelated.ts")).toEqual([]);
		}
	});

	it("every entry has the required fields", () => {
		for (const c of C_CPP_ENTRIES) {
			expect(c.id, "id").toMatch(/^[a-z][a-z0-9_]*$/);
			expect(typeof c.fn).toBe("function");
			expect(c.fix_instruction.length).toBeGreaterThan(20);
		}
	});
});
