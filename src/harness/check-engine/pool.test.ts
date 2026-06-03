import { describe, expect, it } from "vitest";
import { createLimiter } from "./pool.js";

describe("createLimiter", () => {
	it("runs all tasks when count is below the limit", async () => {
		const limit = createLimiter(3);
		const results = await Promise.all([
			limit(() => Promise.resolve(1)),
			limit(() => Promise.resolve(2)),
			limit(() => Promise.resolve(3)),
		]);
		expect(results).toEqual([1, 2, 3]);
	});

	it("queues tasks above the limit", async () => {
		const limit = createLimiter(2);
		let inFlight = 0;
		let maxInFlight = 0;
		const task = async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			// interlinked-ignore: hardcoded_timeout_in_tests — simulated task duration to exercise the concurrency limiter
			await new Promise((r) => setTimeout(r, 30));
			inFlight--;
			return inFlight;
		};
		await Promise.all(Array.from({ length: 6 }, () => limit(task)));
		expect(maxInFlight).toBeLessThanOrEqual(2);
	});

	it("propagates rejections without breaking other tasks", async () => {
		const limit = createLimiter(2);
		const a = limit(() => Promise.reject(new Error("boom")));
		const b = limit(() => Promise.resolve(42));
		await expect(a).rejects.toThrow("boom");
		await expect(b).resolves.toBe(42);
	});

	it("preserves submission order in the FIFO queue", async () => {
		// With a limit of 1, tasks run strictly in submission order.
		const limit = createLimiter(1);
		const completionOrder: number[] = [];
		await Promise.all(
			[1, 2, 3, 4].map((n) =>
				limit(async () => {
					// interlinked-ignore: hardcoded_timeout_in_tests — simulated task duration to exercise the concurrency limiter
					await new Promise((r) => setTimeout(r, 10));
					completionOrder.push(n);
					return n;
				}),
			),
		);
		expect(completionOrder).toEqual([1, 2, 3, 4]);
	});

	it("treats a zero or negative limit as 1 (no infinite recursion)", async () => {
		const limit = createLimiter(0);
		await expect(limit(() => Promise.resolve("ok"))).resolves.toBe("ok");
	});
});
