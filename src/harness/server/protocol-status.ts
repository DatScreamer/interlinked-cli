// ===========================================
// Harness protocol status
// ===========================================
// Extracted from server.ts. The daemon writes a `.interlinked/harness-protocol.json`
// status file describing which sockets (raw / framed) it is serving and a
// per-protocol event/error/timeout tally. The shape and its mutators live here
// so they can be unit-tested without spinning up a socket server.
//
// `recordProtocolEvent` and friends mutate the status object in place — the
// daemon owns one long-lived instance and re-serializes it after each update.

import { writeFileSync } from "node:fs";
import { PROTOCOL_VERSION } from "../daemon-protocol.js";
import { resolveApiKey } from "../policy-classifier.js";
import type { GuardRulesConfig } from "../types.js";
import { ensureDirectory } from "./socket-lifecycle.js";

/** Which socket protocol(s) the daemon serves. */
export type HarnessProtocolMode = "raw" | "framed" | "dual";

/** On-disk shape of `.interlinked/harness-protocol.json`. */
export interface ProtocolStatusFile {
	protocol: HarnessProtocolMode;
	protocol_version: typeof PROTOCOL_VERSION;
	started_at: string;
	raw_socket_path: string | null;
	framed_socket_path: string | null;
	framed_session_id: string | null;
	last_raw_event_at: string | null;
	last_framed_event_at: string | null;
	raw_event_count: number;
	framed_event_count: number;
	framed_error_count: number;
	framed_timeout_count: number;
}

/** Build the initial protocol-status record at daemon startup. Counts start
 *  at zero; `started_at` is stamped now. */
export function createProtocolStatus(opts: {
	protocol: HarnessProtocolMode;
	rawSocketPath: string | null;
	framedSocketPath: string | null;
	framedSessionId: string | null;
}): ProtocolStatusFile {
	return {
		protocol: opts.protocol,
		protocol_version: PROTOCOL_VERSION,
		started_at: new Date().toISOString(),
		raw_socket_path: opts.rawSocketPath,
		framed_socket_path: opts.framedSocketPath,
		framed_session_id: opts.framedSessionId,
		last_raw_event_at: null,
		last_framed_event_at: null,
		raw_event_count: 0,
		framed_event_count: 0,
		framed_error_count: 0,
		framed_timeout_count: 0,
	};
}

/** Increment the per-protocol event counter and stamp the last-event time.
 *  Mutates `status` in place. */
export function recordProtocolEvent(
	status: ProtocolStatusFile,
	protocol: "raw" | "framed",
	now: string = new Date().toISOString(),
): void {
	if (protocol === "raw") {
		status.raw_event_count++;
		status.last_raw_event_at = now;
	} else {
		status.framed_event_count++;
		status.last_framed_event_at = now;
	}
}

/** Serialize the protocol status to `path` (pretty-printed JSON, trailing
 *  newline). Best-effort — any I/O failure is swallowed. */
export function writeProtocolStatus(path: string, status: ProtocolStatusFile): void {
	try {
		ensureDirectory(path);
		writeFileSync(path, `${JSON.stringify(status, null, 2)}\n`);
	} catch (e) {
		void e;
	}
}

/** Build the human-readable startup banner the daemon logs once both sockets
 *  are listening. Pure — every dynamic value is passed in. Mirrors the prior
 *  inline `buildStartupMessage`: lists each active socket, the PID and rule
 *  count, and an optional idle-timeout suffix (omitted when disabled). */
export function buildStartupMessage(opts: {
	protocol: HarnessProtocolMode;
	rawSocketPath: string | null;
	framedSocketPath: string | null;
	pid: number;
	ruleCount: number;
	idleTimeoutMs: number;
	msPerMinute: number;
}): string {
	const sockets: string[] = [];
	if (opts.rawSocketPath !== null) sockets.push(`raw ${opts.rawSocketPath}`);
	if (opts.framedSocketPath !== null) sockets.push(`framed ${opts.framedSocketPath}`);
	const idleSuffix = opts.idleTimeoutMs
		? `, idle timeout ${opts.idleTimeoutMs / opts.msPerMinute}min`
		: "";
	return (
		`Harness started (${opts.protocol}) on ${sockets.join(", ")} ` +
		`(PID ${opts.pid}, ${opts.ruleCount} rules${idleSuffix})`
	);
}

/** Compute the one-line classifier status the bash statusline consumes.
 *  `disabled` when the policy classifier is off; otherwise
 *  `<provider>:<model>:ready` when an API key is resolvable (or the provider
 *  is `claude_code`, which needs none), else `<provider>:<model>:no_key`.
 *  Pure — the only side-effect-free input is the rule config. */
export function computeClassifierStatusLine(rules: GuardRulesConfig): string {
	const p = rules.policy_classifier;
	if (!p?.enabled) return "disabled";
	const hasKey = p.provider === "claude_code" || !!resolveApiKey(p.api_key_env);
	return hasKey ? `${p.provider}:${p.model}:ready` : `${p.provider}:${p.model}:no_key`;
}

/** Collapse a content-scanner `ScannerStatus` into the one-line,
 *  shell-grepable format the bash statusline consumes:
 *  `ready:<pid>` / `dormant` / `starting` / `down:<reason>`. */
export function formatScannerStatusLine(s: {
	state: string;
	pid?: number | undefined;
	detail?: string | undefined;
}): string {
	switch (s.state) {
		case "ready":
			return `ready:${s.pid ?? "?"}`;
		case "dormant":
			return "dormant";
		case "starting":
		case "idle":
			return "starting";
		case "disabled":
			return `down:${s.detail ?? "unknown"}`;
		default:
			return s.state;
	}
}
