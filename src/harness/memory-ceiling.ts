// ===========================================
// Harness daemon — bounded memory, clean recycle
// ===========================================
// The daemon grows under sustained edit traffic. Past roughly 750MB on a
// swap-bound machine it stops answering the socket within the hook's timeout —
// it is NOT killed, it is alive and too slow, which the hook reports as
// "pid present, no live daemon". The agent's next tool call is then blocked
// (fail-closed, correctly), the self-heal starts a replacement, and the old
// process lingers as an orphan still holding its memory. Measured 2026-07-28:
// an orphan resident for over an hour at 743MB while its replacement degraded
// for want of exactly that memory.
//
// The ROOT CAUSE of the growth is not isolated — that needs heap profiling on a
// machine that is not thrashing. This bounds the SYMPTOM instead, which is the
// standard shape for a long-lived process with unbounded growth you have not
// yet found: leave while still healthy, and let the supervisor start a fresh
// one. A guard daemon is cheap to restart (its state is caches and per-session
// trajectory, both rebuildable); a HUNG one blocks the agent.
//
// Pairs with the orphan-reap fix in `harnessStartCommand`: recycling without
// reaping would just produce orphans faster.

/** Recycle above this RSS. Chosen well under the ~750MB point where hangs were
 *  observed, so the daemon leaves while it can still answer and shut down
 *  cleanly. Override with INTERLINKED_HARNESS_RSS_CEILING_MB; 0 disables. */
export const DEFAULT_RSS_CEILING_BYTES = 500 * 1024 * 1024;

/**
 * Is this process over its memory budget?
 *
 * Deliberately conservative: a nonsensical reading or a non-positive ceiling
 * means "healthy". A recycle loop driven by a bad number would be far worse
 * than missing a recycle, because it would take the guard down repeatedly.
 */
export function shouldRecycle(rssBytes: number, ceilingBytes: number): boolean {
	if (!Number.isFinite(ceilingBytes) || ceilingBytes <= 0) return false;
	if (!Number.isFinite(rssBytes) || rssBytes <= 0) return false;
	return rssBytes > ceilingBytes;
}

/** The configured ceiling, honouring the env override. */
export function configuredCeilingBytes(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.INTERLINKED_HARNESS_RSS_CEILING_MB;
	if (raw === undefined || raw === "") return DEFAULT_RSS_CEILING_BYTES;
	const mb = Number(raw);
	// A malformed override must not silently disable the ceiling — fall back to
	// the default rather than to 0, which is the explicit "off" value.
	if (!Number.isFinite(mb) || mb < 0) return DEFAULT_RSS_CEILING_BYTES;
	return Math.floor(mb) * 1024 * 1024;
}
