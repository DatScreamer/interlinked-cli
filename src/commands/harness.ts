// ===========================================
// interlinked harness — Harness server management
// ===========================================

import { execSync, spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { getConfigDir } from "../lib/config.js";
import { c, header, kvLine } from "../lib/formatter.js";
import type { JsonObject } from "../lib/json-types.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

/** Delay after SIGTERM to let the harness process exit cleanly before we check its status. */
const HARNESS_SHUTDOWN_WAIT_MS = 1000;
/** Max wait (ms) after SIGTERM during restart before giving up. */
const HARNESS_RESTART_MAX_WAIT_MS = 3000;
/** Poll interval (ms) while waiting for the harness to shut down during restart. */
const HARNESS_RESTART_POLL_MS = 200;

interface HarnessStatus {
	running: boolean;
	pid?: number;
}

export function getSocketPath(cwd: string = process.cwd()): string {
	return join(getConfigDir(cwd), "harness.sock");
}

function getPidPath(cwd: string = process.cwd()): string {
	return join(getConfigDir(cwd), "harness.pid");
}

/**
 * Candidate harness daemon row pulled from `ps` and filtered by the
 * orphan-selection rules. Returned by `reapOrphanHarnesses` so the operational
 * `harness reap` command can format and report on them — and so tests can
 * assert which PIDs would have been touched without actually signalling them.
 */
export interface OrphanCandidate {
	pid: number;
	ppid: number;
	command: string;
}

/** Result returned by `reapOrphanHarnesses`. `candidates` is the full set the
 * sweep considered. `killed` is the subset that received a successful
 * `process.kill(SIGTERM)` (empty when `dryRun: true`). */
export interface ReapResult {
	candidates: OrphanCandidate[];
	killed: number[];
	dryRun: boolean;
}

export interface ReapOptions {
	/** When true, do NOT issue `process.kill`; just return candidates. Default
	 *  for the `reap` CLI surface so users see the impact before opting in. */
	dryRun?: boolean;
	/** When true, *also* terminate the active daemon (skip the active-pid
	 *  protection and the ancestor protection — this is the equivalent of
	 *  `pkill -f interlinked-cli/dist/harness/server`). */
	killAll?: boolean;
}

/**
 * SIGTERM any orphan interlinked harness daemons before we start a fresh one.
 *
 * Orphans accumulate when a previous session ended without a clean shutdown
 * (Ctrl-C on the parent shell, OS reboot, daemon crash leaving the pid file
 * stale). On one developer machine we observed 28 daemons accumulated across
 * 4 days of sessions, ~1.8 GB stale RSS. Without this sweep, every
 * `interlinked harness start` adds another long-lived process to the pile.
 *
 * Selection criteria: the process command line contains both `node` (or
 * `bun`) and `interlinked-cli/dist/harness/server`. We then exclude:
 *   1. The CLI process running this code (`process.pid`).
 *   2. The current shell / Claude Code ancestor chain (would terminate the
 *      session that just typed `interlinked harness start`).
 *   3. Any PID matching the active `.interlinked/harness.pid` for THIS cwd
 *      (already shutdown by `isHarnessRunning` above, but defensive).
 *
 * `opts.dryRun` returns the candidate list without signalling. `opts.killAll`
 * disables the active-pid + ancestor protections so the user gets a clean
 * slate (the equivalent of a manual `pkill -f`).
 *
 * Best-effort: if `ps` fails, return an empty result — callers fall through.
 */
export function reapOrphanHarnesses(cwd: string, opts: ReapOptions = {}): ReapResult {
	const dryRun = opts.dryRun === true;
	const killAll = opts.killAll === true;
	const empty: ReapResult = { candidates: [], killed: [], dryRun };
	let ps: string;
	try {
		const raw = execSync("ps -ax -o pid=,ppid=,command= 2>/dev/null", {
			encoding: "utf-8",
			timeout: 2000,
		});
		if (typeof raw !== "string") return empty;
		ps = raw;
	} catch (e) {
		void e;
		return empty;
	}
	const ancestorPids = collectAncestorPids();
	const activePid = readActiveHarnessPid(cwd);
	const candidates: OrphanCandidate[] = [];

	// Extract the `--cwd <path>` argument the daemon was spawned with. Each
	// harness binds to one workspace (see `harnessStartCommand`'s
	// `args = [..., serverPath, "--cwd", cwd]` construction); reading that
	// field tells us which repo the daemon serves. Returns null on a
	// legacy/malformed cmdline so the caller can skip the candidate rather
	// than risk reaping a daemon from another workspace.
	const extractCwdArg = (cmdline: string): string | null => {
		const tokens = cmdline.split(/\s+/);
		for (let i = 0; i < tokens.length - 1; i++) {
			if (tokens[i] === "--cwd") return tokens[i + 1] ?? null;
			if (tokens[i]?.startsWith("--cwd=")) {
				return tokens[i]?.slice("--cwd=".length) ?? null;
			}
		}
		return null;
	};

	for (const line of ps.split("\n")) {
		const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
		if (!m) continue;
		const pid = Number.parseInt(m[1] as string, 10);
		const ppid = Number.parseInt(m[2] as string, 10);
		const cmd = m[3] as string;
		if (Number.isNaN(pid) || pid === process.pid) continue;
		if (!cmd.includes("node") && !cmd.includes("bun")) continue;
		if (!cmd.includes("interlinked-cli/dist/harness/server")) continue;
		// Scope by `--cwd`: a daemon spawned from a sibling repo has a
		// different `--cwd` and must NOT be reaped from this workspace —
		// doing so would silently disable hooks in the user's other open
		// project. If `--cwd` is absent (legacy daemon, malformed cmdline)
		// skip the candidate rather than risk a cross-workspace SIGTERM.
		const candidateCwd = extractCwdArg(cmd);
		if (candidateCwd === null || candidateCwd !== cwd) continue;
		if (!killAll) {
			// Default reap path: protect the active daemon + the shell/agent
			// ancestor chain. `--all` (killAll) deliberately skips both so the
			// user gets a clean slate.
			if (ancestorPids.has(pid)) continue;
			if (activePid !== null && pid === activePid) continue;
		} else {
			// Even in killAll mode, never SIGTERM our own ancestor process —
			// that would kill the shell that just invoked us. The active
			// daemon, however, is fair game.
			if (ancestorPids.has(pid)) continue;
		}
		candidates.push({ pid, ppid, command: cmd });
	}
	if (dryRun) {
		return { candidates, killed: [], dryRun: true };
	}
	const killed: number[] = [];
	for (const candidate of candidates) {
		try {
			process.kill(candidate.pid, "SIGTERM");
			killed.push(candidate.pid);
		} catch (e) {
			void e; // Already gone or insufficient permissions; nothing to do.
		}
	}
	if (killed.length > 0) {
		process.stderr.write(
			`[interlinked] Reaped ${killed.length} orphan harness daemon${killed.length === 1 ? "" : "s"}: ${killed.join(", ")}\n`,
		);
	}
	return { candidates, killed, dryRun: false };
}

/**
 * Walk up the parent chain so we never SIGTERM a daemon that's actually our
 * own ancestor (the shell or Claude Code that invoked this CLI). Mirrors the
 * `getProtectedPids` logic in `harness/pre-checks.ts`.
 *
 * Public API: exported so the new operational commands (`harness reap`,
 * `harness clean`, future `doctor` enhancements) and downstream tests can
 * reproduce the same ancestor-protection set without duplicating the walk.
 */
export function collectAncestorPids(): Set<number> {
	const pids = new Set<number>([process.pid]);
	if (process.ppid) pids.add(process.ppid);
	try {
		const psOut = execSync("ps -o pid=,ppid= -ax 2>/dev/null", {
			encoding: "utf-8",
			timeout: 2000,
		});
		const childToParent = new Map<number, number>();
		for (const line of psOut.split("\n")) {
			const m = line.trim().match(/^(\d+)\s+(\d+)$/);
			if (m) childToParent.set(Number.parseInt(m[1] as string, 10), Number.parseInt(m[2] as string, 10));
		}
		let current = process.ppid;
		for (let i = 0; i < 10 && current > 1; i++) {
			pids.add(current);
			const parent = childToParent.get(current);
			if (!parent || parent <= 1) break;
			current = parent;
		}
	} catch (e) {
		void e;
	}
	return pids;
}

/**
 * Read the active daemon PID from `.interlinked/harness.pid`. Returns null
 * when the file is missing or contains a non-numeric value.
 *
 * Public API: exported so operational commands (`harness reap`, `harness
 * clean`) can identify the active daemon without coupling to `isHarnessRunning`,
 * which has additional liveness side effects (it auto-cleans stale pid files).
 */
export function readActiveHarnessPid(cwd: string): number | null {
	try {
		const pidPath = getPidPath(cwd);
		if (!existsSync(pidPath)) return null;
		const pid = Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
		return Number.isNaN(pid) ? null : pid;
	} catch (e) {
		void e;
		return null;
	}
}

function getDaemonLogPath(cwd: string = process.cwd()): string {
	return join(getConfigDir(cwd), "logs", "daemon.log");
}

interface DaemonStderrLog {
	fd: number;
	path: string;
	startOffset: number;
}

function openDaemonStderrLog(cwd: string): DaemonStderrLog | null {
	const path = getDaemonLogPath(cwd);
	try {
		const dir = dirname(path);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const startOffset = existsSync(path) ? statSync(path).size : 0;
		const fd = openSync(path, "a");
		return { fd, path, startOffset };
	} catch (_) {
		return null;
	}
}

function closeDaemonStderrLog(log: DaemonStderrLog | null): void {
	if (!log) return;
	try {
		closeSync(log.fd);
	} catch (_) {
		/* intentional: child inherited its own stderr fd; parent close is best-effort */
	}
}

function readDaemonStderrLog(log: DaemonStderrLog | null): string {
	if (!log) return "";
	try {
		return readFileSync(log.path).subarray(log.startOffset).toString("utf-8");
	} catch (_) {
		return "";
	}
}

/**
 * Check if the compiled dist/ harness is stale (source newer than dist).
 * If stale, rebuild automatically so `harness restart` always runs current code.
 *
 * Resolves the dist path against `getHarnessServerPath()` so the staleness
 * probe targets the same file the daemon will actually load. The legacy
 * `cli/dist/...` layout is one of several candidates checked there; using
 * the resolved path means the probe works in flat-layout source checkouts
 * and node_modules installs alike.
 */
function ensureDistFresh(): void {
	const cwd = process.cwd();
	const distServer = getHarnessServerPath();
	if (!distServer || !existsSync(distServer)) return;

	// Find the matching `src/harness/server.ts` alongside the resolved dist.
	// Two repo shapes ship: flat-layout (`<root>/src/...`) and `cli/`-prefixed
	// (`<root>/cli/src/...`). The dist sits at either `<root>/dist/harness/`
	// or `<root>/cli/dist/harness/`; the matching src is two dirs up plus
	// `src/harness/`.
	const distHarnessDir = dirname(distServer);
	const distRoot = dirname(distHarnessDir);
	const srcRoot = join(dirname(distRoot), "src");
	const srcServer = join(srcRoot, "harness", "server.ts");
	if (!existsSync(srcServer)) return;

	try {
		const distMtime = statSync(distServer).mtimeMs;

		const srcDirs = [
			join(srcRoot, "harness"),
			join(srcRoot, "lib"),
			join(srcRoot, "commands"),
		];
		let stale = false;
		for (const dir of srcDirs) {
			if (!existsSync(dir)) continue;
			if (statSync(dir).mtimeMs > distMtime) {
				stale = true;
				break;
			}
		}
		if (!stale && statSync(srcServer).mtimeMs > distMtime) {
			stale = true;
		}

		if (stale) {
			console.log(c.yellow("Source newer than dist — rebuilding..."));
			try {
				execSync("npm run build", {
					cwd: dirname(srcRoot),
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 30000,
				});
				console.log(c.green("Rebuilt dist/"));
			} catch (_err) {
				console.log(c.red("Build failed — starting harness with potentially stale code"));
			}
		}
	} catch (_) {
		/* intentional: staleness check is best-effort, skip on any fs/spawn error */
	}
}

function getHarnessServerPath(): string {
	// Resolve harness server path — prefer pre-compiled JS for fast startup.
	const dir = import.meta.dirname || __dirname;
	const candidates = [
		// 1. Pre-compiled JS — same dist/ directory as this file (tsup co-entry)
		join(dir, "harness", "server.js"),
		// 2. Pre-compiled JS — one level up (when this file is in dist/commands/)
		join(dir, "..", "harness", "server.js"),
		// 3. tsx-from-src: src/commands/harness.ts running under tsx —
		//    walk to project root and down into dist/.
		join(dir, "..", "..", "dist", "harness", "server.js"),
		// 4. Flat-layout source checkout (no `cli/` prefix).
		join(process.cwd(), "dist", "harness", "server.js"),
		// 5. Pre-compiled JS in node_modules
		join(process.cwd(), "node_modules", "interlinked-cli", "dist", "harness", "server.js"),
		// 6. Monorepo source checkout with `cli/` prefix.
		join(process.cwd(), "cli", "dist", "harness", "server.js"),
		// 7. Pre-compiled binary
		join(process.cwd(), ".interlinked", "harness-server"),
		// 8. Source TypeScript fallbacks (slower — Node can't run .ts directly)
		join(dir, "..", "harness", "server.ts"),
		join(dir, "..", "src", "harness", "server.ts"),
		join(process.cwd(), "cli", "src", "harness", "server.ts"),
	];
	for (const p of candidates) {
		if (existsSync(p)) return p;
	}
	return ""; // Empty string — caller checks and shows error
}

export function isHarnessRunning(cwd?: string): HarnessStatus {
	const pidPath = getPidPath(cwd);
	if (!existsSync(pidPath)) return { running: false };

	try {
		const pid = Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
		if (Number.isNaN(pid)) return { running: false };

		// Check if process is alive
		process.kill(pid, 0); // Signal 0 = just check existence
		return { running: true, pid };
	} catch (_) {
		// Process not running — clean up stale PID file
		try {
			unlinkSync(pidPath);
		} catch (_unlinkErr) {
			/* intentional: best-effort PID file cleanup, ignore unlink errors */
		}
		return { running: false };
	}
}

// ===========================================
// harness start
// ===========================================

export async function harnessStartCommand(opts: {
	daemon?: boolean;
	verbose?: boolean;
	json?: boolean;
}): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = process.cwd();

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

		// Hard cap heap at 1 GB. Daemon working set on a typical project is
		// ~200–500 MB (rules + project graph + trigram index + caches);
		// 1 GB gives 2× headroom and prevents runaway-leak failure modes
		// where one bad accumulation pulls the host into swap. Override via
		// env: `INTERLINKED_HARNESS_HEAP_MB`.
		const heapMb = Number(process.env.INTERLINKED_HARNESS_HEAP_MB) || 1024;
		const args = [`--max-old-space-size=${heapMb}`, serverPath, "--cwd", cwd];
		if (opts.verbose) args.push("--verbose");

		// Reap orphan daemons before binding our own socket. Without this,
		// each `interlinked harness start` over a session lifetime accumulates
		// a stale daemon (oldest seen in production: 28 daemons across 4 days,
		// ~1.8 GB stale RSS). See `reapOrphanHarnesses` for selection rules.
		reapOrphanHarnesses(cwd);

		if (opts.daemon !== false) {
			// Clean up stale socket from any previous run
			const staleSocket = getSocketPath(cwd);
			if (existsSync(staleSocket)) {
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

			// Poll for socket to appear (harness may take 10-30s to compile TypeScript)
			const socketPath = getSocketPath(cwd);
			const maxWaitMs = 60_000;
			const pollMs = 500;
			const startTime = Date.now();
			let ready = false;
			while (Date.now() - startTime < maxWaitMs) {
				if (childExited) break; // Process crashed — stop waiting
				if (existsSync(socketPath)) {
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
}): Promise<void> {
	const mode = getOutputMode(opts);
	const cwd = process.cwd();

	try {
		let oldPid: number | undefined;
		const status = isHarnessRunning(cwd);
		if (status.running && status.pid) {
			oldPid = status.pid;
			process.kill(status.pid, "SIGTERM");
			// Wait for shutdown
			const start = Date.now();
			while (Date.now() - start < HARNESS_RESTART_MAX_WAIT_MS) {
				await new Promise((resolve) => setTimeout(resolve, HARNESS_RESTART_POLL_MS));
				if (!isHarnessRunning(cwd).running) break;
			}
			if (isHarnessRunning(cwd).running) {
				outputError(
					mode,
					`Failed to stop harness (PID ${status.pid}). Try: kill -9 ${status.pid}`,
				);
				return;
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
			if (opts.verbose) args.push("--verbose");
			const child = spawn(nodePath, args, { stdio: "ignore", detached: true, cwd });
			child.unref();
			// Poll for socket (harness may take 10+ seconds to compile and load)
			const maxWaitMs = 30_000;
			const pollMs = 500;
			const startTime = Date.now();
			let newStatus = isHarnessRunning(cwd);
			while (!newStatus.running && Date.now() - startTime < maxWaitMs) {
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

		const result = {
			running: processStatus.running,
			pid: processStatus.pid,
			socket: socketExists,
			socket_path: getSocketPath(cwd),
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

/** Tail the latency log for the most recent record's `ts`. Best-effort: we
 *  read the trailing 8 KiB of the file (enough to span ~50 records at
 *  current sizes), parse JSON lines back-to-front, and return the first ts
 *  we recognise. Returns null on any read/parse failure. */
function readLastLatencyTimestamp(cwd: string): string | null {
	try {
		const path = join(getConfigDir(cwd), "logs", "latency.jsonl");
		if (!existsSync(path)) return null;
		const size = statSync(path).size;
		const tailBytes = Math.min(size, 8 * 1024);
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
