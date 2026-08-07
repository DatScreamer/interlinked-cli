import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writeHeapSnapshotMock = vi.fn<(path?: string) => string>();
vi.mock("node:v8", () => ({
	writeHeapSnapshot: (path?: string) => writeHeapSnapshotMock(path),
}));

import { installDaemonTimers } from "./daemon-timers.js";

/**
 * The memory timer exists because the daemon grows under sustained edit traffic
 * and, past roughly 750MB on a swap-bound machine, stops answering the socket
 * within the hook's timeout — alive but too slow. The agent reads that as a
 * dead guard and its next tool call is blocked; the old process meanwhile
 * lingers as an orphan holding the memory its replacement needs.
 *
 * Recycling early converts that hang into a sub-second restart.
 */
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const MB = 1024 * 1024;

function harness(rss: number, ceiling: number) {
	const shutdown = vi.fn();
	const log = vi.fn();
	const refreshStatuslineSnapshot = vi.fn();
	const stop = installDaemonTimers({
		refreshStatuslineSnapshot,
		shutdown,
		log,
		rssBytes: () => rss,
		ceilingBytes: ceiling,
	});
	return { shutdown, log, refreshStatuslineSnapshot, stop };
}

describe("installDaemonTimers — memory ceiling", () => {
	it("does not recycle a daemon under its ceiling", () => {
		const h = harness(100 * MB, 500 * MB);
		vi.advanceTimersByTime(5 * 60_000);
		expect(h.shutdown).not.toHaveBeenCalled();
		h.stop();
	});

	it("recycles once RSS is over the ceiling", () => {
		const h = harness(600 * MB, 500 * MB);
		vi.advanceTimersByTime(60_000);
		expect(h.shutdown).toHaveBeenCalled();
		h.stop();
	});

	it("says WHY it is recycling, with both numbers", () => {
		// An operator seeing the daemon restart must be able to tell this apart
		// from a crash, or they will go hunting for a bug that isn't there.
		const h = harness(600 * MB, 500 * MB);
		vi.advanceTimersByTime(60_000);
		const msg = h.log.mock.calls.map((c) => String(c[0])).join(" ");
		expect(msg).toContain("600MB");
		expect(msg).toContain("500MB");
		expect(msg).toContain("Recycling");
		h.stop();
	});

	it("refreshes the statusline on its own cadence", () => {
		const h = harness(10 * MB, 500 * MB);
		vi.advanceTimersByTime(30_000);
		expect(h.refreshStatuslineSnapshot).toHaveBeenCalled();
		h.stop();
	});

	it("stops both timers when stopped", () => {
		const h = harness(600 * MB, 500 * MB);
		h.stop();
		vi.advanceTimersByTime(5 * 60_000);
		expect(h.shutdown).not.toHaveBeenCalled();
		expect(h.refreshStatuslineSnapshot).not.toHaveBeenCalled();
	});

	it("never recycles when the ceiling is disabled with 0", () => {
		const h = harness(10_000 * MB, 0);
		vi.advanceTimersByTime(5 * 60_000);
		expect(h.shutdown).not.toHaveBeenCalled();
		h.stop();
	});
});

describe("installDaemonTimers — spike attribution", () => {
	// The unexplained heap spikes (pure V8 heap, ~1GB inside one 30s window)
	// need passive attribution: a callback per >150MB/tick jump, ledgered by the
	// caller and timestamp-joinable against activity.jsonl.
	it("reports a jump over the spike threshold with rss and delta in MB", () => {
		let rss = 100 * MB;
		const onSpike = vi.fn();
		const stop = installDaemonTimers({
			refreshStatuslineSnapshot: vi.fn(),
			shutdown: vi.fn(),
			log: vi.fn(),
			rssBytes: () => rss,
			ceilingBytes: 0,
			onSpike,
		});
		rss = 400 * MB;
		vi.advanceTimersByTime(30_000);
		expect(onSpike).toHaveBeenCalledWith(400, 300);
		stop();
	});

	it("stays silent for growth under the threshold", () => {
		let rss = 100 * MB;
		const onSpike = vi.fn();
		const stop = installDaemonTimers({
			refreshStatuslineSnapshot: vi.fn(),
			shutdown: vi.fn(),
			log: vi.fn(),
			rssBytes: () => rss,
			ceilingBytes: 0,
			onSpike,
		});
		rss = 200 * MB; // +100MB — normal churn, not a spike
		vi.advanceTimersByTime(30_000);
		expect(onSpike).not.toHaveBeenCalled();
		stop();
	});

	it("attributes each spike to ITS tick, not cumulatively", () => {
		let rss = 100 * MB;
		const onSpike = vi.fn();
		const stop = installDaemonTimers({
			refreshStatuslineSnapshot: vi.fn(),
			shutdown: vi.fn(),
			log: vi.fn(),
			rssBytes: () => rss,
			ceilingBytes: 0,
			onSpike,
		});
		rss = 400 * MB;
		vi.advanceTimersByTime(30_000);
		vi.advanceTimersByTime(30_000); // flat since — must not re-report
		expect(onSpike).toHaveBeenCalledTimes(1);
		stop();
	});
});

describe("installDaemonTimers — hand-over on recycle", () => {
	// A bare exit waits for the NEXT tool call's self-heal, which never comes
	// between turns: measured 2026-07-28, one rss-ceiling exit left an
	// ELEVEN-MINUTE hole with no daemon until the user typed. These pin the fix.
	function handoverHarness(handOverResult: boolean) {
		const shutdown = vi.fn();
		const requestHandOver = vi.fn(() => handOverResult);
		const stop = installDaemonTimers({
			refreshStatuslineSnapshot: vi.fn(),
			shutdown,
			requestHandOver,
			log: vi.fn(),
			rssBytes: () => 600 * MB,
			ceilingBytes: 500 * MB,
		});
		return { shutdown, requestHandOver, stop };
	}

	it("prefers spawning a successor over a bare exit", () => {
		const h = handoverHarness(true);
		vi.advanceTimersByTime(30_000);
		expect(h.requestHandOver).toHaveBeenCalledTimes(1);
		expect(h.shutdown).not.toHaveBeenCalled();
		h.stop();
	});

	it("does not spawn a second successor while the first is in flight", () => {
		// Two restarts racing through anti-stomp buys nothing; wait out the
		// patience window before retrying.
		const h = handoverHarness(true);
		vi.advanceTimersByTime(90_000);
		expect(h.requestHandOver).toHaveBeenCalledTimes(1);
		h.stop();
	});

	it("retries the hand-over after the patience window expires unanswered", () => {
		const h = handoverHarness(true);
		vi.advanceTimersByTime(4 * 30_000);
		expect(h.requestHandOver).toHaveBeenCalledTimes(2);
		h.stop();
	});

	it("falls back to a bare exit when nothing can be spawned", () => {
		const h = handoverHarness(false);
		vi.advanceTimersByTime(30_000);
		expect(h.requestHandOver).toHaveBeenCalledTimes(1);
		expect(h.shutdown).toHaveBeenCalledTimes(1);
		h.stop();
	});
});

describe("installDaemonTimers — idle shrink", () => {
	// A daemon idle for minutes on a swap-pinned box is a jetsam target for
	// memory it doesn't need until the next event: drop the shrinkable caches
	// once per idle period, re-armed by new activity.
	function idleHarness(lastEventAtMs: () => number) {
		const shrinkIdleMemory = vi.fn();
		const stop = installDaemonTimers({
			refreshStatuslineSnapshot: vi.fn(),
			shutdown: vi.fn(),
			log: vi.fn(),
			rssBytes: () => 100 * MB,
			ceilingBytes: 500 * MB,
			lastEventAtMs,
			shrinkIdleMemory,
		});
		return { shrinkIdleMemory, stop };
	}

	it("P1: shrinks once after the idle threshold, not on every subsequent tick", () => {
		const start = Date.now();
		const h = idleHarness(() => start);
		vi.advanceTimersByTime(6 * 60_000);
		expect(h.shrinkIdleMemory).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(10 * 60_000);
		expect(h.shrinkIdleMemory).toHaveBeenCalledTimes(1);
		h.stop();
	});

	it("P2: new activity re-arms the shrink for the next idle period", () => {
		const start = Date.now();
		let lastEvent = start;
		const h = idleHarness(() => lastEvent);
		vi.advanceTimersByTime(6 * 60_000);
		expect(h.shrinkIdleMemory).toHaveBeenCalledTimes(1);
		lastEvent = Date.now(); // an event arrives
		vi.advanceTimersByTime(6 * 60_000);
		expect(h.shrinkIdleMemory).toHaveBeenCalledTimes(2);
		h.stop();
	});

	it("N1: recent activity means no shrink", () => {
		const h = idleHarness(() => Date.now());
		vi.advanceTimersByTime(10 * 60_000);
		expect(h.shrinkIdleMemory).not.toHaveBeenCalled();
		h.stop();
	});

	it("N2: absent hooks leave the timers working as before", () => {
		const shutdown = vi.fn();
		const stop = installDaemonTimers({
			refreshStatuslineSnapshot: vi.fn(),
			shutdown,
			log: vi.fn(),
			rssBytes: () => 100 * MB,
			ceilingBytes: 500 * MB,
		});
		vi.advanceTimersByTime(10 * 60_000);
		expect(shutdown).not.toHaveBeenCalled();
		stop();
	});
});

describe("installDaemonTimers — defaults (ceilingBytes/rssBytes omitted)", () => {
	// Both default expressions (`hooks.ceilingBytes ?? configuredCeilingBytes()`
	// and `hooks.rssBytes ?? process.memoryUsage().rss`) only run when the
	// caller omits the corresponding hook — every other test in this file
	// supplies both explicitly.
	it("still runs the memory timer without throwing when both are omitted", () => {
		const shutdown = vi.fn();
		const refreshStatuslineSnapshot = vi.fn();
		const stop = installDaemonTimers({
			refreshStatuslineSnapshot,
			shutdown,
			log: vi.fn(),
		});
		expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
		expect(refreshStatuslineSnapshot).toHaveBeenCalled();
		stop();
	});
});

describe("installDaemonTimers — SIGUSR2 heap snapshot", () => {
	beforeEach(() => {
		writeHeapSnapshotMock.mockReset();
	});

	it("writes a heap snapshot and logs the path on SIGUSR2 when snapshotDir is set", () => {
		writeHeapSnapshotMock.mockReturnValue("/tmp/heap-123.heapsnapshot");
		const log = vi.fn();
		const stop = installDaemonTimers({
			refreshStatuslineSnapshot: vi.fn(),
			shutdown: vi.fn(),
			log,
			rssBytes: () => 10 * MB,
			ceilingBytes: 500 * MB,
			snapshotDir: "/tmp/snaps",
		});
		process.emit("SIGUSR2");
		expect(writeHeapSnapshotMock).toHaveBeenCalledTimes(1);
		expect(log.mock.calls.some((c) => String(c[0]).includes("Heap snapshot written"))).toBe(
			true,
		);
		stop();
	});

	it("logs a failure message when writeHeapSnapshot throws", () => {
		writeHeapSnapshotMock.mockImplementation(() => {
			throw new Error("disk full");
		});
		const log = vi.fn();
		const stop = installDaemonTimers({
			refreshStatuslineSnapshot: vi.fn(),
			shutdown: vi.fn(),
			log,
			rssBytes: () => 10 * MB,
			ceilingBytes: 500 * MB,
			snapshotDir: "/tmp/snaps",
		});
		process.emit("SIGUSR2");
		expect(log.mock.calls.some((c) => String(c[0]).includes("Heap snapshot failed"))).toBe(
			true,
		);
		stop();
	});

	it("does not register a SIGUSR2 handler when snapshotDir is absent", () => {
		const before = process.listenerCount("SIGUSR2");
		const stop = installDaemonTimers({
			refreshStatuslineSnapshot: vi.fn(),
			shutdown: vi.fn(),
			log: vi.fn(),
			rssBytes: () => 10 * MB,
			ceilingBytes: 500 * MB,
		});
		expect(process.listenerCount("SIGUSR2")).toBe(before);
		stop();
	});

	it("removes its SIGUSR2 listener when stopped", () => {
		const before = process.listenerCount("SIGUSR2");
		const stop = installDaemonTimers({
			refreshStatuslineSnapshot: vi.fn(),
			shutdown: vi.fn(),
			log: vi.fn(),
			rssBytes: () => 10 * MB,
			ceilingBytes: 500 * MB,
			snapshotDir: "/tmp/snaps",
		});
		expect(process.listenerCount("SIGUSR2")).toBe(before + 1);
		stop();
		expect(process.listenerCount("SIGUSR2")).toBe(before);
	});
});
