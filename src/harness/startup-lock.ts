// ===========================================
// Daemon startup mutex — N concurrent starts collapse to ONE binder
// ===========================================
// Measured 2026-08-15: bursts of 2–3 daemon starts inside the same second, the
// losers exiting `startup-failed` ("raw socket bind: EADDRINUSE") or
// `anti-stomp`, the winner SIGTERM'd 10s later by the next burst's reaper.
// Every blocked tool call printed "run `interlinked harness start`", so every
// blocked caller ran it — a thundering herd that sustained itself for hours.
//
// The fix is a mutex, not a longer retry. One process wins an O_EXCL lock file
// and binds; everyone else WAITS on the socket and reports what the winner is
// doing. Nobody else reaps, binds, or writes a `startup-failed` row.
//
// Design constraints:
//  - O_EXCL create is the only atomic primitive available across every fs the
//    repo may live on; mtime comparison (the previous self-heal throttle) is
//    check-then-act and races exactly when it matters.
//  - A stale lock MUST self-clear: a daemon killed between acquire and release
//    would otherwise wedge every future start. Two independent staleness
//    signals — the recorded age (TTL) and the holder pid's liveness.
//  - Never throw. A start path that dies of its lock is worse than a herd.

import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { daemonSocketPaths, isDaemonSocketServing } from "./session-paths.js";

/** Lock file name, under `.interlinked/`. Hidden so it never shows up in the
 *  data-directory INDEX as a durable artifact — it is transient by design. */
export const STARTUP_LOCK_FILE = ".harness-start.lock";

/** A lock older than this is presumed abandoned. A cold daemon boot is ~1s;
 *  15s covers boot + socket listen on a slow machine with headroom, while
 *  staying short enough that a genuinely wedged holder cannot block starts for
 *  longer than one agent turn. */
export const STARTUP_LOCK_TTL_MS = 15_000;

/** How long a loser waits for the winner's socket before giving up and saying
 *  so. Deliberately longer than a normal boot and shorter than a hook's
 *  patience: the loser reports, it does not hang the CLI. */
export const STARTUP_WAIT_MS = 8_000;

/** Socket poll interval while waiting for the winner. */
const STARTUP_POLL_MS = 250;

export interface StartupLockHolder {
	pid: number;
	at: number;
}

export type StartupLockResult =
	| { acquired: true; path: string; release: () => void }
	| { acquired: false; holder: StartupLockHolder | null };

export function startupLockPath(repoRoot: string): string {
	return join(repoRoot, ".interlinked", STARTUP_LOCK_FILE);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The current holder, or null when the file is absent/garbage. Never throws. */
export function readStartupLockHolder(repoRoot: string): StartupLockHolder | null {
	try {
		const raw: unknown = JSON.parse(readFileSync(startupLockPath(repoRoot), "utf-8"));
		if (typeof raw !== "object" || raw === null) return null;
		// SAFETY: object-ness checked above; both fields are type-tested below
		// before the holder is trusted by any caller.
		const holder = raw as Partial<StartupLockHolder>;
		if (typeof holder.pid !== "number" || typeof holder.at !== "number") return null;
		return { pid: holder.pid, at: holder.at };
	} catch {
		return null;
	}
}

/** True when a lock may be broken: no readable holder, an expired timestamp, or
 *  a holder process that no longer exists. */
export function isStartupLockStale(holder: StartupLockHolder | null, nowMs: number): boolean {
	if (holder === null) return true;
	if (nowMs - holder.at > STARTUP_LOCK_TTL_MS) return true;
	return !isProcessAlive(holder.pid);
}

function writeLockFile(path: string, pid: number, nowMs: number): boolean {
	let fd: number | null = null;
	try {
		fd = openSync(path, "wx");
		writeSync(fd, JSON.stringify({ pid, at: nowMs }));
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
		// Any OTHER fs failure (read-only mount, permissions) must not stop the
		// daemon from starting: an un-mutexed start is degraded, a start that
		// never happens is an outage. Report success with a no-op release.
		return true;
	} finally {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				/* intentional: fd close is best-effort */
			}
		}
	}
}

/**
 * Try to become THE process that starts the daemon for `repoRoot`.
 *
 * Returns `{acquired: true, release}` for the single winner. Every other
 * concurrent caller gets `{acquired: false, holder}` and must NOT bind, reap,
 * or record a startup failure — it waits (see {@link waitForDaemonSocket}).
 *
 * One steal attempt is made when the existing lock is stale (expired TTL or a
 * dead holder). Exactly one retry, never a loop: if a second process steals in
 * the same instant, THIS one loses and waits, which is the correct outcome.
 */
export function acquireStartupLock(repoRoot: string, nowMs: number = Date.now()): StartupLockResult {
	const path = startupLockPath(repoRoot);
	try {
		mkdirSync(join(repoRoot, ".interlinked"), { recursive: true });
	} catch {
		/* intentional: dir may already exist, or be unwritable — writeLockFile decides */
	}
	const release = (): void => releaseStartupLock(repoRoot);
	if (writeLockFile(path, process.pid, nowMs)) return { acquired: true, path, release };

	const holder = readStartupLockHolder(repoRoot);
	if (!isStartupLockStale(holder, nowMs)) return { acquired: false, holder };
	try {
		unlinkSync(path);
	} catch {
		/* intentional: another process may have cleared it first */
	}
	if (writeLockFile(path, process.pid, nowMs)) return { acquired: true, path, release };
	return { acquired: false, holder: readStartupLockHolder(repoRoot) };
}

/** Release a lock THIS process holds. A lock owned by someone else is left
 *  alone — releasing another process's mutex is how a herd restarts. */
export function releaseStartupLock(repoRoot: string): void {
	const holder = readStartupLockHolder(repoRoot);
	if (holder !== null && holder.pid !== process.pid) return;
	try {
		unlinkSync(startupLockPath(repoRoot));
	} catch {
		/* intentional: already gone */
	}
}

export interface WaitOptions {
	timeout_ms?: number;
	poll_ms?: number;
	/** Test seam — defaults to a real Unix-socket connect probe. */
	probe?: (socketPath: string) => Promise<boolean>;
	/** Test seam — defaults to listing `.interlinked/harness*.sock`. */
	listSockets?: (repoRoot: string) => string[];
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll until SOME daemon socket for `repoRoot` answers, or the deadline passes.
 *
 * This is what a startup-lock loser does instead of binding: the winner is
 * already booting, so the only useful question is "is it up yet?". Resolves
 * true when a socket accepted a connection.
 */
export async function waitForDaemonSocket(repoRoot: string, opts: WaitOptions = {}): Promise<boolean> {
	const deadline = Date.now() + (opts.timeout_ms ?? STARTUP_WAIT_MS);
	const pollMs = opts.poll_ms ?? STARTUP_POLL_MS;
	const probe = opts.probe ?? ((p: string) => isDaemonSocketServing(p, { timeout_ms: pollMs }));
	const list = opts.listSockets ?? daemonSocketPaths;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	for (;;) {
		for (const socketPath of list(repoRoot)) {
			if (await probe(socketPath)) return true;
		}
		if (Date.now() >= deadline) return false;
		await sleep(pollMs);
	}
}

/** True when the lock file exists and is not stale — i.e. a start is genuinely
 *  in flight right now. Used for the "start pending" report. */
export function startupInFlight(repoRoot: string, nowMs: number = Date.now()): boolean {
	if (!existsSync(startupLockPath(repoRoot))) return false;
	return !isStartupLockStale(readStartupLockHolder(repoRoot), nowMs);
}
