// ===========================================
// runProcessAsync — non-blocking subprocess spawn
// ===========================================
// Phase A.1 of the Free CLI Phase-2 roadmap. Lets the check engine spawn
// 6+ language runners truly concurrently. Replaces the synchronous
// `child_process.spawnSync` calls in tool-runners that block the event
// loop and force the existing `runChecksAsync` to be sequential despite
// its `Promise.all` orchestration.
//
// Returns a Promise resolving once the subprocess exits or is killed.
// Honors:
//   • timeout — SIGTERM after `timeout` ms; SIGKILL after a 1 s grace period
//     if the process is still alive. Sets `timedOut: true` in the result.
//   • signal — external AbortSignal; same SIGTERM-then-SIGKILL pattern.
//   • spawn errors — ENOENT / EACCES / etc. surface as `code: null` rather
//     than throwing, so runners can decide whether the missing tool is fatal.
//
// stdout and stderr are captured independently into UTF-8 strings, capped
// at MAX_BUFFER_BYTES to defend against runaway output. Capping silently
// truncates rather than rejecting — large output is usually a noisy linter,
// not a security issue.

import { spawn } from "node:child_process";

/** Hard cap on per-stream capture. 10 MB is enough for any real linter
 *  output; runners that legitimately produce more should stream-process
 *  rather than buffer. */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
/** Grace period after SIGTERM before escalating to SIGKILL. */
const SIGKILL_GRACE_MS = 1000;

export interface RunProcessOptions {
	/** Timeout in ms; the process is SIGTERM'd at this deadline. Default 30 s. */
	timeout?: number;
	/** Optional AbortController signal; the process is killed when it fires. */
	signal?: AbortSignal;
	/** Working directory for the spawned process. */
	cwd?: string;
	/** Additional environment variables (merged on top of `process.env`). */
	env?: NodeJS.ProcessEnv;
}

export interface RunProcessResult {
	stdout: string;
	stderr: string;
	/** Process exit code. `null` when the process never started (ENOENT etc.)
	 *  or was killed before it could exit. */
	code: number | null;
	/** True iff the process exceeded its `timeout`. */
	timedOut: boolean;
	/** True iff we sent SIGTERM/SIGKILL ourselves. */
	killed: boolean;
}

/**
 * Spawn a process and return when it exits (or is killed). Never throws on
 * subprocess-level errors — failures surface in the returned `code`/`killed`
 * fields so the caller can compose error handling.
 */
export function runProcessAsync(
	cmd: string,
	args: string[],
	opts: RunProcessOptions = {},
): Promise<RunProcessResult> {
	const timeoutMs = opts.timeout ?? 30_000;
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let timedOut = false;
		let killed = false;
		let settled = false;
		const env = opts.env ? { ...process.env, ...opts.env } : process.env;
		// `detached: true` makes the child its own process-group leader, so the
		// timeout/abort path can signal the WHOLE group (negative pid) and take
		// down wrapper-spawned grandchildren (e.g. `npx` -> biome/tsc) instead of
		// orphaning the real tool to run past its deadline. The group is the
		// child's own, so a negative-pid signal never reaches the daemon's group.
		const child = spawn(cmd, args, { cwd: opts.cwd, env, detached: true });
		// Stored so `finalize` can clear the SIGKILL grace timer when the
		// process exits cleanly between SIGTERM and the deadline. Without
		// this, every timed-out spawn left a 1s pending timer on the event
		// loop — under heavy parallel batches that can delay daemon
		// shutdown by SIGKILL_GRACE_MS per killed process.
		let killGraceTimer: ReturnType<typeof setTimeout> | null = null;

		const finalize = (code: number | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (killGraceTimer !== null) {
				clearTimeout(killGraceTimer);
				killGraceTimer = null;
			}
			if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
			resolve({ stdout, stderr, code, timedOut, killed });
		};

		// Signal the child's whole process group (negative pid) so a wrapper
		// like `npx` takes its real tool grandchild (biome/tsc/...) down with it
		// instead of orphaning it past the deadline. Falls back to a direct
		// child signal if the group send fails (e.g. pid already reaped).
		const signalTree = (signal: NodeJS.Signals): void => {
			const pid = child.pid;
			try {
				if (pid !== undefined) process.kill(-pid, signal);
				else child.kill(signal);
			} catch (e) {
				void e;
				try {
					child.kill(signal);
				} catch (e2) {
					void e2;
				}
			}
		};

		const killTree = (): void => {
			killed = true;
			signalTree("SIGTERM");
			killGraceTimer = setTimeout(() => {
				if (!settled) signalTree("SIGKILL");
			}, SIGKILL_GRACE_MS);
		};

		const timer = setTimeout(() => {
			timedOut = true;
			killTree();
		}, timeoutMs);

		const onAbort = (): void => {
			killTree();
		};
		if (opts.signal) {
			if (opts.signal.aborted) {
				killTree();
			} else {
				opts.signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdoutBytes >= MAX_BUFFER_BYTES) return;
			stdoutBytes += chunk.length;
			stdout += chunk.toString("utf-8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderrBytes >= MAX_BUFFER_BYTES) return;
			stderrBytes += chunk.length;
			stderr += chunk.toString("utf-8");
		});

		// `error` fires on spawn failures (ENOENT, EACCES). We don't reject;
		// callers expect a settled result with code=null in that case.
		child.on("error", (e) => {
			void e;
			finalize(null);
		});
		child.on("close", (code) => {
			finalize(code);
		});
	});
}
