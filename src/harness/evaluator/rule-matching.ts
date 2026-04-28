// ===========================================
// Guard-Rule Pattern Matching Helpers
// ===========================================
//
// Shared machinery for evaluating a single `GuardRule` against a tool-call
// payload: trigger/tool filters, cached regex compilation, positive +
// negated pattern logic, dot-path field lookup, and the canonical reason
// formatter that fronts every block decision.

import type { JsonObject } from "../../lib/json-types.js";
import type { GuardRule, HarnessEvent } from "../types.js";

/** Nested indexable object type for dot-path field traversal in rule pattern matching */
interface Indexable {
	[key: string]: unknown;
}

/** Rule triggers that match every lifecycle phase regardless of the current phase. */
const TRIGGER_BOTH = "both";

/** Tool-match token meaning "applies to every tool call". */
const TOOL_MATCH_ALL = "*";

/** Public API — consumed by evaluator sub-modules to decide whether a rule applies
 *  to the current lifecycle phase and tool name. */
export function shouldEvaluateRule(
	rule: GuardRule,
	phase: "PreToolUse" | "PostToolUse",
	toolName: string,
): boolean {
	if (!rule.enabled) return false;
	if (rule.trigger !== phase && rule.trigger !== TRIGGER_BOTH) return false;
	if (rule.tool_match.includes(TOOL_MATCH_ALL)) return true;
	return rule.tool_match.some((m) => m.toLowerCase() === toolName.toLowerCase());
}

/**
 * Pre-compiled regex cache for guard rule patterns.
 * These patterns come from admin-authored guard-rules.json config files,
 * not from user or agent input. Caching avoids re-compiling on every
 * tool call (67+ built-in rules × multiple patterns each).
 */
const _ruleRegexCache = new Map<string, RegExp>();

/** Public API — consumed by evaluator sub-modules to cheaply reuse compiled regex
 *  objects derived from trusted guard-rule config patterns. */
export function getCachedRegex(pattern: string, flags: string): RegExp {
	const key = `${pattern}\0${flags}`;
	let re = _ruleRegexCache.get(key);
	if (!re) {
		// Reason: pattern/flags come from the admin-authored guard-rules
		// config (trusted); the cache and isolation are orthogonal to ReDoS.
		// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
		re = new RegExp(pattern, flags);
		_ruleRegexCache.set(key, re);
	}
	// Reset lastIndex for stateful flags (g, y) — guard rules don't use them,
	// but defensive in case a config adds them.
	re.lastIndex = 0;
	return re;
}

/** Public API — arguments to {@link matchesRule}. Grouped as a struct so the
 *  evaluator and `command-decomposition.ts` can share a single call contract. */
export interface MatchRuleContext {
	command: string;
	toolInput: JsonObject;
	rule: GuardRule;
	extraExceptions?: Record<string, string[]>;
}

/** Return values from {@link evaluatePatterns}: either the rule's patterns
 *  passed (MATCH), no positive pattern hit, or a negated exception fired. */
const PATTERN_RESULT_MATCH = "match";
const PATTERN_RESULT_NO_POSITIVE = "no-positive-match";
const PATTERN_RESULT_NEGATED = "negated-match";
type PatternResult =
	| typeof PATTERN_RESULT_MATCH
	| typeof PATTERN_RESULT_NO_POSITIVE
	| typeof PATTERN_RESULT_NEGATED;

/** Evaluate the positive + negated pattern pair against a resolved input value. */
function evaluatePatterns(rule: GuardRule, toolInput: JsonObject, fallback: string): PatternResult {
	const positivePatterns = rule.patterns.filter((p) => !p.negate);
	const negatedPatterns = rule.patterns.filter((p) => p.negate);

	// ANY positive pattern must match (OR logic); vacuously true with zero patterns.
	let anyPositiveMatched = positivePatterns.length === 0;
	for (const pattern of positivePatterns) {
		const value = getField(toolInput, pattern.field) || fallback;
		if (!value) continue;
		const regex = getCachedRegex(pattern.regex, pattern.flags || "i");
		if (regex.test(String(value))) {
			anyPositiveMatched = true;
			break;
		}
	}
	if (!anyPositiveMatched) return PATTERN_RESULT_NO_POSITIVE;

	// ALL negated patterns must NOT match (exceptions).
	for (const pattern of negatedPatterns) {
		const value = getField(toolInput, pattern.field) || fallback;
		if (!value) continue;
		const regex = getCachedRegex(pattern.regex, pattern.flags || "i");
		if (regex.test(String(value))) return PATTERN_RESULT_NEGATED;
	}
	return PATTERN_RESULT_MATCH;
}

/** Public API — consumed by evaluator sub-modules to test a rule against a tool-call payload.
 *  Applies OR over positive patterns, exceptions via `negate: true` patterns, and a final
 *  allowlist from `extra_exceptions` that lets local configs carve specific callsites. */
export function matchesRule(ctx: MatchRuleContext): boolean {
	const { command, toolInput, rule, extraExceptions } = ctx;

	const patternResult = evaluatePatterns(rule, toolInput, command);
	if (patternResult !== PATTERN_RESULT_MATCH) return false;

	// Check extra exceptions from local config (substring allowlist on command).
	const exceptions = extraExceptions?.[rule.id];
	if (exceptions) {
		const cmd = String(getField(toolInput, "command") || command);
		for (const exc of exceptions) {
			if (cmd.includes(exc)) return false;
		}
	}
	return true;
}

/** `typeof` keyword for non-primitive indexable containers; anything else (string,
 *  number, function, etc.) is a dead-end during dot-path traversal. */
const TYPEOF_OBJECT = "object";

/** Public API — consumed by evaluator sub-modules for dot-path field traversal
 *  (e.g., "tool_response.stdout") into a payload object. */
export function getField(obj: Indexable, path: string): unknown {
	if (!path.includes(".")) return obj[path];
	const parts = path.split(".");
	let current: Indexable = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		const value = current[parts[i]];
		if (value == null || typeof value !== TYPEOF_OBJECT || Array.isArray(value))
			return undefined;
		current = value as Indexable;
	}
	return current[parts[parts.length - 1]];
}

/** Public API — consumed by evaluator sub-modules to format the `reason` field
 *  on a blocking decision, appending the rule's optional remediation suggestion. */
export function formatReason(rule: GuardRule): string {
	let msg = `BLOCKED: ${rule.reason}`;
	if (rule.suggestion) {
		msg += `\n\nSuggestion: ${rule.suggestion}`;
	}
	return msg;
}

/** Public API — agent-facing reason for `decision: "ask"`. Distinct from the
 *  block reason because the agent isn't being refused — it's being asked to
 *  pause for human approval. The leading marker tells the agent this is a
 *  *potentially* destructive operation, not a rule violation per se. */
export function formatAskReason(rule: GuardRule): string {
	let msg = `POTENTIALLY DESTRUCTIVE: ${rule.reason}\n\n`;
	msg += "This action requires user confirmation before proceeding. ";
	msg += "If the user approves, the operation will run; if not, choose a non-destructive alternative.";
	if (rule.suggestion) {
		msg += `\n\nSuggestion: ${rule.suggestion}`;
	}
	return msg;
}

/** Public API — user-only message attached to ask decisions on clients that
 *  surface a separate user channel (Claude Code's `systemMessage`, Cursor's
 *  `userMessage`). Includes the tool name, rule id, and a one-line "what's
 *  about to happen" so the human can decide without re-reading the agent's
 *  context. */
export function formatAskSystemMessage(rule: GuardRule, event: HarnessEvent): string {
	const lines = [
		`⚠️  Interlinked detected a potentially destructive operation.`,
		`   Tool:     ${event.tool_name || "unknown"}`,
		`   Rule:     ${rule.id} (${rule.severity})`,
		`   Why:      ${rule.reason}`,
	];
	if (rule.suggestion) {
		lines.push(`   Safer:    ${rule.suggestion}`);
	}
	lines.push("");
	lines.push("Approve only if you intended this action. Deny to make the agent pick a non-destructive path.");
	return lines.join("\n");
}
