// ===========================================
// Filesystem Guards (PreToolUse)
// ===========================================
//
// Helpers for the protected-files rule family and the repo-confinement
// gate. Both check the target filesystem path of a tool call before the
// tool runs; both may return a blocking `HarnessDecision` the caller
// passes straight through.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { GuardRulesConfig, HarnessDecision } from "../types.js";
import { globMatch, normalizeToolToOp } from "./tool-classifiers.js";

/** Sentinel for the secrets-only variant of a protected-files rule.
 *  Other `check` values fall through to the blanket block branch. */
const PROTECTED_FILE_CHECK_SECRETS = "secrets";

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
}): HarnessDecision | null {
	const { rawPath, cwd, allowlist } = args;
	const absPath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);
	let resolvedPath: string;
	try {
		resolvedPath = realpathSync(absPath);
	} catch {
		resolvedPath = absPath; // Write creates new files; resolve may fail.
	}
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

	return {
		decision: "block",
		reason: `BLOCKED: Writing to ${rawPath} is outside the repo root (${cwd}). Agents must confine writes to the project directory.`,
		rule_id: "builtin-repo-confinement",
		severity: "critical",
		category: "Security",
	};
}
