// ===========================================
// Daemon control — liveness-verified reaping, complete stop
// ===========================================
// Two rules the 2026-08-15 restart storm taught, both about trusting PIDs:
//
//  1. NEVER SIGTERM a daemon that is answering. Every reaper here (the orphan
//     sweep on `harness start`, the pre-restart sweep) selected victims from
//     `ps` output and pid files, so a healthy daemon whose pid file had been
//     cleaned — or whose pid the active-pid check did not cover — was killed by
//     the next `start`. That kill opened the gap that made the NEXT caller run
//     `harness start`. Only an explicit `harness stop`/`restart` may stop a
//     serving daemon; a REAPER must verify over the socket first.
//  2. A stop must stop EVERYTHING. `interlinked disable` stopped the pid-file
//     daemon and left two orphans running, still holding memory and still
//     answering — a stood-down repo with live guards is the worst of both.
//
// Every dependency is injectable so both rules are unit-testable without real
// processes.

import { recordDaemonEvent } from "../harness/daemon-ledger.js";
import type { DaemonLedgerEvent } from "../harness/daemon-ledger.js";
import {
	type DiscoveredDaemon,
	discoverDaemons,
	isDaemonSocketServing,
} from "../harness/session-paths.js";
import {
	collectAncestorPids,
	type ReapOptions,
	type ReapResult,
	reapOrphanHarnesses,
} from "./harness-process.js";

/** Grace period between SIGTERM and the "did it actually stop?" check. */
const STOP_GRACE_MS = 1_000;

export interface DaemonControlDeps {
	discover?: (cwd: string) => DiscoveredDaemon[];
	/** PIDs of daemons for this repo that no pid file names — the `ps`-derived
	 *  orphan set. These are exactly the processes `disable` used to miss. */
	extraPids?: (cwd: string) => number[];
	probe?: (socketPath: string) => Promise<boolean>;
	kill?: (pid: number) => void;
	isAlive?: (pid: number) => boolean;
	/** Pids that must never be signalled (this process + its ancestor chain). */
	protectedPids?: () => Set<number>;
	recordEvent?: (evt: DaemonLedgerEvent) => void;
	wait?: (ms: number) => Promise<void>;
	/** Test seam — the underlying `ps`-driven sweep. Injecting it is what lets a
	 *  unit test assert that the protected set actually REACHED the sweep, which
	 *  is the whole invariant `reapOrphanHarnessesVerified` exists to hold. */
	reap?: (cwd: string, opts: ReapOptions) => ReapResult;
}

function realIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function realKill(pid: number): void {
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		/* intentional: ESRCH (already gone) is the expected happy path */
	}
}

function orphanPids(cwd: string): number[] {
	return reapOrphanHarnesses(cwd, { dryRun: true }).candidates.map((c) => c.pid);
}

/**
 * The PIDs of daemons that are actually ANSWERING for this repo.
 *
 * This is the reaper's protected set: a process in here is doing the job the
 * reaper exists to protect, so it is never a victim, whatever the pid files
 * say. A dead process is never probed (its socket may be a corpse another
 * daemon has since replaced).
 */
export async function collectServingDaemonPids(
	cwd: string,
	deps: DaemonControlDeps = {},
): Promise<Set<number>> {
	const discover = deps.discover ?? discoverDaemons;
	const probe = deps.probe ?? ((p: string) => isDaemonSocketServing(p));
	const serving = new Set<number>();
	for (const entry of discover(cwd)) {
		if (entry.pid === null || !entry.alive) continue;
		if (await probe(entry.paths.socket)) serving.add(entry.pid);
	}
	return serving;
}

/**
 * Orphan sweep that cannot kill a working daemon: the serving set is resolved
 * over the socket first and handed to the sweep as protected pids.
 *
 * Every reaper call site should use THIS, not `reapOrphanHarnesses` directly.
 */
export async function reapOrphanHarnessesVerified(
	cwd: string,
	opts: { dryRun?: boolean; killAll?: boolean } = {},
	deps: DaemonControlDeps = {},
): Promise<ReapResult> {
	const protectPids = await collectServingDaemonPids(cwd, deps);
	return (deps.reap ?? reapOrphanHarnesses)(cwd, { ...opts, protectPids });
}

export interface StopAllResult {
	stopped: number[];
	survived: number[];
}

/**
 * Stop EVERY daemon process serving this repo — the pid-file daemon, every
 * per-session daemon, and the `ps`-visible orphans no pid file names.
 *
 * Unlike a reaper this MAY stop a serving daemon: that is the point of an
 * explicit stop. One `explicit-stop` ledger row is written before the signals
 * so the resulting `signal` exits classify as planned instead of reading like
 * the storm's reaper kills.
 */
export async function stopAllDaemons(
	cwd: string,
	deps: DaemonControlDeps = {},
): Promise<StopAllResult> {
	const discover = deps.discover ?? discoverDaemons;
	const extras = deps.extraPids ?? orphanPids;
	const protectedPids = (deps.protectedPids ?? collectAncestorPids)();
	const kill = deps.kill ?? realKill;
	const isAlive = deps.isAlive ?? realIsAlive;
	const wait = deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

	const targets = new Set<number>();
	for (const entry of discover(cwd)) {
		if (entry.pid !== null && entry.alive) targets.add(entry.pid);
	}
	for (const pid of extras(cwd)) targets.add(pid);
	for (const pid of protectedPids) targets.delete(pid);
	if (targets.size === 0) return { stopped: [], survived: [] };

	(deps.recordEvent ?? ((evt: DaemonLedgerEvent) => recordDaemonEvent(cwd, evt)))({
		at: Date.now(),
		pid: process.pid,
		event: "handover",
		reason: "explicit-stop",
		detail: `stopping ${targets.size} daemon(s): ${[...targets].join(", ")}`,
	});
	for (const pid of targets) kill(pid);
	await wait(STOP_GRACE_MS);

	const stopped: number[] = [];
	const survived: number[] = [];
	for (const pid of targets) (isAlive(pid) ? survived : stopped).push(pid);
	return { stopped, survived };
}
