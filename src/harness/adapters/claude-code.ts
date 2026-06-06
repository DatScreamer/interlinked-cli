// ===========================================
// Claude Code adapter
// ===========================================
// Native payload reference: https://docs.claude.com/en/docs/claude-code/hooks
// Checked against CLI hooks docs as of 2026-04-23.
//
// Decision format:
//   stdout `{ "decision": "deny" | "ask", "reason": "..." }` — blocks/prompts
//   stdout `{ "hookSpecificOutput": { "additionalContext": "..." } }` — passes with note
//   exit 0 + no stdout = allow

import type { JsonObject } from "../../lib/json-types.js";
import { formatAskReasonWithTargets } from "../evaluator/rule-matching.js";
import { type ClassifierOverrides, classifyFromToolName } from "../tool-class-classifier.js";
import type { ToolClass, UnifiedHookEvent, UnifiedPhase } from "../unified-event.js";
import { makeEventId } from "../unified-event.js";
import { buildHookCommand } from "./hook-command.js";
import type { AdapterOutput, RunnerAdapter, SettingsFragment } from "./types.js";

const NATIVE_EVENTS = [
	"SessionStart",
	"SessionEnd",
	"UserPromptSubmit",
	"Stop",
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"PermissionRequest",
	"SubagentStart",
	"SubagentStop",
	"Notification",
	"PreCompact",
	"TaskCompleted",
	"TeammateIdle",
] as const;

const PHASE_MAP: Record<string, UnifiedPhase> = {
	SessionStart: "session-start",
	SessionEnd: "session-end",
	UserPromptSubmit: "user-prompt",
	Stop: "stop",
	PreToolUse: "pre-tool",
	PostToolUse: "post-tool",
	PostToolUseFailure: "post-tool",
	PermissionRequest: "other",
	SubagentStart: "subagent-start",
	SubagentStop: "subagent-stop",
	Notification: "notification",
	PreCompact: "pre-compact",
	TaskCompleted: "other",
	TeammateIdle: "other",
};

export interface ClaudeCodeAdapterOptions {
	/** Pre-loaded classifier overrides; adapter does not read disk itself. */
	overrides?: ClassifierOverrides | undefined;
}

export function createClaudeCodeAdapter(opts: ClaudeCodeAdapterOptions = {}): RunnerAdapter {
	return {
		id: "claude-code",
		label: "Claude Code",
		nativeEventNames: NATIVE_EVENTS,

		detectFromEnv(env) {
			return Boolean(
				env.CLAUDE_CODE ||
					env.CLAUDE_WORKING_DIR ||
					env.CLAUDECODE ||
					env.CLAUDE_CODE_VERSION,
			);
		},

		parseHookInput(nativeJson, nativeEventName) {
			const raw = isObject(nativeJson) ? nativeJson : {};
			const phase = PHASE_MAP[nativeEventName] ?? "other";
			const session_id = readString(raw.session_id) ?? "unknown";
			const cwd = readString(raw.cwd) ?? process.cwd();
			const ts = new Date().toISOString();

			const action = buildClaudeAction(nativeEventName, raw, opts.overrides);

			return {
				schema_version: "1",
				event_id: makeEventId(),
				session_id,
				// Runner's tool-invocation id (Claude Code `tool_use_id`); the
				// adapter path used to drop it. See UnifiedHookEvent.tool_use_id.
				tool_use_id: readString(raw.tool_use_id) ?? undefined,
				ts,
				runner: "claude-code",
				runner_native_event: nativeEventName,
				phase,
				action,
				context: {
					cwd,
					agent: readString(raw.agent_name)
						? { id: readString(raw.agent_name) ?? undefined }
						: undefined,
				},
				raw,
			};
		},

		classifyToolClass(toolName, toolInput) {
			return classifyFromToolName(
				toolName,
				toolInput,
				opts.overrides ? { overrides: opts.overrides } : {},
			);
		},

		renderSettingsFragment(binaryPath, scope): SettingsFragment {
			const path = scope === "user" ? "~/.claude/settings.json" : ".claude/settings.json";
			const hooks: Record<string, unknown[]> = {};
			for (const event of NATIVE_EVENTS) {
				const hookCommand = buildHookCommand(binaryPath, "claude-code", event);
				hooks[event] = [
					{
						matcher: "",
						hooks: [{ type: "command", command: hookCommand }],
					},
				];
			}
			return { path, fragment: { hooks }, mergeStrategy: "array-append" };
		},

		encodeDecision(decision, event): AdapterOutput {
			const stderr = (decision.warnings ?? []).join("\n");
			const isPre = event?.phase === "pre-tool";
			// Claude Code rejects hookSpecificOutput without a hookEventName that
			// matches the incoming event. Echo the runner's native event; fall
			// back by phase if absent.
			const hookEventName =
				event?.runner_native_event ?? (isPre ? "PreToolUse" : "PostToolUse");

			if (decision.decision === "block") {
				const reason = decision.reason ?? "Blocked by interlinked harness";
				if (isPre) {
					// PreToolUse: a deny MUST be carried in
					// hookSpecificOutput.permissionDecision. Root-level
					// {decision:"deny"} is NOT valid for PreToolUse — Claude Code
					// rejects it ("(root): Invalid input") and the block is
					// silently dropped, so the tool runs anyway. (PostToolUse, by
					// contrast, uses root {decision:"block"} — handled below.)
					return {
						stdout: JSON.stringify({
							hookSpecificOutput: {
								hookEventName,
								permissionDecision: "deny",
								permissionDecisionReason: reason,
							},
						}),
						stderr: stderr || undefined,
						exit_code: 0,
					};
				}
				// PostToolUse: root-level {decision:"block"} is the valid shape.
				return {
					stdout: JSON.stringify({ decision: "block", reason }),
					stderr: stderr || undefined,
					exit_code: 0,
				};
			}
			if (decision.decision === "ask") {
				// Append the resolved targets bullet list to the ask prompt body
				// so the human sees exactly what's about to happen (specific
				// file, URL, branch) instead of just the rule description.
				// When `resolved_targets` is unset the formatter returns the
				// reason verbatim — pre-existing callers render unchanged.
				const reason = formatAskReasonWithTargets(
					decision.reason ?? "Confirmation required",
					decision.resolved_targets,
				);
				// `ask` is a PreToolUse-only permission outcome and, like deny,
				// lives in hookSpecificOutput.permissionDecision — root
				// {decision:"ask"} is invalid.
				return {
					stdout: JSON.stringify({
						hookSpecificOutput: {
							hookEventName,
							permissionDecision: "ask",
							permissionDecisionReason: reason,
						},
					}),
					stderr: stderr || undefined,
					exit_code: 0,
				};
			}
			// allow.
			// Claude Code drops PreToolUse stderr from the model's view
			// (PostToolUse stderr IS surfaced as additional context, but
			// PreToolUse on `allow` is not). Route PreToolUse warnings through
			// hookSpecificOutput.additionalContext — supported by the spec at
			// PreToolUse — so the agent actually sees them on the same turn
			// (alongside the tool result). PostToolUse keeps the stderr-only
			// path because the runtime already echoes it; duplicating would
			// double-display.
			const contextParts: string[] = [];
			if (decision.additional_context) contextParts.push(decision.additional_context);
			if (isPre && stderr) contextParts.push(stderr);
			if (contextParts.length > 0) {
				return {
					stdout: JSON.stringify({
						hookSpecificOutput: {
							hookEventName,
							additionalContext: contextParts.join("\n"),
						},
					}),
					stderr: stderr || undefined,
					exit_code: 0,
				};
			}
			return { stderr: stderr || undefined, exit_code: 0 };
		},
	};
}

function buildClaudeAction(
	eventName: string,
	raw: JsonObject,
	overrides: ClassifierOverrides | undefined,
): UnifiedHookEvent["action"] {
	if (eventName === "UserPromptSubmit") {
		const text = readString(raw.prompt) ?? readString(raw.message) ?? "";
		return { kind: "user_prompt", text };
	}
	if (eventName === "SessionStart" || eventName === "SessionEnd") {
		return { kind: "session_lifecycle", event: eventName === "SessionStart" ? "start" : "end" };
	}
	if (
		eventName === "PreToolUse" ||
		eventName === "PostToolUse" ||
		eventName === "PostToolUseFailure"
	) {
		return buildToolCallAction(raw, overrides, eventName !== "PreToolUse");
	}
	return { kind: "other", subkind: eventName, data: raw };
}

function buildToolCallAction(
	raw: JsonObject,
	overrides: ClassifierOverrides | undefined,
	isPost: boolean,
): UnifiedHookEvent["action"] {
	const tool_name_raw = readString(raw.tool_name) ?? "unknown";
	const tool_name = normalizeToolName(tool_name_raw);
	const tool_input = (raw.tool_input as unknown) ?? {};
	const tool_class: ToolClass = classifyFromToolName(
		tool_name_raw,
		tool_input,
		overrides ? { overrides } : {},
	);
	const base = {
		kind: "tool_call" as const,
		tool_name,
		tool_class,
		tool_input,
		tool_input_redacted: tool_input,
	};
	if (isPost) {
		return {
			...base,
			tool_response: raw.tool_response,
			tool_error: readString(raw.tool_error) ?? undefined,
		};
	}
	return base;
}

function normalizeToolName(tool: string): string {
	return tool
		.replace(/([A-Z])/g, "_$1")
		.toLowerCase()
		.replace(/^_/, "");
}

function isObject(v: unknown): v is JsonObject {
	return v != null && typeof v === "object" && !Array.isArray(v);
}

function readString(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}
