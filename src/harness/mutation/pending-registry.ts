// ===========================================
// Per-edit mutation — the daemon-scoped bridge between the two hook windows
// ===========================================
// PreToolUse and PostToolUse are separate hook invocations that share only the
// daemon process. A run that outlived the PreToolUse budget has to be findable
// again in the PostToolUse window, so the handles live here — one store for the
// life of the daemon, reaped on every access.
//
// Correlation is by CONTENT, not by ordering. Two edits to the same file in
// flight at once, or an edit that never landed, must not let one window's
// results be reported against another window's bytes. Hashing the exact overlay
// that was measured makes a mismatch a miss rather than a wrong answer.

import { createHash } from "node:crypto";
import { createPendingStore, type PendingStore, reapExpired } from "./pending-runs.js";

/**
 * Identity of the exact text a run measured.
 *
 * Short by design — this is a correlation key inside one process, not a
 * security boundary, and it appears in log lines a human reads.
 */
export function overlayHash(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

let store: PendingStore | null = null;

/** The process-wide store, created on first use and reaped on every access so
 *  an abandoned run cannot accumulate for the life of a long daemon. */
export function pendingRegistry(now: number = Date.now()): PendingStore {
	if (store === null) store = createPendingStore();
	reapExpired(store, now);
	return store;
}

/** Drop everything. Tests only — a shared singleton would otherwise leak state
 *  across cases and make failures depend on execution order. */
export function resetPendingRegistry(): void {
	store = null;
}
