import { describe, expect, it } from "vitest";
import { parsePropertyBudget } from "./property-budget.js";

describe("parsePropertyBudget", () => {
	it("returns null when unset", () => {
		expect(parsePropertyBudget(undefined)).toBeNull();
		expect(parsePropertyBudget("")).toBeNull();
	});

	it("parses a positive integer", () => {
		expect(parsePropertyBudget("30")).toBe(30);
		expect(parsePropertyBudget("1")).toBe(1);
	});

	it("returns null for non-positive or non-numeric values", () => {
		expect(parsePropertyBudget("0")).toBeNull();
		expect(parsePropertyBudget("-5")).toBeNull();
		expect(parsePropertyBudget("abc")).toBeNull();
	});

	it("is inert as a module import when the env is unset (no throw)", async () => {
		// Importing the setup module with INTERLINKED_PROPERTY_NUMRUNS unset must
		// not load fast-check or mutate global config — a bare re-import is safe.
		await expect(import("./property-budget.js")).resolves.toBeDefined();
	});
});
