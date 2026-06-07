// ===========================================
// interlinked harness — Harness server management
// ===========================================

import { existsSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { distStaleness, stalenessWarning } from "../harness/build-staleness.js";
import type { JsonObject } from "../lib/json-types.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
import { c, header, kvLine } from "../lib/formatter.js";
import {
	closeDaemonStderrLog,
	ensureDistFresh,
	getFramedSocketPath,
	getHarnessServerPath,
	getPidPath,
	getSocketPath,
	isHarnessRunning,
	openDaemonStderrLog,
	readDaemonStderrLog,
	reapOrphanHarnesses,
} from "./harness-process.js";
import {
	expectedSocketPaths,
	type FramedSocketStatus,
	type HarnessProtocolMode,
	type HarnessProtocolStatus,
	parseHarnessProtocol,
	queryHarness,
	readActiveMode,
	readFramedSocketStatuses,
	readLastLatencyTimestamp,
	readProtocolStatus,
	readRssMb,
} from "./harness-status-helpers.js";

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

// ===========================================
// harness start
// ===========================================

/**
 * Build the `node` argv for the harness server. Caps the V8 heap at 4 GB (the
 * old 1 GB default OOM'd long sessions — 46+ "Reached heap limit" crashes in one
 * week). Override via `INTERLINKED_HARNESS_HEAP_MB`.
 */
function buildHarnessSpawnArgs(
	serverPath: string,
	cwd: string,
	protocol: HarnessProtocolMode,
	sessionId: string,
	opts: { verbose?: boolean },
): string[] {
	const heapMb = Number(process.env.INTERLINKED_HARNESS_HEAP_MB) || 4096;
	const args = [`--max-old-space-size=${heapMb}`, serverPath, "--cwd", cwd];
	args.push("--protocol", protocol);
	if (protocol !== "raw") args.push("--session-id", sessionId);
	if (opts.verbose) args.push("--verbose");
	return args;
}

/**
 * Daemonize the harness: clean a stale socket, spawn detached with stderr routed
 * to a log-file fd (a pipe would need closing on CLI exit, breaking later daemon
 * writes), poll for the expected sockets, and emit the started/failed payload.
 */
async function daemonizeHarness(args: {
	mode: ReturnType<typeof getOutputMode>;
	cwd: string;
	nodePath: string;
	spawnArgs: string[];
	protocol: HarnessProtocolMode;
	sessionId: string;
	serverPath: string;
}): Promise<void> {
	const { mode, cwd, nodePath, spawnArgs, protocol, sessionId, serverPath } = args;
	const staleSocket = getSocketPath(cwd);
	if (protocol !== "framed" && existsSync(staleSocket)) {
		try {
			unlinkSync(staleSocket);
		} catch (_) {
			/* intentional: best-effort stale socket cleanup, harness server will retry */
		}
	}
	const stderrLog = openDaemonStderrLog(cwd);
	const daemonStdio: ["ignore", "ignore", "ignore" | number] = ["ignore", "ignore", stderrLog?.fd ?? "ignore"];
	const child = (() => {
		try {
			return spawn(nodePath, spawnArgs, { stdio: daemonStdio, detached: true, cwd });
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
	if (!ready) stderrOutput = readDaemonStderrLog(stderrLog);
	output(mode, newStatus, {
		json: () => ({ status: ready ? "started" : "failed", pid: resolvedPid, protocol, sockets: socketPaths }),
		normal: () => {
			if (ready) return c.green(`Harness started (PID ${resolvedPid})`);
			const lines = [c.red(`Failed to start harness after ${elapsed}s.`)];
			if (childExited && stderrOutput) {
				lines.push(c.dim("Error output:"));
				lines.push(c.dim(stderrOutput.trim().slice(0, 500)));
			} else if (childExited) {
				lines.push(c.dim("Process exited without output."));
			} else {
				lines.push(c.dim("Process is running but socket not created. Try foreground:"));
			}
			lines.push(c.dim(`  node ${serverPath} --cwd ${cwd} --verbose`));
			return lines.join("\n");
		},
	});
}

/** Foreground start: exec directly so the harness replaces this process. */
function startHarnessForeground(
	mode: ReturnType<typeof getOutputMode>,
	nodePath: string,
	spawnArgs: string[],
	cwd: string,
): void {
	output(
		mode,
		{},
		{
			json: () => ({ status: "starting_foreground" }),
			normal: () => c.dim("Starting harness in foreground (Ctrl+C to stop)..."),
		},
	);
	const child = spawn(nodePath, spawnArgs, { stdio: "inherit", cwd });
	child.on("exit", (code) => process.exit(code || 0));
}

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
		const args = buildHarnessSpawnArgs(serverPath, cwd, protocol, sessionId, opts);

		// Reap orphan daemons before binding our own socket. Without this,
		// each `interlinked harness start` over a session lifetime accumulates
		// a stale daemon (oldest seen in production: 28 daemons across 4 days,
		// ~1.8 GB stale RSS). See `reapOrphanHarnesses` for selection rules.
		reapOrphanHarnesses(cwd);

		if (opts.daemon !== false) {
			await daemonizeHarness({
				mode,
				cwd,
				nodePath,
				spawnArgs: args,
				protocol,
				sessionId,
				serverPath,
			});
		} else {
			startHarnessForeground(mode, nodePath, args, cwd);
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

/**
 * Poll `isHarnessRunning(cwd)` until it reports the daemon gone or `maxMs`
 * elapses. Returns once either condition holds; the caller re-checks liveness
 * to decide what to do next. Shared by the SIGTERM and SIGKILL wait loops in
 * the restart escalation so each loop is declared once.
 */
async function waitForHarnessExit(cwd: string, maxMs: number, pollMs: number): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < maxMs) {
		await new Promise((resolve) => setTimeout(resolve, pollMs));
		if (!isHarnessRunning(cwd).running) break;
	}
}

/**
 * Stop a running harness for a restart: SIGTERM, wait, then escalate to SIGKILL
 * if it ignores the term. Owns its own stderr nudges (normal mode only) and the
 * survived-SIGKILL fatal error. Returns the prior pid (for the JSON payload) and
 * whether the daemon survived SIGKILL — when `survived` is true the caller must
 * abort the restart.
 *
 * Behavior-identical to the inline block it replaces: the `Sending termination
 * signals` rule blocks an agent from running `kill -9` itself, so owning the
 * escalation here is what makes `harness restart` actually restart.
 */
async function stopRunningHarnessForRestart(
	cwd: string,
	mode: ReturnType<typeof getOutputMode>,
): Promise<{ oldPid: number | undefined; survived: boolean }> {
	const status = isHarnessRunning(cwd);
	if (!status.running || !status.pid) return { oldPid: undefined, survived: false };
	const oldPid = status.pid;
	try {
		process.kill(status.pid, "SIGTERM");
	} catch {
		// intentional: already dead between status check and signal — fall through to the start path.
	}
	await waitForHarnessExit(cwd, HARNESS_RESTART_MAX_WAIT_MS, HARNESS_RESTART_POLL_MS);
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
		await waitForHarnessExit(cwd, HARNESS_RESTART_KILL_WAIT_MS, HARNESS_RESTART_POLL_MS);
		if (isHarnessRunning(cwd).running) {
			outputError(
				mode,
				`PID ${status.pid} survived SIGKILL — possibly a kernel-protected process. Investigate manually.`,
			);
			return { oldPid, survived: true };
		}
	}
	if (mode === "normal") {
		process.stderr.write(c.dim(`Stopped harness (was PID ${status.pid})\n`));
	}
	return { oldPid, survived: false };
}

/**
 * Resilience pass before respawn: sweep orphan daemons and remove stale socket /
 * pid files left by a previous crash. Without this a stale pid+sock pair can make
 * the new daemon double-bind on the socket or confuse `isHarnessRunning` callers.
 * Run on the happy path too — a fresh restart should never inherit dirt.
 */
function cleanStaleRestartFiles(cwd: string): void {
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
}

/**
 * JSON-mode restart start: inline the start logic so the whole restart emits one
 * JSON document. Spawns the daemon, polls for its sockets, and emits a single
 * `restarted` / `failed` / `error` payload (never a human-readable line).
 */
async function inlineJsonRestartStart(
	cwd: string,
	opts: { verbose?: boolean },
	protocol: HarnessProtocolMode,
	sessionId: string,
	oldPid: number | undefined,
	mode: ReturnType<typeof getOutputMode>,
): Promise<void> {
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
}

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
		// SIGTERM → escalate to SIGKILL if wedged. The helper owns its stderr
		// nudges and the survived-SIGKILL fatal error; on survival we abort.
		const { oldPid, survived } = await stopRunningHarnessForRestart(cwd, mode);
		if (survived) return;

		cleanStaleRestartFiles(cwd);

		// Start fresh — but for JSON mode, emit a single combined payload
		if (mode === "json") {
			await inlineJsonRestartStart(cwd, opts, protocol, sessionId, oldPid, mode);
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

/** Protocol sub-lines for the human-readable status report (caller guards non-null). */
function protocolStatusLines(protocolStatus: HarnessProtocolStatus): string[] {
	const lines = [kvLine("Protocol", protocolStatus.protocol)];
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
	return lines;
}

/** One line per framed socket (health, or its error / "unknown" fallback). */
function framedSocketLines(framedSockets: FramedSocketStatus[]): string[] {
	return framedSockets.map((framed) => {
		const health = framed.health
			? `${framed.health.status} (${framed.health.protocol_version})`
			: framed.health_error || "unknown";
		return kvLine(`Framed ${framed.session_id}`, `${health} — ${framed.socket_path}`);
	});
}

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
		const staleness = distStaleness(cwd);

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
			build_stale: staleness?.stale ?? false,
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
				if (protocolStatus) lines.push(...protocolStatusLines(protocolStatus));
				lines.push(...framedSocketLines(framedSockets));
				if (rssMb !== null) {
					lines.push(kvLine("RSS", `${rssMb} MB`));
				}
				const sw = stalenessWarning(staleness);
				if (sw) lines.push(kvLine("Build", c.yellow(sw)));
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
