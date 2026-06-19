// interlinked-tdd: exempt
/**
 * §3.21 add_then_revert_loop — the revert-loop (A→B→A oscillation) sequence
 * detector plus its three pure index/scan helpers. Extracted verbatim from
 * `quality.ts` as a leaf cluster (nothing else in the quality module depends
 * on these helpers or the threshold constant). Re-exported from `quality.ts`
 * for back-compat so existing `./quality.js` imports keep resolving.
 */

import type { SequenceDetector, SequenceMatch } from "./types.js";

// ============================================================
// §3.21 add_then_revert_loop
// ============================================================

/** Threshold for content-hash re-appearance in a file's recent_line_edits
 *  ring buffer before the add-then-revert detector fires. Two occurrences
 *  of the same hash is "cycled back" — the line content was previously at
 *  this state, was edited away, and is now back. */
const REVERT_LOOP_HASH_THRESHOLD = 2;

/** Build a map from content_hash to the list of positions where it
 *  appears in a single file's recent-line-edits ring buffer. Pure helper
 *  extracted so the detector body reads as two flat passes (build index,
 *  scan for cycling hashes) rather than a triple-nested loop. */
function indexHashPositions(
	edits: ReadonlyArray<{ content_hash: string } | undefined>,
): Map<string, number[]> {
	const hashIndex = new Map<string, number[]>();
	for (let i = 0; i < edits.length; i++) {
		const entry = edits[i];
		if (!entry) continue;
		const positions = hashIndex.get(entry.content_hash);
		if (positions) {
			positions.push(i);
		} else {
			hashIndex.set(entry.content_hash, [i]);
		}
	}
	return hashIndex;
}

/** True iff at least one gap between adjacent positions is greater than
 *  one AND that gap contains a genuinely DIFFERENT content state — i.e., the
 *  file moved away to some other content `B` (B ≠ the candidate hash) and then
 *  came back. A bare index gap is not enough: a buffer like `[A, A', A]` where
 *  `A'` is the same hash padded by a non-recorded no-op would index as a gap
 *  without a real intervening state. Requiring a distinct intervening hash is
 *  the literal definition of A→B→A oscillation and is what keeps blocked /
 *  no-op / re-applied edits (which never reach a distinct state) from
 *  advancing the cycle counter.
 *
 *  `edits[k].content_hash === hash` for any k strictly between two same-hash
 *  positions does NOT count as a distinct state — that's still the candidate
 *  content, so the run is consecutive-with-padding, not a revert. */
function hasDistinctIntervening(
	positions: ReadonlyArray<number>,
	hash: string,
	edits: ReadonlyArray<{ content_hash: string } | undefined>,
): boolean {
	for (let i = 1; i < positions.length; i++) {
		const a = positions[i - 1];
		const b = positions[i];
		if (a === undefined || b === undefined) continue;
		if (b - a <= 1) continue;
		// Scan the open interval (a, b) for any entry whose hash differs from
		// the candidate — that is the genuine intervening state `B`.
		for (let k = a + 1; k < b; k++) {
			const entry = edits[k];
			if (entry && entry.content_hash !== hash) return true;
		}
	}
	return false;
}

/** Returns the first cycling (hash, positions) pair found in the index, or
 *  null if no hash satisfies the threshold AND has a distinct intervening
 *  content state (a real A→B→A oscillation). One finding per file is enough;
 *  we don't pile on per-hash. */
function findCyclingHash(
	hashIndex: ReadonlyMap<string, number[]>,
	edits: ReadonlyArray<{ content_hash: string } | undefined>,
): { hash: string; positions: number[] } | null {
	for (const [hash, positions] of hashIndex) {
		if (positions.length < REVERT_LOOP_HASH_THRESHOLD) continue;
		if (!hasDistinctIntervening(positions, hash, edits)) continue;
		return { hash, positions };
	}
	return null;
}

/**
 * Fires at PreToolUse when any file's recent line-edit history contains the
 * same `content_hash` 2+ times with a genuinely different intervening content
 * state (a real A→B→A oscillation), signaling the agent has cycled a line
 * range through prior content (classic AI thrashing). Reads
 * `trajectory.recent_line_edits` — does NOT populate.
 *
 * Precision contract (2026-05): a blocked edit (PreToolUse rejected by the
 * tsc overlay / a reservation / a guard) leaves the file unchanged. The agent
 * then retries successfully. That blocked attempt is NOT a content state the
 * file ever reached, so it must not count as a revert. Two layers enforce
 * this: (1) `session-state.recordRecentLineEdit` records only successful
 * PostToolUse writes and drops no-op re-applies, so blocked / intended edits
 * never enter the history; (2) this detector requires a distinct intervening
 * state, so even a legacy / hydrated buffer polluted by the old dual-record
 * (Pre + Post) path cannot fire without a real B between the two A's.
 */
export const addThenRevertLoop: SequenceDetector = {
	id: "add_then_revert_loop",
	description:
		"Same line range cycled through prior content — agent is thrashing without converging",
	family: "quality",
	phase: "pre_warn",
	default_enabled: true,
	determinism: "fully_deterministic",
	fn: (trajectory) => {
		const recent = trajectory.recent_line_edits;
		if (!recent || recent.size === 0) return [];
		const matches: SequenceMatch[] = [];
		for (const [file, edits] of recent) {
			if (edits.length < REVERT_LOOP_HASH_THRESHOLD) continue;
			const hashIndex = indexHashPositions(edits);
			const cycle = findCyclingHash(hashIndex, edits);
			if (!cycle) continue;
			matches.push({
				prior_event_count: cycle.positions.length,
				prior_summary: `${cycle.positions.length} occurrences of hash ${cycle.hash} in ${file}`,
				message:
					`${file} has cycled back to a prior content state ${cycle.positions.length} times ` +
					"this session (same line-range content_hash reappearing). This is the " +
					"add-then-revert thrashing shape — pause and reconsider the design rather " +
					"than continuing to revise the same lines.",
				evidence: [file, cycle.hash],
			});
		}
		return matches;
	},
};
