import { nonNull } from "../../lib/non-null.js";
import {
	describeReason,
	findMalformedRulesIn,
	suggestRuleFix,
} from "../../lib/settings-validator.js";
import { scanPromptInjection } from "../signatures.js";
import type {
	EscalationRequest,
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import {
	INJECTION_SCAN_MIN_CHARS,
	isContentScanExempt,
} from "./write-content-guards-content-quality.js";

const BINARY_FILE_EXTENSIONS =
	/\.(png|jpe?g|gif|bmp|ico|webp|avif|svg|woff2?|ttf|otf|eot|wasm|pdf|zip|tar|gz|bz2|7z|rar|exe|dll|so|dylib|o|a|pyc|class|jar|mp3|mp4|wav|ogg|webm|mov|avi|db|sqlite|sqlite3)$/i;
const MERGE_CONFLICT_MARKER = /^<{7}\s|^={7}$|^>{7}\s/m;

export interface WriteContentGuardState {
	toolName: string;
	filePath: string;
	content: string;
	preEditContent: string | undefined;
	postEditContent: string;
	event: HarnessEvent;
	rules: GuardRulesConfig;
	session: SessionTrajectory | undefined;
	externalOverlays: boolean;
	warnings: string[];
	escalation: EscalationRequest | undefined;
}

export function injectionGuard(state: WriteContentGuardState): HarnessDecision | null {
	const { content, event, filePath, session, toolName, warnings } = state;
	const cwd = typeof event.cwd === "string" ? event.cwd : undefined;
	if (content.length <= INJECTION_SCAN_MIN_CHARS || isContentScanExempt(filePath, cwd)) {
		return null;
	}
	const matches = scanPromptInjection(content);
	if (matches.length === 0) return null;
	const highConfidence = matches.some(
		(match) => match.severity === "critical" || match.severity === "high",
	);
	if (highConfidence) {
		return {
			decision: "block",
			reason: `BLOCKED: Prompt injection pattern detected in content being written to ${filePath}: ${nonNull(matches[0]).description}. This content may compromise agent behavior.`,
			warnings,
			rule_id: "pretooluse-injection-scan",
			severity: "critical",
			category: "Security",
		};
	}
	state.escalation = {
		trigger: "post_injection_action",
		summary: `Partial prompt injection pattern detected in content for ${filePath}: ${nonNull(matches[0]).description}`,
		tool_name: toolName,
		tool_input_redacted: { file_path: filePath, content: "[REDACTED]" },
		sensitivity_level: session?.sensitivity_level || "Public",
		step_number: session?.tool_call_count || 0,
		recent_tool_sequence: session?.tool_sequence.slice(-10) || [],
	};
	warnings.push(
		`[interlinked:injection] Low-confidence injection pattern detected in ${filePath}: ${nonNull(matches[0]).description}`,
	);
	return null;
}

function isClaudeSettingsFile(filePath: string): boolean {
	return /(?:^|\/)\.claude\/settings(?:\.local)?\.json$/.test(filePath);
}

export function jsonAndClaudeSettingsGuard(
	state: WriteContentGuardState,
): HarnessDecision | null {
	const { content, filePath, warnings } = state;
	let parsedJson: unknown;
	if (filePath.endsWith(".json") && content.trim()) {
		try {
			parsedJson = JSON.parse(content);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			warnings.push(
				`[interlinked] Warning: Invalid JSON in ${filePath}: ${message.slice(0, 100)}`,
			);
		}
	}
	if (!isClaudeSettingsFile(filePath) || parsedJson === undefined) return null;
	const malformed = findMalformedRulesIn(parsedJson);
	if (malformed.length === 0) return null;
	const first = nonNull(malformed[0]);
	const others = malformed.length > 1 ? ` (and ${malformed.length - 1} more)` : "";
	const suggestion = suggestRuleFix(first.rule, first.reason);
	const suggestionClause = suggestion !== null ? ` Did you mean ${JSON.stringify(suggestion)}?` : "";
	return {
		decision: "block",
		reason:
			`BLOCKED: Write to ${filePath} would add a malformed permission rule. ` +
			`permissions.${first.bucket}[${first.index}] = ${JSON.stringify(first.rule)} ` +
			`(${describeReason(first.reason)})${others}.${suggestionClause} ` +
			"Claude Code's /doctor would skip this rule at load time. " +
			"Fix the rule string (or remove it) before retrying.",
		warnings,
		rule_id: "permission-rule-syntax",
		severity: "high",
		category: "settings-integrity",
	};
}

export function pathAndFormatGuard(state: WriteContentGuardState): HarnessDecision | null {
	const { content, filePath, warnings } = state;
	if (filePath.includes("../") || filePath.startsWith("/etc/") || filePath.startsWith("/usr/")) {
		return {
			decision: "block",
			reason: `BLOCKED: Writing to ${filePath} — path traversal or system directory write detected. Agents should only write within the project directory.`,
			warnings,
		};
	}
	if (BINARY_FILE_EXTENSIONS.test(filePath)) {
		return {
			decision: "block",
			reason: `BLOCKED: ${filePath} is a binary file. Text editing tools should not write to binary formats — use the appropriate tool or command instead.`,
			warnings,
		};
	}
	if (MERGE_CONFLICT_MARKER.test(content)) {
		return {
			decision: "block",
			reason: `BLOCKED: Merge conflict markers detected in ${filePath}. Resolve the conflict before writing.`,
			warnings,
		};
	}
	return null;
}
