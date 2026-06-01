// ===========================================
// Socket / filesystem lifecycle helpers
// ===========================================
// Extracted from server.ts. Pure, path-parameterized filesystem helpers the
// daemon uses when binding and tearing down its Unix socket. No module-level
// state — every function takes the path it operates on, which makes the
// socket-cleanup behavior (idempotent unlink, recursive parent-dir creation)
// unit-testable against a tmp directory.

import { existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

/** Ensure the parent directory of `path` exists, creating it (recursively) if
 *  not. Idempotent — a no-op when the directory is already present. */
export function ensureDirectory(path: string): void {
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

/** Remove a stale Unix socket file if present. Best-effort and idempotent:
 *  a missing file is fine, and any unlink error (permissions, race) is
 *  swallowed so a stale socket can't block daemon startup or shutdown. */
export function cleanupSocket(path: string): void {
	try {
		if (existsSync(path)) {
			unlinkSync(path);
		}
	} catch (e) {
		void e;
	}
}

/** Remove `path` if it exists. Best-effort and idempotent — used for the
 *  daemon's pid file across the early-shutdown, force-exit, and graceful
 *  teardown paths, where a missing or already-removed file must not throw. */
export function removeFileIfExists(path: string): void {
	try {
		if (existsSync(path)) {
			rmSync(path);
		}
	} catch (e) {
		void e;
	}
}
