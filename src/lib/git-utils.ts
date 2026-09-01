// ===========================================
// Git Utilities — Shared helpers for git commands
// ===========================================
// Common git operations used across git, guard, and attach commands.

import { execFileSync } from "node:child_process";
import { nonNull } from "./non-null.js";

/**
 * Run a git command and return trimmed stdout.
 * Throws on non-zero exit.
 * Uses execFileSync to avoid shell injection via metacharacters in args.
 */
function git(args: string, cwd: string): string {
	const argv = args.match(/"[^"]*"|'[^']*'|\S+/g) || [];
	// Strip wrapping quotes from arguments
	const cleaned = argv.map((a) =>
		(a.startsWith('"') && a.endsWith('"')) || (a.startsWith("'") && a.endsWith("'"))
			? a.slice(1, -1)
			: a,
	);
	return execFileSync("git", cleaned, {
		cwd,
		encoding: "utf-8",
		timeout: 10000,
		stdio: ["pipe", "pipe", "pipe"],
	}).trim();
}

/**
 * Check if the given directory is inside a git repository.
 */
export function isGitRepo(cwd: string): boolean {
	try {
		git("rev-parse --git-dir", cwd);
		return true;
	} catch (_err) {
		/* intentional: non-zero exit means cwd is not inside a git repo */
		return false;
	}
}

/**
 * Get the current branch name, or null if detached HEAD.
 */
export function getCurrentBranch(cwd: string): string | null {
	try {
		return git("branch --show-current", cwd) || null;
	} catch (_err) {
		/* intentional: not a git repo or detached HEAD — null signals "no branch" */
		return null;
	}
}

/**
 * Get the HEAD commit SHA (short form by default).
 */
export function getHeadSha(cwd: string, short = true): string | null {
	try {
		return git(`rev-parse ${short ? "--short" : ""} HEAD`, cwd) || null;
	} catch (_err) {
		/* intentional: empty/bare repo has no HEAD — null signals "unknown" */
		return null;
	}
}

/**
 * Get the full commit message for a ref.
 */
export function getCommitMessage(ref: string, cwd: string): string | null {
	try {
		return git(`log -1 --format=%B ${ref}`, cwd) || null;
	} catch (_err) {
		/* intentional: ref unknown or not a git repo — null signals "unavailable" */
		return null;
	}
}

/**
 * Get staged file paths (for pre-commit hooks).
 */
export function getStagedFiles(cwd: string): string[] {
	try {
		const output = git("diff --cached --name-only", cwd);
		return output ? output.split("\n").filter(Boolean) : [];
	} catch (_err) {
		/* intentional: no index or not a git repo — treat as nothing staged */
		return [];
	}
}

/**
 * Get the git toplevel directory.
 */
export function getGitToplevel(cwd: string): string | null {
	try {
		return git("rev-parse --show-toplevel", cwd) || null;
	} catch (_err) {
		/* intentional: not inside a git worktree — null signals "no toplevel" */
		return null;
	}
}

/**
 * Parse Interlinked trailers from a commit message.
 * Returns a map of trailer key -> value (e.g. "Interlinked-Checkpoint" -> "42").
 */
export function parseInterlinkedTrailers(message: string): Record<string, string> {
	const trailers: Record<string, string> = {};
	const lines = message.split("\n");
	for (const line of lines) {
		// Value must start with a non-whitespace character: `\s*(.+)` alone
		// backtracks on a whitespace-only remainder and records an empty value.
		const match = line.match(/^(Interlinked-\w[\w-]*):\s*(\S.*)$/);
		if (match) {
			trailers[nonNull(match[1])] = nonNull(match[2]).trim();
		}
	}
	return trailers;
}

export interface ProjectIdentity {
	workspaceKey?: string | undefined;
	projectKey?: string | undefined;
}

/**
 * Derive workspace_key and project_key from git repo metadata.
 * Used by `attach --auto`.
 */
export function deriveProjectIdentity(cwd: string): ProjectIdentity {
	// 1. Try git remote URL -> extract repo name
	let repoName: string | null = null;
	try {
		const remoteUrl = git("remote get-url origin", cwd);
		if (remoteUrl) {
			// SSH: git@github.com:user/my-project.git
			const sshMatch = remoteUrl.match(/[:/]([^/]+?)(?:\.git)?$/);
			// HTTPS: https://github.com/user/my-project.git
			if (sshMatch) {
				repoName = nonNull(sshMatch[1]);
			}
		}
	} catch (_err) {
		/* intentional: no git remote configured — fall through to toplevel directory name */
	}

	// 2. Fallback: git toplevel directory name
	if (!repoName) {
		const toplevel = getGitToplevel(cwd);
		if (toplevel) {
			const parts = toplevel.split("/");
			repoName = parts[parts.length - 1] || null;
		}
	}

	if (!repoName) return {};

	// 3. Sanitize: lowercase, replace spaces/special chars with hyphens
	const slug = repoName
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");

	return {
		workspaceKey: slug || undefined,
		projectKey: "main",
	};
}
