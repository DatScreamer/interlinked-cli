import { describe, expect, it } from "vitest";
import { formatReceipt } from "./report.js";

describe("formatReceipt", () => {
	it("formats the total to two decimals", () => {
		expect(formatReceipt([{ price: 2.5, qty: 2 }])).toBe("TOTAL: $5.00");
	});
});
