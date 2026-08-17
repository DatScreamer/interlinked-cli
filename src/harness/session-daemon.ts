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
import { reapZombieIncumbent } from "./server/anti-stomp.js";
import { type DaemonPaths, isDaemonSocketServing } from "./session-paths.js";

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

/** Bind attempts before a listen failure is fatal. A cold start on a loaded
 *  machine races a still-exiting predecessor's socket teardown; retrying twice
 *  costs a couple of hundred milliseconds and converts the most common
 *  transient EADDRINUSE into a normal start instead of a dead daemon. */
export const BIND_ATTEMPTS = 3;
/** Backoff before attempt n+1, in ms. Indexed by the attempt that just failed;
 *  the last entry repeats if `attempts` is raised. */
export const BIND_BACKOFF_MS = [50, 150];

function closeQuietly(server: Server): void {
	try {
		server.close();
	} catch (err) {
		void err; /* intentional: a server that never listened throws here */
	}
}

function listenOnce(server: Server, socketPath: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
}

/** Decide whether another bind attempt can plausibly succeed, clearing a stale
 *  socket file when that is what stands in the way.
 *
 *  The ownership rule is the same one every anti-stomp check applies: a socket
 *  that ANSWERS belongs to a live incumbent and is never unlinked — that
 *  failure is terminal, and the caller must exit rather than stomp it. A
 *  socket file that answers nothing is a stale artifact from a dead
 *  predecessor: remove it and retry. A non-EADDRINUSE failure is some other
 *  transient (a directory being recreated, a slow unlink), so we simply retry
 *  it without touching anything. */
async function prepareBindRetry(
	err: unknown,
	socketPath: string,
	isServing: (socketPath: string) => Promise<boolean>,
): Promise<boolean> {
	if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") return true;
	if (await isServing(socketPath)) return false;
	rmSync(socketPath, { force: true });
	return true;
}

export interface BindSessionSocketOptions {
	socketPath: string;
	onConnection: (socket: Socket) => void;
	/** Total attempts, including the first. Defaults to {@link BIND_ATTEMPTS}. */
	attempts?: number;
	/** Test seams. */
	sleep?: (ms: number) => Promise<void>;
	isServing?: (socketPath: string) => Promise<boolean>;
}

/**
 * Bind the session socket, retrying a bounded number of times.
 *
 * Every attempt uses a FRESH server object: a `net.Server` whose listen failed
 * carries the failure in its internal handle state, and reusing it makes the
 * retry's outcome depend on Node internals rather than on the socket path.
 *
 * Throws the LAST failure when every attempt is spent — the caller (and, above
 * it, the startup guard) turns that into a loud exit. It never returns a
 * server that is not listening.
 */
export async function bindSessionSocket(opts: BindSessionSocketOptions): Promise<Server> {
	const attempts = opts.attempts ?? BIND_ATTEMPTS;
	const isServing = opts.isServing ?? isDaemonSocketServing;
	const sleep =
		opts.sleep ??
		((ms: number) =>
			new Promise<void>((resolve) => {
				const t = setTimeout(resolve, ms);
				t.unref();
			}));
	let lastErr: unknown = new Error(`bind aborted before any attempt (${opts.socketPath})`);
	for (let attempt = 0; attempt < attempts; attempt++) {
		const server = createServer(opts.onConnection);
		try {
			await listenOnce(server, opts.socketPath);
			return server;
		} catch (err) {
			lastErr = err;
			closeQuietly(server);
			if (attempt === attempts - 1) break;
			if (!(await prepareBindRetry(err, opts.socketPath, isServing))) break;
			await sleep(BIND_BACKOFF_MS[attempt] ?? BIND_BACKOFF_MS[BIND_BACKOFF_MS.length - 1] ?? 150);
		}
	}
	throw lastErr;
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
		// A live PID alone is NOT proof of a healthy incumbent — the same
		// caveat the raw-socket check in server.ts carries (see
		// `isDaemonSocketServing`'s doc comment in session-paths.ts):
		// `installCrashResilience()` deliberately keeps a daemon process
		// running through an unexpected error, so a session daemon whose
		// socket LISTENER died (but not the process) still passes this
		// PID-liveness claim forever. Probe whether the incumbent's framed
		// socket actually answers before deferring to it.
		let incumbentServing: boolean;
		try {
			incumbentServing = await isDaemonSocketServing(paths.socket);
		} catch {
			// Fail safe: an unexpected throw from the probe itself is not
			// proof the incumbent is dead — prefer deferring (the pre-fix
			// behavior) over stomping a possibly-healthy daemon's socket.
			incumbentServing = true;
		}
		if (incumbentServing) {
			throw new DaemonOwnershipConflictError(session_id, claim.ownerPid);
		}
		// Live PID, but nothing is actually listening on its socket: a zombie
		// kept resident by crash-resilience, not a healthy incumbent. Reap
		// (best effort) and take over. `reapZombieIncumbent`'s SIGTERM is
		// asynchronous — the zombie's pid may still be alive by the time we
		// re-check — so we force-write our own claim directly rather than
		// re-running `claimSessionPid` (which would just reproduce the same
		// "live foreign pid" conflict). Mirrors the raw-socket path's
		// decide-then-force-take-over shape in server.ts.
		reapZombieIncumbent(claim.ownerPid, (msg) => console.error(msg));
		writeFileSync(paths.pid, String(process.pid));
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
		server = await bindSessionSocket({ socketPath: paths.socket, onConnection });
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
