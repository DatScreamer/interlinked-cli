// ===========================================
// Harness daemon — bounded memory, clean recycle
// ===========================================
// The daemon used to grow under sustained edit traffic until it stopped
// answering the socket. Worse, its RSS recycler spawned a successor while the
// bloated process was still alive, briefly doubling the pressure that had
// already made the workstation unsafe.
//
// Two growth ROOT CAUSES were since isolated and fixed (2026-07-28): generated
// dist/ bundles entering the inline-check family via bash path extraction
// (`isGeneratedArtifactPath` exemption), and the 46MB mutation manifest being
// re-parsed on every code-edit PreToolUse (~300MB transient per parse; now an
// mtime/size-keyed cache in `mutation/manifest.ts`). The ceiling remains as
// the backstop for the next unfound cause. At the hard ceiling the daemon stops
// first; it never overlaps its heap with an RSS-triggered successor. The next
// cold hook can run deterministic inline guards and single-flight self-heal
// after memory is released. A guard daemon is cheap to restart (its state is
// caches and per-session trajectory, both rebuildable); a bloated one can take
// down every coding session on the machine.
//
// Pairs with the orphan-reap fix in `harnessStartCommand`: recycling without
// reaping would just produce orphans faster.

/** The daemon's V8 old-space limit (MB), passed as `--max-old-space-size` by
 *  every spawn path. This is the PRIMARY memory regulator, sized from two
 *  measurements (2026-07-28): the old loaded live set reached ~950MB, while
 *  heap-profiling the balloon showed ~400MB of transient TS-compiler
 *  AST/binder garbage per edit burst. That compiler/test fanout is no longer
 *  admitted in-process, so 1536MB gives the remaining live set headroom while
 *  forcing GC well before the RSS ceiling. 640MB (tried first)
 *  sat UNDER the live set and hard-crashed every fresh daemon at load
 *  ("Reached heap limit", row-less ledger deaths). Must stay comfortably
 *  BELOW the RSS ceiling (pinned by test) or the recycler fires before GC
 *  does and every loaded daemon churns. Override with
 *  INTERLINKED_HARNESS_HEAP_MB.
 *
 *  RESTORED to 1536 (2026-08-31): the pressure that forced the temporary
 *  2560MB allowance was in-daemon compiler/test fanout. TypeScript overlay
 *  work now runs behind a cross-process sidecar admission gate, affected
 *  Vitest is nonqueueing and out-of-process, and synchronous structural
 *  ripple compilation is no longer on the daemon path. Keeping the emergency
 *  allowance would permit the exact whole-system OOM this boundary exists to
 *  prevent. */
export const DEFAULT_DAEMON_HEAP_MB = 1536;

const BYTES_PER_MB = 1024 * 1024;
const DAEMON_NATIVE_HEADROOM_MB = 512;
const MAX_SUPPORTED_DAEMON_HEAP_MB = 4096;
const MAX_SUPPORTED_DAEMON_RSS_MB = 8192;

/** Validated V8 heap limit shared by every TypeScript daemon spawn path.
 * Invalid, non-positive, non-finite, and sub-megabyte values fall back to the
 * measured default rather than producing an invalid or effectively unusable
 * Node flag. */
export function configuredHeapMb(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.INTERLINKED_HARNESS_HEAP_MB;
	const parsed = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
	const requested = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_DAEMON_HEAP_MB;
	const ceilingBytes = configuredCeilingBytes(env);
	const ceilingBound =
		ceilingBytes === 0
			? MAX_SUPPORTED_DAEMON_HEAP_MB
			: Math.max(1, Math.floor(ceilingBytes / BYTES_PER_MB) - DAEMON_NATIVE_HEADROOM_MB);
	return Math.min(requested, MAX_SUPPORTED_DAEMON_HEAP_MB, ceilingBound);
}

/** Recycle above this RSS — the ANOMALY BACKSTOP, not the regulator: with the
 *  V8 heap capped at {@link DEFAULT_DAEMON_HEAP_MB}, crossing 2GB means
 *  native/external growth the heap limit cannot see (or an override), and a
 *  graceful stop before replacement is the right exit. This leaves 512MB for
 *  code, stacks, buffers, and other non-old-space memory without allowing one
 *  repo daemon to consume most of a developer workstation's free memory.
 *  Override with INTERLINKED_HARNESS_RSS_CEILING_MB; 0 disables.
 */
export const DEFAULT_RSS_CEILING_BYTES = 2048 * 1024 * 1024;

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
	if (raw === undefined || raw.trim() === "") return DEFAULT_RSS_CEILING_BYTES;
	const mb = Number(raw);
	// A malformed override must not silently disable the ceiling — fall back to
	// the default rather than to 0, which is the explicit "off" value.
	if (!Number.isFinite(mb) || mb < 0) return DEFAULT_RSS_CEILING_BYTES;
	if (mb === 0) return 0;
	// Bound before multiplying. A huge but finite decimal can otherwise
	// overflow to Infinity, which shouldRecycle deliberately treats as an
	// invalid/disabled ceiling. One hostile environment variable would then
	// remove the machine-safety backstop entirely.
	const defaultMb = DEFAULT_RSS_CEILING_BYTES / BYTES_PER_MB;
	return Math.max(defaultMb, Math.min(Math.floor(mb), MAX_SUPPORTED_DAEMON_RSS_MB)) * BYTES_PER_MB;
}
