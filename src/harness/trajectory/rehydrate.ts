// Trajectory rehydration across a daemon restart.
//
// Red-team F4 (2026-08-09). The live trajectory state is runtime-only: the
// session snapshot deliberately drops `trajectoryDetector` and the shadow
// engine builds fresh state per session id (`server/trajectory-shadow.ts`
// `getState`). A restart therefore zeroes `fileReadSteps` while the SESSION
// keeps going — so an edit to a file read before the restart looks unread, and
// `reb_blind_edit_unread_file` fires on a file the agent demonstrably read.
// Measured repeatedly on 2026-08-09, a session that rebuilt after every fix.
//
// What survives a restart is the session's own `files_read` set: it is
// serialized into `<id>.live.json` and hydrated on the next event. That is
// enough, because the read/edit rules ask "was this file read this session",
// not "at which step". The step index is unrecoverable and unnecessary.
//
// Deliberately NOT solved by suppressing the rule when a session shows zero
// reads: a pinned case (`fires on a MultiEdit to an unread source file`) covers
// exactly that shape, and suppressing it would delete real signal.

import type { TrajectoryState } from "./types.js";

/**
 * Seed a fresh trajectory state with reads the session performed before this
 * process existed.
 *
 * Seeded reads carry step 0 — older than anything this process observed, which
 * is exactly right: they happened in a previous daemon lifetime. A read this
 * process already recorded always wins, so calling this on a warm state is
 * harmless, and calling it twice changes nothing.
 */
export function seedReadsFromSession(
	state: TrajectoryState,
	filesRead: readonly string[],
): void {
	for (const file of filesRead) {
		if (!file || state.fileReadSteps.has(file)) continue;
		state.fileReadSteps.set(file, 0);
		state.readCount += 1;
	}
}
