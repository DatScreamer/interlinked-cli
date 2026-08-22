// ===========================================
// Handover churn backstop — bounded restart loops
// ===========================================
// Root cause (2026-08-22 postmortem): a build-refresh handover, an
// rss-ceiling recycle, and an explicit `interlinked harness restart` can all
// target the SAME repo within seconds of each other — the build-refresh
// watcher spawns `harness restart`, which unconditionally SIGTERMs every
// daemon pid file it discovers (`stopAllDaemons`, "unlike a reaper this MAY
// stop a serving daemon") before checking whether a DIFFERENT trigger's
// successor is still mid-boot. A successor that has written its pid file but
// not yet reached `listening` looks identical to a stale orphan, so the next
// trigger kills it too — five daemons died pre-listening in nine minutes on
// 2026-08-22 this way, each contributing a `handover` ledger row with no
// matching `listening` row.
//
// The primary fix (see startup-lock.ts's heartbeat + harness-lifecycle-
// helpers.ts's `resolveRestartAction`) makes a restart trigger DEFER to an
// in-flight start instead of killing it. This module is the required
// BACKSTOP for whatever the primary fix misses: no caller may keep spawning
// successors forever. Every automatic handover site (rss-ceiling in
// build-refresh.ts's `spawnRestartViaCli`, build-refresh itself in its tick
// handler, and the explicit-restart path in harness-lifecycle-helpers.ts)
// consults `handoverChurnExceeded` before spawning. Past the threshold, the
// caller backs off — recording a `churn-backstop` row so the postmortem
// self-explains — and recovery falls to a path this module does NOT gate:
// the hook's cold-fallback self-heal, or a human running `interlinked
// harness start` directly.

import type { DaemonLedgerEvent } from "./daemon-ledger.js";

/** Unresolved handovers inside the window before a caller backs off. */
export const HANDOVER_CHURN_MAX_ATTEMPTS = 4;
/** Rolling window the backstop counts over. */
export const HANDOVER_CHURN_WINDOW_MS = 10 * 60_000;

/**
 * Net unresolved handovers in the trailing window: every `handover` row
 * minus every `listening` row, both within `windowMs` of `nowMs`. A daemon
 * that reaches `listening` after a handover "pays off" that attempt; one
 * that never does keeps counting against every later caller until the
 * window ages the row out.
 */
export function netUnresolvedHandovers(
	events: readonly DaemonLedgerEvent[],
	nowMs: number,
	windowMs: number = HANDOVER_CHURN_WINDOW_MS,
): number {
	const windowStart = nowMs - windowMs;
	let handovers = 0;
	let listens = 0;
	for (const e of events) {
		if (e.at < windowStart || e.at > nowMs) continue;
		if (e.event === "handover") handovers++;
		else if (e.event === "listening") listens++;
	}
	return Math.max(0, handovers - listens);
}

/** True once the backstop should refuse another automatic handover attempt. */
export function handoverChurnExceeded(
	events: readonly DaemonLedgerEvent[],
	nowMs: number,
	maxAttempts: number = HANDOVER_CHURN_MAX_ATTEMPTS,
	windowMs: number = HANDOVER_CHURN_WINDOW_MS,
): boolean {
	return netUnresolvedHandovers(events, nowMs, windowMs) >= maxAttempts;
}

/** The ledger row every backstop trip records, so the next postmortem reads
 *  the defense acting instead of a silent gap. `detail` names which trigger
 *  backed off. */
export function churnBackstopEvent(pid: number, nowMs: number, detail: string): DaemonLedgerEvent {
	return { at: nowMs, pid, event: "handover", reason: "churn-backstop", detail };
}
