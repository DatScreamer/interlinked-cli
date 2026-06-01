// ===========================================
// interlinked harness — process / orphan-daemon utilities
// ===========================================
// Pure process-management helpers split out of `harness.ts`: PID/socket path
// resolution, orphan-daemon reaping, ancestor-chain protection, daemon server
// path resolution, stale-dist rebuild, and liveness probing. The lifecycle
// command handlers (`harnessStartCommand` et al.) import from here; `harness.ts`
// re-exports the public surface so importers stay byte-for-byte identical.

import { execSync, spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { daemonPathsFor } from "../harness/session-paths.js";
import { getConfigDir } from "../lib/config.js";
import { c } from "../lib/formatter.js";

interface HarnessStatus {
	running: boolean;
	pid?: number;
}

export function getSocketPath(cwd: string = process.cwd()): string {
	return join(getConfigDir(cwd), "harness.sock");
}

export function getFramedSocketPath(cwd: string, sessionId: string | undefined): string {
	return daemonPathsFor(cwd, sessionId || "default").socket;
}

export function getPidPath(cwd: string = process.cwd()): string {
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
	const killedSet = new Set<number>();
	const markKilled = (pid: number): void => {
		if (killedSet.has(pid)) return;
		killedSet.add(pid);
		killed.push(pid);
	};

	const termSent: OrphanCandidate[] = [];
	for (const candidate of candidates) {
		// Signal every candidate before waiting. With per-candidate waits, N
		// SIGTERM-deaf orphans cost N * (TERM grace + KILL grace) and later
		// daemons were not even signalled until earlier timeouts expired.
		try {
			process.kill(candidate.pid, "SIGTERM");
			termSent.push(candidate);
		} catch (termErr) {
			// Already gone counts as reaped; permission errors do not.
			if (isNoSuchProcessError(termErr)) markKilled(candidate.pid);
		}
	}

	// Verify all signalled processes under one shared deadline, then
	// escalate only survivors. This preserves the "don't clear pid files
	// unless the process is truly gone" contract without serial timeouts.
	const termSurvivors = waitForProcessesExit(
		termSent.map((candidate) => candidate.pid),
		REAP_GRACE_MS,
		markKilled,
	);
	const killSent: number[] = [];
	for (const candidate of termSent) {
		if (!termSurvivors.has(candidate.pid)) continue;
		try {
			process.kill(candidate.pid, "SIGKILL");
			killSent.push(candidate.pid);
		} catch (killErr) {
			if (isNoSuchProcessError(killErr)) markKilled(candidate.pid);
		}
	}
	waitForProcessesExit(killSent, REAP_KILL_GRACE_MS, markKilled);
	// After everything dies, sweep the stale pid/sock files so the next
	// `startSessionDaemon` doesn't see an "existing PID" left behind by a
	// daemon that crashed without reaching its own removePidFile() call.
	if (killed.length > 0) {
		clearOrphanedPidFiles(cwd, killed);
		process.stderr.write(
			`[interlinked] Reaped ${killed.length} orphan harness daemon${killed.length === 1 ? "" : "s"}: ${killed.join(", ")}\n`,
		);
	}
	return { candidates, killed, dryRun: false };
}

/** Grace window for the daemon to exit on SIGTERM before we escalate to
 *  SIGKILL. Three seconds covers the longest normal shutdown path
 *  (async-analysis drain caps at 2s) without making restarts feel sluggish. */
const REAP_GRACE_MS = 3000;
/** After SIGKILL the kernel reaps within milliseconds; one second is overkill
 *  but cheap insurance against pathological scheduling. */
const REAP_KILL_GRACE_MS = 1000;

/** Block synchronously until every PID is gone or `timeoutMs` elapses. Returns
 *  the still-alive survivors. Polls with `process.kill(pid, 0)` (signal 0 is
 *  "test for existence") at ~50 ms intervals. */
function waitForProcessesExit(
	pids: readonly number[],
	timeoutMs: number,
	onExited: (pid: number) => void,
): Set<number> {
	const alive = new Set(pids);
	const deadline = Date.now() + timeoutMs;
	while (alive.size > 0 && Date.now() < deadline) {
		for (const pid of [...alive]) {
			if (!hasProcess(pid)) {
				alive.delete(pid);
				onExited(pid);
			}
		}
		if (alive.size === 0) break;
		// Use Atomics.wait for a no-CPU sleep — busy-looping here would burn
		// a core during shutdown.
		const buf = new SharedArrayBuffer(4);
		Atomics.wait(new Int32Array(buf), 0, 0, 50);
	}
	for (const pid of [...alive]) {
		if (!hasProcess(pid)) {
			alive.delete(pid);
			onExited(pid);
		}
	}
	return alive;
}

function hasProcess(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return !isNoSuchProcessError(err);
	}
}

function isNoSuchProcessError(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as NodeJS.ErrnoException).code === "ESRCH"
	);
}

/** After reaping, drop any pid/sock files whose contents reference the
 *  killed PIDs. Without this the next start sees `existingPid !== null` and
 *  refuses to bind even though no daemon is alive. Best-effort: missing or
 *  unreadable files are skipped silently. */
function clearOrphanedPidFiles(cwd: string, killedPids: number[]): void {
	const killedSet = new Set(killedPids);
	const dir = join(cwd, ".interlinked");
	const candidates: string[] = [];
	try {
		for (const name of readdirSync(dir)) {
			if (name === "harness.pid" || /^harness-.+\.pid$/.test(name)) {
				candidates.push(join(dir, name));
			}
		}
	} catch {
		return;
	}
	for (const pidPath of candidates) {
		let pidStr = "";
		try {
			pidStr = readFileSync(pidPath, "utf-8").trim();
		} catch {
			continue;
		}
		const filePid = Number.parseInt(pidStr, 10);
		if (!Number.isFinite(filePid)) continue;
		if (!killedSet.has(filePid)) continue;
		try {
			rmSync(pidPath, { force: true });
		} catch {
			/* intentional: best-effort cleanup — already-removed pid is fine */
		}
		// Pair with its socket file — same prefix, .sock suffix.
		const sockPath = pidPath.replace(/\.pid$/, ".sock");
		try {
			if (existsSync(sockPath)) rmSync(sockPath, { force: true });
		} catch {
			/* intentional: best-effort cleanup — already-removed socket is fine */
		}
	}
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

export interface DaemonStderrLog {
	fd: number;
	path: string;
	startOffset: number;
}

export function openDaemonStderrLog(cwd: string): DaemonStderrLog | null {
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

export function closeDaemonStderrLog(log: DaemonStderrLog | null): void {
	if (!log) return;
	try {
		closeSync(log.fd);
	} catch (_) {
		/* intentional: child inherited its own stderr fd; parent close is best-effort */
	}
}

export function readDaemonStderrLog(log: DaemonStderrLog | null): string {
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
export function ensureDistFresh(): void {
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

export function getHarnessServerPath(): string {
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

export type { HarnessStatus };
