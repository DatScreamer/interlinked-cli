// ===========================================
// Anti-stomp loser exit — one decision, shared by both startup races
// ===========================================
// Two independent checks can find that THIS process lost the race to own a
// daemon socket: the legacy raw-socket PID check (`liveForeignDaemonPid`,
// run synchronously at the top of server.ts) and the framed per-session
// ownership check inside `startSessionDaemon()` (session-daemon.ts), which
// throws `DaemonOwnershipConflictError` when a live PID already holds the
// session's pid file. Both losers must do the SAME two things: record the
// `anti-stomp` ledger row, then terminate — anything less leaves a
// timer-holding zombie. Before this fix, the framed path's throw reached
// `installCrashResilience()`'s survive-on-error handler, which logs and
// keeps the process running BY DESIGN (continuity for a genuinely
// unexpected check failure) — exactly wrong for an EXPECTED, already-decided
// ownership conflict, where every earlier `process.on`/`setInterval`
// registration in that same startup script keeps the event loop alive with
// no answering socket. This module names that decision so server.ts can
// route both callers through it, and a test can assert it without a real
// process exit or a real ledger write (see anti-stomp.test.ts).
//
// Deliberately bypasses the full graceful `shutdown()`: at the point either
// check fires, THIS process hasn't bound anything (that is the definition
// of losing before the bind), while the WINNER may already be live on the
// very socket path `shutdown()`'s cleanup unconditionally unlinks — calling
// it here would reintroduce the original stomp bug through a different
// door. A bare exit is safe: `process.exit()` tears down every
// timer/watcher/interval this script has registered so far, ref'd or not.

import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { recordDaemonEvent } from "../daemon-ledger.js";

export interface AntiStompDeps {
	logAlways: (msg: string) => void;
	/** Appends the `anti-stomp` exit row for THIS process to the daemon ledger. */
	recordExit: () => void;
	/** Terminates the process. */
	exit: () => void;
}

/** The real deps for a daemon process: its own stderr logger, the `anti-stomp`
 *  exit row for THIS pid (not the winner's — matching the start/handover
 *  rows' convention), and a plain exit 0. Losing a race is an ORDERLY
 *  outcome, so the code is 0; a startup that could not bind exits non-zero
 *  instead (see ./startup-guard.ts). Tests build the interface directly. */
export function antiStompDepsFor(cwd: string, logAlways: (msg: string) => void): AntiStompDeps {
	return {
		logAlways,
		recordExit: () =>
			recordDaemonEvent(cwd, { at: Date.now(), pid: process.pid, event: "exit", reason: "anti-stomp" }),
		exit: () => process.exit(0),
	};
}

export interface AntiStompLossArgs {
	/** PID of the daemon that won the race. */
	ownerPid: number;
	/** What was contested — e.g. "the raw socket" or `the framed session "default"`. */
	detail: string;
	cwd: string;
	deps: AntiStompDeps;
}

/** The loser's full contract, in order: clean own pid litter, log, record,
 *  exit. Callers decide WHETHER this fires (the two checks above have
 *  different trigger conditions); this function only owns WHAT happens once
 *  that's decided.
 *
 *  The pid-litter sweep exists because a dual-protocol newcomer writes the
 *  RAW `harness.pid` before it loses the FRAMED race — without the sweep
 *  that file permanently names a corpse, every `harness.pid` reader (the
 *  statusline glyph, the cold gate's pid discovery) concludes "daemon dead"
 *  next to a healthy incumbent, and the statusline's revive loop
 *  manufactures a fresh corpse every throttle window (the perpetual
 *  "restarting" of 2026-08-16). Ownership rule: remove a pid file ONLY when
 *  it names THIS process — the winner's files are never touched. */
export function loseAntiStompRace(args: AntiStompLossArgs): void {
	const { ownerPid, detail, cwd, deps } = args;
	removeOwnPidLitter(cwd);
	deps.logAlways(
		`[interlinked] A harness daemon (PID ${ownerPid}) already owns ${detail} for ${cwd}. ` +
			"Refusing to start a second one (would stomp its socket). " +
			"Use `interlinked harness restart` to replace it.",
	);
	deps.recordExit();
	deps.exit();
}

/** Remove every `.interlinked/harness*.pid` whose content is THIS process's
 *  pid. Best-effort and never throws — this runs on an exit path. Foreign
 *  pids (the winner's, or garbage) are left untouched. */
export function removeOwnPidLitter(cwd: string, ownPid: number = process.pid): void {
	const dir = join(cwd, ".interlinked");
	let names: string[] = [];
	try {
		names = readdirSync(dir).filter((n) => /^harness(-.+)?\.pid$/.test(n));
	} catch (err) {
		void err; // unreadable dir — nothing to clean
		return;
	}
	for (const name of names) {
		const p = join(dir, name);
		try {
			if (Number.parseInt(readFileSync(p, "utf-8").trim(), 10) === ownPid) unlinkSync(p);
		} catch (err) {
			void err; // unreadable/gone/permission — leave it; foreign files must survive
		}
	}
}

// ===========================================
// Zombie incumbent reap — the "live PID, dead socket" case
// ===========================================
// `liveForeignDaemonPid` proves a PID exists; `isDaemonSocketServing`
// (session-paths.ts) proves it actually answers. When the PID is alive but
// the socket is not serving, the incumbent is a zombie kept resident by
// `installCrashResilience()`'s survive-on-error design — exactly the process
// this module's loser contract does NOT apply to, because THIS process is
// the one taking over, not losing. Reap it (best effort) instead of
// deferring to it forever.

/**
 * Best-effort SIGTERM of a live-but-not-serving incumbent. Never throws:
 * `ESRCH` (already gone by the time we signal it) is expected and silent;
 * any other failure is logged but non-fatal — the caller is about to bind
 * the socket and take over regardless of whether this signal lands.
 * Deliberately SIGTERM-only (not SIGKILL): the zombie's own shutdown path,
 * if its event loop is merely slow rather than fully wedged, still gets a
 * chance to exit cleanly and release its pid file.
 */
export function reapZombieIncumbent(pid: number, logAlways: (msg: string) => void): void {
	try {
		process.kill(pid, "SIGTERM");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ESRCH") {
			logAlways(`[interlinked] Could not signal zombie incumbent PID ${pid}: ${String(err)}`);
		}
	}
}
