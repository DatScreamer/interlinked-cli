// ===========================================
// Per-session daemon path derivation
// ===========================================
// The legacy design keyed the daemon off a single `.interlinked/harness.sock`
// per repo. The Phase-E design allows multiple concurrent sessions — each
// CLI session gets its own socket and PID file keyed by session id.
//
// Fallback behavior for backward compatibility: when no session id is
// provided we return the legacy paths so existing deployments keep working.
// An explicit "default" session id is different: it names the framed default
// front door (`harness-default.sock`) used when no runner-specific session id
// is available.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface DaemonPaths {
	socket: string;
	pid: string;
	log: string;
}

/** Compute the socket/PID/log paths for a given repo root + optional session id. */
export function daemonPathsFor(repoRoot: string, sessionId?: string): DaemonPaths {
	const base = join(repoRoot, ".interlinked");
	if (!sessionId) {
		return {
			socket: join(base, "harness.sock"),
			pid: join(base, "harness.pid"),
			log: join(base, "logs", "daemon.log"),
		};
	}
	const safe = sanitizeSessionId(sessionId);
	return {
		socket: join(base, `harness-${safe}.sock`),
		pid: join(base, `harness-${safe}.pid`),
		log: join(base, "logs", `daemon-${safe}.log`),
	};
}

/** Sanitize a session id for safe use in filenames. Keeps alphanumerics,
 *  underscores, hyphens; replaces everything else with underscore; caps the
 *  length at 64 characters. */
export function sanitizeSessionId(id: string): string {
	const cleaned = id.replace(/[^A-Za-z0-9_-]/g, "_");
	return cleaned.slice(0, 64);
}

export interface DiscoveredDaemon {
	session_id: string;
	paths: DaemonPaths;
	pid: number | null;
	alive: boolean;
}

/** Walk .interlinked/ looking for all daemon PID/socket pairs. Used by
 *  `interlinked status` and `interlinked doctor`. */
export function discoverDaemons(repoRoot: string): DiscoveredDaemon[] {
	const base = join(repoRoot, ".interlinked");
	if (!existsSync(base)) return [];

	const out: DiscoveredDaemon[] = [];
	let entries: string[];
	try {
		entries = readdirSync(base);
	} catch {
		return [];
	}

	for (const name of entries) {
		if (!name.endsWith(".pid")) continue;
		const pidPath = join(base, name);
		const sessionId = parseSessionIdFromFilename(name);
		const paths = name === "harness.pid" ? daemonPathsFor(repoRoot) : daemonPathsFor(repoRoot, sessionId);
		const pid = readPidFile(pidPath);
		out.push({
			session_id: sessionId,
			paths,
			pid,
			alive: pid != null && isProcessAlive(pid),
		});
	}
	return out;
}

/** Remove stale PID + socket files for sessions whose process is gone. */
export function cleanupOrphans(repoRoot: string): DiscoveredDaemon[] {
	const found = discoverDaemons(repoRoot);
	const cleaned: DiscoveredDaemon[] = [];
	for (const entry of found) {
		if (entry.alive) continue;
		removeIfExists(entry.paths.pid);
		removeIfExists(entry.paths.socket);
		cleaned.push(entry);
	}
	return cleaned;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function parseSessionIdFromFilename(name: string): string {
	// Either "harness.pid" → "default", or "harness-<id>.pid" → "<id>"
	if (name === "harness.pid") return "default";
	const m = /^harness-(.+)\.pid$/.exec(name);
	return m ? m[1] : "default";
}

function readPidFile(path: string): number | null {
	if (!existsSync(path)) return null;
	const raw = safeReadFile(path);
	const n = Number.parseInt(raw.trim(), 10);
	return Number.isFinite(n) && n > 0 ? n : null;
}

function safeReadFile(path: string): string {
	let out = "";
	try {
		out = readFileSync(path, "utf-8");
	} catch {
		out = "";
	}
	return out;
}

function isProcessAlive(pid: number): boolean {
	let alive = false;
	try {
		// Signal 0 checks for existence without delivering a signal.
		process.kill(pid, 0);
		alive = true;
	} catch (err) {
		alive = (err as NodeJS.ErrnoException).code === "EPERM";
	}
	return alive;
}

function removeIfExists(path: string): boolean {
	if (!existsSync(path)) return false;
	let removed = false;
	try {
		// Socket files show up as special files; rm with force handles both.
		const info = statSync(path);
		if (info) rmSync(path, { force: true });
		removed = true;
	} catch {
		removed = false;
	}
	return removed;
}
