// ===========================================
// Shared git I/O for commit-time PreToolUse gates
// ===========================================
// `gitShow` / `resolveRepoRoot` were identical, independently-written copies
// in commit-baseline-gate.ts and commit-registry-parity-gate.ts (both need
// "read a staged blob" / "find the repo toplevel" and nothing more) — the
// code-clones check caught the duplication when the second copy landed.
// Extracted here so both import the same implementation; a future commit
// gate needing the same two primitives should import from here too rather
// than writing a third copy.

import { execFileSync } from "node:child_process";

const GIT_TIMEOUT_MS = 1_500;

/** `git show <ref>` content, or null when it doesn't resolve (ref not
 *  staged/committed, path not tracked, git missing). Fail-open by design —
 *  every caller treats null as "nothing to compare", never as an error. */
export function gitShow(repoRoot: string, ref: string): string | null {
	try {
		return execFileSync("git", ["-C", repoRoot, "show", ref], {
			encoding: "utf-8",
			timeout: GIT_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return null;
	}
}

/** Resolve the git toplevel for a directory, or null (not a git repo, git
 *  missing, or the command times out). Fail-open by design. */
export function resolveRepoRoot(dir: string): string | null {
	try {
		const out = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
			encoding: "utf-8",
			timeout: GIT_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const top = out.split("\n")[0]?.trim();
		return top && top.length > 0 ? top : null;
	} catch {
		return null;
	}
}
