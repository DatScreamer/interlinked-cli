import { describe, expect, it } from "vitest";
import {
	configuredCeilingBytes,
	DEFAULT_DAEMON_HEAP_MB,
	DEFAULT_RSS_CEILING_BYTES,
	shouldRecycle,
} from "./memory-ceiling.js";

/**
 * The daemon grows under sustained edit traffic and, past roughly 750MB on a
 * swap-bound machine, stops answering the socket within the hook's timeout.
 * It is not killed — it is alive and too slow, which the hook reports as
 * "pid present, no live daemon". The old process then lingers as an orphan
 * holding the memory the replacement needs.
 *
 * The root cause is not isolated. This bounds the SYMPTOM: exit cleanly while
 * still healthy so the existing self-heal starts a fresh daemon, rather than
 * degrading into a hang. Recycling a stateless-by-design guard is cheap; a
 * hung one blocks the agent's next tool call.
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
		expect(DEFAULT_RSS_CEILING_BYTES).toBeLessThan(2048 * 1024 * 1024);
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

	it("converts a valid MB override to bytes", () => {
		expect(configuredCeilingBytes({ INTERLINKED_HARNESS_RSS_CEILING_MB: "500" })).toBe(
			500 * 1024 * 1024,
		);
	});

	it("floors a fractional MB override rather than rounding", () => {
		expect(configuredCeilingBytes({ INTERLINKED_HARNESS_RSS_CEILING_MB: "10.7" })).toBe(
			10 * 1024 * 1024,
		);
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

	it("defaults to process.env when no env argument is passed", () => {
		const prior = process.env.INTERLINKED_HARNESS_RSS_CEILING_MB;
		process.env.INTERLINKED_HARNESS_RSS_CEILING_MB = "42";
		try {
			expect(configuredCeilingBytes()).toBe(42 * 1024 * 1024);
		} finally {
			if (prior === undefined) delete process.env.INTERLINKED_HARNESS_RSS_CEILING_MB;
			else process.env.INTERLINKED_HARNESS_RSS_CEILING_MB = prior;
		}
	});
});
