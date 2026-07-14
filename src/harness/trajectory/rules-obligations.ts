// ===========================================
// Deterministic Trajectory-Analysis Engine — Family 3: Obligation Ledger (adapters)
// ===========================================
//
// The two Family-3 rules are implemented (and fully tested) in
// obligation-inventory.ts as self-contained pure functions over an event list
// (its local ToolEvent is a structural subset of the engine's, so engine events
// pass straight through). These thin adapters lift them into the engine's
// `(state, event) => Verdict | null` shape so they ride the standard shadow
// wiring: verdicts surface as `[interlinked:trajectory] <ruleId> (sev, shadow —
// would <action>)` warnings, never enacted, never blocking.
//
// Scope note: both adapters read the bounded `recentEvents` window (last 64
// events), so at Stop the open-obligation ledger nets over recent activity
// rather than the whole session. The full-stream Stop formatter
// (`formatOpenObligations`) stays exported for future server Stop wiring.

import { isEditEvent } from "./helpers.js";
import { formatOpenObligations, obligationConflictMarkerRule } from "./obligation-inventory.js";
import type { ToolEvent, TrajectoryRule, TrajectoryState, Verdict } from "./types.js";

/** Strip the inner `[interlinked:obligation…] <rule_id>:` framing — the shadow
 *  formatter adds its own `[interlinked:trajectory] <ruleId>` prefix, so keeping
 *  both would double-tag the line. */
function stripObligationTag(message: string): string {
	return message.replace(/^\[interlinked:obligations?\]\s*(?:[a-z0-9_]+:\s*)?/, "");
}

/**
 * `recentEvents` minus the OTHER hook leg of the current tool call. The
 * PreToolUse leg carries input identical to the PostToolUse leg we evaluate on,
 * so leaving it in would misread a marker freshly introduced by THIS edit as
 * one that "persisted" from an earlier edit.
 */
function priorEvents(state: TrajectoryState, event: ToolEvent): ToolEvent[] {
	if (!event.toolUseId) return state.recentEvents;
	return state.recentEvents.filter((e) => e === event || e.toolUseId !== event.toolUseId);
}

// ============================================================
// obl_conflict_marker_persisted (N/H) — per-edit
// ============================================================
// Fires when an edit LEAVES a 7-char Git conflict-marker run in the file.
// Detection, exemptions (docs/fixtures/codegen), and messaging all live in
// obligation-inventory.ts; this adapter only gates to the PostToolUse edit leg
// (so one tool call cannot fire twice) and maps the verdict shape.
export const oblConflictMarkerPersisted: TrajectoryRule = (state, event) => {
	if (event.hook !== "PostToolUse" || !isEditEvent(event)) return null;
	const v = obligationConflictMarkerRule(priorEvents(state, event), event);
	if (!v) return null;
	return {
		ruleId: v.rule_id,
		action: v.action,
		severity: v.severity,
		reason: stripObligationTag(v.message),
	};
};

// ============================================================
// obl_net_open_at_stop (N/M) — Stop-time inventory
// ============================================================
// The net-open obligation ledger (opened-minus-closed TODO/stub/disabled-test/
// conflict-marker lines), surfaced once at Stop as a calm inventory. Self-gates
// to Stop events; the shadow normalizer forwards PreToolUse / PostToolUse /
// Stop (Stop forwarding added in 31b0a54), so this fires at each Stop. Note it
// nets over the bounded `recentEvents` window (last 64 events), not the whole
// session.
export const oblNetOpenAtStop: TrajectoryRule = (state, event) => {
	if (event.hook !== "Stop") return null;
	const text = formatOpenObligations(state.recentEvents);
	if (!text) return null;
	const verdict: Verdict = {
		ruleId: "obl_net_open_at_stop",
		action: "nudge",
		severity: "medium",
		reason: stripObligationTag(text),
	};
	return verdict;
};

/** All Family-3 obligation-ledger rules (engine-shaped adapters). */
export const OBLIGATION_RULES: ReadonlyArray<TrajectoryRule> = [
	oblConflictMarkerPersisted,
	oblNetOpenAtStop,
];
