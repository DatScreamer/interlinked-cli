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

import { join } from "node:path";
import { getHeapStatistics, writeHeapSnapshot } from "node:v8";
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
	/**
	 * Called when RSS jumps by more than the spike threshold between two ticks —
	 * the passive attribution channel for the unexplained ~1GB heap spikes
	 * (fingerprinted 2026-07-28: pure V8 heap, external ~20MB). A ledger row per
	 * spike, timestamp-joinable against activity.jsonl, turns the next day of
	 * normal use into the profiling session nobody has to run.
	 */
	onSpike?: (rssMb: number, deltaMb: number) => void;
	/** Directory for SIGUSR2 heap snapshots; absent disables the handler. */
	snapshotDir?: string;
	/** Timestamp of the last hook event this daemon served (server tracks it
	 *  for the idle timer already). Enables the idle shrink below. */
	lastEventAtMs?: () => number;
	/** Drop shrinkable caches (parsed manifest, forced GC). Called once per
	 *  idle period, re-armed by new activity: an idle daemon on a swap-pinned
	 *  box is a jetsam target for memory it doesn't need until the next event
	 *  — measured 2026-07-28, row-less SIGKILLs during a 2h idle gap.
	 *  ALSO the emergency valve under heap pressure (storm postmortem
	 *  2026-08-17): the heap cap sits below the RSS recycle ceiling, so a
	 *  transient spike aborts V8 before the graceful recycle can fire —
	 *  shrinking at the pressure fraction keeps headroom for the spike. */
	shrinkIdleMemory?: () => void;
	/** Injected for tests; defaults to v8.getHeapStatistics. */
	heapStats?: () => { usedBytes: number; limitBytes: number };
	/** Ledger callback when the emergency heap-pressure shrink fires. */
	onHeapPressure?: (usedMb: number, limitMb: number) => void;
}

/** Heap-use fraction of the V8 limit that triggers the emergency shrink. */
const EMERGENCY_HEAP_FRACTION = 0.75;
/** Emergency shrinks are rate-limited — GC under sustained pressure every
 *  tick would trade the OOM for a CPU stall. */
const EMERGENCY_SHRINK_COOLDOWN_MS = 120_000;

/** Idle time after which the shrink fires (once per idle period). */
const IDLE_SHRINK_AFTER_MS = 5 * 60_000;

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
	const readHeap =
		hooks.heapStats ??
		((): { usedBytes: number; limitBytes: number } => {
			const s = getHeapStatistics();
			return { usedBytes: s.used_heap_size, limitBytes: s.heap_size_limit };
		});
	let lastEmergencyShrinkAt = 0;

	const statusline = setInterval(hooks.refreshStatuslineSnapshot, STATUSLINE_REFRESH_INTERVAL_MS);
	// Ticks to wait for a spawned successor's SIGTERM before concluding the
	// hand-over failed and retrying. Two ticks ≈ a minute — far beyond a normal
	// restart, tight enough that a lost successor doesn't strand a bloated daemon.
	const HANDOVER_PATIENCE_TICKS = 2;
	/** One tick's RSS growth that counts as a spike worth attributing. */
	const SPIKE_DELTA_BYTES = 150 * BYTES_PER_MB;
	let ticksSinceHandOver = -1;
	let prevRss = readRss();
	// SIGUSR2 → heap snapshot on demand, for root-causing the spikes offline.
	// SIGUSR1 is reserved by Node for the debugger; USR2 is conventionally free.
	// Handler is stored so the disposer can unregister it (tests install and
	// tear these timers down repeatedly in one process).
	const onSigusr2 = (): void => {
		try {
			const path = writeHeapSnapshot(join(hooks.snapshotDir ?? "", `heap-${process.pid}.heapsnapshot`));
			hooks.log(`Heap snapshot written: ${path}`);
		} catch (err) {
			hooks.log(`Heap snapshot failed: ${String(err)}`);
		}
	};
	if (hooks.snapshotDir) process.on("SIGUSR2", onSigusr2);
	// Idle shrink: fire once per idle period. `lastShrinkAt < lastEvent` means
	// "no shrink since the last event" — firing stamps lastShrinkAt past the
	// idle period's event, and only a NEWER event re-arms the comparison.
	let lastShrinkAt = 0;
	const memory = setInterval(() => {
		const rss = readRss();
		const delta = rss - prevRss;
		prevRss = rss;
		if (delta > SPIKE_DELTA_BYTES) {
			hooks.onSpike?.(Math.round(rss / BYTES_PER_MB), Math.round(delta / BYTES_PER_MB));
		}
		if (hooks.lastEventAtMs && hooks.shrinkIdleMemory) {
			const lastEvent = hooks.lastEventAtMs();
			if (Date.now() - lastEvent >= IDLE_SHRINK_AFTER_MS && lastShrinkAt < lastEvent) {
				lastShrinkAt = Date.now();
				hooks.shrinkIdleMemory();
			}
		}
		// Emergency valve: shrink the moment heap use crosses the pressure
		// fraction — waiting for idleness or the RSS ceiling is what let spikes
		// abort V8 (heap cap < RSS ceiling, storm postmortem 2026-08-17).
		if (hooks.shrinkIdleMemory) {
			const heap = readHeap();
			const pressured =
				heap.limitBytes > 0 && heap.usedBytes / heap.limitBytes > EMERGENCY_HEAP_FRACTION;
			if (pressured && Date.now() - lastEmergencyShrinkAt >= EMERGENCY_SHRINK_COOLDOWN_MS) {
				lastEmergencyShrinkAt = Date.now();
				hooks.shrinkIdleMemory();
				hooks.onHeapPressure?.(
					Math.round(heap.usedBytes / BYTES_PER_MB),
					Math.round(heap.limitBytes / BYTES_PER_MB),
				);
			}
		}
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
		process.removeListener("SIGUSR2", onSigusr2);
	};
}
