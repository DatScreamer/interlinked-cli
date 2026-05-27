// ===========================================
// Guard-Rule Pattern Matching Helpers
// ===========================================
//
// Shared machinery for evaluating a single `GuardRule` against a tool-call
// payload: trigger/tool filters, cached regex compilation, positive +
// negated pattern logic, dot-path field lookup, and the canonical reason
// formatter that fronts every block decision.

import type { JsonObject } from "../../lib/json-types.js";
import type { GuardRule, HarnessEvent, RulePattern } from "../types.js";
import { extractScannableText } from "./spans.js";
import { normalizeCommandWrappers } from "./wrapper-normalization.js";

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
 *  objects derived from trusted guard-rule config patterns.
 *
 *  ReDoS validation is intentionally NOT applied here. Admin-authored built-in
 *  rules contain bounded patterns like `(-[rf]+\s+)*` whose outer shape
 *  matches a generic ReDoS heuristic but are actually safe (anchored by
 *  literal characters between groups). The ReDoS gate runs at the LOAD point
 *  for user-supplied / `/enforce`-distilled rules instead — see
 *  `rules/distilled-rules.ts` and `safeCompileRegex` in `redos-validation.ts`. */
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

/** Apply opt-in projections (`strip_wrappers`, `executed_only`) to the
 *  raw field value before regex matching. Order: mask non-executed spans
 *  first (preserves indices via space-fill), then strip wrapper prefixes
 *  from the resulting executed-only string. Both off → identity. */
function projectForPattern(value: string, pattern: RulePattern): string {
	let v = value;
	if (pattern.executed_only) v = extractScannableText(v);
	if (pattern.strip_wrappers) v = normalizeCommandWrappers(v);
	return v;
}

/** Evaluate the positive + negated pattern pair against a resolved input value. */
function evaluatePatterns(rule: GuardRule, toolInput: JsonObject, fallback: string): PatternResult {
	const positivePatterns = rule.patterns.filter((p) => !p.negate);
	const negatedPatterns = rule.patterns.filter((p) => p.negate);

	// ANY positive pattern must match (OR logic); vacuously true with zero patterns.
	let anyPositiveMatched = positivePatterns.length === 0;
	for (const pattern of positivePatterns) {
		const value = getField(toolInput, pattern.field) || fallback;
		if (!value) continue;
		const regex = getCachedRegex(pattern.regex, pattern.flags ?? "i");
		if (regex.test(projectForPattern(String(value), pattern))) {
			anyPositiveMatched = true;
			break;
		}
	}
	if (!anyPositiveMatched) return PATTERN_RESULT_NO_POSITIVE;

	// ALL negated patterns must NOT match (exceptions).
	for (const pattern of negatedPatterns) {
		const value = getField(toolInput, pattern.field) || fallback;
		if (!value) continue;
		const regex = getCachedRegex(pattern.regex, pattern.flags ?? "i");
		if (regex.test(projectForPattern(String(value), pattern))) return PATTERN_RESULT_NEGATED;
	}
	return PATTERN_RESULT_MATCH;
}

/** Normalize an extension token: lowercase, strip a leading dot, drop empties.
 *  `'.PY'` and `'py'` both compare equal. The empty string is filtered out so a
 *  config that accidentally includes `''` doesn't allow every extensionless path. */
function normalizeExt(token: string): string {
	const t = token.trim().toLowerCase();
	return t.startsWith(".") ? t.slice(1) : t;
}

/** Extract the lower-cased file extension (no leading dot) from a path-like
 *  string. Returns "" when no dot is present. The harness rule matcher uses
 *  this to gate `file_extensions`-scoped rules — a rule that targets `.py`
 *  shouldn't fire on `index.html`. */
function extractFileExt(filePath: string): string {
	const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
	const base = slash >= 0 ? filePath.slice(slash + 1) : filePath;
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return "";
	return base.slice(dot + 1).toLowerCase();
}

/** When a rule declares `file_extensions`, the tool's `file_path` (or `path`)
 *  must end in one of them. Returns `true` when the rule applies (no allowlist
 *  set, OR the file matches), `false` when scoping rejects the call. */
function passesFileExtensionScope(rule: GuardRule, toolInput: JsonObject): boolean {
	const allowlist = rule.file_extensions;
	if (!allowlist || allowlist.length === 0) return true;
	const filePath = String(getField(toolInput, "file_path") || getField(toolInput, "path") || "");
	if (!filePath) return false;
	const ext = extractFileExt(filePath);
	if (!ext) return false;
	const normalized = allowlist.map(normalizeExt).filter((e) => e.length > 0);
	return normalized.includes(ext);
}

/** Public API — consumed by evaluator sub-modules to test a rule against a tool-call payload.
 *  Applies OR over positive patterns, exceptions via `negate: true` patterns, and a final
 *  allowlist from `extra_exceptions` that lets local configs carve specific callsites. */
export function matchesRule(ctx: MatchRuleContext): boolean {
	const { command, toolInput, rule, extraExceptions } = ctx;

	if (!passesFileExtensionScope(rule, toolInput)) return false;

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
