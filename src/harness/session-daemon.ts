// ===========================================
// Session daemon — Unix-socket wrapper around the dispatcher
// ===========================================
// Binds a per-session Unix socket, accepts newline-delimited JSON frames,
// routes them through the dispatcher, streams responses back. Idle-shutdown
// after `idle_shutdown_ms` of no activity. Registers its PID on start and
// clears it on stop.
//
// The legacy `server.ts` daemon (one socket per repo) keeps working; this
// module is the shape Phase E calls for. It may run side-by-side with the
// legacy daemon on a different socket path.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { type DispatcherState, dispatchRpc } from "./daemon-dispatcher.js";
import {
	decodeFrame,
	encodeFrame,
	isRequest,
	makeError,
	type RpcMessage,
	type RpcRequest,
	splitFrames,
} from "./daemon-protocol.js";
import type { DaemonPaths } from "./session-paths.js";

export interface SessionDaemonOptions {
	paths: DaemonPaths;
	session_id: string;
	/** Milliseconds with no activity before the daemon self-terminates. */
	idle_shutdown_ms?: number;
	/** Dispatcher state — tsgo runner + evaluator context factory. */
	state: Omit<DispatcherState, "shutdown" | "started_at" | "rpc_inflight">;
}

export interface SessionDaemonHandle {
	readonly paths: DaemonPaths;
	readonly session_id: string;
	readonly started_at: number;
	/** Gracefully shut down: unref socket, remove pid/sock files, close clients. */
	stop(reason?: string): Promise<void>;
	/** Number of in-flight RPCs. */
	rpcInflight(): number;
}

/** Thrown when another LIVE process already owns this session's pid file.
 *  Distinguishable from any other startup failure so the caller (server.ts)
 *  can route it through the anti-stomp loser contract (ledger row + exit)
 *  instead of `installCrashResilience()`'s survive-on-error path — right for
 *  a genuinely unexpected throw, wrong for an ALREADY-DECIDED ownership
 *  conflict: that process must actually terminate, not log and keep its
 *  already-registered timers running (the orphan-accumulation bug this
 *  type exists to close). */
export class DaemonOwnershipConflictError extends Error {
	constructor(
		public readonly sessionId: string,
		public readonly ownerPid: number,
	) {
		super(`session daemon already running for ${sessionId} (PID ${ownerPid})`);
		this.name = "DaemonOwnershipConflictError";
	}
}

export type SessionPidClaim = { claimed: true } | { claimed: false; ownerPid: number };

/**
 * Atomically claim `pidPath` for `pid`. Exclusive-create (`wx`) makes the
 * claim indivisible at the OS level: of any number of processes racing to
 * create the same path, at most one `open(O_CREAT|O_EXCL)` can succeed — the
 * rest see EEXIST no matter how close together they run. This replaces a
 * read-then-remove-then-bind-then-write-pid sequence that left a real window
 * open: two starts close enough together could BOTH pass a plain "does a
 * live pid already own this" read (neither had written yet), both proceed to
 * unlink+rebind the socket path (one silently stealing the other's live
 * bind), and both resolve successfully — confirmed empirically (100% of 20
 * trials, see the anti-stomp regression probe) before this fix.
 */
export function claimSessionPid(pidPath: string, pid: number): SessionPidClaim {
	const existingPid = readPidFile(pidPath);
	if (existingPid !== null && existingPid !== pid && isProcessAlive(existingPid)) {
		return { claimed: false, ownerPid: existingPid };
	}
	try {
		writeFileSync(pidPath, String(pid), { flag: "wx" });
		return { claimed: true };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		// A concurrent claim landed between our read above and this write.
		// Re-read whoever is there NOW: still foreign+alive → we genuinely
		// lost; anything else (self, or a dead process's stale claim) → ours.
		const racedPid = readPidFile(pidPath);
		if (racedPid !== null && racedPid !== pid && isProcessAlive(racedPid)) {
			return { claimed: false, ownerPid: racedPid };
		}
		writeFileSync(pidPath, String(pid));
		return { claimed: true };
	}
}

export async function startSessionDaemon(opts: SessionDaemonOptions): Promise<SessionDaemonHandle> {
	const { paths, session_id } = opts;
	const idleMs = opts.idle_shutdown_ms ?? 15 * 60 * 1000;
	const started_at = Date.now();
	let inflight = 0;
	let lastActivity = Date.now();
	let stopped = false;

	// Ensure the .interlinked/ directory and logs/ directory exist.
	const interlinkedDir = dirname(paths.socket);
	if (!existsSync(interlinkedDir)) mkdirSync(interlinkedDir, { recursive: true });
	const logsDir = dirname(paths.log);
	if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });

	// Claim ownership BEFORE touching the socket — see claimSessionPid for why
	// this order (not the socket bind, and not a later pid write) is what
	// makes two racing starts resolve to exactly one winner.
	const claim = claimSessionPid(paths.pid, process.pid);
	if (!claim.claimed) {
		throw new DaemonOwnershipConflictError(session_id, claim.ownerPid);
	}
	if (existsSync(paths.socket)) rmSync(paths.socket, { force: true });

	const clients = new Set<Socket>();
	let server: Server | null = null;

	const state: DispatcherState = {
		started_at,
		rpc_inflight: 0,
		tsgo: opts.state.tsgo,
		getEvaluatorContext: opts.state.getEvaluatorContext,
		evaluateHook: opts.state.evaluateHook,
		shutdown: (_reason?: string) => {
			void handle.stop();
		},
	};

	const touch = (): void => {
		lastActivity = Date.now();
	};

	const onConnection = (socket: Socket): void => {
		clients.add(socket);
		touch();
		let pending = "";
		socket.on("data", async (chunk: Buffer) => {
			const { frames, remainder } = splitFrames(chunk.toString("utf-8"), pending);
			pending = remainder;
			for (const frame of frames) {
				touch();
				await handleFrame(frame, socket);
			}
		});
		socket.on("error", () => socket.destroy());
		socket.on("close", () => clients.delete(socket));
	};

	async function handleFrame(frame: string, socket: Socket): Promise<void> {
		let message: RpcMessage;
		try {
			message = decodeFrame(frame);
		} catch (err) {
			// Respond with a generic bad_request error without an id.
			socket.write(encodeFrame(makeError("unknown", "bad_request", (err as Error).message)));
			return;
		}
		if (!isRequest(message)) {
			// The daemon doesn't receive responses — drop silently.
			return;
		}
		inflight++;
		state.rpc_inflight = inflight;
		let response: RpcMessage;
		try {
			response = await dispatchRpc(message as RpcRequest, state);
		} catch (err) {
			response = makeError(message.id, "internal", (err as Error).message);
		}
		inflight--;
		state.rpc_inflight = inflight;
		socket.write(encodeFrame(response));
	}

	try {
		server = createServer(onConnection);
		await new Promise<void>((resolve, reject) => {
			(server as Server).once("error", reject);
			(server as Server).listen(paths.socket, () => resolve());
		});
	} catch (err) {
		// The pid claim succeeded but the bind didn't — release it so a retry
		// (or a genuinely concurrent starter) isn't blocked by a ghost claim.
		rmSync(paths.pid, { force: true });
		throw err;
	}

	// Idle-shutdown poller — lightweight; fires only after true inactivity.
	const idleTimer =
		idleMs > 0
			? setInterval(
					() => {
						if (inflight > 0) return;
						if (Date.now() - lastActivity < idleMs) return;
						void handle.stop("idle_shutdown");
					},
					Math.min(idleMs, 60_000),
				)
			: null;
	idleTimer?.unref();

	const handle: SessionDaemonHandle = {
		paths,
		session_id,
		started_at,
		rpcInflight: () => inflight,
		async stop(_reason?: string) {
			if (stopped) return;
			stopped = true;
			if (idleTimer) clearInterval(idleTimer);
			for (const c of clients) c.destroy();
			clients.clear();
			await new Promise<void>((resolve) => {
				if (!server) return resolve();
				server.close(() => resolve());
			});
			for (const path of [paths.pid, paths.socket]) {
				if (existsSync(path)) rmSync(path, { force: true });
			}
		},
	};

	return handle;
}

function readPidFile(path: string): number | null {
	if (!existsSync(path)) return null;
	try {
		const pid = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
		return Number.isFinite(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}
