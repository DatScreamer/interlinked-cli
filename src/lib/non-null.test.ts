import { describe, expect, it } from "vitest";
import { nonNull } from "./non-null.js";

describe("nonNull", () => {
	it("returns the value when present", () => {
		expect(nonNull("x")).toBe("x");
		expect(nonNull(42)).toBe(42);
		const obj = { a: 1 };
		expect(nonNull(obj)).toBe(obj);
	});

	it("passes through defined-but-falsy values (not a truthiness check)", () => {
		expect(nonNull(0)).toBe(0);
		expect(nonNull("")).toBe("");
		expect(nonNull(false)).toBe(false);
		expect(nonNull(Number.NaN)).toBeNaN();
	});

	it("throws on undefined", () => {
		expect(() => nonNull(undefined)).toThrow(/expected a value/);
	});

	it("throws on null", () => {
		expect(() => nonNull(null)).toThrow(/expected a value/);
	});

	it("includes the caller-supplied message in the thrown error", () => {
		expect(() => nonNull(undefined, "lines[i] must exist")).toThrow("lines[i] must exist");
	});

	it("narrows provably-safe index access (the migration call site)", () => {
		const items: readonly number[] = [10, 20, 30];
		expect(nonNull(items[0])).toBe(10);
		expect(nonNull(items[items.length - 1])).toBe(30);
	});
});
