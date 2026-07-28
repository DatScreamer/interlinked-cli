// ===========================================
// Per-edit mutation — pending runs across the two hook windows
// ===========================================
// A mutation run that outlives the PreToolUse budget is not wasted: the engine
// keeps working, and PostToolUse gets a second window to harvest whatever
// finished. This store is the correlation between those two windows.
//
// KEYED BY (file, overlayHash), never by anything repo-specific, so the same
// mechanism works in any project the harness guards. The daemon is per-repo, so
// a file path plus the exact bytes measured is a sufficient key.
//
// Hashing the CONTENT is the load-bearing part. PostToolUse must never attribute
// a PreToolUse measurement to different bytes: if the edit that landed is not the
// edit that was measured, the finding is about code that no longer exists. A
// content mismatch drops the run rather than reporting it against the wrong text.
//
// Entries expire. A hook pair that never closes — the agent was interrupted, the
// tool call failed, the daemon restarted mid-edit — must not leak into an
// unrelated later edit, and the store must not grow without bound in a long
// session.

/** How long a started-but-unharvested run stays claimable. Generous enough to
 *  cover a slow engine, short enough that it cannot reach a later, unrelated
 *  edit of the same file. */
export const PENDING_TTL_MS = 120_000;

export interface PendingRun {
	/** Repo-relative or absolute path, exactly as the gate saw it. */
	file: string;
	/** Digest of the overlay content measured — the anti-misattribution key. */
	overlayHash: string;
	/** Opaque handle the runner returned; meaningful only to that runner. */
	jobId: string;
	/** Which runner holds the job — a sharded edit has one entry per shard. */
	runnerUrl: string;
	/** Epoch ms, for TTL. */
	startedAt: number;
}

/** Opaque store. A plain array: an edit has at most a handful of shards, so key
 *  indexing would cost more in complexity than it saves in lookups. */
export interface PendingStore {
	runs: PendingRun[];
}

export function createPendingStore(): PendingStore {
	return { runs: [] };
}

/** Remember an in-flight run so the PostToolUse window can claim its result. */
export function recordPending(store: PendingStore, run: PendingRun): void {
	store.runs.push(run);
}

function isLive(run: PendingRun, now: number): boolean {
	return now - run.startedAt <= PENDING_TTL_MS;
}

/**
 * Claim every live run recorded for this exact file AND content.
 *
 * Single-use: claimed runs are removed, so a second PostToolUse for the same
 * edit cannot re-report findings the agent has already been shown. Returns all
 * shards of one edit together, since a sharded measurement is only complete when
 * every shard has been accounted for.
 */
export function takePending(
	store: PendingStore,
	file: string,
	overlayHash: string,
	now: number,
): PendingRun[] {
	const claimed: PendingRun[] = [];
	const kept: PendingRun[] = [];
	for (const run of store.runs) {
		const mine = run.file === file && run.overlayHash === overlayHash && isLive(run, now);
		if (mine) claimed.push(run);
		else if (isLive(run, now)) kept.push(run);
		// Expired-and-not-mine entries are dropped here too: any traversal is a
		// fine moment to shed them, and it keeps the store self-limiting.
	}
	store.runs = kept;
	return claimed;
}

/** Drop expired entries, returning how many were shed. */
export function reapExpired(store: PendingStore, now: number): number {
	const before = store.runs.length;
	store.runs = store.runs.filter((r) => isLive(r, now));
	return before - store.runs.length;
}
