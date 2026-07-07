import { describe, expect, it } from "vitest";
import { computeTotal } from "./order.js";

describe("computeTotal", () => {
	it("sums price times quantity", () => {
		expect(
			computeTotal([
				{ price: 2, qty: 3 },
				{ price: 1, qty: 1 },
			]),
		).toBe(7);
	});

	it("returns 0 for an empty cart", () => {
		expect(computeTotal([])).toBe(0);
	});
});
