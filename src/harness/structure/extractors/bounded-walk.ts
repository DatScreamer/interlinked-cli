// ===========================================
// Bounded filesystem walk — shared hard cap for all extractors
// ===========================================
// Every extractor recursively walks the repo from `repoRoot`. Skip-dir
// filtering (skip-dirs.ts) is the *primary* defense against runaway walks,
// but it has been patched reactively twice (most recently `reference-repos`
// after a 38K-file directory cost ~25s of `scored_suggestions` phase time
// per PostToolUse Edit — see skip-dirs.ts history).
//
// This module is defense-in-depth: a hard, skip-list-independent cap so the
// *next* unanticipated pathological root (e.g. `repoRoot` mis-resolved to
// `$HOME`) cannot run away regardless of which directory names it contains.
// When the cap trips the walk stops and returns whatever it gathered so far.
//
// Normal projects never approach the cap — interlinked-cli minus skip-dirs
// is only a few thousand files — so under the cap output is byte-identical
// to an uncapped walk. The cap only ever fires on a pathological root.

/**
 * Maximum number of directory entries (files + subdirectories) any single
 * extractor walk will visit before stopping. ~25K is an order of magnitude
 * above any real project tree this harness analyses (interlinked-cli itself,
 * minus skip-dirs, is a few thousand entries) yet small enough that a
 * mis-rooted walk over `$HOME` or a vendored monorepo aborts in well under
 * a second instead of taking 11-25s.
 */
export const MAX_WALK_ENTRIES = 25_000;

/**
 * Maximum wall-clock time (ms) any single extractor walk will spend before
 * stopping. Backstops the entry budget for the case where entries are cheap
 * to count but expensive to process (e.g. huge files being read + regex
 * scanned by env/config extractors). 8s is generous for any real project
 * and far below the multi-second-per-event latencies the runaway incident
 * produced.
 */
export const MAX_WALK_MS = 8_000;

/**
 * Mutable per-walk budget. One instance is created at the top of each
 * extractor's `extract()` call and threaded through its recursive walk.
 * Sharing a single object means the entry count and deadline are global to
 * that walk, not reset per subdirectory.
 */
export interface WalkBudget {
	/** Directory entries visited so far across the whole walk. */
	entriesVisited: number;
	/** `performance.now()` value past which the walk must stop. */
	deadline: number;
	/** Set true once either limit is hit; never reset back to false. */
	truncated: boolean;
}

/** Creates a fresh budget for one extractor walk. */
export function createWalkBudget(): WalkBudget {
	return {
		entriesVisited: 0,
		deadline: performance.now() + MAX_WALK_MS,
		truncated: false,
	};
}

/**
 * Records that one directory entry was visited and reports whether the walk
 * may continue. Returns `false` once either the entry budget or the time
 * budget is exhausted; callers must stop descending/iterating when it does.
 * Idempotently sets `budget.truncated` on the first limit breach.
 */
export function consumeWalkEntry(budget: WalkBudget): boolean {
	budget.entriesVisited += 1;
	if (budget.entriesVisited > MAX_WALK_ENTRIES) {
		budget.truncated = true;
		return false;
	}
	// Check the clock only periodically — performance.now() per entry would
	// add measurable overhead to the common (small-tree) case.
	if (budget.entriesVisited % 512 === 0 && performance.now() > budget.deadline) {
		budget.truncated = true;
		return false;
	}
	return !budget.truncated;
}

/**
 * Emits a one-line stderr warning when an extractor walk was truncated.
 * Truncation must never be silent: a partial artifact graph otherwise
 * produces confusing, wrong structural findings with no explanation.
 * Stderr-only (non-blocking) per the harness warning convention.
 */
export function warnWalkTruncated(extractorName: string, repoRoot: string): void {
	console.error(
		`[interlinked-harness] ${extractorName} walk hit the hard cap ` +
			`(>${MAX_WALK_ENTRIES} entries or >${MAX_WALK_MS}ms) under ${repoRoot}; ` +
			"artifact graph is partial. This usually means repoRoot resolved to an " +
			"unexpectedly large tree.",
	);
}
