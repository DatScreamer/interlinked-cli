// ===========================================
// interlinked harness — Status / IO helpers
// ===========================================
// Extracted from harness.ts to keep that file under the 1000-line cap.
// This module owns: protocol-status types, socket-status readers, RSS,
// mode, latency-timestamp, and the raw-socket query helper.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, join } from "node:path";
import { createDaemonClient } from "../harness/daemon-client.js";
import type { DaemonHealth } from "../harness/daemon-protocol.js";
import { discoverDaemons } from "../harness/session-paths.js";
import { getConfigDir } from "../lib/config.js";
import { isJsonObject, type JsonObject } from "../lib/json-types.js";
import { getFramedSocketPath, getSocketPath } from "./harness-process.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HarnessProtocolMode = "raw" | "framed" | "dual";

export interface HarnessProtocolStatus {
	protocol: HarnessProtocolMode;
	protocol_version: string;
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

export interface FramedSocketStatus {
	session_id: string;
	pid: number | null;
	alive: boolean;
	socket_path: string;
	health: DaemonHealth | null;
	health_error: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** `ps` reports RSS in kilobytes; we surface it in megabytes. */
const KB_PER_MB = 1024;
/** Tail size for the latency-log scan in `readLastLatencyTimestamp`.
 *  ~50 records at current schema sizes, more than enough to find the most
 *  recent valid `ts` even when several trailing lines are partial / corrupt. */
const LATENCY_TAIL_BYTES = 8 * 1024;

// ---------------------------------------------------------------------------
// Protocol helpers
// ---------------------------------------------------------------------------

export function getProtocolStatusPath(cwd: string = process.cwd()): string {
	return join(getConfigDir(cwd), "harness-protocol.json");
}

export function parseHarnessProtocol(raw: string | undefined): HarnessProtocolMode {
	if (raw === "raw" || raw === "framed" || raw === "dual") return raw;
	return "dual";
}

export function expectedSocketPaths(
	cwd: string,
	protocol: HarnessProtocolMode,
	sessionId: string,
): string[] {
	if (protocol === "raw") return [getSocketPath(cwd)];
	if (protocol === "framed") return [getFramedSocketPath(cwd, sessionId)];
	return [getSocketPath(cwd), getFramedSocketPath(cwd, sessionId)];
}

// ---------------------------------------------------------------------------
// Status readers
// ---------------------------------------------------------------------------

/** Read RSS (resident set size) of a live PID via `ps -o rss= -p <pid>`,
 *  in MB. Returns null on any failure — RSS is operational telemetry, not
 *  a hard requirement, so we never fail the status call on it. */
export function readRssMb(pid: number): number | null {
	try {
		const out = execSync(`ps -o rss= -p ${pid} 2>/dev/null`, {
			encoding: "utf-8",
			timeout: 1000,
		}).trim();
		const kb = Number.parseInt(out, 10);
		if (Number.isNaN(kb)) return null;
		return Math.round(kb / KB_PER_MB);
	} catch (e) {
		void e;
		return null;
	}
}

/** Narrow a parsed `config.json` value to its `mode` field. Returns null when
 *  the value isn't a JSON object or `mode` isn't a string. */
function parseActiveMode(value: unknown): string | null {
	if (!isJsonObject(value)) return null;
	return typeof value.mode === "string" ? value.mode : null;
}

/** Read the configured operational mode from `.interlinked/config.json`.
 *  Returns null if the file is missing or malformed — the user might just
 *  not have run `interlinked enable` yet. */
export function readActiveMode(cwd: string): string | null {
	try {
		const configPath = join(getConfigDir(cwd), "config.json");
		if (!existsSync(configPath)) return null;
		return parseActiveMode(JSON.parse(readFileSync(configPath, "utf-8")));
	} catch (e) {
		void e;
		return null;
	}
}

/** Narrow a parsed `harness-protocol.json` value to a full
 *  `HarnessProtocolStatus`, defaulting every optional field and rejecting an
 *  unrecognized (or absent) `protocol` literal. */
function parseHarnessProtocolStatus(value: unknown): HarnessProtocolStatus | null {
	if (!isJsonObject(value)) return null;
	if (value.protocol !== "raw" && value.protocol !== "framed" && value.protocol !== "dual") {
		return null;
	}
	return {
		protocol: value.protocol,
		protocol_version:
			typeof value.protocol_version === "string" ? value.protocol_version : "unknown",
		started_at: typeof value.started_at === "string" ? value.started_at : "",
		raw_socket_path: typeof value.raw_socket_path === "string" ? value.raw_socket_path : null,
		framed_socket_path:
			typeof value.framed_socket_path === "string" ? value.framed_socket_path : null,
		framed_session_id:
			typeof value.framed_session_id === "string" ? value.framed_session_id : null,
		last_raw_event_at:
			typeof value.last_raw_event_at === "string" ? value.last_raw_event_at : null,
		last_framed_event_at:
			typeof value.last_framed_event_at === "string" ? value.last_framed_event_at : null,
		raw_event_count: typeof value.raw_event_count === "number" ? value.raw_event_count : 0,
		framed_event_count:
			typeof value.framed_event_count === "number" ? value.framed_event_count : 0,
		framed_error_count:
			typeof value.framed_error_count === "number" ? value.framed_error_count : 0,
		framed_timeout_count:
			typeof value.framed_timeout_count === "number" ? value.framed_timeout_count : 0,
	};
}

export function readProtocolStatus(cwd: string): HarnessProtocolStatus | null {
	try {
		const path = getProtocolStatusPath(cwd);
		if (!existsSync(path)) return null;
		return parseHarnessProtocolStatus(JSON.parse(readFileSync(path, "utf-8")));
	} catch (e) {
		void e;
		return null;
	}
}

export async function readFramedSocketStatuses(cwd: string): Promise<FramedSocketStatus[]> {
	const framedDaemons = discoverDaemons(cwd).filter(
		(entry) => basename(entry.paths.socket) !== "harness.sock",
	);
	return Promise.all(
		framedDaemons.map(async (entry): Promise<FramedSocketStatus> => {
			const out: FramedSocketStatus = {
				session_id: entry.session_id,
				pid: entry.pid,
				alive: entry.alive,
				socket_path: entry.paths.socket,
				health: null,
				health_error: null,
			};
			if (!entry.alive) {
				out.health_error = "process not alive";
				return out;
			}
			try {
				out.health = await createDaemonClient(entry.paths.socket).call("daemon.health", {}, {
					timeout_ms: 500,
				});
			} catch (err) {
				out.health_error = err instanceof Error ? err.message : String(err);
			}
			return out;
		}),
	);
}

/** Tail the latency log for the most recent record's `ts`. Best-effort: we
 *  read the trailing 8 KiB of the file (enough to span ~50 records at
 *  current sizes), parse JSON lines back-to-front, and return the first ts
 *  we recognise. Returns null on any read/parse failure. */
/** Narrow a parsed latency-log record to its `ts` field. Returns null when
 *  the value isn't a JSON object or `ts` isn't a string. */
function parseLatencyRecordTs(value: unknown): string | null {
	if (!isJsonObject(value)) return null;
	return typeof value.ts === "string" ? value.ts : null;
}

export function readLastLatencyTimestamp(cwd: string): string | null {
	try {
		const path = join(getConfigDir(cwd), "logs", "latency.jsonl");
		if (!existsSync(path)) return null;
		const size = statSync(path).size;
		const tailBytes = Math.min(size, LATENCY_TAIL_BYTES);
		const startOffset = size - tailBytes;
		const buf = readFileSync(path);
		const text = buf.subarray(startOffset).toString("utf-8");
		const lines = text.split("\n").filter((l) => l.trim().length > 0);
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i];
			if (line === undefined) continue;
			try {
				const ts = parseLatencyRecordTs(JSON.parse(line));
				if (ts !== null) return ts;
			} catch (e) {
				void e;
			}
		}
		return null;
	} catch (e) {
		void e;
		return null;
	}
}

// ---------------------------------------------------------------------------
// Raw-socket query helper
// ---------------------------------------------------------------------------

export function queryHarness(
	cwd: string,
	event: JsonObject,
	timeoutMs = 2000,
): Promise<JsonObject | null> {
	return new Promise((resolve) => {
		const socketPath = getSocketPath(cwd);
		if (!existsSync(socketPath)) {
			resolve(null);
			return;
		}

		const timeout = setTimeout(() => {
			try {
				sock.destroy();
			} catch (_) {
				/* intentional: socket already destroyed or never connected */
			}
			resolve(null);
		}, timeoutMs);

		const sock = createConnection(socketPath);
		let data = "";

		sock.on("connect", () => {
			sock.write(`${JSON.stringify(event)}\n`);
		});
		sock.on("data", (chunk) => {
			data += chunk.toString();
			const nlIdx = data.indexOf("\n");
			if (nlIdx !== -1) {
				clearTimeout(timeout);
				sock.destroy();
				try {
					resolve(JSON.parse(data.slice(0, nlIdx)));
				} catch {
					resolve(null);
				}
			}
		});
		sock.on("error", () => {
			clearTimeout(timeout);
			resolve(null);
		});
		sock.on("close", () => {
			clearTimeout(timeout);
			if (data.trim()) {
				try {
					resolve(JSON.parse(data.trim()));
				} catch {
					resolve(null);
				}
			} else {
				resolve(null);
			}
		});
	});
}
