// snapshot-hygiene — detects a write that creates/stages a snapshot REVIEW
// artifact that must never be committed.
//
// Bug class (agent-era test-integrity): an agent that can't get a snapshot test
// to pass will sometimes write the *review* artifact the runner emits for a
// mismatch — jest/vitest's `*.snap.new` or cargo-insta's `*.pending-snap` —
// instead of regenerating the accepted snapshot through the runner (`vitest -u`,
// `cargo insta accept`). Committing the review file is a no-op for the assertion
// (runners ignore `.new` / `.pending-snap` at test time) AND leaves a dangling
// artifact. It is the snapshot analog of leaving an `.only` / `.skip` behind:
// the test signal looks satisfied but isn't.
//
// Source: docs/design/test-category-adoption-from-the-wild.md §6/§9.1(b)/§10.
// Jeff Emanuel's Rust repos lean heavily on insta `*.snap` golden oracles.
//
// Check id: snapshot_hygiene. Advisory (test-integrity taste family), though the
// filename match itself is exact — these extensions are ONLY ever runner-emitted
// review files, so the FP rate is zero. Path-only by design: distinguishing a
// runner-regenerated `*.snap` from a hand-edited one needs the prior bytes +
// runner provenance, which the (content, filePath) signature doesn't carry, so
// the hand-edited-`*.snap` sub-detector is intentionally omitted (FP-prone).

import type { InlineMatch } from "./shared.js";

/** Runner-emitted snapshot-review artifacts that must never be committed:
 *  `*.snap.new` (jest/vitest mismatch/obsolete review file) and `*.pending-snap`
 *  (cargo-insta pending snapshot). Matched on the basename, so the `__snapshots__/`
 *  and `snapshots/` directory conventions are both covered. */
const SNAPSHOT_REVIEW_BASENAME_RE = /(?:\.snap\.new|\.pending-snap)$/i;

/**
 * Detect a write whose TARGET PATH is a snapshot-review artifact that should
 * never be committed. Path-only: `content` is accepted to satisfy the registry's
 * `(content, filePath) => InlineMatch[]` contract but is not inspected. Returns a
 * single match anchored at line 1, or `[]`. Zero-FP.
 *
 * check id: `snapshot_hygiene`
 */
export function detectSnapshotHygiene(_content: string, filePath: string): InlineMatch[] {
	const basename = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
	if (!SNAPSHOT_REVIEW_BASENAME_RE.test(basename)) return [];
	return [
		{
			line: 1,
			text: `snapshot review artifact ${basename} — never commit; regenerate via the test runner (vitest -u / cargo insta accept)`.slice(
				0,
				150,
			),
		},
	];
}
