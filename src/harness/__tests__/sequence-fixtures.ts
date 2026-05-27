// interlinked-tdd: exempt — test fixture helper only. Consumed by every
// sequence-detector test file; no testable surface of its own.

import type { HarnessEvent, SessionTrajectory } from "../types.js";
import { SessionTracker } from "../session-state.js";

const DEFAULT_TIMESTAMP = "2026-05-27T00:00:00.000Z";
const DEFAULT_SESSION_ID = "test-session";

/**
 * Default field values applied to every fixture event. Tests pass `Partial`
 * shapes; this is what fills in `session_id`, `agent_source`, etc. so the
 * caller only specifies the fields they care about.
 */
const DEFAULT_EVENT: HarnessEvent = {
	hook_event: "PreToolUse",
	session_id: DEFAULT_SESSION_ID,
	agent_source: "claude",
	agent_name: "tester",
	timestamp: DEFAULT_TIMESTAMP,
};

/**
 * Build a `SessionTrajectory` by replaying `events` through a fresh
 * `SessionTracker`. The result is the final per-session trajectory state
 * with all derived fields (taint_sources, file_write_times, tool_sequence,
 * etc.) populated as they would be at runtime.
 *
 * Pattern lifted from `stop-rescan.test.ts::makeSession()`, generalized to
 * accept an arbitrary event stream rather than a bare list of written files.
 * Used by every sequence-detector test to build the prior trajectory
 * against which the detector is exercised.
 *
 * The `lastEvent` return value is the event the detector would be invoked
 * with as the `candidate` — by convention, the last event in the stream is
 * the trigger. Tests that want a different candidate should override.
 *
 * @param events ordered partial events; defaults filled by `DEFAULT_EVENT`
 * @param overrides post-hoc patches applied directly to the trajectory
 *   (e.g., `{ sensitivity_level: "Confidential" }`). Set fields the tracker
 *   doesn't populate from events alone.
 */
export function buildTrajectoryFixture(
	events: ReadonlyArray<Partial<HarnessEvent>>,
	overrides?: Partial<SessionTrajectory>,
): { session: SessionTrajectory; lastEvent: HarnessEvent } {
	const tracker = new SessionTracker();
	let last: HarnessEvent | null = null;
	const sessionId = overrides?.session_id ?? DEFAULT_SESSION_ID;
	for (const partial of events) {
		const ev: HarnessEvent = {
			...DEFAULT_EVENT,
			session_id: sessionId,
			...partial,
		};
		tracker.recordEvent(ev);
		last = ev;
	}
	const session = tracker.get(sessionId);
	if (!session) {
		throw new Error("buildTrajectoryFixture: tracker produced no session");
	}
	if (overrides) Object.assign(session, overrides);
	if (last === null) {
		last = { ...DEFAULT_EVENT, session_id: sessionId };
	}
	return { session, lastEvent: last };
}

/**
 * Convenience constructor for a candidate event that is NOT in the trajectory
 * yet. Useful for PreToolUse detectors: build the trajectory from prior
 * events, then construct the candidate separately so the detector sees the
 * pair as it would at runtime.
 */
export function makeCandidate(
	partial: Partial<HarnessEvent>,
	sessionId: string = DEFAULT_SESSION_ID,
): HarnessEvent {
	return {
		...DEFAULT_EVENT,
		session_id: sessionId,
		...partial,
	};
}
