// ===========================================
// Harness liveness — a ROUND-TRIP, not a pid
// ===========================================
// `isHarnessRunning()` answers "is this pid alive". That is not the question
// any diagnostic actually wants: `installCrashResilience()` deliberately keeps
// a daemon process running through an error, so a daemon whose LISTENER died
// stays pid-alive forever while answering nothing. A fresh-eyes audit
// (2026-08-14, F1) found both diagnostics reporting exactly such a process as
// healthy — `harness status` printed "running (PID …)" two lines above
// "Socket: not found", and `doctor` printed "[pass] Harness server". Meanwhile
// the hook path, which does its own liveness check, was correctly failing
// closed on every tool call. The tools were lying; the guard was not.
//
// So liveness here means one thing: SOMETHING ANSWERED. We connect, send a
// real event, and wait for the decision line — the same exchange a hook makes.
// Three states come out of it, and every surface must be able to say all
// three, because the middle one is the entire bug:
//
//   listening — a socket answered (verified, not inferred)
//   zombie    — a pid is alive and nothing answered (LOUD: the guard is off)
//   stopped   — no pid, nothing answered (honest, expected, harmless)

import { existsSync } from "node:fs";
import { createDaemonClient } from "../harness/daemon-client.js";
import { daemonSocketPaths, discoverDaemons } from "../harness/session-paths.js";
import { isRawStatusDecision, parseDaemonHealth } from "../harness/socket-readiness.js";
import { c } from "../lib/formatter.js";
import { getFramedSocketPath, getSocketPath } from "./harness-process.js";
import { queryHarnessSocket } from "./harness-status-helpers.js";

export type HarnessLivenessState = "listening" | "zombie" | "stopped";

/** Short by design: a diagnostic must not hang on a wedged daemon. A healthy
 *  local round-trip is sub-millisecond; anything past this is not serving in
 *  any sense a hook would benefit from. */
export const LIVENESS_PROBE_TIMEOUT_MS = 1500;

export interface HarnessLivenessInput {
	/** `isHarnessRunning(cwd).running` — pid-file liveness. */
	processRunning: boolean;
	/** Did a socket complete a request/response exchange? */
	socketAnswered: boolean;
}

/**
 * The verdict. An ANSWER outranks a pid in both directions: something serving
 * is listening even if the legacy pid file is stale or missing (a framed-only
 * daemon is the normal case), and a pid with no answer is a zombie no matter
 * how alive the process is.
 */
export function classifyHarnessLiveness(input: HarnessLivenessInput): HarnessLivenessState {
	if (input.socketAnswered) return "listening";
	return input.processRunning ? "zombie" : "stopped";
}

/**
 * One real request/response against the raw socket. Returns false — never
 * throws — when the socket file is absent, the connect is refused, or the
 * daemon does not answer within the timeout.
 *
 * The absent-file short-circuit is not just an optimization: it keeps the
 * probe from opening a connection that can only fail, so callers can assert
 * "no socket ⇒ no query" without inspecting timing.
 */
export async function probeHarnessSocket(
	cwd: string,
	timeoutMs: number = LIVENESS_PROBE_TIMEOUT_MS,
): Promise<boolean> {
	// Every daemon flavor counts (review 2026-08-26, both passes): the raw
	// socket speaks newline-JSON hook events; framed per-session daemons speak
	// the RPC envelope, so they are probed with a REAL `daemon.health` call —
	// sending a raw StatusQuery at a framed socket only proved "something
	// listens" while generating bad_request error traffic on every status/
	// doctor run. Named session sockets are discovered, not just the default.
	// First success wins immediately; a silent sibling cannot stall an answer.
	// Cancellation (review pass 15): the first success ABORTS the losing
	// probes — otherwise a silent raw socket keeps its socket + timer holding
	// the event loop for the full timeout after framed health already won.
	const controller = new AbortController();
	const probes: Array<Promise<boolean>> = [];
	const rawPath = getSocketPath(cwd);
	if (existsSync(rawPath)) probes.push(probeRawSocket(rawPath, timeoutMs, controller.signal));
	for (const framedPath of framedSocketCandidates(cwd, rawPath)) {
		probes.push(probeFramedHealth(framedPath, timeoutMs, controller.signal));
	}
	if (probes.length === 0) return false;
	const won = await firstSuccess(probes);
	if (won) controller.abort();
	return won;
}

async function probeRawSocket(
	socketPath: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<boolean> {
	const answer = await queryHarnessSocket(
		socketPath,
		{
			hook_event: "StatusQuery",
			session_id: "cli-status",
			agent_source: "claude",
			timestamp: new Date().toISOString(),
		},
		timeoutMs,
		signal,
	);
	return isRawStatusDecision(answer);
}

/** A framed daemon is healthy only if it answers its OWN protocol's
 *  `daemon.health` with a VALID health body — an envelope-shaped anything is
 *  not health (review pass 15: any non-null object used to count). */
async function probeFramedHealth(
	socketPath: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		const health = await createDaemonClient(socketPath).call(
			"daemon.health",
			{},
			signal ? { timeout_ms: timeoutMs, signal } : { timeout_ms: timeoutMs },
		);
		return parseDaemonHealth(health) !== null;
	} catch {
		return false;
	}
}

/**
 * Parse a `daemon.health` result into a typed DaemonHealth, or null. EVERY
 * required field is validated (review pass 16: the earlier two-field check
 * accepted `{status:"ready", protocol_version:"garbage"}`). Degraded still
 * counts as alive; a WRONG protocol version does not — an incompatible
 * daemon needs a restart, and reporting it "listening" would hide that.
 */
export { parseDaemonHealth } from "../harness/socket-readiness.js";


/** All framed socket paths worth probing: pid-file-discovered session daemons
 *  (named sessions included — doctor previously saw only the default) plus the
 *  default framed path, deduped, existing on disk, never the raw socket. */
function framedSocketCandidates(cwd: string, rawPath: string): string[] {
	const discovered = daemonSocketPaths(cwd).filter((path) => path !== rawPath);
	return [...new Set([getFramedSocketPath(cwd, undefined), ...discovered])].filter(
		(p): p is string => typeof p === "string" && p.length > 0 && p !== rawPath && existsSync(p),
	);
}

/** Resolve true on the FIRST fulfilled true; false only when every probe has
 *  settled falsy. A rejected probe counts as false. */
function firstSuccess(probes: Array<Promise<boolean>>): Promise<boolean> {
	return new Promise((resolve) => {
		let remaining = probes.length;
		const settle = (ok: boolean): void => {
			if (ok) resolve(true);
			remaining -= 1;
			if (remaining === 0) resolve(false);
		};
		for (const p of probes) {
			p.then(settle, () => settle(false));
		}
	});
}

/** Delay before the confirming re-probe. Binding a unix socket is sub-second
 *  locally, so a daemon that is merely still starting answers on the second
 *  attempt — which matters because `harness restart && harness status` (this
 *  repo's own troubleshooting recipe) lands inside that window every time. */
const LIVENESS_CONFIRM_DELAY_MS = 750;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		// Deliberately NOT unref'd (review 2026-08-26): this timer is AWAITED, so
		// releasing it from event-loop ownership let the whole process exit with
		// "unsettled top-level await" (code 13) whenever nothing else was pending
		// — which is exactly the framed-only-daemon case the confirm delay
		// exists to re-check. The wait is bounded and paid only in the ambiguous
		// zombie-suspect state.
		setTimeout(resolve, ms);
	});
}

/**
 * The probe a diagnostic should call: one round-trip, and — only when a live
 * pid makes the silence ambiguous — one confirming re-probe.
 *
 * Asymmetric on purpose. Calling a healthy daemon a ZOMBIE two seconds after
 * it started would be the same class of lie this module exists to remove, just
 * pointed the other way; and the wait is paid ONLY in the state that is
 * already broken (pid alive, nothing answering). With no live pid there is
 * nothing to wait for, so "not running" stays instant.
 */
export async function probeHarnessLive(
	cwd: string,
	processRunning: boolean,
	confirmDelayMs: number = LIVENESS_CONFIRM_DELAY_MS,
): Promise<boolean> {
	if (await probeHarnessSocket(cwd)) return true;
	// `processRunning` reflects only the legacy harness.pid; a NAMED session
	// daemon that is alive but still binding its socket earned the confirming
	// re-probe too (review pass 15: it was reported "stopped" mid-startup).
	const anyDaemonAlive = processRunning || discoverDaemons(cwd).some((d) => d.alive);
	if (!anyDaemonAlive) return false;
	await delay(confirmDelayMs);
	return probeHarnessSocket(cwd);
}

/**
 * The `Status:` value for the human report. Each state gets its own colour AND
 * its own words: "running (PID …)" is reserved for a VERIFIED listener, so it
 * can no longer appear beside "Socket: not found" the way the audit found it.
 */
export function livenessStatusValue(state: HarnessLivenessState, pid: number | undefined): string {
	if (state === "listening") return c.green(`running (PID ${pid ?? "?"}) — socket answering`);
	if (state === "zombie") {
		return c.red(`ZOMBIE — process alive (PID ${pid ?? "?"}), no socket answering`);
	}
	return c.dim("not running");
}

/**
 * The one wording for the zombie state, shared by `harness status` and
 * `doctor` so a user who sees it in one place recognizes it in the other.
 * States the CONSEQUENCE first (the guard is not running), then the fix.
 */
export function zombieWarningLine(pid: number | undefined): string {
	const who = pid === undefined ? "The harness process" : `Harness PID ${pid}`;
	return (
		`ZOMBIE DAEMON: ${who} is alive but no harness socket answered. ` +
		"It is holding the pid file while guarding nothing — every tool call fails closed " +
		"(or runs ungated on a fail-open runner). Fix: interlinked harness restart"
	);
}

/** Status + message for one doctor row — the same pair shape
 *  `collectionLivenessCheck` returns, so doctor spreads it into a CheckResult
 *  without this module importing doctor's types. */
export interface HarnessServerRow {
	status: "pass" | "fail" | "warn";
	message: string;
}

export interface HarnessServerRowInput {
	processRunning: boolean;
	pid: number | undefined;
	/** Does `harness.sock` exist on disk? Only distinguishes the two
	 *  not-running messages. */
	socketExists: boolean;
	/** Round-trip result, or undefined when the caller did not probe (which
	 *  keeps the pre-probe wording rather than inventing a verdict). */
	socketAnswered: boolean | undefined;
}

/**
 * `doctor`'s "Harness server" row. Returns the status/message pair rather than
 * a full CheckResult — same shape as `collectionLivenessCheck` — so the
 * liveness vocabulary stays in one module without doctor's types leaking back
 * into it.
 *
 * The row that matters is the third one: a live pid that answers nothing used
 * to render `[pass] Harness server -- Running (PID …)`, which is the single
 * most misleading line either diagnostic could print.
 */
export function harnessServerRow(input: HarnessServerRowInput): HarnessServerRow {
	const pidSuffix = input.pid === undefined ? "" : ` (PID ${input.pid})`;
	if (input.socketAnswered === true) {
		return { status: "pass", message: `Running${pidSuffix} -- socket answering` };
	}
	if (input.processRunning && input.socketAnswered === false) {
		return { status: "fail", message: zombieWarningLine(input.pid) };
	}
	if (input.processRunning) return { status: "pass", message: `Running${pidSuffix}` };
	if (input.socketExists) {
		return {
			status: "warn",
			message: "Stale socket found but process not running -- run 'interlinked harness start'",
		};
	}
	return {
		status: "warn",
		message:
			"Not running -- guard evaluation uses inline fallback (5 checks vs 20+). Start: 'interlinked harness start'",
	};
}
