// ===========================================
// harness-restart-guard — restart trigger vs. in-flight start
// ===========================================
// `harnessRestartCommand` (harness.ts) used to call `stopRunningHarnessForRestart`
// unconditionally on every invocation. `stopAllDaemons` is explicitly allowed to
// stop a SERVING daemon ("unlike a reaper this MAY stop a serving daemon") —
// correct for a genuine stop, but a daemon that has written its pid file and not
// yet reached `listening` looks identical to a stale orphan to that sweep. So any
// two overlapping restart triggers for the same repo (a build-refresh handover,
// an rss-ceiling recycle, a human re-running the command) fought over the same
// socket: whichever ran second killed the successor the first had JUST spawned.
// Five successors died pre-listening in nine minutes this way on 2026-08-22.
//
// `resolveRestartAction` makes the kill conditional on two ledger-backed
// signals — a genuinely in-flight start (the startup lock, now heartbeated by
// `touchStartupLock` so a slow-but-alive holder is never mistaken for dead —
// see startup-lock.ts), and the handover-churn backstop shared with the
// automatic handover sites (build-refresh.ts). `reportRestartDecision` ledgers
// + reports every non-"proceed" verdict, closing the "successor vanishes with
// no row" symptom: a startup-lock LOSER previously took `reportPendingStart`
// (harness-lifecycle-helpers.ts), which never touches the ledger at all.

import type { DaemonLedgerEvent } from "../harness/daemon-ledger.js";
import { readRecentDaemonEvents, recordDaemonEvent } from "../harness/daemon-ledger.js";
import {
	HANDOVER_CHURN_MAX_ATTEMPTS,
	HANDOVER_CHURN_WINDOW_MS,
	churnBackstopEvent,
	handoverChurnExceeded,
} from "../harness/handover-churn.js";
import { startupInFlight, waitForDaemonSocket } from "../harness/startup-lock.js";
import { c } from "../lib/formatter.js";
import { type OutputMode, output, outputError } from "../lib/output.js";

/** Verdict from {@link resolveRestartAction} — what `harness restart` should
 *  do before it kills anything. */
export type RestartDeferDecision =
	| { action: "deferred-ready" }
	| { action: "deferred-timeout" }
	| { action: "backoff-churn" }
	| { action: "proceed" };

export interface ResolveRestartActionDeps {
	inFlight?: (cwd: string, nowMs?: number) => boolean;
	wait?: typeof waitForDaemonSocket;
	readEvents?: typeof readRecentDaemonEvents;
}

/**
 * Decide what `harness restart` should do before it stops anything.
 *
 *  - a start is genuinely IN FLIGHT → wait for its socket instead of killing
 *    it. Ready within the wait window means there is nothing left to restart
 *    (`"deferred-ready"`); still not answering means the holder is presumed
 *    wedged and the caller should proceed (`"deferred-timeout"`).
 *  - no start is in flight, but too many unresolved handovers have piled up
 *    in the ledger within the churn window → refuse outright
 *    (`"backoff-churn"`).
 *  - neither condition holds → the normal stop+respawn sequence is safe
 *    (`"proceed"`).
 */
export async function resolveRestartAction(
	cwd: string,
	nowMs: number = Date.now(),
	deps: ResolveRestartActionDeps = {},
): Promise<RestartDeferDecision> {
	const inFlight = deps.inFlight ?? startupInFlight;
	const wait = deps.wait ?? waitForDaemonSocket;
	const readEvents = deps.readEvents ?? readRecentDaemonEvents;

	if (inFlight(cwd, nowMs)) {
		const ready = await wait(cwd);
		return { action: ready ? "deferred-ready" : "deferred-timeout" };
	}
	if (handoverChurnExceeded(readEvents(cwd), nowMs)) {
		return { action: "backoff-churn" };
	}
	return { action: "proceed" };
}

export interface ReportRestartDecisionDeps {
	recordEvent?: (evt: DaemonLedgerEvent) => void;
}

/**
 * Report + ledger a non-"proceed" {@link resolveRestartAction} verdict. Every
 * branch writes a row, so a deferred or backed-off restart still self-explains
 * in `daemon-events.jsonl`.
 */
export function reportRestartDecision(
	mode: OutputMode,
	cwd: string,
	decision: RestartDeferDecision,
	deps: ReportRestartDecisionDeps = {},
): void {
	const recordEvent = deps.recordEvent ?? ((evt: DaemonLedgerEvent) => recordDaemonEvent(cwd, evt));
	const nowMs = Date.now();
	if (decision.action === "deferred-ready") {
		recordEvent({ at: nowMs, pid: process.pid, event: "handover", reason: "deferred-to-inflight" });
		output(
			mode,
			{},
			{
				json: () => ({ status: "already_restarted" }),
				normal: () =>
					c.dim("A harness start was already in flight and is now serving — nothing to restart."),
			},
		);
		return;
	}
	if (decision.action === "backoff-churn") {
		recordEvent(churnBackstopEvent(process.pid, nowMs, "explicit-restart suppressed"));
		outputError(
			mode,
			`Too many restart attempts (${HANDOVER_CHURN_MAX_ATTEMPTS}+) without a successful start in the ` +
				`last ${Math.round(HANDOVER_CHURN_WINDOW_MS / 60_000)} minutes — backing off. Check ` +
				".interlinked/daemon-events.jsonl before retrying.",
		);
		return;
	}
	// "deferred-timeout": the in-flight holder never answered within the wait
	// window. Log it for the postmortem; the caller falls through to a real
	// stop+respawn (the wedged-holder fallback).
	recordEvent({ at: nowMs, pid: process.pid, event: "handover", reason: "deferred-timeout" });
}
