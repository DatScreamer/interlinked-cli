// ===========================================
// Coverage debt — foreign-session surfacing (ownership scoping, 2026-07-17)
// ===========================================
// Focus is a property of ONE session's trajectory: a session cannot "return
// to" work it never did, so only debts a session itself opened may block its
// wander (`coverage-debt.ts` step 2). Another session's open debt is real
// repo state the current session should KNOW about without being walled by —
// these helpers render that heads-up and attach it to whatever the debt fold
// decided. The commit gate stays the cross-session ground truth.

import type { Obligation } from "./obligations.js";
import type { HarnessDecision } from "./types.js";

/** Human-scale age for a debt note: moments / minutes / hours / days. */
export function fmtAge(ms: number): string {
	if (ms < 60_000) return "moments";
	if (ms < 90 * 60_000) return `${Math.round(ms / 60_000)}m`;
	if (ms < 48 * 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
	return `${Math.round(ms / 86_400_000)}d`;
}

/**
 * The once-per-session heads-up for a debt some OTHER session left open. It
 * must read as information, not accusation ("you added code" was the original
 * defect: a cold agent can't tell the debt isn't theirs, leaving it a choice
 * between doing someone else's WIP, editing enforcement config, or evading).
 * It also names the recovery for the session-churn case — a restart changes
 * the session id, so "your own" pre-restart debt reads as foreign; editing
 * the pair continues that work regardless of owner.
 */
export function foreignDebtNote(d: Obligation, atMs: number): string {
	const age = fmtAge(Math.max(0, atMs - d.openedAtMs));
	if (d.kind === "red_suite") {
		return (
			`[interlinked:coverage] Note: another session's edits to ${d.file} left the ` +
			`suite RED (~${age} ago). Your edit is allowed — greening ${d.file} or its ` +
			`failing tests continues that work; the commit gate backstops.`
		);
	}
	return (
		`[interlinked:coverage] Note: another session left uncovered debt on ${d.file} ` +
		`(~${age} ago). Your edit is allowed — editing ${d.file} or its companion test ` +
		`continues that work; the commit gate backstops.`
	);
}

/**
 * Attach a note to whatever the fold decided. `null` decision (plain allow)
 * becomes an allow CARRYING the warning (the pipeline merges allow-decision
 * warnings onto the running decision); an existing decision — allow or a
 * passthrough block — gets the note appended after its own warnings.
 */
export function attachWarning(
	decision: HarnessDecision | null,
	note: string | null,
): HarnessDecision | null {
	if (note === null) return decision;
	if (decision === null) return { decision: "allow", warnings: [note] };
	return { ...decision, warnings: [...(decision.warnings ?? []), note] };
}
