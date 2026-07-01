// ===========================================
// Per-edit mutation — outcome → harness decision (build step 7, wire contract)
// ===========================================
// Maps a MutationGateOutcome onto the harness wire (spec §9). There is no `warn`
// decision: a WARN / not-measured outcome is `allow` + warnings. Only a
// `measured` block produces `decision: "block"`, carrying the survivor + uncovered
// work-list in `reason` (a Pre-block fires no Post, so the reason must carry it).

import type { HarnessDecision } from "../types/decisions.js";
import type { MutantRecord, MutationGateOutcome } from "./types.js";

const RULE_ID = "per-edit-mutation";
const CATEGORY = "mutation";

function survivorSummary(s: MutantRecord): string {
	return `${s.mutator} ${s.originalLexeme}→${s.replacement}`;
}

function blockReason(survivors: MutantRecord[], uncovered: number): string {
	const parts: string[] = [];
	if (survivors.length > 0) parts.push(`${survivors.length} new surviving mutant(s)`);
	if (uncovered > 0) parts.push(`${uncovered} uncovered changed mutation site(s)`);
	const detail = survivors.length > 0 ? ` Survivors: ${survivors.map(survivorSummary).join("; ")}.` : "";
	return `[interlinked:mutation] BLOCKED: ${parts.join(" + ")} in the changed region.${detail} Resolve by strengthening the test, fixing or removing the code, or annotating an equivalent mutant.`;
}

/** Spec §6 small-scope block: too many mutation sites in the changed region to gate
 *  as one edit. Its own class — "split the patch", not "strengthen the test". */
function oversizeReason(count: number, threshold: number): string {
	return (
		`[interlinked:mutation] BLOCKED: this edit changes ${count} mutation sites in one patch ` +
		`(over the ${threshold}-site small-scope limit). Split it into smaller behavioral changes ` +
		`— each with its test — so the gate stays inside its budget. (spec §6)`
	);
}

/** Spec §7 red/green block: the proposed overlay's affected tests fail. Nothing
 *  downstream (survivors, coverage) is trustworthy until the suite is green. */
function suiteRedReason(): string {
	return (
		"[interlinked:mutation] BLOCKED: the affected tests are RED on this edit. " +
		"Fix the suite first — survivor/coverage results are meaningless against a failing suite. (spec §7)"
	);
}

/** Spec §7 RED-witness warning: a newly-added test passed on the pre-edit base too,
 *  so it never demonstrably failed — a weak/tautological test. WARN, not a block. */
function redWitnessWarning(): string {
	return (
		"[interlinked:mutation] the new test did not fail on the pre-edit base (RED-witness unmet) — " +
		"it may be tautological. Confirm it actually exercises the new behavior."
	);
}

/** Map a mutation gate outcome onto the harness wire contract (spec §9). */
export function mutationOutcomeToDecision(outcome: MutationGateOutcome): HarnessDecision {
	if (outcome.kind === "unavailable") {
		return { decision: "allow", warnings: [outcome.warning], rule_id: RULE_ID, category: CATEGORY };
	}
	if (outcome.decision === "block") {
		// Priority: a red suite is the most fundamental failure; then oversize ("split
		// the patch"); then the survivor/uncovered work-list.
		const reason = outcome.suiteRed
			? suiteRedReason()
			: outcome.changedSiteCount > outcome.siteCountThreshold
				? oversizeReason(outcome.changedSiteCount, outcome.siteCountThreshold)
				: blockReason(outcome.newSurvivors, outcome.uncoveredSites.length);
		return { decision: "block", reason, rule_id: RULE_ID, severity: "medium", category: CATEGORY };
	}
	// Clean allow — but surface a failed RED-witness as a non-blocking warning.
	if (outcome.redWitnessFailed) {
		return { decision: "allow", warnings: [redWitnessWarning()], rule_id: RULE_ID, category: CATEGORY };
	}
	return { decision: "allow", rule_id: RULE_ID, category: CATEGORY };
}
