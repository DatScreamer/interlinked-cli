// ===========================================
// interlinked harness — Harness server management
// ===========================================

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
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

function getSocketPath(cwd: string = process.cwd()): string {
	return join(getConfigDir(cwd), "harness.sock");
}

function getPidPath(cwd: string = process.cwd()): string {
	return join(getConfigDir(cwd), "harness.pid");
}

/**
 * Check if the compiled dist/ harness is stale (source newer than dist).
 * If stale, rebuild automatically so `harness restart` always runs current code.
 */
function ensureDistFresh(): void {
	const cwd = process.cwd();
	const distServer = join(cwd, "cli", "dist", "harness", "server.js");
	const srcServer = join(cwd, "cli", "src", "harness", "server.ts");

	if (!existsSync(distServer) || !existsSync(srcServer)) return;

	try {
		const distMtime = statSync(distServer).mtimeMs;

		// Check if ANY source file in cli/src/ is newer than dist
		const srcDirs = [
			join(cwd, "cli", "src", "harness"),
			join(cwd, "cli", "src", "lib"),
			join(cwd, "cli", "src", "commands"),
		];
		let stale = false;
		for (const dir of srcDirs) {
			if (!existsSync(dir)) continue;
			// Check the directory's own mtime as a fast proxy
			if (statSync(dir).mtimeMs > distMtime) {
				stale = true;
				break;
			}
		}
		// Also check the specific server.ts file
		if (!stale && statSync(srcServer).mtimeMs > distMtime) {
			stale = true;
		}

		if (stale) {
			console.log(c.yellow("Source newer than dist — rebuilding..."));
			try {
				execSync("npm run build", {
					cwd: join(cwd, "cli"),
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
		// 3. Pre-compiled JS in node_modules
		join(process.cwd(), "node_modules", "interlinked-cli", "dist", "harness", "server.js"),
		// 4. Source checkout dist/ (monorepo dev)
		join(process.cwd(), "cli", "dist", "harness", "server.js"),
		// 5. Pre-compiled binary
		join(process.cwd(), ".interlinked", "harness-server"),
		// 6. Source TypeScript fallbacks (slower — Node can't run .ts directly)
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

		const args = [serverPath, "--cwd", cwd];
		if (opts.verbose) args.push("--verbose");

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

			// Daemonize: spawn detached, pipe stderr so we can report errors
			const child = spawn(nodePath, args, {
				stdio: ["ignore", "ignore", "pipe"],
				detached: true,
				cwd,
			});
			let stderrOutput = "";
			child.stderr?.on("data", (chunk: Buffer) => {
				stderrOutput += chunk.toString();
			});
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

		// Clean up stale socket if process is gone
		const socketPath = getSocketPath(cwd);
		if (existsSync(socketPath) && !isHarnessRunning(cwd).running) {
			try {
				unlinkSync(socketPath);
			} catch (_) {
				/* intentional: best-effort stale socket cleanup */
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

		const result = {
			running: processStatus.running,
			pid: processStatus.pid,
			socket: socketExists,
			socket_path: getSocketPath(cwd),
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
