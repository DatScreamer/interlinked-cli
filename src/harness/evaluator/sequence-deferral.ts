// ===========================================
// Sequence-detector deferral acknowledgement (PreToolUse)
// ===========================================
// Several `pre_block` sequence detectors END their message with a documented
// escape hatch — `secret_read_then_network_call` says, verbatim:
//
//   "If the destination is legitimate, acknowledge with
//    `// interlinked: defer secret_read_then_network_call -- <reason>`."
//
// Nothing read it. The marker grammar was wired into the Stop-time rescan
// (`stop-rescan.ts`) and the content-check suppression path only, so the
// PreToolUse sequence phase never looked at the candidate's own text. Lived
// 2026-08-16: a latched `secret_read_then_network_call` refused every socket
// probe of the local daemon for the rest of the session, WITH the exact
// acknowledgment the block message asked for present in the command. Trajectory
// sensitivity is sticky — once the session reads one confidential file it stays
// Confidential — so a detector with an unread escape hatch blocks permanently.
//
// Zero-FP shape, three constraints:
//   1. The marker must name the EXACT detector id. `defer secrets`, a prefix, or
//      a wildcard never suppresses — an acknowledgment is per-detector consent.
//   2. Only the CANDIDATE'S OWN text counts (the Bash command, or a write's
//      content / replacement). Nothing on disk and nothing from an earlier turn
//      can pre-authorize this call.
//   3. Suppression is LOGGED, never silent: every acknowledged block emits an
//      `[interlinked:sequence-deferred]` warning naming the detector, the reason
//      the agent gave (or its absence), and the message that was suppressed.
//
// Scope: the pre_block path only. A `pre_warn` finding costs nothing and stays
// visible — acknowledging a warning you can already read is not the problem.

import type { SequenceFinding } from "../sequence-checks/types.js";
import { scanInlineDeferrals } from "../suppressions.js";
import type { HarnessEvent } from "../types.js";

/** Longest suppressed-message fragment echoed back in the acknowledgement. */
const MESSAGE_EVIDENCE_MAX = 120;

/** Candidate fields that carry agent-authored text for this one call. */
const TEXT_FIELDS = ["command", "content", "new_string"] as const;

/**
 * The candidate's own text: a Bash command, or the content / replacement text a
 * write carries. Concatenated because a marker anywhere in the call the agent is
 * making is the agent speaking about THIS call.
 */
function candidateText(event: HarnessEvent): string {
	const input = event.tool_input;
	if (!input) return "";
	const parts: string[] = [];
	for (const key of TEXT_FIELDS) {
		const value = input[key];
		if (typeof value === "string" && value !== "") parts.push(value);
	}
	return parts.join("\n");
}

/**
 * Detector ids the candidate acknowledges, mapped to the reason given (null when
 * the agent supplied none — an empty reason still defers, and the audit trail
 * records that it was empty).
 */
export function acknowledgedSequenceIds(event: HarnessEvent): Map<string, string | null> {
	const acknowledged = new Map<string, string | null>();
	const text = candidateText(event);
	if (!text.includes("interlinked:")) return acknowledged; // cheap reject
	for (const perLine of scanInlineDeferrals(text).values()) {
		for (const [checkId, reason] of perLine) {
			if (!acknowledged.has(checkId)) acknowledged.set(checkId, reason);
		}
	}
	return acknowledged;
}

/** The audit line for one acknowledged block. */
export function formatSequenceAcknowledgement(
	finding: SequenceFinding,
	reason: string | null,
): string {
	return (
		`[interlinked:sequence-deferred] ${finding.detector_id} would have BLOCKED this call; the call ` +
		`carries \`interlinked: defer ${finding.detector_id}\`, so it is allowed and recorded. ` +
		`Reason given: ${reason ?? "(none — an unexplained deferral is itself a signal)"}. ` +
		`Suppressed: ${finding.match.message.slice(0, MESSAGE_EVIDENCE_MAX)}`
	);
}

/**
 * Drop the pre_block findings this candidate explicitly acknowledges, pushing
 * one audit warning per drop. Returns the findings that still block.
 *
 * PERSISTS NOTHING — the warning is the record, so a dry run needs no special
 * casing (the 2026-08-04 rule for evaluators that write ledgers).
 */
export function dropAcknowledgedFindings(
	findings: readonly SequenceFinding[],
	event: HarnessEvent,
	warnings: string[],
): SequenceFinding[] {
	if (findings.length === 0) return [];
	const acknowledged = acknowledgedSequenceIds(event);
	if (acknowledged.size === 0) return [...findings];
	const kept: SequenceFinding[] = [];
	for (const finding of findings) {
		if (!acknowledged.has(finding.detector_id)) {
			kept.push(finding);
			continue;
		}
		warnings.push(
			formatSequenceAcknowledgement(finding, acknowledged.get(finding.detector_id) ?? null),
		);
	}
	return kept;
}
