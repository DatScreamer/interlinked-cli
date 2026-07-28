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
// Two growth ROOT CAUSES were since isolated and fixed (2026-07-28): generated
// dist/ bundles entering the inline-check family via bash path extraction
// (`isGeneratedArtifactPath` exemption), and the 46MB mutation manifest being
// re-parsed on every code-edit PreToolUse (~300MB transient per parse; now an
// mtime/size-keyed cache in `mutation/manifest.ts`). The ceiling remains as
// the backstop for the next unfound cause: leave while still healthy, let the
// supervisor start a fresh one. A guard daemon is cheap to restart (its state
// is caches and per-session trajectory, both rebuildable); a HUNG one blocks
// the agent.
//
// Pairs with the orphan-reap fix in `harnessStartCommand`: recycling without
// reaping would just produce orphans faster.

/** The daemon's V8 old-space limit (MB), passed as `--max-old-space-size` by
 *  every spawn path. This is the PRIMARY memory regulator, sized from two
 *  measurements (2026-07-28): the live set of a loaded daemon is ~950MB
 *  (ledger heap_mb at exit; index + graphs + cached manifest + caches), and
 *  heap-profiling the balloon (heap-76407.heapsnapshot) showed a further
 *  ~400MB of transient TS-compiler AST/binder garbage per edit burst that V8
 *  never collected under the old 4096MB spawn default — no GC pressure ever
 *  arrived before the RSS ceiling killed the process. 1536 gives the live set
 *  headroom while forcing GC well before the ceiling; 640 (tried first)
 *  sat UNDER the live set and hard-crashed every fresh daemon at load
 *  ("Reached heap limit", row-less ledger deaths). Must stay comfortably
 *  BELOW the RSS ceiling (pinned by test) or the recycler fires before GC
 *  does and every loaded daemon churns. Override with
 *  INTERLINKED_HARNESS_HEAP_MB. */
export const DEFAULT_DAEMON_HEAP_MB = 1536;

const BYTES_PER_MB = 1024 * 1024;

/** Recycle above this RSS — the ANOMALY BACKSTOP, not the regulator: with the
 *  V8 heap capped at {@link DEFAULT_DAEMON_HEAP_MB}, a healthy daemon tops out
 *  near heap+external+code ≈ 1.6GB and GCs its way back down; crossing 1.8GB
 *  means native/external growth the heap limit cannot see (or a heap-limit
 *  override), and recycling with handover is the right exit. The structural
 *  shrink (manifest sharding, index residency) is tracked work — this pairing
 *  buys availability at today's measured footprint, not a small daemon.
 *  Override with INTERLINKED_HARNESS_RSS_CEILING_MB; 0 disables. */
export const DEFAULT_RSS_CEILING_BYTES = 1800 * 1024 * 1024;

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
	return Math.floor(mb) * BYTES_PER_MB;
}
