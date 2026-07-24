// G4 ambient clock — pins the two properties the determinism program rests on
// (docs/design/reproducibility/g4-harness-determinism.md): inside
// runWithClock the frozen time wins across await points, and CONCURRENT
// evaluations keep their own clocks (the daemon is per-connection serial but
// cross-connection interleavable — a module-global would bleed; audited
// 2026-07-24, falsifier-confirmed no serialization primitive exists).

import { describe, expect, it } from "vitest";
import { harnessNow, runWithClock } from "./harness-clock.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

describe("harnessNow / runWithClock", () => {
	it("returns real time outside any clock scope", () => {
		const before = Date.now();
		const now = harnessNow();
		expect(now).toBeGreaterThanOrEqual(before);
		expect(now).toBeLessThanOrEqual(Date.now());
	});

	it("returns the frozen time inside a scope, across await points", async () => {
		const frozen = 1_753_000_000_000;
		const observed = await runWithClock(frozen, async () => {
			const first = harnessNow();
			await sleep(5);
			return { first, second: harnessNow() };
		});
		expect(observed).toEqual({ first: frozen, second: frozen });
	});

	it("isolates concurrent scopes (no bleed between interleaved evaluations)", async () => {
		const [a, b] = await Promise.all([
			runWithClock(1_000, async () => {
				await sleep(8);
				return harnessNow();
			}),
			runWithClock(2_000, async () => {
				await sleep(2);
				return harnessNow();
			}),
		]);
		expect(a).toBe(1_000);
		expect(b).toBe(2_000);
	});

	it("nests: inner scope wins, outer restores after", async () => {
		const result = await runWithClock(10, async () => {
			const outer = harnessNow();
			const inner = await runWithClock(20, async () => harnessNow());
			return { outer, inner, restored: harnessNow() };
		});
		expect(result).toEqual({ outer: 10, inner: 20, restored: 10 });
	});

	it("supports synchronous bodies too", () => {
		expect(runWithClock(42, () => harnessNow())).toBe(42);
	});
});
