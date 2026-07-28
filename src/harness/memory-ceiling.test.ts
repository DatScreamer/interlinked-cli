import { describe, expect, it } from "vitest";
import { DEFAULT_RSS_CEILING_BYTES, shouldRecycle } from "./memory-ceiling.js";

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

	it("has a default ceiling well below the ~750MB hang threshold", () => {
		// The point is to leave while still responsive, not to approach the cliff.
		expect(DEFAULT_RSS_CEILING_BYTES).toBeLessThan(750 * 1024 * 1024);
		expect(DEFAULT_RSS_CEILING_BYTES).toBeGreaterThan(200 * 1024 * 1024);
	});
});
