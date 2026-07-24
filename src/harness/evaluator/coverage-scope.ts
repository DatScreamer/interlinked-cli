// ===========================================
// Per-edit coverage — test-scope identity
// ===========================================
// The per-edit gate measures coverage under whatever affected-test set it
// selects TODAY, but the drop ratchet used to compare that against a stored
// fraction with no record of which test set earned it. Selection is
// non-stationary (graph growth, new companions, overlay contents), so a
// ratchet over it eventually false-blocks: a file pinned at 100% from a broad
// run blocks EVERY edit once selection narrows to a scope that can only reach
// 98.7% (observed live on mcp-client-bio staging/utils.ts, 2026-07-24 — four
// blocks, comment-free edit blocked, 59/77 baseline entries exposed).
//
// The fix: every measurement carries a scope id — "full" for the full suite,
// a short hash of the sorted selected-test list otherwise. Baselines store the
// scope that earned them; a comparison across DIFFERENT scopes is meaningless,
// so the gate re-anchors (reseed + loud allow-warning) instead of blocking.
// The precise per-line added-coverage check is scope-independent and still
// guards new code; the commit-time full-suite gate still catches real
// regressions.

import { createHash } from "node:crypto";

/** Stable identity for the test set a coverage measurement ran under. */
export function coverageScopeId(selectedTests: string[] | undefined): string {
	if (selectedTests === undefined) return "full";
	const hash = createHash("sha256");
	for (const test of [...selectedTests].sort()) {
		hash.update(test);
		hash.update("\n");
	}
	return `scoped:${hash.digest("hex").slice(0, 12)}`;
}

/** One-decimal percentage — rounding 98.7% up to "99%" hid the one-line gap
 *  that made the bio incident a ten-minute diagnosis. */
export function pctPrecise(fraction: number): string {
	return `${(fraction * 100).toFixed(1)}%`;
}

/** The allow-warning emitted when a stored baseline was earned under a
 *  different test scope and the gate re-anchors instead of blocking. */
export function formatScopeReanchorWarning(
	relPath: string,
	priorFraction: number,
	nowFraction: number,
	scopeId: string,
): string {
	return (
		`[interlinked:coverage] ${relPath}: the recorded ${pctPrecise(priorFraction)} baseline ` +
		`was measured under a different affected-test scope; re-anchored at ` +
		`${pctPrecise(nowFraction)} (${scopeId}). Drop enforcement resumes from this measurement; ` +
		`the commit-time full-suite gate still checks the complete picture.`
	);
}
