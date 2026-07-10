// ===========================================
// Command Decomposition & Env Var Safety
// ===========================================
// Splits compound bash commands into subcommands for individual
// guard rule evaluation, and classifies env var prefixes as safe/dangerous.

import type { JsonObject } from "../lib/json-types.js";
import { nonNull } from "../lib/non-null.js";
import { type CohortManager, getActiveCohort } from "./cohort.js";
import { classifySpans } from "./evaluator/spans.js";
import type {
	AgentRole,
	GuardRule,
	HarnessEvent,
	InputRewrite,
	ToolConcurrencyClass,
} from "./types.js";
import { DANGEROUS_ENV_VARS, SAFE_ENV_VARS } from "./types.js";

// ===========================================
// Compound Command Decomposition
// ===========================================

/** Split a compound bash command into its subcommands.
 *
 *  Splits on top-level `&&`, `||`, `;`, `|`, `&` (background), and newlines.
 *  Span-classified regions (quoted strings, inline-exec payloads, comments,
 *  heredoc bodies) are atomic — operators inside them never split. Newlines
 *  and pipes matter: `npm publish --dry-run\nnpm publish` must decompose so
 *  the second segment is evaluated without the first segment's `--dry-run`
 *  suppressing it (the compound-bypass shape destructive_command_guard
 *  closed for `safe-cmd && destructive-cmd`; see
 *  docs/external-pulse/destructive-command-guard.md).
 *
 *  Heredoc glue rules keep bodies attached to their command: no split on the
 *  header line's operators or newline (`cat <<EOF | grep x` stays whole), and
 *  none inside the body — otherwise body text would be evaluated as commands. */
export function decomposeCommand(command: string): string[] {
	const spans = classifySpans(command);
	const atomic = spans.filter((s) => s.kind !== "executed");
	const heredocs = spans.filter((s) => s.kind === "heredoc");

	const atomicEndFor = (idx: number): number | null => {
		for (const s of atomic) {
			if (idx >= s.start && idx < s.end) return s.end;
		}
		return null;
	};
	const heredocStartsAt = (idx: number): boolean => heredocs.some((s) => s.start === idx);
	// A heredoc whose body begins after this position's line: operators here
	// belong to the heredoc's header line and must not split.
	const pendingHeredocOnLine = (idx: number): boolean => {
		let lineEnd = command.indexOf("\n", idx);
		if (lineEnd === -1) lineEnd = command.length;
		return heredocs.some((s) => s.start > idx && s.start <= lineEnd + 1);
	};

	const parts: string[] = [];
	let current = "";
	let depth = 0;
	const push = () => {
		const trimmed = current.trim();
		if (trimmed) parts.push(trimmed);
		current = "";
	};

	for (let i = 0; i < command.length; i++) {
		const atomicEnd = atomicEndFor(i);
		if (atomicEnd !== null) {
			current += command.slice(i, atomicEnd);
			i = atomicEnd - 1;
			continue;
		}

		const ch = command[i];
		const next = command[i + 1];

		// Track subshell/substitution depth
		if (ch === "(" || (ch === "$" && next === "(")) {
			depth++;
			current += ch;
			continue;
		}
		if (ch === ")" && depth > 0) {
			depth--;
			current += ch;
			continue;
		}
		if (ch === "`") {
			depth = depth === 0 ? 1 : 0;
			current += ch;
			continue;
		}

		// Only split at top level
		if (depth === 0) {
			if (ch === "\n") {
				// `\` line continuations and heredoc header newlines glue.
				if (command[i - 1] === "\\" || heredocStartsAt(i + 1)) {
					current += ch;
					continue;
				}
				push();
				continue;
			}
			if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
				if (pendingHeredocOnLine(i)) {
					current += ch + (next ?? "");
					i++;
					continue;
				}
				push();
				i++;
				continue;
			}
			if (ch === ";" || ch === "|") {
				if (pendingHeredocOnLine(i)) {
					current += ch;
					continue;
				}
				push();
				continue;
			}
			if (ch === "&") {
				// Background `&` — but not the `2>&1` / `&>` redirect forms.
				if (command[i - 1] === ">" || next === ">") {
					current += ch;
					continue;
				}
				if (pendingHeredocOnLine(i)) {
					current += ch;
					continue;
				}
				push();
				continue;
			}
		}

		current += ch;
	}

	push();
	return parts;
}

// ===========================================
// Env Var Prefix Stripping
// ===========================================

const ENV_VAR_ASSIGN_RE = /^[A-Za-z_]\w*=/;

export interface EnvStripResult {
	stripped: string;
	dangerous_var?: string;
}

/**
 * Strip leading env var assignments from a command string.
 *
 * For deny rule matching: strips ALL env vars (aggressive — prevents bypass).
 * For allow rule matching: strips only SAFE_ENV_VARS (conservative — prevents escalation).
 */
export function stripEnvVarPrefix(command: string, mode: "deny" | "allow"): EnvStripResult {
	const parts = command.trim().split(/\s+/);
	let i = 0;

	while (i < parts.length && ENV_VAR_ASSIGN_RE.test(nonNull(parts[i]))) {
		const varName = nonNull(nonNull(parts[i]).split("=")[0]);

		if (DANGEROUS_ENV_VARS.has(varName)) {
			return { stripped: command, dangerous_var: varName };
		}

		if (mode === "allow" && !SAFE_ENV_VARS.has(varName)) {
			break;
		}

		i++;
	}

	return { stripped: parts.slice(i).join(" ") };
}

// ===========================================
// Guard Rule Evaluation with Decomposition
// ===========================================

/** Callback type for custom rule matching (mirrors evaluator's matchesRule) */
export type MatchRuleFn = (
	cmd: string,
	input: JsonObject,
	rule: GuardRule,
	extras?: Record<string, string[]>,
) => boolean;

export interface CompoundEvalResult {
	decision: "allow" | "block";
	reason?: string | undefined;
	warnings: string[];
	updated_input?: JsonObject | undefined;
	rule_id?: string | undefined;
	severity?: "critical" | "high" | "medium" | "low" | undefined;
	category?: string | undefined;
}

/**
 * Evaluate a compound bash command by decomposing it into subcommands
 * and checking each against guard rules individually.
 *
 * Returns a block if ANY subcommand is blocked, aggregates warnings,
 * and applies rewrites where applicable.
 */
export function evaluateCompoundCommand(
	fullCommand: string,
	guardRules: GuardRule[],
	extraExceptions?: Record<string, string[]>,
	matchFn?: MatchRuleFn,
): CompoundEvalResult {
	const subcommands = decomposeCommand(fullCommand);
	const warnings: string[] = [];

	// Single command — no decomposition needed (fast path)
	if (subcommands.length <= 1) {
		return { decision: "allow", warnings };
	}

	let rewrittenParts: string[] | null = null;
	const matcher = matchFn ?? defaultMatchRule;

	for (let idx = 0; idx < subcommands.length; idx++) {
		const sub = nonNull(subcommands[idx]);
		const { stripped, dangerous_var } = stripEnvVarPrefix(sub, "deny");

		if (dangerous_var) {
			return {
				decision: "block",
				reason: `BLOCKED: Dangerous environment variable ${dangerous_var}= detected in command. This can hijack library loading or alter execution.`,
				warnings,
				severity: "critical",
				category: "Security",
			};
		}

		const subInput: JsonObject = { command: stripped };

		for (const rule of guardRules) {
			if (!shouldEvaluateForBash(rule)) continue;
			if (!matcher(stripped, subInput, rule, extraExceptions)) continue;

			if (rule.action === "block") {
				return {
					decision: "block",
					reason: `BLOCKED: ${rule.reason} (in subcommand: ${nonNull(sub).slice(0, 80)})`,
					warnings,
					rule_id: rule.id,
					severity: rule.severity,
					category: rule.category,
				};
			}

			if (rule.action === "warn") {
				warnings.push(
					`[interlinked] Warning: ${rule.reason} (in subcommand: ${nonNull(sub).slice(0, 60)})`,
				);
			}

			if (rule.action === "rewrite" && rule.rewrite) {
				const rewritten = applyRewrite(sub, rule.rewrite);
				if (rewritten !== sub) {
					if (!rewrittenParts) rewrittenParts = [...subcommands];
					rewrittenParts[idx] = rewritten;
					warnings.push(
						`[interlinked:rewrite] Rewrote: ${nonNull(sub).slice(0, 40)} → ${rewritten.slice(0, 40)}`,
					);
				}
			}
		}
	}

	const result: CompoundEvalResult = { decision: "allow", warnings };
	if (rewrittenParts) {
		result.updated_input = { command: rewrittenParts.join(" && ") };
	}
	return result;
}

function shouldEvaluateForBash(rule: GuardRule): boolean {
	if (!rule.enabled) return false;
	if (rule.trigger !== "PreToolUse" && rule.trigger !== "both") return false;
	if (rule.tool_match.includes("*")) return true;
	return rule.tool_match.some((m) => {
		const lower = m.toLowerCase();
		return lower === "bash" || lower === "shell";
	});
}

// ===========================================
// Input Rewrite Application
// ===========================================

/** Apply an InputRewrite spec to a command string.
 *  Rewrite patterns come from trusted admin config (guard-rules.json), not user input.
 *  Regex length is capped to prevent accidental complexity from config errors. */
export function applyRewrite(command: string, rewrite: InputRewrite): string {
	if (rewrite.match.length > 200) return command;
	try {
		const regex = safeRegex(rewrite.match, "g");
		return regex ? command.replace(regex, rewrite.replace) : command;
	} catch {
		return command;
	}
}

// ===========================================
// Trusted Config Regex Helper
// ===========================================

/**
 * Pre-compiled regex cache for trusted admin config patterns.
 * Guard rule patterns come from guard-rules.json files authored by
 * the project admin — they are NOT user/agent input.
 */
const _regexCache = new Map<string, RegExp | null>();

function safeRegex(pattern: string, flags: string): RegExp | null {
	if (pattern.length > 200) return null;
	const key = `${pattern}\0${flags}`;
	const cached = _regexCache.get(key);
	if (cached !== undefined) return cached;
	try {
		// Reason: pattern source is the admin-authored guard-rules file;
		// length is capped above (≤200) and compile failures fall through.
		// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
		const re = new RegExp(pattern, flags);
		_regexCache.set(key, re);
		return re;
	} catch {
		_regexCache.set(key, null);
		return null;
	}
}

/** Minimal rule matching for subcommand evaluation (mirrors evaluator's matchesRule).
 *  All regex patterns come from trusted admin config (guard-rules.json). */
function defaultMatchRule(command: string, toolInput: JsonObject, rule: GuardRule): boolean {
	const positivePatterns = rule.patterns.filter((p) => !p.negate);
	const negatedPatterns = rule.patterns.filter((p) => p.negate);

	let anyPositiveMatched = positivePatterns.length === 0;
	for (const pattern of positivePatterns) {
		const value = resolvePatternValue(pattern.field, command, toolInput);
		if (!value) continue;
		const regex = safeRegex(pattern.regex, pattern.flags || "i");
		if (regex?.test(value)) {
			anyPositiveMatched = true;
			break;
		}
	}

	if (!anyPositiveMatched) return false;

	for (const pattern of negatedPatterns) {
		const value = resolvePatternValue(pattern.field, command, toolInput);
		if (!value) continue;
		const regex = safeRegex(pattern.regex, pattern.flags || "i");
		if (regex?.test(value)) return false;
	}

	return true;
}

function resolvePatternValue(field: string, command: string, toolInput: JsonObject): string {
	if (field === "command") return command;
	return String(toolInput[field] ?? "");
}

// ===========================================
// Tool Concurrency Classification
// ===========================================

/** Read-only tools that never mutate state */
const READ_ONLY_TOOLS = new Set([
	"Read",
	"ReadFile",
	"read_file",
	"FileRead",
	"Glob",
	"GlobTool",
	"Grep",
	"GrepTool",
	"Ls",
	"ListFiles",
	"WebSearch",
	"web_search",
	"WebFetch",
	"web_fetch",
	"ToolSearch",
	"TaskGet",
	"TaskList",
	"AskUserQuestion",
]);

/** Tools that modify state */
const STATE_CHANGING_TOOLS = new Set([
	"Write",
	"WriteFile",
	"write_file",
	"FileWrite",
	"Edit",
	"EditFile",
	"edit_file",
	"FileEdit",
	"Bash",
	"Shell",
	"shell",
	"run_command",
	"NotebookEdit",
	"TaskCreate",
	"TaskUpdate",
]);

/** Classify a tool call's concurrency safety */
export function classifyToolConcurrency(toolName: string): ToolConcurrencyClass {
	if (READ_ONLY_TOOLS.has(toolName)) return "read_only";
	if (STATE_CHANGING_TOOLS.has(toolName)) return "state_changing";
	return "unknown";
}

// ===========================================
// Agent Role Inference
// ===========================================

/**
 * True when the cohort knows this event's agent as somebody's child. The wire
 * fields (`parent_agent`, `agent_type`) are populated only on Subagent
 * lifecycle envelopes — an ordinary PreToolUse tool call from inside a
 * subagent carries none of them, which left `applies_to_roles` a dead lever
 * at gate time (docs/design/cohort-git-discipline.md §3.3). The cohort DOES
 * know the lineage (SubagentStart recorded `parent_agent`), so ask it first;
 * falls back to the active-cohort provider when no cohort is passed.
 */
function cohortKnowsAsSubagent(event: HarnessEvent, cohort?: CohortManager | null): boolean {
	const cohortView = cohort ?? getActiveCohort();
	if (!event.agent_name || !cohortView) return false;
	return Boolean(cohortView.getAgent(event.agent_name)?.parent_agent);
}

/** Infer agent role from event context when not explicitly set */
export function inferAgentRole(event: HarnessEvent, cohort?: CohortManager | null): AgentRole {
	if (event.agent_role) return event.agent_role;

	if (cohortKnowsAsSubagent(event, cohort)) return "subagent";
	if (event.parent_agent) return "subagent";
	if (event.hook_event === "SubagentStart" || event.hook_event === "SubagentStop")
		return "subagent";

	const agentType = event.agent_type?.toLowerCase() || "";
	if (agentType.includes("explore") || agentType.includes("plan")) return "subagent";
	if (agentType.includes("worker")) return "worker";
	if (agentType.includes("lead") || agentType.includes("coordinator")) return "lead";

	const name = (event.agent_name || "").toLowerCase();
	if (name.includes("worker")) return "worker";
	if (name.includes("lead") || name.includes("coordinator")) return "lead";

	return "unknown";
}

/** Check if a guard rule applies to the given agent role */
export function ruleAppliesToRole(rule: GuardRule, role: AgentRole): boolean {
	if (!rule.applies_to_roles || rule.applies_to_roles.length === 0) return true;
	return rule.applies_to_roles.includes(role);
}
