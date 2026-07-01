// ===========================================
// Deterministic Trajectory-Analysis Engine — public entry
// ===========================================
//
// Aggregates the rule families (Family 1 churn + Family 5 security) and exposes
// the single `evaluateTrajectory` entry the daemon's shadow wiring calls. The
// obligation-inventory Stop-time pair (obligation-inventory.ts) is deliberately
// separate and surfaced through its own formatters, not here.
//
// Deterministic by construction: `applyEvent` folds the event into state (no IO,
// no clock, no randomness), then every rule — a pure `(state, event) => Verdict |
// null` — runs against the folded state. Rules never mutate state and never throw.

import { CHURN_RULES } from "./rules-churn.js";
import { SECURITY_RULES } from "./rules-security.js";
import { applyEvent } from "./state.js";
import type { ToolEvent, TrajectoryRule, TrajectoryState, Verdict } from "./types.js";

export { createState } from "./state.js";
export type { ToolEvent, TrajectoryState, Verdict } from "./types.js";

/** Every wired trajectory rule (churn + security families), in evaluation order. */
export const TRAJECTORY_RULES: ReadonlyArray<TrajectoryRule> = [...CHURN_RULES, ...SECURITY_RULES];

/**
 * Fold `event` into `state`, then evaluate every rule against the folded state.
 * Returns all firing verdicts (empty when none fire). `applyEvent` performs the
 * incremental (mutating) fold; the rules are pure and total. Call on BOTH the
 * PreToolUse and PostToolUse of a tool call — security rules self-gate to Pre,
 * churn rules to Post, so passing every tool event through is correct and never
 * double-fires a rule.
 */
export function evaluateTrajectory(state: TrajectoryState, event: ToolEvent): Verdict[] {
	applyEvent(state, event);
	const verdicts: Verdict[] = [];
	for (const rule of TRAJECTORY_RULES) {
		const fired = rule(state, event);
		if (fired) verdicts.push(fired);
	}
	return verdicts;
}
