// ===========================================
// Stale-state recovery at bind — connect before you conclude
// ===========================================
// The daemon used to decide who owns the socket from the PID FILE, and only
// looked at the socket when a live foreign pid was found. Two failures came out
// of that, both measured 2026-08-15:
//
//  1. A stale `harness.sock` left by a killed daemon (no pid file, or a pid
//     file naming a recycled pid) made every newcomer's bind fail with
//     EADDRINUSE, exit `startup-failed`, and leave the corpse in place — so the
//     NEXT newcomer failed identically. Minutes of "harness pid present, no
//     live daemon" with nothing serving: a deadlock the system could not leave
//     on its own.
//  2. The inverse: a genuinely healthy incumbent whose pid file had been
//     cleaned got its socket unlinked out from under it.
//
// Both disappear once the question is asked of the SOCKET instead of the pid
// table: connect to it. A connection that is accepted proves an incumbent is
// serving (defer, exit 0, never signal it). A refused connection proves nobody
// is home no matter what any pid file claims (unlink the corpse, then bind).
// PIDs stay advisory — they name who to reap, never whether to reap.

import { existsSync } from "node:fs";
import { isDaemonSocketServing, liveForeignDaemonPid } from "../session-paths.js";
import {
	type AntiStompDeps,
	antiStompDepsFor,
	loseAntiStompRace,
	reapZombieIncumbent,
} from "./anti-stomp.js";
import { removeFileIfExists } from "./socket-lifecycle.js";

// Re-exported so a starting daemon takes its whole bind-time policy — the
// incumbent verdict AND the loser contract the framed path also needs — from
// one module.
export { antiStompDepsFor } from "./anti-stomp.js";

export type IncumbentVerdict =
	/** A live listener accepted a connection. Defer to it; do NOT bind or signal. */
	| { kind: "serving"; pid: number | null }
	/** A socket file existed but nothing answered. The corpse was removed; bind. */
	| { kind: "stale"; pid: number | null }
	/** No socket file at all — a clean start. */
	| { kind: "clear" };

export interface IncumbentDeps {
	fileExists: (path: string) => boolean;
	/** Resolves true when a listener ACCEPTS a connection on `path`. Must fail
	 *  SAFE (resolve true) on ambiguity — stomping a possibly-healthy daemon is
	 *  the worse error. */
	probe: (path: string) => Promise<boolean>;
	/** PID of a live, foreign process holding `pidPath`, else null. */
	liveForeignPid: (pidPath: string) => number | null;
	removeFile: (path: string) => void;
	log: (msg: string) => void;
}

/**
 * Decide what a starting daemon should do about whatever already occupies its
 * socket path, and clear the corpse when there is one.
 *
 * Side effect by design: on the `stale` verdict the dead socket file (and a pid
 * file naming a process that is gone) are unlinked here, so the caller's bind
 * cannot hit EADDRINUSE against a file nobody owns. A pid file naming a LIVE
 * process is left in place — the caller reaps that process explicitly.
 */
export async function resolveIncumbent(
	socketPath: string,
	pidPath: string,
	deps: IncumbentDeps,
): Promise<IncumbentVerdict> {
	const pid = deps.liveForeignPid(pidPath);
	if (!deps.fileExists(socketPath)) {
		// No socket file. A live pid with no socket is a daemon that never bound
		// here (or a framed-only deployment); either way there is nothing to
		// defer to and nothing to clear.
		return { kind: "clear" };
	}

	let serving: boolean;
	try {
		serving = await deps.probe(socketPath);
	} catch {
		// A throw from the probe itself is not proof of death. Fail safe:
		// defer, exactly as the pre-2026-08 behavior did.
		serving = true;
	}
	if (serving) return { kind: "serving", pid };

	deps.log(
		`[interlinked] ${socketPath} exists but refuses connections — removing the stale socket ` +
			`${pid === null ? "(no live owner)" : `(pid ${pid} is alive but not serving)`} and binding.`,
	);
	deps.removeFile(socketPath);
	// A pid file whose process is gone is the other half of the corpse: leaving
	// it made `harness status` and the hook's cold gate report a daemon that
	// does not exist. A LIVE pid stays — the caller reaps that one by signal.
	if (pid === null) deps.removeFile(pidPath);
	return { kind: "stale", pid };
}

export interface SettleIncumbentArgs {
	socketPath: string;
	pidPath: string;
	cwd: string;
	logAlways: (msg: string) => void;
	/** Test seam — defaults to this daemon's own loser contract (log, ledger
	 *  row, exit 0). Owned here so the caller needs one import, not two. */
	antiStomp?: AntiStompDeps;
	/** Test seam — defaults to the real fs/socket probe wiring. */
	deps?: IncumbentDeps;
}

/**
 * The daemon's whole pre-bind decision, in one call: resolve the incumbent,
 * defer (exit 0) to one that answers, reap one that is alive but deaf.
 *
 * Lives here rather than inline in server.ts so the policy is testable and so
 * server.ts holds under its line cap. Returns the verdict for tests; in
 * production the `serving` branch does not return at all (it exits).
 */
export async function settleIncumbentAtBind(args: SettleIncumbentArgs): Promise<IncumbentVerdict> {
	const deps: IncumbentDeps = args.deps ?? {
		fileExists: existsSync,
		probe: (p) => isDaemonSocketServing(p),
		liveForeignPid: liveForeignDaemonPid,
		removeFile: removeFileIfExists,
		log: args.logAlways,
	};
	const verdict = await resolveIncumbent(args.socketPath, args.pidPath, deps);
	if (verdict.kind === "serving") {
		loseAntiStompRace({
			ownerPid: verdict.pid ?? 0,
			detail: "the raw socket",
			cwd: args.cwd,
			deps: args.antiStomp ?? antiStompDepsFor(args.cwd, args.logAlways),
		});
	} else if (verdict.kind === "stale" && verdict.pid !== null) {
		reapZombieIncumbent(verdict.pid, args.logAlways);
	}
	return verdict;
}
