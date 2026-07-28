// ===========================================
// Per-edit mutation — shard planning
// ===========================================
// Splits ONE file's line span into contiguous ranges, one per available runner.
//
// The shard unit is a line range, not a file, because a model edits one file at
// a time: splitting by file would leave the common case entirely unparallelised.
// Stryker restricts a run to a span via `--mutate <file>:<start>-<end>`, so N
// runners can measure N slices of the same edit concurrently.
//
// Keeping the partition pure and exhaustively tested matters because a gap in
// the tiling is invisible: the missed lines simply never get mutated, and their
// survivors are silently never reported. A wrong partition does not fail — it
// under-reports, which is the worst failure mode a quality gate can have.

export interface Shard {
	/** 1-based inclusive first line, matching Stryker's mutation-range syntax. */
	start: number;
	/** 1-based inclusive last line, matching Stryker's mutation-range syntax. */
	end: number;
}

/**
 * Tile `1..totalLines` into at most `shardCount` contiguous ranges.
 *
 * Guarantees, all pinned by tests: no gaps, no overlaps, nothing outside the
 * file, and every line covered exactly once. The remainder is distributed across
 * the leading shards rather than truncated — a floor-split would drop the last
 * line of any odd-length file.
 *
 * Never emits more shards than there are lines: an empty range would make
 * Stryker fall back to mutating the WHOLE file, so every shard would duplicate
 * the entire run.
 */
/** Partition 1..totalLines into `shardCount` contiguous, non-overlapping ranges
 *  that tile the whole span exactly. */
export function planShards(totalLines: number, shardCount: number): Shard[] {
	// Normalise first, then partition. An earlier version guarded the degenerate
	// cases with an early return, and mutation testing proved every branch of that
	// guard EQUIVALENT: `Math.min` and the loop bound already absorbed 0, negative
	// and NaN. That made the guard decorative — the function's totality actually
	// rested on accidental NaN arithmetic, so a later refactor of the loop could
	// have broken degenerate handling while the guard still looked responsible.
	// Clamping explicitly makes the normalisation the thing that holds.
	const total = Number.isFinite(totalLines) ? Math.max(0, Math.floor(totalLines)) : 0;
	const wanted = Number.isFinite(shardCount) ? Math.max(1, Math.floor(shardCount)) : 1;

	// Never more shards than lines: an empty range makes Stryker fall back to the
	// WHOLE file, so every shard would duplicate the entire run.
	const n = Math.min(wanted, total);
	const base = Math.floor(total / n);
	const remainder = total % n;

	const shards: Shard[] = [];
	let cursor = 1;
	for (let i = 0; i < n; i++) {
		// The first `remainder` shards take one extra line, which is what makes the
		// tiling exact for counts that do not divide evenly.
		const size = base + (i < remainder ? 1 : 0);
		shards.push({ start: cursor, end: cursor + size - 1 });
		cursor += size;
	}
	return shards;
}
