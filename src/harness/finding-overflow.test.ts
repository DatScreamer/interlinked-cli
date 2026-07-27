import { describe, expect, it } from "vitest";
import { listWithOverflow, MAX_LISTED_FINDINGS } from "./finding-overflow.js";

const render = (n: number) => `  L${n}: item`;

describe("listWithOverflow", () => {
	it("renders every item when the list fits the cap", () => {
		expect(listWithOverflow([1, 2], render)).toBe("  L1: item\n  L2: item");
	});

	it("renders exactly at the cap with no overflow line", () => {
		const out = listWithOverflow([1, 2, 3, 4, 5], render);
		expect(out).not.toContain("more");
		expect(out.split("\n")).toHaveLength(5);
	});

	it("truncates past the cap and reports the remainder", () => {
		const out = listWithOverflow([1, 2, 3, 4, 5, 6, 7], render);
		expect(out).toContain("  L5: item");
		expect(out).not.toContain("  L6: item");
		expect(out).toContain("\n  ... and 2 more");
	});

	it("honours an explicit cap over the default", () => {
		expect(listWithOverflow([1, 2, 3], render, 1)).toBe("  L1: item\n  ... and 2 more");
	});

	it("returns an empty string for an empty list", () => {
		expect(listWithOverflow([], render)).toBe("");
	});

	// The 9 call sites this replaces all emitted exactly `\n  ... and N more`
	// with a two-space indent. Any drift here silently rewrites operator-facing
	// output at every one of them at once, so it is pinned byte-for-byte.
	it("reproduces the legacy suffix byte-for-byte", () => {
		const items = Array.from({ length: 8 }, (_, i) => i + 1);
		const legacy = `${items.slice(0, 5).map(render).join("\n")}\n  ... and ${items.length - 5} more`;
		expect(listWithOverflow(items, render)).toBe(legacy);
	});

	it("matches the legacy shape at the cap-8 and cap-10 sites too", () => {
		for (const cap of [8, 10]) {
			const items = Array.from({ length: cap + 3 }, (_, i) => i + 1);
			const legacy = `${items.slice(0, cap).map(render).join("\n")}\n  ... and 3 more`;
			expect(listWithOverflow(items, render, cap), `cap ${cap}`).toBe(legacy);
		}
	});

	it("exposes the default as a named constant rather than a literal", () => {
		expect(MAX_LISTED_FINDINGS).toBe(5);
		expect(listWithOverflow([1, 2, 3, 4, 5, 6], render)).toBe(
			listWithOverflow([1, 2, 3, 4, 5, 6], render, MAX_LISTED_FINDINGS),
		);
	});
});
