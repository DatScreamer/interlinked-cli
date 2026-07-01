import { describe, expect, it, vi } from "vitest";
import { getCheckInventory } from "../harness/check-inventory.js";
import { harnessChecksCommand } from "./harness-checks.js";

/** Run `fn` and return everything it wrote to console.log, joined by newlines. */
function capture(fn: () => void): string {
	const spy = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		fn();
		return spy.mock.calls.map((c) => c.join(" ")).join("\n");
	} finally {
		spy.mockRestore();
	}
}

// These tests verify the command faithfully RENDERS the inventory. The actual
// COUNTS are pinned once, in check-inventory.test.ts — so adding a check never
// forces an edit here.
describe("harnessChecksCommand", () => {
	it("normal mode prints the total and every family label", () => {
		const out = capture(() => harnessChecksCommand({}));
		const inv = getCheckInventory();
		expect(out).toContain("Total checks");
		expect(out).toContain(String(inv.total));
		for (const f of inv.families) {
			expect(out, `family ${f.key} label`).toContain(f.label);
		}
	});

	it("--json round-trips the full inventory object", () => {
		const out = capture(() => harnessChecksCommand({ json: true }));
		// SAFETY: --json mode serialized getCheckInventory() with JSON.stringify;
		// parsing it back yields the identical CheckInventory shape, which the
		// assertions below verify field-by-field.
		const parsed = JSON.parse(out) as ReturnType<typeof getCheckInventory>;
		const inv = getCheckInventory();
		expect(parsed.total).toBe(inv.total);
		expect(parsed.families).toEqual(inv.families);
	});

	it("--short is a single summary line carrying the total", () => {
		const out = capture(() => harnessChecksCommand({ short: true }));
		expect(out.trim()).not.toContain("\n");
		expect(out).toContain(`${getCheckInventory().total} checks`);
	});

	it("--full surfaces the authoritative source of each count", () => {
		const out = capture(() => harnessChecksCommand({ full: true }));
		expect(out).toContain("CHECK_REGISTRY");
	});
});
