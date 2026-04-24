// ===========================================
// Sidecar Manager — Long-running Python subprocess
// ===========================================
//
// Spawns a Python process running the OPF sidecar script, keeps stdin/stdout
// open across many scan requests, and correlates responses by a numeric `id`
// field. Designed to survive idle periods (auto-shutdown, re-spawn on next
// call), crashes (bounded auto-restart), and clean shutdown via SIGTERM.
//
// Protocol (one JSON object per line, both directions):
//   request:  {"id": "<id>", "op": "ping" | "scan" | "shutdown", "text"?: string}
//   response: {"id": "<id>", "ok": boolean, "spans"?: [...], "redacted_text"?: string, "error"?: string}
//
// Fail-open posture: every error path returns `{ok: false, error}` instead of
// throwing. The content-scanner translates that into allow + a warning.

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";

// ===========================================
// Types
// ===========================================

export interface SidecarSpan {
	label: string;
	start: number;
	end: number;
	text: string;
	score?: number;
}

export interface SidecarResponse {
	ok: boolean;
	error?: string;
	spans?: SidecarSpan[];
	redacted_text?: string;
}

export interface SidecarRequest {
	op: "ping" | "scan" | "shutdown";
	text?: string;
	/** Optional per-call AbortSignal — resolves with error on abort. */
	signal?: AbortSignal;
	/** Override the default timeout. When unset, uses scan_timeout_ms (or startup_timeout_ms on the first call). */
	timeout_ms?: number;
}

/** Subset of `child_process.spawn` shape needed by the manager — supports DI for tests. */
export type SpawnFn = (
	command: string,
	args: readonly string[],
	options: SpawnOptions,
) => ChildProcess;

export interface SidecarManagerOptions {
	python_bin: string;
	script_path: string;
	startup_timeout_ms: number;
	scan_timeout_ms: number;
	idle_shutdown_ms: number;
	max_restarts: number;
	/** Test hook — defaults to `node:child_process.spawn`. */
	spawn?: SpawnFn;
	/** Test hook — defaults to writing to `process.stderr`. */
	stderrSink?: (chunk: string) => void;
}

type PendingEntry = {
	resolve: (r: SidecarResponse) => void;
	timer: ReturnType<typeof setTimeout>;
	detach: () => void;
};

/** Build a fail-open response envelope. All error paths in this module route
 *  through here so the "failed" shape lives in one place. */
function failResponse(error: string): SidecarResponse {
	return { ok: false, error };
}

/** Type predicate that narrows `unknown` to a plain object (but not `null`). */
function isRecord(x: unknown): x is Record<string, unknown> {
	return x !== null && typeof x === "object";
}

/** Type predicate for a non-empty string — used to extract the `id` field from parsed responses. */
function isStringId(x: unknown): x is string {
	return typeof x === "string" && x.length > 0;
}

// ===========================================
// Manager
// ===========================================

/**
 * Minimal long-running subprocess wrapper. Public API is `send()` and
 * `shutdown()`; everything else is lifecycle plumbing. Spawns lazily on the
 * first `send()` so the feature imposes zero cost when disabled.
 */
export class SidecarManager {
	private child: ChildProcess | null = null;
	private pending = new Map<string, PendingEntry>();
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private restartCount = 0;
	private nextId = 1;
	private lineBuffer = "";
	/** Flips true once the child has emitted its first response. Gates per-call timeouts. */
	private booted = false;
	private shuttingDown = false;

	constructor(private readonly opts: SidecarManagerOptions) {}

	/**
	 * Send a request to the sidecar, returning the response or a fail-open
	 * `{ok:false, error}`. Never throws.
	 */
	async send(req: SidecarRequest): Promise<SidecarResponse> {
		if (this.shuttingDown) {
			return failResponse("sidecar is shutting down");
		}

		try {
			this.ensureSpawned();
		} catch (e) {
			return failResponse(`sidecar spawn failed: ${formatErr(e)}`);
		}

		const id = String(this.nextId++);
		const timeoutMs =
			req.timeout_ms ?? (this.booted ? this.opts.scan_timeout_ms : this.opts.startup_timeout_ms);

		const payload: Record<string, unknown> = { id, op: req.op };
		if (req.text !== undefined) payload.text = req.text;

		return new Promise<SidecarResponse>((resolve) => {
			const timer = setTimeout(() => {
				const entry = this.pending.get(id);
				if (!entry) return;
				this.pending.delete(id);
				entry.detach();
				resolve(failResponse(`timeout after ${timeoutMs}ms`));
			}, timeoutMs);

			let onAbort: (() => void) | undefined;
			if (req.signal) {
				onAbort = () => {
					const entry = this.pending.get(id);
					if (!entry) return;
					this.pending.delete(id);
					entry.detach();
					resolve(failResponse("aborted"));
				};
				req.signal.addEventListener("abort", onAbort, { once: true });
			}

			const detach = () => {
				clearTimeout(timer);
				if (onAbort && req.signal) req.signal.removeEventListener("abort", onAbort);
			};

			this.pending.set(id, { resolve, timer, detach });

			try {
				this.child?.stdin?.write(`${JSON.stringify(payload)}\n`);
			} catch (e) {
				this.pending.delete(id);
				detach();
				resolve(failResponse(`write failed: ${formatErr(e)}`));
				return;
			}

			this.resetIdleTimer();
		});
	}

	/** Graceful shutdown — sends `{op:"shutdown"}`, then SIGKILL if the child doesn't exit. */
	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		if (!this.child) return;

		const child = this.child;
		try {
			child.stdin?.write(`${JSON.stringify({ id: "shutdown", op: "shutdown" })}\n`);
			child.stdin?.end();
		} catch {
			// best-effort — the child may already have exited
		}

		await new Promise<void>((resolve) => {
			const forceKillAfterMs = 1000;
			const killTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// best-effort
				}
				resolve();
			}, forceKillAfterMs);
			child.once("exit", () => {
				clearTimeout(killTimer);
				resolve();
			});
		});

		this.rejectAllPending("sidecar shut down");
		this.child = null;
	}

	// ---- lifecycle internals -------------------------------------------------

	private ensureSpawned(): void {
		if (this.child && !this.child.killed) return;
		if (this.restartCount >= this.opts.max_restarts) {
			throw new Error(
				`sidecar exceeded max_restarts (${this.opts.max_restarts}); disabled for this session`,
			);
		}

		const spawnFn: SpawnFn = this.opts.spawn ?? nodeSpawn;
		const child = spawnFn(this.opts.python_bin, [this.opts.script_path], {
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.child = child;
		this.restartCount++;
		this.booted = false;
		this.lineBuffer = "";

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));

		const stderrSink = this.opts.stderrSink ?? defaultStderrSink;
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => stderrSink(chunk));

		child.on("error", (err: Error) => {
			this.rejectAllPending(`sidecar error: ${err.message}`);
			this.child = null;
		});
		child.on("exit", (code: number | null) => {
			this.rejectAllPending(`sidecar exited with code ${code ?? "null"}`);
			this.child = null;
		});

		this.resetIdleTimer();
	}

	private onStdout(chunk: string): void {
		this.lineBuffer += chunk;
		let newlineIdx = this.lineBuffer.indexOf("\n");
		while (newlineIdx !== -1) {
			const line = this.lineBuffer.slice(0, newlineIdx).trim();
			this.lineBuffer = this.lineBuffer.slice(newlineIdx + 1);
			if (line) this.deliverLine(line);
			newlineIdx = this.lineBuffer.indexOf("\n");
		}
	}

	private deliverLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return; // malformed — drop silently, parallels fail-open posture
		}
		if (!isRecord(parsed)) return;
		const id = isStringId(parsed.id) ? parsed.id : undefined;
		if (!id) return; // startup noise with no id — drop
		const entry = this.pending.get(id);
		if (!entry) return;
		this.pending.delete(id);
		entry.detach();
		this.booted = true;
		// Defensive projection — the sidecar is trusted but we validate shape
		// before exposing the response to callers.
		entry.resolve({
			ok: parsed.ok === true,
			error: typeof parsed.error === "string" ? parsed.error : undefined,
			spans: Array.isArray(parsed.spans) ? (parsed.spans as SidecarSpan[]) : undefined,
			redacted_text:
				typeof parsed.redacted_text === "string" ? parsed.redacted_text : undefined,
		});
	}

	private rejectAllPending(reason: string): void {
		if (this.pending.size === 0) return;
		for (const [, entry] of this.pending) {
			entry.detach();
			entry.resolve(failResponse(reason));
		}
		this.pending.clear();
	}

	private resetIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			// Let the main event loop exit naturally — don't block on idle-shutdown.
			this.shutdown().catch(() => {
				// best-effort
			});
		}, this.opts.idle_shutdown_ms);
		this.idleTimer.unref?.();
	}
}

// ===========================================
// Helpers
// ===========================================

function formatErr(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}

function defaultStderrSink(chunk: string): void {
	process.stderr.write(`[opf-sidecar] ${chunk}`);
}
