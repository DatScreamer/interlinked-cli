// ===========================================
// Trigram Index — Git / File Discovery
// ===========================================
// Freestanding git helpers used by TrigramIndex.build() and
// incrementalUpdate() for file discovery and commit pinning. None of these
// reference TrigramIndex instance state — they take a cwd and shell out to git
// (with a filesystem-walk fallback when git is unavailable).

import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

/** Get list of tracked files via `git ls-files`. Falls back to filesystem walk. */
export function getTrackedFiles(cwd: string): string[] {
	try {
		const output = execSync("git ls-files -z", {
			cwd,
			encoding: "buffer",
			timeout: 30_000,
			maxBuffer: 50 * 1024 * 1024, // 50MB for large repos
		});
		// Split on null bytes, filter empty
		const tracked = output
			.toString("utf-8")
			.split("\0")
			.filter((f) => f.length > 0);

		// Also include gitignored .interlinked/hooks/ files — these are generated
		// by `interlinked enable` and should be searchable (e.g. the hook script).
		try {
			const extra = execSync("git ls-files -z --others -- .interlinked/hooks/", {
				cwd,
				encoding: "buffer",
				timeout: 5_000,
				maxBuffer: 1 * 1024 * 1024,
			});
			const untracked = extra
				.toString("utf-8")
				.split("\0")
				.filter((f) => f.length > 0);
			if (untracked.length > 0) {
				tracked.push(...untracked);
			}
		} catch (err) {
			void err; /* intentional: non-fatal — hooks dir may not exist */
		}

		return tracked;
	} catch {
		// Fallback: walk filesystem (limited to 2 levels for safety)
		return walkDir(cwd, cwd, 0, 5);
	}
}

/** Simple recursive directory walk (fallback when git is unavailable) */
function walkDir(dir: string, root: string, depth: number, maxDepth: number): string[] {
	if (depth > maxDepth) return [];
	const results: string[] = [];
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				results.push(...walkDir(full, root, depth + 1, maxDepth));
			} else if (entry.isFile()) {
				results.push(relative(root, full));
			}
		}
	} catch (err) {
		void err; /* intentional: permission errors etc. just return what we've found */
	}
	return results;
}

/** Get the current HEAD commit hash */
export function getHeadCommit(cwd: string): string {
	try {
		return execSync("git rev-parse HEAD", {
			cwd,
			encoding: "utf-8",
			timeout: 5_000,
		}).trim();
	} catch {
		return "unknown";
	}
}

/**
 * List files changed between `baseCommit` and HEAD (via `git diff --name-only`).
 * Returns null when the diff fails (e.g., base commit no longer exists) so the
 * caller can decide a full rebuild is needed — distinct from an empty result.
 */
export function getChangedFilesSince(cwd: string, baseCommit: string): string[] | null {
	try {
		const diff = execSync(`git diff --name-only ${baseCommit}..HEAD`, {
			cwd,
			encoding: "utf-8",
			timeout: 10_000,
		}).trim();
		return diff ? diff.split("\n").filter(Boolean) : [];
	} catch {
		// If diff fails (e.g., base commit no longer exists), signal "unknown".
		return null;
	}
}
