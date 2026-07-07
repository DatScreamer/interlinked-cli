import { computeTotal } from "./order.js";

export function formatReceipt(items) {
	return `TOTAL: $${computeTotal(items).toFixed(2)}`;
}
