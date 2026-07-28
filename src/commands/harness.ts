// ===========================================
// interlinked harness — Harness server management
// ===========================================

import { existsSync } from "node:fs";
import { distStaleness, stalenessWarning } from "../harness/build-staleness.js";
import { c, header, kvLine } from "../lib/formatter.js";
import type { JsonObject } from "../lib/json-types.js";
import { getOutputMode, output, outputError } from "../lib/output.js";
// Lifecycle/status helpers extracted to a sibling to hold this file under the
// per-file line cap. Behavior is byte-identical; these are the same functions
// the start / restart / status commands have always called.
import {
	buildHarnessSpawnArgs,
	cleanStaleRestartFiles,
	daemonizeHarness,
	framedSocketLines,
	inlineJsonRestartStart,
	protocolStatusLines,
	startHarnessForeground,
	stopRunningHarnessForRestart,
} from "./harness-lifecycle-helpers.js";
import {
	ensureDistFresh,
	getFramedSocketPath,
	getHarnessServerPath,
	getSocketPath,
	isHarnessRunning,
	reapOrphanHarnesses,
} from "./harness-process.js";
import {
	parseHarnessProtocol,
	queryHarness,
	readActiveMode,
	readFramedSocketStatuses,
	readLastLatencyTimestamp,
	readProtocolStatus,
	readRssMb,
} from "./harness-status-helpers.js";
import {
	buildHarnessTestEvent,
	type HarnessTestOpts,
	resolveHarnessTestInput,
} from "./harness-test-event.js";

// `interlinked harness health` — check-health governance report (Tricorder-
// style demotion signal over the recurrence log). Implementation lives in a
// sibling to hold this file under the per-file line cap.
export { harnessHealthCommand } from "./harness-health.js";
export type {
	OrphanCandidate,
	ReapOptions,
	ReapResult,
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

/** Delay after SIGTERM to let the harness process exit cleanly before we check its status. */
const HARNESS_SHUTDOWN_WAIT_MS = 1000;

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
		// Reap BEFORE the already-running check. The reap below (line ~120) only
		// ran on the spawn path, so the most common call in a long session — a
		// hung-but-live daemon, `start` reports "already running", returns — never
		// reaped anything. Orphans then accumulated for hours: measured
		// 2026-07-28, one had been resident since 09:15 holding 743MB while the
		// live daemon degraded for want of the memory it was sitting on. Reaping
		// first makes every `start` a cleanup, which is what the docs already
		// promise ("`interlinked harness start` reaps orphans and reports what it
		// reaped").
		const reaped = reapOrphanHarnesses(cwd);
		const status = isHarnessRunning(cwd);
		if (status.running) {
			output(
				mode,
				{ already_running: true, pid: status.pid, reaped: reaped.killed },
				{
					json: () => ({ status: "already_running", pid: status.pid, reaped: reaped.killed }),
					normal: () =>
						reaped.killed.length > 0
							? `Harness already running (PID ${status.pid}); reaped ${reaped.killed.length} orphan(s): ${reaped.killed.join(", ")}`
							: `Harness already running (PID ${status.pid})`,
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
	command: string | undefined,
	opts: HarnessTestOpts,
): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = process.cwd();

	try {
		// Resolve flags (--write/--edit/positional) + any --from-file/--stdin
		// content into a synthetic PreToolUse event. Pure construction lives in
		// ./harness-test-event.js so the flag→event mapping is unit-tested
		// without a live socket.
		const input = await resolveHarnessTestInput(command, opts, cwd);
		const { toolName, displayLabel, event } = buildHarnessTestEvent(input);
		// Gates that resolve the ledger / overlay (coverage debt, new-file debt)
		// need the project root; without it they fail closed. The builder omits it
		// (it's pure / cwd-free), so stamp it on the event here before sending.
		event.cwd = cwd;

		// Try harness first
		const socketExists = existsSync(getSocketPath(cwd));
		let decision: JsonObject | null = null;

		if (socketExists) {
			// A Write/Edit event can trigger the coverage overlay (vitest), which
			// takes seconds — far past the 2s status-ping default. `harness test`
			// is interactive, so wait for the real gate to finish.
			decision = await queryHarness(cwd, event, 60_000);
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
					`${blocked ? c.red("BLOCKED") : c.green("ALLOWED")} ${c.dim(`${toolName}:`)} ${displayLabel}`,
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
