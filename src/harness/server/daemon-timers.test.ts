import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
