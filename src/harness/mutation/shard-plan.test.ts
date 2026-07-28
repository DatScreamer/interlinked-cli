import { describe, expect, it } from "vitest";
import { planShards } from "./shard-plan.js";

/** Every plan must tile 1..total exactly: no gaps, no overlaps, nothing outside. */
function assertTiles(shards: { start: number; end: number }[], total: number): void {
	expect(shards[0]?.start).toBe(1);
	expect(shards[shards.length - 1]?.end).toBe(total);
	for (let i = 1; i < shards.length; i++) {
		// Contiguous: each shard starts exactly one line after the previous ended.
		expect(shards[i]?.start).toBe((shards[i - 1]?.end ?? 0) + 1);
	}
	for (const s of shards) expect(s.end).toBeGreaterThanOrEqual(s.start);
}

/** Total lines covered, used to prove nothing is dropped or double-counted. */
function coveredLines(shards: { start: number; end: number }[]): number {
	return shards.reduce((n, s) => n + (s.end - s.start + 1), 0);
}

describe("planShards — degenerate inputs (must not produce a bogus range)", () => {
	it("returns no shards for a zero-line file", () => {
		expect(planShards(0, 2)).toEqual([]);
	});

	it("returns no shards for a negative line count", () => {
		expect(planShards(-5, 2)).toEqual([]);
	});

	it("returns a single whole-file shard when shardCount is 1", () => {
		expect(planShards(100, 1)).toEqual([{ start: 1, end: 100 }]);
	});

	it("returns a single whole-file shard when shardCount is 0 or negative", () => {
		expect(planShards(100, 0)).toEqual([{ start: 1, end: 100 }]);
		expect(planShards(100, -3)).toEqual([{ start: 1, end: 100 }]);
	});
});

describe("planShards — partitions", () => {
	it("splits evenly when the line count divides cleanly", () => {
		const shards = planShards(100, 2);
		expect(shards).toEqual([
			{ start: 1, end: 50 },
			{ start: 51, end: 100 },
		]);
		assertTiles(shards, 100);
	});

	it("distributes the remainder instead of dropping it", () => {
		// 233 is odd: a naive floor-split would leave line 233 unmutated, and an
		// unmutated line is a survivor nobody ever hears about.
		const shards = planShards(233, 2);
		expect(shards).toHaveLength(2);
		expect(coveredLines(shards)).toBe(233);
		assertTiles(shards, 233);
	});

	it("tiles exactly for an awkward count across three shards", () => {
		const shards = planShards(7, 3);
		expect(shards).toHaveLength(3);
		expect(coveredLines(shards)).toBe(7);
		assertTiles(shards, 7);
	});

	it("never emits more shards than there are lines", () => {
		// 3 lines across 8 machines: 8 shards would mean empty ranges, and an empty
		// --mutate range makes Stryker mutate the WHOLE file on every shard.
		const shards = planShards(3, 8);
		expect(shards.length).toBeLessThanOrEqual(3);
		assertTiles(shards, 3);
	});

	it("handles a one-line file", () => {
		expect(planShards(1, 4)).toEqual([{ start: 1, end: 1 }]);
	});

	it("tiles exactly across many shard counts and sizes", () => {
		let checked = 0;
		for (const total of [1, 2, 5, 13, 100, 232, 1001]) {
			for (const n of [1, 2, 3, 4, 7, 16]) {
				const shards = planShards(total, n);
				expect(coveredLines(shards)).toBe(total);
				assertTiles(shards, total);
				checked++;
			}
		}
		expect(checked).toBe(42);
	});
});
