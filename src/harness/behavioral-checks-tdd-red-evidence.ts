// ===========================================
// TDD commit gate — red evidence
// ===========================================
// How a red cycle is JUDGED and DESCRIBED: whether its evidence is sound
// enough to block, and what the reader is told about where it came from.
//
// Split from `behavioral-checks-tdd.ts` (at the per-file line cap) because
// this is one cohesive question — "should this red stop a commit, and can the
// reader tell why?" — and because the answer got two new inputs at once.
//
// The gate reads REMEMBERED state; nothing re-measures the tree at decision
// time. That is fine when the memory is fresh and specific, and wrong when it
// is neither. Two ways it goes wrong, both observed on 2026-07-26:
//
//   • Suite-sourced: a whole-suite failure fans out across every tracked
//     cycle, reddening files that had nothing to do with it (16 unrelated
//     files in one session).
//   • Stale: a red from hundreds of steps and many edits ago blocked commits
//     for hours against a suite that was, at that moment, green.
//
// Neither is a reason to discard the finding — both are reasons to stop
// asserting a failure nobody has seen recently, and to say what the claim
// rests on instead.

import { basename } from "node:path";
import { ALL_TESTS_SENTINEL } from "./server-tdd-cycle.js";
import type { SessionTrajectory } from "./types.js";

/** The cycle fields the commit gate reads. */
export type RedCycleView = {
	state: string;
	red_at?: number | undefined;
	red_command?: string | undefined;
	test_file: string | null;
};

/**
 * How many tool calls a red may sit unrefreshed before it stops being grounds
 * to BLOCK. Past this it still surfaces — as a warning telling the reader to
 * re-run, rather than an assertion about a tree nobody has measured since.
 */
export const STALE_RED_AGE_STEPS = 50;

/**
 * Whether a cycle's red came from a whole-suite run rather than a run targeting
 * this file's own tests.
 *
 * Derived from existing session state (no schema change), so it also applies to
 * sessions persisted before this check existed: the suite result is recorded
 * under `ALL_TESTS_SENTINEL`, and the fan-out stamps every cycle it touches with
 * that run's step. A cycle whose `red_at` matches a FAILING suite run, with no
 * targeted run recorded for its own test file, was reddened by the fan-out.
 */
export function isSuiteSourcedRed(
	session: SessionTrajectory,
	cycle: { red_at?: number | undefined; test_file: string | null },
): boolean {
	const suite = session.test_runs?.get(ALL_TESTS_SENTINEL);
	if (!suite || suite.status !== "fail") return false;
	if (cycle.red_at === undefined || cycle.red_at !== suite.at_step) return false;
	// A targeted run for this file's own tests is sound per-file evidence and
	// overrides the fan-out attribution.
	return !(cycle.test_file && session.test_runs?.has(cycle.test_file));
}

/** True when the red is old enough to prompt a re-run rather than block. A red
 *  with no recorded step is treated as fresh (fail safe — keep blocking). */
export function isStaleRed(session: SessionTrajectory, cycle: RedCycleView): boolean {
	if (cycle.red_at === undefined) return false;
	return session.tool_call_count - cycle.red_at > STALE_RED_AGE_STEPS;
}

/** True when the red should warn rather than block. */
export function isSoftenedRed(session: SessionTrajectory, cycle: RedCycleView): boolean {
	return isSuiteSourcedRed(session, cycle) || isStaleRed(session, cycle);
}

/** The run that set the red, for the reader. Without it a stale red and a live
 *  one read identically and the block cannot be judged. */
function redEvidence(cycle: RedCycleView): string {
	if (cycle.red_at === undefined) return "";
	const cmd = cycle.red_command ? `: \`${cycle.red_command}\`` : "";
	return ` (last failing run at step ${cycle.red_at}${cmd})`;
}

/** The operator-facing sentence for a red cycle. */
export function redCycleMessage(
	session: SessionTrajectory,
	sourceFile: string,
	cycle: RedCycleView,
): string {
	const name = basename(sourceFile);
	if (isSuiteSourcedRed(session, cycle)) {
		return `The full suite was failing when ${name} was last observed, but the failure is not attributed to this file${redEvidence(cycle)}. Re-run its own tests to confirm.`;
	}
	if (isStaleRed(session, cycle)) {
		const age = session.tool_call_count - (cycle.red_at ?? 0);
		return `${name} has been red since step ${cycle.red_at} — ${age} tool calls ago — and nothing has re-run its tests since${redEvidence(cycle)}. That is no longer evidence about the current tree; re-run its tests to confirm or clear it.`;
	}
	return `Tests are ${cycle.state === "regression" ? "REGRESSING" : "FAILING"} for ${name}${redEvidence(cycle)}. Fix before committing.`;
}
