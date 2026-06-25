// ===========================================
// Filesystem Guards (PreToolUse)
// ===========================================
//
// Helpers for the protected-files rule family and the repo-confinement
// gate. Both check the target filesystem path of a tool call before the
// tool runs; both may return a blocking `HarnessDecision` the caller
// passes straight through.

import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import type { GuardRulesConfig, HarnessDecision } from "../types.js";
import { globMatch, normalizeToolToOp } from "./tool-classifiers.js";

/** Sentinel for the secrets-only variant of a protected-files rule.
 *  Other `check` values fall through to the blanket block branch. */
const PROTECTED_FILE_CHECK_SECRETS = "secrets";

/** realpath that falls back to the input when it can't resolve (e.g. a write
 *  target that does not exist yet). Used both to canonicalize a write path and
 *  to canonicalize the temp roots it is compared against. */
function realpathOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

// Ephemeral temp roots a coding host may provision a session scratchpad under.
// Both the literal and realpath'd forms are kept so a write target compares
// equal whether it arrives resolved (`/private/tmp/...`, e.g. the realpath of
// an existing file) or unresolved (`/tmp/...`, e.g. a brand-new file the host
// handed us). Computed once — these dirs are stable for the daemon's lifetime.
const EPHEMERAL_TEMP_ROOTS: readonly string[] = (() => {
	const roots = new Set<string>();
	for (const base of [tmpdir(), "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"]) {
		const abs = resolve(base);
		roots.add(abs);
		roots.add(realpathOrSelf(abs));
	}
	return [...roots];
})();

// The session scratchpad is the one out-of-repo location a coding host BOTH
// provisions for the agent AND scopes to this exact run — an ephemeral temp
// subtree shaped like `<temp-root>/.../<session-id>/scratchpad/...`. Blocking
// it is over-reach: the host's own directive hands the agent that path, and a
// denied write merely relocates into the repo (polluting the tracked tree and
// tripping the quality gates meant for real code). It is allowed only when all
// three properties hold, so the carve-out can never broaden into a blanket
// `/tmp` escape (other tools' temp state, predictable paths, symlink games):
//   • ephemeral      — under a recognized temp root (realpath-compared),
//   • session-scoped — the unguessable session id is a path segment,
//   • host-sanctioned — a `scratchpad` segment nested under that session dir.
function sessionScratchpadAllows(resolvedPath: string, sessionId: string | undefined): boolean {
	if (!sessionId) return false;
	const underTempRoot = EPHEMERAL_TEMP_ROOTS.some((root) =>
		resolvedPath.startsWith(root.endsWith(sep) ? root : `${root}${sep}`),
	);
	if (!underTempRoot) return false;
	const segments = resolvedPath.split(sep);
	const sessionIdx = segments.indexOf(sessionId);
	// scratchpad must sit BELOW the session dir, i.e. `<session-id>/scratchpad/`.
	return sessionIdx !== -1 && segments.indexOf("scratchpad") > sessionIdx;
}

/** Public API — consumed by evaluator/pre-tool.ts. Iterates the configured
 *  protected-files rules and returns a blocking decision if any rule
 *  matches the call. Returns `null` when no rule fires. */
export function evaluateProtectedFiles(args: {
	toolName: string;
	filePath: string;
	content: string;
	protectedFiles: GuardRulesConfig["protected_files"];
	containsSecrets: (content: string) => boolean;
}): HarnessDecision | null {
	const { toolName, filePath, content, protectedFiles, containsSecrets } = args;
	for (const pf of protectedFiles) {
		if (!pf.operations.includes(normalizeToolToOp(toolName))) continue;
		if (!globMatch(filePath, pf.glob)) continue;
		if (pf.check === PROTECTED_FILE_CHECK_SECRETS) {
			if (content && containsSecrets(content)) {
				return {
					decision: "block",
					reason: `Secrets detected in file write to ${filePath}: ${pf.reason}`,
					rule_id: "protected-file-secrets",
					severity: "critical",
					category: "Security",
				};
			}
			// No secrets found — secrets-only rule is not a blanket block.
			continue;
		}
		return {
			decision: "block",
			reason: pf.reason,
			rule_id: "protected-file",
			severity: "high",
			category: "Security",
		};
	}
	return null;
}

/** Public API — consumed by evaluator/pre-tool.ts. Enforces that file-write
 *  targets resolve inside the repo root (or one of the allowlisted prefixes).
 *  Returns a blocking `HarnessDecision` when the write would escape, `null`
 *  otherwise. */
export function evaluateRepoConfinement(args: {
	rawPath: string;
	cwd: string;
	allowlist: string[];
	linkedProjects?: string[];
	sessionId?: string;
}): HarnessDecision | null {
	const { rawPath, cwd, allowlist, linkedProjects = [], sessionId } = args;
	const absPath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);
	// realpath canonicalizes existing targets (defeating symlink escapes); a
	// brand-new file falls back to its absolute path.
	const resolvedPath = realpathOrSelf(absPath);
	const cwdNormalized = cwd.endsWith("/") ? cwd : `${cwd}/`;
	if (resolvedPath.startsWith(cwdNormalized) || resolvedPath === cwd) return null;

	const home = homedir();
	const isAllowed = allowlist.some((prefix) => {
		const absPrefix = prefix.startsWith("~/")
			? resolve(home, prefix.slice(2))
			: resolve(prefix);
		const normalizedPrefix = absPrefix.endsWith("/") ? absPrefix : `${absPrefix}/`;
		return resolvedPath.startsWith(normalizedPrefix) || resolvedPath === absPrefix;
	});
	if (isAllowed) return null;

	// Linked workspace members: declared sibling project roots that compose
	// this workspace, resolved against the project root (cwd). Bounded and
	// explicit — the multi-repo workspace model (e.g. public CLI + private
	// cloud), not a blanket escape.
	const inLinkedProject = linkedProjects.some((rel) => {
		const absRoot = isAbsolute(rel) ? resolve(rel) : resolve(cwd, rel);
		const normalized = absRoot.endsWith("/") ? absRoot : `${absRoot}/`;
		return resolvedPath.startsWith(normalized) || resolvedPath === absRoot;
	});
	if (inLinkedProject) return null;

	// Host-provisioned, session-scoped scratchpad — ephemeral + session-scoped +
	// host-sanctioned (see sessionScratchpadAllows). Tightly bounded, so it is
	// never a blanket temp-dir escape.
	if (sessionScratchpadAllows(resolvedPath, sessionId)) return null;

	const linkedHint = linkedProjects.length > 0 ? " or a declared linked project" : "";
	return {
		decision: "block",
		reason: `BLOCKED: Writing to ${rawPath} is outside the repo root (${cwd})${linkedHint}. Agents must confine writes to the project directory.`,
		rule_id: "builtin-repo-confinement",
		severity: "critical",
		category: "Security",
	};
}
