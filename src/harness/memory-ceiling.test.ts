import { describe, expect, it } from "vitest";
import {
	configuredCeilingBytes,
	configuredHeapMb,
	DEFAULT_DAEMON_HEAP_MB,
	DEFAULT_RSS_CEILING_BYTES,
	shouldRecycle,
} from "./memory-ceiling.js";

describe("configuredHeapMb", () => {
	it("accepts a bounded override and floors fractions when the RSS ceiling has headroom", () => {
		expect(
			configuredHeapMb({
				INTERLINKED_HARNESS_HEAP_MB: "2048.9",
				INTERLINKED_HARNESS_RSS_CEILING_MB: "3072",
			}),
		).toBe(2048);
	});

	it("caps the heap below the RSS backstop and rejects runaway Node argv", () => {
		expect(configuredHeapMb({ INTERLINKED_HARNESS_HEAP_MB: "2048" })).toBe(1536);
		expect(
			configuredHeapMb({
				INTERLINKED_HARNESS_HEAP_MB: "999999999999",
				INTERLINKED_HARNESS_RSS_CEILING_MB: "10000",
			}),
		).toBe(4096);
	});

	it.each([undefined, "", "0", "-1", "Infinity", "NaN", "0.5"])(
		"falls back for an unusable override: %s",
		(value) => {
			const env = value === undefined ? {} : { INTERLINKED_HARNESS_HEAP_MB: value };
			expect(configuredHeapMb(env)).toBe(DEFAULT_DAEMON_HEAP_MB);
		},
	);
});

/**
 * The daemon grows under sustained edit traffic and, past roughly 750MB on a
 * swap-bound machine, stops answering the socket within the hook's timeout.
 * It is not killed — it is alive and too slow, which the hook reports as
 * "pid present, no live daemon". The old process then lingers as an orphan
 * holding the memory the replacement needs.
 *
 * The dominant root cause was a full read of a 1 GiB append-only activity log,
 * compounded by compiler/test fanout. Those paths are now bounded, and this
 * remains the hard machine-safety backstop for any future growth: exit cleanly
 * before a second daemon can overlap the bloated heap.
 */
describe("shouldRecycle", () => {
	it("keeps running well under the ceiling", () => {
		expect(shouldRecycle(100 * 1024 * 1024, DEFAULT_RSS_CEILING_BYTES)).toBe(false);
	});

	it("recycles once RSS crosses the ceiling", () => {
		expect(shouldRecycle(DEFAULT_RSS_CEILING_BYTES + 1, DEFAULT_RSS_CEILING_BYTES)).toBe(true);
	});

	it("does not recycle exactly AT the ceiling — the limit is inclusive", () => {
		// Off-by-one here would recycle a daemon that is precisely at its budget,
		// costing a restart for nothing.
		expect(shouldRecycle(DEFAULT_RSS_CEILING_BYTES, DEFAULT_RSS_CEILING_BYTES)).toBe(false);
	});

	it("treats a nonsensical reading as healthy rather than recycling blindly", () => {
		// process.memoryUsage() should never return these, but a recycle loop
		// driven by a bad reading would be far worse than ignoring it.
		for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
			expect(shouldRecycle(bad, DEFAULT_RSS_CEILING_BYTES)).toBe(false);
		}
	});

	it("ignores a non-positive ceiling — that is how the feature is disabled", () => {
		expect(shouldRecycle(10 ** 12, 0)).toBe(false);
		expect(shouldRecycle(10 ** 12, -1)).toBe(false);
	});

	it("keeps the ceiling a bounded backstop (not disabled, not runaway)", () => {
		// The former 3584MB default permitted the whole-system OOM class before
		// recycling. With compiler/test fanout removed, 2GB is the hard backstop.
		expect(DEFAULT_DAEMON_HEAP_MB).toBe(1536);
		expect(DEFAULT_RSS_CEILING_BYTES).toBe(2048 * 1024 * 1024);
		expect(DEFAULT_RSS_CEILING_BYTES).toBeGreaterThan(200 * 1024 * 1024);
	});

	it("keeps the V8 heap limit comfortably BELOW the RSS ceiling", () => {
		// The regulator/backstop ordering: V8 must hit GC pressure (heap limit)
		// well before the recycler hits the RSS ceiling. When these inverted
		// (heap 4096MB vs ceiling 500–700MB, 2026-07-28) V8 never ran a major GC
		// and every loaded daemon was recycled for carrying collectable garbage —
		// a permanent restart loop with the guard down in the gaps.
		const heapBytes = DEFAULT_DAEMON_HEAP_MB * 1024 * 1024;
		expect(heapBytes).toBeLessThan(DEFAULT_RSS_CEILING_BYTES);
		// Headroom for external memory + code + stacks before the backstop.
		expect(DEFAULT_RSS_CEILING_BYTES - heapBytes).toBeGreaterThan(150 * 1024 * 1024);
	});
});

describe("configuredCeilingBytes", () => {
	it("falls back to the default when the env var is undefined", () => {
		expect(configuredCeilingBytes({})).toBe(DEFAULT_RSS_CEILING_BYTES);
	});

	it("falls back to the default when the env var is an empty string", () => {
		expect(configuredCeilingBytes({ INTERLINKED_HARNESS_RSS_CEILING_MB: "" })).toBe(
			DEFAULT_RSS_CEILING_BYTES,
		);
	});

	it("falls back to the default for a whitespace-only override", () => {
		expect(configuredCeilingBytes({ INTERLINKED_HARNESS_RSS_CEILING_MB: " \t " })).toBe(
			DEFAULT_RSS_CEILING_BYTES,
		);
	});

	it("converts a valid bounded MB override to bytes", () => {
		expect(configuredCeilingBytes({ INTERLINKED_HARNESS_RSS_CEILING_MB: "3072" })).toBe(
			3072 * 1024 * 1024,
		);
	});

	it("floors a fractional MB override rather than rounding", () => {
		expect(configuredCeilingBytes({ INTERLINKED_HARNESS_RSS_CEILING_MB: "3072.7" })).toBe(
			3072 * 1024 * 1024,
		);
	});

	it.each(["1", "500", "2047"])("rejects an unusably low nonzero RSS ceiling: %s", (value) => {
		const env = { INTERLINKED_HARNESS_RSS_CEILING_MB: value };
		expect(configuredCeilingBytes(env)).toBe(DEFAULT_RSS_CEILING_BYTES);
		expect(configuredHeapMb(env)).toBe(DEFAULT_DAEMON_HEAP_MB);
	});

	it("treats 0 as a valid explicit override (the documented 'off' value), not malformed", () => {
		expect(configuredCeilingBytes({ INTERLINKED_HARNESS_RSS_CEILING_MB: "0" })).toBe(0);
	});

	it("falls back to the default (not 0) when the override is non-numeric", () => {
		expect(configuredCeilingBytes({ INTERLINKED_HARNESS_RSS_CEILING_MB: "not-a-number" })).toBe(
			DEFAULT_RSS_CEILING_BYTES,
		);
	});

	it("falls back to the default (not 0) when the override is negative", () => {
		expect(configuredCeilingBytes({ INTERLINKED_HARNESS_RSS_CEILING_MB: "-5" })).toBe(
			DEFAULT_RSS_CEILING_BYTES,
		);
	});

	it("bounds huge finite overrides before byte conversion can overflow", () => {
		const ceiling = configuredCeilingBytes({ INTERLINKED_HARNESS_RSS_CEILING_MB: "1e300" });
		expect(ceiling).toBe(8192 * 1024 * 1024);
		expect(Number.isFinite(ceiling)).toBe(true);
		expect(shouldRecycle(ceiling + 1, ceiling)).toBe(true);
	});

	it("defaults to process.env when no env argument is passed", () => {
		const prior = process.env.INTERLINKED_HARNESS_RSS_CEILING_MB;
		process.env.INTERLINKED_HARNESS_RSS_CEILING_MB = "3072";
		try {
			expect(configuredCeilingBytes()).toBe(3072 * 1024 * 1024);
		} finally {
			if (prior === undefined) delete process.env.INTERLINKED_HARNESS_RSS_CEILING_MB;
			else process.env.INTERLINKED_HARNESS_RSS_CEILING_MB = prior;
		}
	});
});
