// ===========================================
// Harness daemon — background timers
// ===========================================
// The periodic work the daemon does off the hook path: refreshing the
// statusline snapshot so live counters stay current without a triggering event,
// and watching its own memory so it recycles before it degrades.
//
// Extracted from server.ts because that file is over the per-file line cap;
// keeping timers here means adding one is a change to a small module rather
// than growth on a file that may only shrink.

import { configuredCeilingBytes, shouldRecycle } from "../memory-ceiling.js";

const STATUSLINE_REFRESH_INTERVAL_MS = 10_000;
const MEMORY_CHECK_INTERVAL_MS = 30_000;
const BYTES_PER_MB = 1024 * 1024;

export interface DaemonTimerHooks {
	/** Recompute the statusline snapshot (reservations, index, bridge state). */
	refreshStatuslineSnapshot: () => void;
	/** Clean shutdown — releases the socket and pid file. */
	shutdown: () => void;
	/**
	 * Spawn a successor (`harness restart`) and return true, or false when
	 * nothing can be spawned. Preferred over bare `shutdown` on a ceiling
	 * breach: a bare exit waits for the NEXT tool call's self-heal, which never
	 * comes between turns — measured 2026-07-28, one rss-ceiling exit left an
	 * eleven-minute hole with no daemon until the user typed. A planned exit
	 * during activity must bring its own successor.
	 */
	requestHandOver?: () => boolean;
	/** Always-on log line (not gated behind --verbose). */
	log: (message: string) => void;
	/** Injected for tests; defaults to this process's RSS. */
	rssBytes?: () => number;
	/** Injected for tests; defaults to the configured ceiling. */
	ceilingBytes?: number;
}

/**
 * Start the daemon's background timers. Returns a stop function for tests.
 *
 * The memory timer is the interesting one. The daemon grows under sustained
 * edit traffic and, past roughly 750MB on a swap-bound machine, stops answering
 * the socket within the hook's timeout — alive but too slow, which the agent
 * sees as a dead guard, and which leaves the old process orphaned still holding
 * its memory. Leaving cleanly at a lower ceiling turns that hang into a
 * sub-second restart: `shutdown()` releases the socket and the hook's existing
 * self-heal starts a fresh daemon. The state lost is caches and per-session
 * trajectory, both rebuildable.
 *
 * The ROOT CAUSE of the growth is not isolated — that needs heap profiling on a
 * machine that is not thrashing. This bounds the symptom, which is the standard
 * shape for a long-lived process with growth you have not yet found.
 */
export function installDaemonTimers(hooks: DaemonTimerHooks): () => void {
	const ceiling = hooks.ceilingBytes ?? configuredCeilingBytes();
	const readRss = hooks.rssBytes ?? (() => process.memoryUsage().rss);

	const statusline = setInterval(hooks.refreshStatuslineSnapshot, STATUSLINE_REFRESH_INTERVAL_MS);
	// Ticks to wait for a spawned successor's SIGTERM before concluding the
	// hand-over failed and retrying. Two ticks ≈ a minute — far beyond a normal
	// restart, tight enough that a lost successor doesn't strand a bloated daemon.
	const HANDOVER_PATIENCE_TICKS = 2;
	let ticksSinceHandOver = -1;
	const memory = setInterval(() => {
		const rss = readRss();
		if (!shouldRecycle(rss, ceiling)) return;
		// A successor was already spawned — give its `harness restart` time to
		// SIGTERM us instead of spawning a second one every tick (the restarts
		// would race each other through anti-stomp for no benefit).
		if (ticksSinceHandOver >= 0 && ticksSinceHandOver < HANDOVER_PATIENCE_TICKS) {
			ticksSinceHandOver++;
			return;
		}
		// Prefer a HANDOVER: spawn the successor, let its `harness restart`
		// SIGTERM this process through the normal graceful path. Only when
		// nothing can be spawned (src-run daemon) fall back to a bare exit and
		// the next call's self-heal.
		const handedOver = hooks.requestHandOver?.() ?? false;
		if (handedOver) ticksSinceHandOver = 0;
		hooks.log(
			`Recycling: RSS ${Math.round(rss / BYTES_PER_MB)}MB over ${Math.round(ceiling / BYTES_PER_MB)}MB ceiling — ${handedOver ? "successor spawned; awaiting its restart" : "restarting clean rather than degrading into a hang"}`,
		);
		if (!handedOver) hooks.shutdown();
	}, MEMORY_CHECK_INTERVAL_MS);

	// Neither timer should hold the process open on its own.
	statusline.unref?.();
	memory.unref?.();

	return () => {
		clearInterval(statusline);
		clearInterval(memory);
	};
}
