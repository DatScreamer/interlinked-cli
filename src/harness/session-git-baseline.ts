// ===========================================
// Session Git Baseline — SessionStart working-tree snapshot
// ===========================================
// Standalone helper lifted out of session-state.ts. Captures the git
// working-tree state once at session start so downstream channels (the
// git-session-scope-gate, rollback feasibility) can separate "pre-existing
// dirty" from "this session touched it". Kept dependency-free (just
// `execFileSync`) so it stays trivially testable in isolation.

import { execFileSync } from "node:child_process";
import { nonNull } from "../lib/non-null.js";

/** Timeout for the SessionStart git-baseline snapshot. Both `git rev-parse HEAD`
 *  and `git status --porcelain` should complete in milliseconds on a normal
 *  repo; the timeout is defensive against hung git (lock contention, NFS, etc.). */
const GIT_BASELINE_TIMEOUT_MS = 2000;

/** Capture the git working-tree state at session start: HEAD sha + porcelain-
 *  classified sets of modified/staged/untracked paths. Tolerates non-git dirs
 *  (returns empty baseline). Cached for the lifetime of the session — never
 *  re-snapshotted. Exported for direct testing. */
export function captureGitBaseline(cwd: string): {
	modified: Set<string>;
	staged: Set<string>;
	untracked: Set<string>;
	head_sha: string;
} {
	const empty = {
		modified: new Set<string>(),
		staged: new Set<string>(),
		untracked: new Set<string>(),
		head_sha: "",
	};
	let headSha = "";
	try {
		headSha = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: GIT_BASELINE_TIMEOUT_MS,
		}).trim();
	} catch {
		headSha = "";
	}

	let porcelain = "";
	try {
		porcelain = execFileSync("git", ["status", "--porcelain", "-z", "-uall"], {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: GIT_BASELINE_TIMEOUT_MS,
		});
	} catch {
		return empty;
	}

	const modified = new Set<string>();
	const staged = new Set<string>();
	const untracked = new Set<string>();
	const entries = porcelain.split("\0").filter((e) => e.length > 0);
	for (let i = 0; i < entries.length; i++) {
		const raw = nonNull(entries[i]);
		if (raw.length < 3) continue;
		const indexStatus = raw[0];
		const worktreeStatus = raw[1];
		const path = raw.slice(3);
		if (indexStatus === "R" || indexStatus === "C") {
			i++; // skip the old-path entry of a rename/copy
		}
		if (indexStatus === "?" && worktreeStatus === "?") {
			untracked.add(path);
			continue;
		}
		if (indexStatus === "!" && worktreeStatus === "!") continue;
		if (indexStatus !== " " && indexStatus !== "?" && indexStatus !== "!") {
			staged.add(path);
		}
		if (worktreeStatus !== " " && worktreeStatus !== "?" && worktreeStatus !== "!") {
			modified.add(path);
		}
	}
	return { modified, staged, untracked, head_sha: headSha };
}
