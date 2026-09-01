import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidecarPool, type SidecarPoolOptions } from "./sidecar-pool.js";
import type { SidecarStatus } from "./sidecar-manager.js";

// SidecarManager never spawns a real process during construction (it's lazy —
// only `.send()` triggers a spawn), so building a SidecarPool with these
// options never touches node:child_process as long as no test calls `.send()`.
function makePool(pool_size: number, onStatusChange?: (s: SidecarStatus) => void): SidecarPool {
	const opts: SidecarPoolOptions = {
		python_bin: "python3",
		script_path: "/dev/null",
		startup_timeout_ms: 1000,
		scan_timeout_ms: 1000,
		idle_shutdown_ms: 1000,
		max_restarts: 3,
		pool_size,
		onStatusChange,
	};
	return new SidecarPool(opts);
}

// SAFETY: `onChildStatus`/`computeAggregate` are private status-aggregation
// internals with no other reachable entry point; casting to reach them for
// direct unit coverage does not widen any externally-observed type.
// This loose alias reaches the private members described above for direct unit coverage.
type Peek = any;

describe("SidecarPool — computeAggregate / onChildStatus (mutation-kill w53)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// test-contract: invariant — the constructor pre-fills every pool slot
	// with an idle placeholder (sidecar-pool.ts L66-70), so computeAggregate
	// must observe all `pool_size` slots and sum their restartCounts, not
	// just the slot that was ever explicitly reported.
	it("covers all initial child slots and sums restart counts across them", () => {
		// Only child index 2 is ever reported; children 0 and 1 must still be
		// present as the constructor's "idle" placeholders and contribute to
		// the aggregate (kills the Array.from length/mapfn mutants, which
		// leave slots 0/1 empty/undefined, and the restartCount sign mutant).
		const pool = makePool(3);
		(pool as Peek).onChildStatus(2, {
			state: "ready",
			restartCount: 5,
			pid: 42,
			sinceIso: "2020-01-01T00:00:00.000Z",
		});
		const status = pool.getStatus();
		expect(status.state).toBe("ready");
		expect(status.pid).toBe(42);
		expect(status.restartCount).toBe(5);
		expect(status.detail).toBe("1/3 ready");
	});

	// test-contract: invariant — computeAggregate's readyCount block must only
	// fire for children whose state is literally "ready"; with the pool's
	// default all-idle state, readyCount and the aggregate detail string must
	// both reflect zero ready children.
	it("computeAggregate treats untouched default children as idle, none ready", () => {
		const pool = makePool(3);
		const agg = (pool as Peek).computeAggregate();
		expect(agg.state).toBe("idle");
		expect(agg.pid).toBeUndefined();
		expect(agg.detail).toBe("0/3 ready");
	});

	// test-contract: invariant — computeAggregate's firstReadyPid assignment
	// is guarded by `=== undefined` so it fires only once; the surfaced pid
	// must stay pinned to the first child that became ready, not the last.
	it("keeps the FIRST ready child's pid when multiple children become ready", () => {
		const pool = makePool(2);
		(pool as Peek).onChildStatus(0, { state: "ready", restartCount: 0, pid: 10, sinceIso: "a" });
		(pool as Peek).onChildStatus(1, { state: "ready", restartCount: 0, pid: 20, sinceIso: "b" });
		expect(pool.getStatus().pid).toBe(10);
	});

	// test-contract: invariant — `onChildStatus`'s change-detection guard
	// (sidecar-pool.ts L122-127) must suppress both the onStatusChange
	// callback and the sinceIso bump when the recomputed aggregate is
	// identical to the current one on every compared field.
	it("does not re-fire onStatusChange or bump sinceIso when nothing actually changed", () => {
		const onStatusChange = vi.fn();
		const pool = makePool(1, onStatusChange);
		onStatusChange.mockClear(); // drop the constructor's initial "idle" fire
		(pool as Peek).onChildStatus(0, { state: "ready", restartCount: 0, pid: 7, sinceIso: "t1" });
		expect(onStatusChange).toHaveBeenCalledTimes(1);
		const sinceIsoAfterFirst = pool.getStatus().sinceIso;

		(pool as Peek).onChildStatus(0, { state: "ready", restartCount: 0, pid: 7, sinceIso: "t2" });
		expect(onStatusChange).toHaveBeenCalledTimes(1);
		expect(pool.getStatus().sinceIso).toBe(sinceIsoAfterFirst);
	});

	// test-contract: invariant — a genuine state transition (spawning ->
	// dormant) with pid/detail/restartCount held constant must be detected
	// as "changed" and must bump sinceIso (sidecar-pool.ts L130-133).
	it("updates aggregate state and bumps sinceIso when only the state changes", () => {
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const pool = makePool(1);
		(pool as Peek).onChildStatus(0, { state: "spawning", restartCount: 0, sinceIso: "a" });
		const afterSpawning = pool.getStatus();
		expect(afterSpawning.state).toBe("spawning");
		const isoAfterSpawning = afterSpawning.sinceIso;

		vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
		(pool as Peek).onChildStatus(0, { state: "dormant", restartCount: 0, sinceIso: "b" });
		const afterDormant = pool.getStatus();
		expect(afterDormant.state).toBe("dormant");
		expect(afterDormant.pid).toBeUndefined();
		expect(afterDormant.detail).toBe("0/1 ready");
		expect(afterDormant.sinceIso).not.toBe(isoAfterSpawning);
	});

	// test-contract: invariant — of the four change-detection comparisons in
	// onChildStatus (state/pid/detail/restartCount), the pid comparison alone
	// must trigger an update when it is the only field that differs.
	it("detects a pid-only aggregate change (state/detail/restartCount held constant)", () => {
		const pool = makePool(1);
		(pool as Peek).onChildStatus(0, { state: "ready", restartCount: 0, pid: 100, sinceIso: "a" });
		expect(pool.getStatus().pid).toBe(100);
		(pool as Peek).onChildStatus(0, { state: "ready", restartCount: 0, pid: 200, sinceIso: "b" });
		expect(pool.getStatus().pid).toBe(200);
	});

	// test-contract: invariant — of the four change-detection comparisons in
	// onChildStatus (state/pid/detail/restartCount), the detail comparison
	// alone must trigger an update when it is the only field that differs.
	it("detects a detail-only aggregate change (state/pid/restartCount held constant)", () => {
		const pool = makePool(2);
		(pool as Peek).onChildStatus(0, { state: "ready", restartCount: 0, pid: 1, sinceIso: "a" });
		const afterFirst = pool.getStatus();
		expect(afterFirst.detail).toBe("1/2 ready");
		expect(afterFirst.pid).toBe(1);

		(pool as Peek).onChildStatus(1, { state: "ready", restartCount: 0, pid: 2, sinceIso: "b" });
		const afterSecond = pool.getStatus();
		expect(afterSecond.detail).toBe("2/2 ready");
		expect(afterSecond.pid).toBe(1); // first-ready-wins, unchanged
		expect(afterSecond.state).toBe("ready"); // unchanged
	});

	// test-contract: invariant — of the four change-detection comparisons in
	// onChildStatus (state/pid/detail/restartCount), the restartCount
	// comparison alone must trigger an update when it is the only field that
	// differs.
	it("detects a restartCount-only aggregate change (state/pid/detail held constant)", () => {
		const pool = makePool(1);
		(pool as Peek).onChildStatus(0, { state: "ready", restartCount: 0, pid: 1, sinceIso: "a" });
		expect(pool.getStatus().restartCount).toBe(0);
		(pool as Peek).onChildStatus(0, { state: "ready", restartCount: 5, pid: 1, sinceIso: "b" });
		const status = pool.getStatus();
		expect(status.restartCount).toBe(5);
		expect(status.state).toBe("ready");
		expect(status.pid).toBe(1);
		expect(status.detail).toBe("1/1 ready");
	});

	// test-contract: security — fireStatus (sidecar-pool.ts L161-169) must
	// treat a missing onStatusChange as a no-op guard, not call `undefined`
	// as a function; a regression would crash the constructor and every
	// status transition in every caller that doesn't pass the callback.
	it("fireStatus is a safe no-op (never throws) when no onStatusChange callback is configured", () => {
		expect(() => makePool(1)).not.toThrow();
		const pool = makePool(1);
		expect(() => (pool as Peek).onChildStatus(0, { state: "ready", restartCount: 0, pid: 9, sinceIso: "z" })).not.toThrow();
	});
});
