import type { HookEvent, Verdict } from "../types.js";

interface RuleEntry {
	id: string;
	action: "block" | "warn";
	tool_match: string[];
	patterns: RegExp[];
	reason: string;
	suggestion?: string;
}

// Ported from interlinked-cli builtin-cf-dns-record-delete (warn).
// Source: src/harness/rules/builtin-rules-database.ts as of commit 9eaa677.
const RULES: RuleEntry[] = [
	{
		id: "cloud-builtin-cf-dns-record-delete",
		action: "warn",
		tool_match: ["Bash", "Shell", "run_command"],
		patterns: [/\bcf\s+dns\s+records?\s+delete\b/i],
		reason:
			"DNS record deletion has wide blast radius and is reversible only via manual recreation",
		suggestion:
			"Confirm the record is intentional to delete; for transient testing prefer disabling",
	},
];

const PRE_TOOL_USE: HookEvent["hook_event"] = "PreToolUse";
const ACTION_BLOCK: RuleEntry["action"] = "block";

function hasCommandField(value: unknown): value is { command: unknown } {
	return value !== null && typeof value === "object" && "command" in value;
}

function extractCommand(toolInput: unknown): string {
	if (!hasCommandField(toolInput)) return "";
	return typeof toolInput.command === "string" ? toolInput.command : "";
}

function findMatchingRule(toolName: string, command: string): RuleEntry | null {
	for (const rule of RULES) {
		if (!rule.tool_match.includes(toolName)) continue;
		if (rule.patterns.some((pat) => pat.test(command))) return rule;
	}
	return null;
}

export function evaluate(event: HookEvent): Verdict {
	if (event.hook_event !== PRE_TOOL_USE) return { decision: "allow" };
	const command = extractCommand(event.tool_input);
	if (!command) return { decision: "allow" };
	const rule = findMatchingRule(event.tool_name, command);
	if (!rule) return { decision: "allow" };
	if (rule.action === ACTION_BLOCK) {
		return { decision: "block", reason: rule.reason, rule_id: rule.id };
	}
	return { decision: "allow", warnings: [rule.reason], rule_id: rule.id };
}
