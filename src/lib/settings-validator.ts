// ===========================================
// Permission-rule validator for Claude Code settings files
// ===========================================
//
// Claude Code's "Always allow" flow auto-derives a permission rule
// (e.g. `Bash(node *)`) from the user's command. For commands that
// begin with shell tests like `[ -d dir ]` the extractor occasionally
// emits a string with mismatched parentheses, e.g.
//   "Bash(-d) && cd && echo && node /path *)"
// Claude Code's own /doctor flags those as "Invalid permission rule
// ... was skipped: Mismatched parentheses".
//
// We can't stop the upstream extractor from writing them, but we can
// detect them after the fact and offer to strip them. This module is
// the single source of truth for that check, consumed by
// `interlinked doctor` (read-only) and `interlinked doctor --fix`
// (rewrite settings file with offenders removed).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type PermissionBucket = "allow" | "deny" | "ask";

/** Reason why a rule is considered malformed. Used by the
 *  PreToolUse content-guard to render a specific error message at
 *  write time. Three detected classes today:
 *    - "paren_imbalance" matches Claude Code's /doctor diagnostic.
 *    - "empty_rule" catches blank-string entries which Claude
 *      Code's settings reader silently accepts but no rule ever
 *      matches against — pure dead weight in the allowlist.
 *    - "missing_tool_prefix" catches strings like `"just a string"`
 *      that don't start with `<Tool>(`. They never match any tool
 *      call so the rule has no effect; flagging at write time keeps
 *      the allowlist readable. */
export type MalformedRuleReason = "paren_imbalance" | "empty_rule" | "missing_tool_prefix";

export interface MalformedRule {
	bucket: PermissionBucket;
	index: number;
	rule: string;
	/** Why this rule was flagged. Optional so legacy callers that
	 *  populate the `MalformedRule[]` array without a reason still
	 *  compile; the PreToolUse guard treats `undefined` as
	 *  `"paren_imbalance"` (the only detected class today). */
	reason?: MalformedRuleReason;
}

/** Human-readable description for a `MalformedRuleReason`. Used by
 *  the PreToolUse settings-file content guard to render a precise
 *  error message at write time. */
export function describeReason(reason: MalformedRuleReason | undefined): string {
	switch (reason) {
		case "empty_rule":
			return "empty rule";
		case "missing_tool_prefix":
			return "missing Tool(...) prefix";
		case "paren_imbalance":
		case undefined:
			return "mismatched parentheses";
	}
}

/** A well-formed rule starts with `<ToolName>(`. This regex matches
 *  identifier-then-open-paren without requiring full grammar
 *  validation — that's Claude Code's job. */
const RULE_TOOL_PREFIX_RE = /^[A-Za-z][\w]*\(/;

/** Scan a parsed settings-JSON object and return every malformed
 *  rule it contains. Mirror of `validateSettingsFile`'s logic but
 *  for an in-memory object — used by the PreToolUse content guard
 *  to inspect a proposed write BEFORE it lands on disk. */
export function findMalformedRulesIn(parsedJson: unknown): MalformedRule[] {
	const out: MalformedRule[] = [];
	if (typeof parsedJson !== "object" || parsedJson === null) return out;
	const perms = (parsedJson as { permissions?: Record<PermissionBucket, unknown> })
		?.permissions;
	if (!perms || typeof perms !== "object") return out;
	for (const bucket of ["allow", "deny", "ask"] as const) {
		const list = perms[bucket];
		if (!Array.isArray(list)) continue;
		for (let i = 0; i < list.length; i++) {
			const rule = list[i];
			if (typeof rule !== "string") continue;
			if (rule.trim() === "") {
				out.push({ bucket, index: i, rule, reason: "empty_rule" });
				continue;
			}
			if (!RULE_TOOL_PREFIX_RE.test(rule)) {
				out.push({ bucket, index: i, rule, reason: "missing_tool_prefix" });
				continue;
			}
			if (!isParenBalanced(rule)) {
				out.push({ bucket, index: i, rule, reason: "paren_imbalance" });
			}
		}
	}
	return out;
}

export interface SettingsValidationResult {
	filePath: string;
	exists: boolean;
	parseError?: string;
	totalRules: number;
	malformed: MalformedRule[];
}

/**
 * Parens-only balance check: every `(` must have a matching `)` and we
 * must never go negative. This is the same shape the upstream /doctor
 * complains about, so a rule passing this check will not trigger the
 * "Mismatched parentheses" warning. We deliberately do not validate
 * deeper rule grammar — that's Claude Code's job — and we do not want
 * to flag rules the upstream tool happily accepts.
 */
export function isParenBalanced(rule: string): boolean {
	let depth = 0;
	for (const ch of rule) {
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth < 0) return false;
		}
	}
	return depth === 0;
}

/**
 * Default scan set: project-local + user-global Claude Code settings.
 * Both `settings.json` and `settings.local.json` at each scope. Caller
 * may override (tests pass a tmpdir).
 */
export function defaultSettingsPaths(cwd: string): string[] {
	return [
		join(cwd, ".claude", "settings.json"),
		join(cwd, ".claude", "settings.local.json"),
		join(homedir(), ".claude", "settings.json"),
		join(homedir(), ".claude", "settings.local.json"),
	];
}

export function validateSettingsFile(filePath: string): SettingsValidationResult {
	const result: SettingsValidationResult = {
		filePath,
		exists: existsSync(filePath),
		totalRules: 0,
		malformed: [],
	};
	if (!result.exists) return result;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(filePath, "utf-8"));
	} catch (e) {
		result.parseError = e instanceof Error ? e.message : String(e);
		return result;
	}

	const perms = (parsed as { permissions?: Record<PermissionBucket, unknown> })?.permissions;
	if (!perms || typeof perms !== "object") return result;

	for (const bucket of ["allow", "deny", "ask"] as const) {
		const list = perms[bucket];
		if (!Array.isArray(list)) continue;
		for (let i = 0; i < list.length; i++) {
			const rule = list[i];
			if (typeof rule !== "string") continue;
			result.totalRules++;
			if (!isParenBalanced(rule)) {
				result.malformed.push({ bucket, index: i, rule });
			}
		}
	}
	return result;
}

/**
 * Rewrite a settings file with malformed permission rules removed.
 * Returns the count actually stripped. Preserves field order and the
 * file's existing indentation (2-space JSON, matching what Claude Code
 * itself writes). No-op when there are no offenders, so it's safe to
 * call unconditionally from `--fix`.
 */
export function stripMalformedRules(filePath: string): number {
	if (!existsSync(filePath)) return 0;
	let parsed: { permissions?: Record<PermissionBucket, unknown> };
	try {
		parsed = JSON.parse(readFileSync(filePath, "utf-8"));
	} catch {
		return 0;
	}
	const perms = parsed?.permissions;
	if (!perms || typeof perms !== "object") return 0;

	let stripped = 0;
	for (const bucket of ["allow", "deny", "ask"] as const) {
		const list = perms[bucket];
		if (!Array.isArray(list)) continue;
		const cleaned = list.filter((r) => {
			if (typeof r !== "string") return true;
			if (isParenBalanced(r)) return true;
			stripped++;
			return false;
		});
		if (stripped > 0) perms[bucket] = cleaned;
	}

	if (stripped > 0) {
		writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
	}
	return stripped;
}
