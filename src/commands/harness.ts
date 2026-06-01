// ===========================================
// interlinked harness — Harness server management
// ===========================================

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, join } from "node:path";
import { createDaemonClient } from "../harness/daemon-client.js";
import type { DaemonHealth } from "../harness/daemon-protocol.js";
import { discoverDaemons } from "../harness/session-paths.js";
import { getConfigDir } from "../lib/config.js";
import { c, header, kvLine } from "../lib/formatter.js";
import type { JsonObject } from "../lib/json-types.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import {
	closeDaemonStderrLog,
	type DaemonStderrLog,
	ensureDistFresh,
	getFramedSocketPath,
	getHarnessServerPath,
	getPidPath,
	getSocketPath,
	type HarnessStatus,
	isHarnessRunning,
	openDaemonStderrLog,
	readDaemonStderrLog,
	reapOrphanHarnesses,
} from "./harness-process.js";

// Re-export the process/orphan-management surface so existing importers of
// `./harness.js` (init, enable, doctor, harness-reap, harness-clean, skill,
// index, tests) keep a byte-for-byte-identical public API after the split.
export {
	collectAncestorPids,
	getSocketPath,
	isHarnessRunning,
	readActiveHarnessPid,
	reapOrphanHarnesses,
} from "./harness-process.js";
export type {
	OrphanCandidate,
	ReapOptions,
	ReapResult,
} from "./harness-process.js";

/** Delay after SIGTERM to let the harness process exit cleanly before we check its status. */
const HARNESS_SHUTDOWN_WAIT_MS = 1000;
/** Grace after SIGKILL before declaring the process unkillable. The kernel
 *  reaps within milliseconds in normal cases; one second is generous. */
const HARNESS_RESTART_KILL_WAIT_MS = 1000;
/** Max wait (ms) after SIGTERM during restart before giving up. */
const HARNESS_RESTART_MAX_WAIT_MS = 3000;
/** Poll interval (ms) while waiting for the harness to shut down during restart. */
const HARNESS_RESTART_POLL_MS = 200;

type HarnessProtocolMode = "raw" | "framed" | "dual";

interface HarnessProtocolStatus {
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

function getProtocolStatusPath(cwd: string = process.cwd()): string {
	return join(getConfigDir(cwd), "harness-protocol.json");
}

function parseHarnessProtocol(raw: string | undefined): HarnessProtocolMode {
	if (raw === "raw" || raw === "framed" || raw === "dual") return raw;
	return "dual";
}

function expectedSocketPaths(
	cwd: string,
	protocol: HarnessProtocolMode,
	sessionId: string,
): string[] {
	if (protocol === "raw") return [getSocketPath(cwd)];
	if (protocol === "framed") return [getFramedSocketPath(cwd, sessionId)];
	return [getSocketPath(cwd), getFramedSocketPath(cwd, sessionId)];
}

interface FramedSocketStatus {
	session_id: string;
	pid: number | null;
	alive: boolean;
	socket_path: string;
	health: DaemonHealth | null;
	health_error: string | null;
}

// ===========================================
// harness start
// ===========================================

export async function harnessStartCommand(opts: {
	daemon?: boolean;
	verbose?: boolean;
	json?: boolean;
	protocol?: string;
	sessionId?: string;
}): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = process.cwd();
	const protocol = parseHarnessProtocol(opts.protocol);
	const sessionId = opts.sessionId || "default";

	try {
		const status = isHarnessRunning(cwd);
		if (status.running) {
			output(
				mode,
				{ already_running: true, pid: status.pid },
				{
					json: () => ({ status: "already_running", pid: status.pid }),
					normal: () => `Harness already running (PID ${status.pid})`,
				},
			);
			return;
		}

		// Auto-rebuild if source is newer than compiled dist
		ensureDistFresh();

		const serverPath = getHarnessServerPath();
		if (!serverPath || !existsSync(serverPath)) {
			outputError(
				mode,
				serverPath
					? `Harness server not found at ${serverPath}`
					: "Harness server not found. Ensure interlinked-cli is installed correctly or run from the source checkout.",
			);
			return;
		}

		const nodePath = process.execPath; // Use the same Node binary running the CLI

		// Cap heap at 4 GB. The previous 1 GB default reliably OOM'd in
		// long-running sessions where activity logs and trajectory state
		// accumulate — `.interlinked/logs/daemon.log` showed 46+ V8 fatal
		// "Reached heap limit" crashes against the old cap in a single
		// week. 4 GB gives ~8-10× headroom over the typical 200-500 MB
		// working set while still preventing host-swap death from a
		// genuine runaway-leak. Override via env:
		// `INTERLINKED_HARNESS_HEAP_MB`.
		const heapMb = Number(process.env.INTERLINKED_HARNESS_HEAP_MB) || 4096;
		const args = [`--max-old-space-size=${heapMb}`, serverPath, "--cwd", cwd];
		args.push("--protocol", protocol);
		if (protocol !== "raw") args.push("--session-id", sessionId);
		if (opts.verbose) args.push("--verbose");

		// Reap orphan daemons before binding our own socket. Without this,
		// each `interlinked harness start` over a session lifetime accumulates
		// a stale daemon (oldest seen in production: 28 daemons across 4 days,
		// ~1.8 GB stale RSS). See `reapOrphanHarnesses` for selection rules.
		reapOrphanHarnesses(cwd);

		if (opts.daemon !== false) {
			// Clean up stale socket from any previous run
			const staleSocket = getSocketPath(cwd);
			if (protocol !== "framed" && existsSync(staleSocket)) {
				try {
					unlinkSync(staleSocket);
				} catch (_) {
					/* intentional: best-effort stale socket cleanup, harness server will retry */
				}
			}

			// Daemonize with stderr inherited by a log file. A pipe would need to be
			// closed when this CLI exits, which can make later daemon stderr writes fail.
			const stderrLog = openDaemonStderrLog(cwd);
			const daemonStdio: ["ignore", "ignore", "ignore" | number] = [
				"ignore",
				"ignore",
				stderrLog?.fd ?? "ignore",
			];
			const child = (() => {
				try {
					return spawn(nodePath, args, {
						stdio: daemonStdio,
						detached: true,
						cwd,
					});
				} finally {
					closeDaemonStderrLog(stderrLog);
				}
			})();
			let stderrOutput = "";
			let childExited = false;
			child.on("exit", () => {
				childExited = true;
			});
			child.unref();

			// Poll for expected sockets to appear (harness may take 10-30s to compile TypeScript)
			const socketPaths = expectedSocketPaths(cwd, protocol, sessionId);
			const maxWaitMs = 60_000;
			const pollMs = 500;
			const startTime = Date.now();
			let ready = false;
			while (Date.now() - startTime < maxWaitMs) {
				if (childExited) break; // Process crashed — stop waiting
				if (socketPaths.every((socketPath) => existsSync(socketPath))) {
					ready = true;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, pollMs));
			}

			const newStatus = isHarnessRunning(cwd);
			const resolvedPid = newStatus.pid ?? child.pid;
			const elapsed = Math.round((Date.now() - startTime) / 1000);
			if (!ready) {
				stderrOutput = readDaemonStderrLog(stderrLog);
			}
			output(mode, newStatus, {
				json: () => ({
					status: ready ? "started" : "failed",
					pid: resolvedPid,
					protocol,
					sockets: socketPaths,
				}),
				normal: () => {
					if (ready) return c.green(`Harness started (PID ${resolvedPid})`);
					const lines = [c.red(`Failed to start harness after ${elapsed}s.`)];
					if (childExited && stderrOutput) {
						lines.push(c.dim("Error output:"));
						lines.push(c.dim(stderrOutput.trim().slice(0, 500)));
					} else if (childExited) {
						lines.push(c.dim("Process exited without output."));
					} else {
						lines.push(
							c.dim("Process is running but socket not created. Try foreground:"),
						);
					}
					lines.push(c.dim(`  node ${serverPath} --cwd ${cwd} --verbose`));
					return lines.join("\n");
				},
			});
		} else {
			// Foreground mode — exec directly (replaces this process)
			output(
				mode,
				{},
				{
					json: () => ({ status: "starting_foreground" }),
					normal: () => c.dim("Starting harness in foreground (Ctrl+C to stop)..."),
				},
			);

			const child = spawn(nodePath, args, {
				stdio: "inherit",
				cwd,
			});
			child.on("exit", (code) => process.exit(code || 0));
		}
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}

// ===========================================
// harness stop
// ===========================================

export async function harnessStopCommand(opts: { json?: boolean }): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = process.cwd();

	try {
		const status = isHarnessRunning(cwd);
		if (!status.running || !status.pid) {
			output(
				mode,
				{ stopped: false },
				{
					json: () => ({ status: "not_running" }),
					normal: () => c.dim("Harness is not running."),
				},
			);
			return;
		}

		process.kill(status.pid, "SIGTERM");

		// Wait for shutdown
		await new Promise((resolve) => setTimeout(resolve, HARNESS_SHUTDOWN_WAIT_MS));

		// Verify it stopped
		const afterStatus = isHarnessRunning(cwd);
		output(
			mode,
			{ stopped: !afterStatus.running },
			{
				json: () => ({
					status: afterStatus.running ? "still_running" : "stopped",
					pid: status.pid,
				}),
				normal: () =>
					afterStatus.running
						? c.yellow(
								`Harness still running (PID ${status.pid}). Try: kill -9 ${status.pid}`,
							)
						: c.green(`Harness stopped (was PID ${status.pid})`),
			},
		);
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}

// ===========================================
// harness restart
// ===========================================

export async function harnessRestartCommand(opts: {
	daemon?: boolean;
	verbose?: boolean;
	json?: boolean;
	protocol?: string;
	sessionId?: string;
}): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = process.cwd();
	const protocol = parseHarnessProtocol(opts.protocol);
	const sessionId = opts.sessionId || "default";

	try {
		let oldPid: number | undefined;
		const status = isHarnessRunning(cwd);
		if (status.running && status.pid) {
			oldPid = status.pid;
			try {
				process.kill(status.pid, "SIGTERM");
			} catch {
				// intentional: already dead between status check and signal — fall through to the start path.
			}
			// Wait for graceful shutdown, then escalate to SIGKILL if the
			// daemon is wedged. Previously we surfaced the wedge as a hard
			// error and asked the user to `kill -9` themselves — but the
			// `Sending termination signals` rule blocks them from doing it
			// inside an agent session, deadlocking restart entirely. Owning
			// the escalation here is what makes `harness restart` actually
			// restart instead of give up.
			const start = Date.now();
			while (Date.now() - start < HARNESS_RESTART_MAX_WAIT_MS) {
				await new Promise((resolve) => setTimeout(resolve, HARNESS_RESTART_POLL_MS));
				if (!isHarnessRunning(cwd).running) break;
			}
			if (isHarnessRunning(cwd).running) {
				if (mode === "normal") {
					process.stderr.write(
						c.yellow(
							`PID ${status.pid} ignored SIGTERM after ${HARNESS_RESTART_MAX_WAIT_MS}ms — escalating to SIGKILL\n`,
						),
					);
				}
				try {
					process.kill(status.pid, "SIGKILL");
				} catch {
					// intentional: permission denied or already gone — last-ditch fall-through.
				}
				const killStart = Date.now();
				while (Date.now() - killStart < HARNESS_RESTART_KILL_WAIT_MS) {
					await new Promise((resolve) => setTimeout(resolve, HARNESS_RESTART_POLL_MS));
					if (!isHarnessRunning(cwd).running) break;
				}
				if (isHarnessRunning(cwd).running) {
					outputError(
						mode,
						`PID ${status.pid} survived SIGKILL — possibly a kernel-protected process. Investigate manually.`,
					);
					return;
				}
			}
			if (mode === "normal") {
				process.stderr.write(c.dim(`Stopped harness (was PID ${status.pid})\n`));
			}
		}

		// Resilience pass: sweep orphan daemons and remove stale state files
		// before respawning. Without this, a previous crash that left a stale
		// pid+sock pair can make the new daemon double-bind on the socket or
		// confuse `isHarnessRunning` callers downstream. We do this on the
		// happy path too — a fresh restart should never inherit dirt.
		reapOrphanHarnesses(cwd);
		const socketPath = getSocketPath(cwd);
		if (existsSync(socketPath) && !isHarnessRunning(cwd).running) {
			try {
				unlinkSync(socketPath);
			} catch (_) {
				/* intentional: best-effort stale socket cleanup */
			}
		}
		const stalePidPath = getPidPath(cwd);
		if (existsSync(stalePidPath) && !isHarnessRunning(cwd).running) {
			try {
				unlinkSync(stalePidPath);
			} catch (_) {
				/* intentional: best-effort stale pid-file cleanup */
			}
		}

		// Start fresh — but for JSON mode, emit a single combined payload
		if (mode === "json") {
			// Inline the start logic to produce one JSON document
			const serverPath = getHarnessServerPath();
			if (!serverPath || !existsSync(serverPath)) {
				output(
					mode,
					{},
					{
						json: () => ({ status: "error", message: "Harness server not found" }),
						normal: () => "",
					},
				);
				return;
			}
			const nodePath = process.execPath;
			const args = [serverPath, "--cwd", cwd];
			args.push("--protocol", protocol);
			if (protocol !== "raw") args.push("--session-id", sessionId);
			if (opts.verbose) args.push("--verbose");
			const child = spawn(nodePath, args, { stdio: "ignore", detached: true, cwd });
			child.unref();
			// Poll for socket (harness may take 10+ seconds to compile and load)
			const socketPaths = expectedSocketPaths(cwd, protocol, sessionId);
			const maxWaitMs = 30_000;
			const pollMs = 500;
			const startTime = Date.now();
			let newStatus = isHarnessRunning(cwd);
			while (
				(!newStatus.running || !socketPaths.every((socketPath) => existsSync(socketPath))) &&
				Date.now() - startTime < maxWaitMs
			) {
				await new Promise((resolve) => setTimeout(resolve, pollMs));
				newStatus = isHarnessRunning(cwd);
			}
			output(
				mode,
				{},
				{
					json: () => ({
						status: newStatus.running ? "restarted" : "failed",
						old_pid: oldPid,
						new_pid: newStatus.pid,
						protocol,
						sockets: socketPaths,
					}),
					normal: () => "",
				},
			);
		} else {
			await harnessStartCommand(opts);
		}
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}

// ===========================================
// harness status
// ===========================================

export async function harnessStatusCommand(opts: { json?: boolean }): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = process.cwd();

	try {
		const processStatus = isHarnessRunning(cwd);
		const socketExists = existsSync(getSocketPath(cwd));

		// Try to get status from harness via socket
		let _harnessInfo: JsonObject | null = null;
		if (socketExists) {
			_harnessInfo = await queryHarness(cwd, {
				hook_event: "StatusQuery",
				session_id: "cli-status",
				agent_source: "claude" as const,
				timestamp: new Date().toISOString(),
			});
		}

		// Operational signals: orphan count, RSS of active daemon, configured
		// mode, last-event timestamp. Each is best-effort — a missing data
		// point shouldn't fail the whole status call.
		const orphanInfo = reapOrphanHarnesses(cwd, { dryRun: true });
		const rssMb =
			processStatus.running && processStatus.pid !== undefined
				? readRssMb(processStatus.pid)
				: null;
		const activeMode = readActiveMode(cwd);
		const lastEventAt = readLastLatencyTimestamp(cwd);
		const protocolStatus = readProtocolStatus(cwd);
		const framedSockets = await readFramedSocketStatuses(cwd);

		const result = {
			running: processStatus.running,
			pid: processStatus.pid,
			socket: socketExists,
			socket_path: getSocketPath(cwd),
			raw_socket: {
				path: getSocketPath(cwd),
				exists: socketExists,
				health: socketExists ? "legacy-raw" : "missing",
			},
			framed_sockets: framedSockets,
			protocol_status: protocolStatus,
			protocol_version: protocolStatus?.protocol_version ?? null,
			last_raw_event_at: protocolStatus?.last_raw_event_at ?? null,
			last_framed_event_at: protocolStatus?.last_framed_event_at ?? null,
			framed_error_count: protocolStatus?.framed_error_count ?? null,
			framed_timeout_count: protocolStatus?.framed_timeout_count ?? null,
			orphan_count: orphanInfo.candidates.length,
			rss_mb: rssMb,
			mode: activeMode,
			last_event_at: lastEventAt,
		};

		output(mode, result, {
			json: () => result,
			normal: () => {
				const lines: string[] = [];
				lines.push(header("Harness Status"));
				lines.push(
					kvLine(
						"Status",
						processStatus.running
							? c.green(`running (PID ${processStatus.pid})`)
							: c.dim("not running"),
					),
				);
				lines.push(
					kvLine(
						"Socket",
						socketExists ? c.green(getSocketPath(cwd)) : c.dim("not found"),
					),
				);
				if (protocolStatus) {
					lines.push(kvLine("Protocol", protocolStatus.protocol));
					if (protocolStatus.raw_socket_path) {
						lines.push(kvLine("Raw socket", protocolStatus.raw_socket_path));
					}
					if (protocolStatus.framed_socket_path) {
						lines.push(kvLine("Framed socket", protocolStatus.framed_socket_path));
					}
					if (protocolStatus.last_raw_event_at) {
						lines.push(kvLine("Last raw event", protocolStatus.last_raw_event_at));
					}
					if (protocolStatus.last_framed_event_at) {
						lines.push(kvLine("Last framed event", protocolStatus.last_framed_event_at));
					}
					lines.push(
						kvLine(
							"Framed errors",
							`${protocolStatus.framed_error_count} errors, ${protocolStatus.framed_timeout_count} timeouts`,
						),
					);
				}
				for (const framed of framedSockets) {
					const health = framed.health
						? `${framed.health.status} (${framed.health.protocol_version})`
						: framed.health_error || "unknown";
					lines.push(kvLine(`Framed ${framed.session_id}`, `${health} — ${framed.socket_path}`));
				}
				if (rssMb !== null) {
					lines.push(kvLine("RSS", `${rssMb} MB`));
				}
				if (activeMode !== null) {
					lines.push(kvLine("Mode", activeMode));
				}
				if (lastEventAt !== null) {
					lines.push(kvLine("Last event", lastEventAt));
				}
				const orphanLine =
					orphanInfo.candidates.length === 0
						? c.dim("0")
						: c.yellow(
								`${orphanInfo.candidates.length} (run 'interlinked harness reap' to inspect)`,
							);
				lines.push(kvLine("Orphans", orphanLine));
				if (!processStatus.running) {
					lines.push("");
					lines.push(c.dim("  Start with: interlinked harness start"));
				}
				return lines.join("\n");
			},
		});
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}

/** `ps` reports RSS in kilobytes; we surface it in megabytes. */
const KB_PER_MB = 1024;
/** Tail size for the latency-log scan in `readLastLatencyTimestamp`.
 *  ~50 records at current schema sizes, more than enough to find the most
 *  recent valid `ts` even when several trailing lines are partial / corrupt. */
const LATENCY_TAIL_BYTES = 8 * 1024;

/** Read RSS (resident set size) of a live PID via `ps -o rss= -p <pid>`,
 *  in MB. Returns null on any failure — RSS is operational telemetry, not
 *  a hard requirement, so we never fail the status call on it. */
function readRssMb(pid: number): number | null {
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

/** Read the configured operational mode from `.interlinked/config.json`.
 *  Returns null if the file is missing or malformed — the user might just
 *  not have run `interlinked enable` yet. */
function readActiveMode(cwd: string): string | null {
	try {
		const configPath = join(getConfigDir(cwd), "config.json");
		if (!existsSync(configPath)) return null;
		const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as { mode?: unknown };
		return typeof parsed.mode === "string" ? parsed.mode : null;
	} catch (e) {
		void e;
		return null;
	}
}

function readProtocolStatus(cwd: string): HarnessProtocolStatus | null {
	try {
		const path = getProtocolStatusPath(cwd);
		if (!existsSync(path)) return null;
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<HarnessProtocolStatus>;
		if (
			parsed.protocol !== "raw" &&
			parsed.protocol !== "framed" &&
			parsed.protocol !== "dual"
		) {
			return null;
		}
		return {
			protocol: parsed.protocol,
			protocol_version:
				typeof parsed.protocol_version === "string" ? parsed.protocol_version : "unknown",
			started_at: typeof parsed.started_at === "string" ? parsed.started_at : "",
			raw_socket_path:
				typeof parsed.raw_socket_path === "string" ? parsed.raw_socket_path : null,
			framed_socket_path:
				typeof parsed.framed_socket_path === "string" ? parsed.framed_socket_path : null,
			framed_session_id:
				typeof parsed.framed_session_id === "string" ? parsed.framed_session_id : null,
			last_raw_event_at:
				typeof parsed.last_raw_event_at === "string" ? parsed.last_raw_event_at : null,
			last_framed_event_at:
				typeof parsed.last_framed_event_at === "string" ? parsed.last_framed_event_at : null,
			raw_event_count:
				typeof parsed.raw_event_count === "number" ? parsed.raw_event_count : 0,
			framed_event_count:
				typeof parsed.framed_event_count === "number" ? parsed.framed_event_count : 0,
			framed_error_count:
				typeof parsed.framed_error_count === "number" ? parsed.framed_error_count : 0,
			framed_timeout_count:
				typeof parsed.framed_timeout_count === "number" ? parsed.framed_timeout_count : 0,
		};
	} catch (e) {
		void e;
		return null;
	}
}

async function readFramedSocketStatuses(cwd: string): Promise<FramedSocketStatus[]> {
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
function readLastLatencyTimestamp(cwd: string): string | null {
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
				const parsed = JSON.parse(line) as { ts?: unknown };
				if (typeof parsed.ts === "string") return parsed.ts;
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

// ===========================================
// harness test
// ===========================================

export async function harnessTestCommand(
	command: string,
	opts: {
		tool?: string;
		json?: boolean;
	},
): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = process.cwd();

	try {
		const toolName = opts.tool || "Bash";
		const toolInput: JsonObject =
			toolName === "Bash" || toolName === "Shell" ? { command } : { file_path: command };

		const testEvent = {
			hook_event: "PreToolUse" as const,
			session_id: "cli-test",
			agent_source: "claude" as const,
			agent_name: "test",
			tool_name: toolName,
			tool_input: toolInput,
			timestamp: new Date().toISOString(),
		};

		// Try harness first
		const socketExists = existsSync(getSocketPath(cwd));
		let decision: JsonObject | null = null;

		if (socketExists) {
			decision = await queryHarness(cwd, testEvent);
		}

		if (!decision) {
			output(
				mode,
				{ error: "harness_not_running" },
				{
					json: () => ({ error: "Harness not running" }),
					normal: () =>
						c.yellow("Harness not running. Start with: interlinked harness start"),
				},
			);
			return;
		}

		// Alias captured in the enclosing scope so the callback body narrows
		// the null check above without needing `!` assertions.
		const resolvedDecision: JsonObject = decision;
		output(mode, resolvedDecision, {
			json: () => resolvedDecision,
			normal: () => {
				const lines: string[] = [];
				const blocked = resolvedDecision.decision === "block";
				lines.push(
					`${blocked ? c.red("BLOCKED") : c.green("ALLOWED")} ${c.dim(`${toolName}:`)} ${command}`,
				);
				if (resolvedDecision.reason) {
					lines.push(`  ${resolvedDecision.reason}`);
				}
				if (resolvedDecision.warnings && Array.isArray(resolvedDecision.warnings)) {
					for (const w of resolvedDecision.warnings as string[]) {
						lines.push(`  ${c.yellow(w)}`);
					}
				}
				return lines.join("\n");
			},
		});

		if (decision.decision === "block") {
			process.exitCode = 1;
		}
	} catch (err) {
		outputError(mode, err instanceof Error ? err.message : String(err));
	}
}

// ===========================================
// Socket Query Helper
// ===========================================

function queryHarness(cwd: string, event: JsonObject): Promise<JsonObject | null> {
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
		}, 2000);

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
