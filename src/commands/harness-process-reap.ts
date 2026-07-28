// interlinked-tdd: exempt
// ===========================================
// interlinked harness — orphan-reap selection + termination helpers
// ===========================================
// Pure private helpers split out of `harness-process.ts`: ps-row parsing,
// orphan candidate selection, SIGTERM/SIGKILL escalation, process-liveness
// polling, and stale pid/sock-file cleanup. `reapOrphanHarnesses` (in
// harness-process.ts) is the only consumer; these have no module-private state
// and form a leaf cluster, so the split introduces no circular import. The
// `OrphanCandidate` type lives here (the cluster's natural owner) and is
// re-exported from harness-process.ts so existing importers stay unchanged.

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

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

/**
 * Extract the `--cwd <path>` argument the daemon was spawned with. Each harness
 * binds to one workspace (see `harnessStartCommand`'s `args = [..., serverPath,
 * "--cwd", cwd]` construction); reading that field tells us which repo the
 * daemon serves. Returns null on a legacy/malformed cmdline so the caller can
 * skip the candidate rather than risk reaping a daemon from another workspace.
 */
export function extractCwdArg(cmdline: string): string | null {
	const tokens = cmdline.split(/\s+/);
	// Scan every token: the `--cwd=<path>` equals form is self-contained and can
	// legitimately be the LAST token, so the loop must reach the final index. The
	// space form `--cwd <path>` reads tokens[i+1] — `undefined → null` past the
	// end, which is correct (a valueless `--cwd` is malformed).
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i] === "--cwd") return tokens[i + 1] ?? null;
		if (tokens[i]?.startsWith("--cwd=")) {
			return tokens[i]?.slice("--cwd=".length) ?? null;
		}
	}
	return null;
}

/** Parse one `ps` row of the form `<pid> <ppid> <command>`. Returns null when
 *  the line doesn't match (blank lines, header residue) or the pid is NaN. */
export function parsePsRow(line: string): OrphanCandidate | null {
	const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
	if (!m) return null;
	const pid = Number.parseInt(m[1] as string, 10);
	const ppid = Number.parseInt(m[2] as string, 10);
	const command = m[3] as string;
	if (Number.isNaN(pid)) return null;
	return { pid, ppid, command };
}

/**
 * True when a parsed `ps` row is a reapable orphan harness for THIS workspace,
 * after applying the self / non-harness / cross-cwd / ancestor / active-pid
 * protections. The `killAll` flag drops the active-pid protection (but never the
 * ancestor protection — that would kill the shell that invoked us).
 */
export function isReapCandidate(
	row: OrphanCandidate,
	cwd: string,
	ancestorPids: Set<number>,
	activePid: number | null,
	killAll: boolean,
): boolean {
	const { pid, command: cmd } = row;
	if (pid === process.pid) return false;
	if (!cmd.includes("node") && !cmd.includes("bun")) return false;
	if (!cmd.includes("interlinked-cli/dist/harness/server")) return false;
	// Scope by `--cwd`: a daemon spawned from a sibling repo has a different
	// `--cwd` and must NOT be reaped from this workspace — doing so would silently
	// disable hooks in the user's other open project. If `--cwd` is absent (legacy
	// daemon, malformed cmdline) skip the candidate rather than risk a
	// cross-workspace SIGTERM.
	const candidateCwd = extractCwdArg(cmd);
	if (candidateCwd === null || candidateCwd !== cwd) return false;
	// Never SIGTERM our own ancestor chain — true in both default and killAll
	// mode. killAll additionally treats the active daemon as fair game.
	if (ancestorPids.has(pid)) return false;
	if (!killAll && activePid !== null && pid === activePid) return false;
	return true;
}

/**
 * Walk the `ps` table and return the orphan harness daemons eligible for
 * reaping in `cwd`. Pure filtering — no signalling, no fs writes — so the dry-run
 * surface and the live reap share one selection rule.
 */
export function collectReapCandidates(
	ps: string,
	cwd: string,
	ancestorPids: Set<number>,
	activePid: number | null,
	killAll: boolean,
): OrphanCandidate[] {
	const candidates: OrphanCandidate[] = [];
	for (const line of ps.split("\n")) {
		const row = parsePsRow(line);
		if (!row) continue;
		if (isReapCandidate(row, cwd, ancestorPids, activePid, killAll)) {
			candidates.push(row);
		}
	}
	return candidates;
}

/**
 * SIGTERM every candidate, wait under one shared deadline, then SIGKILL only the
 * survivors and wait again. Returns the PIDs confirmed gone (an ESRCH at any
 * signalling step counts as reaped; a permission error does not). Batching all
 * signals before the first wait keeps N SIGTERM-deaf orphans from costing
 * N × (TERM grace + KILL grace).
 */
export function terminateCandidates(candidates: readonly OrphanCandidate[]): number[] {
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
		// SIGTERM-deaf orphans cost N * (TERM grace + KILL grace) and later daemons
		// were not even signalled until earlier timeouts expired.
		try {
			process.kill(candidate.pid, "SIGTERM");
			termSent.push(candidate);
		} catch (termErr) {
			// Already gone counts as reaped; permission errors do not.
			if (isNoSuchProcessError(termErr)) markKilled(candidate.pid);
		}
	}

	// Verify all signalled processes under one shared deadline, then escalate only
	// survivors. This preserves the "don't clear pid files unless the process is
	// truly gone" contract without serial timeouts.
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
	return killed;
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
export function waitForProcessesExit(
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

export function hasProcess(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return !isNoSuchProcessError(err);
	}
}

export function isNoSuchProcessError(err: unknown): boolean {
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
export function clearOrphanedPidFiles(cwd: string, killedPids: number[]): void {
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
