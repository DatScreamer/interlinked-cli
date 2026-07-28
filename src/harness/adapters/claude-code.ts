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

import { hookTimeoutSecondsFor } from "../../lib/hook-timeouts.js";
import type { JsonObject } from "../../lib/json-types.js";
import { formatAskReasonWithTargets } from "../evaluator/rule-matching.js";
import { type ClassifierOverrides, classifyFromToolName } from "../tool-class-classifier.js";
import type { ToolClass, UnifiedHookEvent, UnifiedPhase } from "../unified-event.js";
import { makeEventId } from "../unified-event.js";
import { buildDetachedHookCommand, buildHookCommand } from "./hook-command.js";
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
				// SessionEnd is fire-and-forget: nothing consumes its output, and a
				// runner that exits right after firing it (`claude update`) cancels
				// any foreground hook still booting ("Hook cancelled"). The detached
				// form returns to the shell in milliseconds. Every other event stays
				// foreground — their output (context, warnings, block decisions) is
				// consumed by the runner.
				const hookCommand =
					event === "SessionEnd"
						? buildDetachedHookCommand(binaryPath, "claude-code", event)
						: buildHookCommand(binaryPath, "claude-code", event);
				// Per-event timeout (seconds; lib/hook-timeouts.ts is the single
				// source): PreToolUse must outlast the per-edit coverage overlay,
				// PostToolUse the full quality pass — Claude Code's 60s default
				// killed the hook after the run's cost was already paid.
				const timeout = hookTimeoutSecondsFor(event);
				hooks[event] = [
					{
						matcher: "",
						hooks: [
							{ type: "command", command: hookCommand, ...(timeout !== undefined ? { timeout } : {}) },
						],
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
				const reason =
					decision.reason ??
					"Blocked by the interlinked harness, but no reason was attached — likely a harness " +
						"bug; re-run, or run `interlinked harness restart`, then report it.";
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
			// Claude Code feeds hook stderr to the model on exit code 2 (a block),
			// NOT on exit 0. So on an allow, stderr alone reaches nobody — for
			// EITHER phase. Both therefore route warnings through
			// hookSpecificOutput.additionalContext, which is model-visible on the
			// same turn as the tool result.
			//
			// This used to be PreToolUse-only, on the belief that "the runtime
			// already echoes PostToolUse stderr, duplicating would double-display".
			// Measured false: a PostToolUse warning the daemon composed and wrote
			// to activity.jsonl never reached the agent. The consequence was large
			// and silent — every non-blocking PostToolUse finding the harness
			// produced was invisible, so advisory findings appeared only when some
			// unrelated error happened to block in the same turn. stderr is kept
			// as well, for the exit-2 path and for humans reading a terminal.
			// DELIBERATE Stop/SubagentStop semantics (do not "fix" one-sidedly):
			// on a Stop event, additionalContext is not a note — the runner treats
			// it as a reason to CONTINUE the turn. Left unbounded that looped
			// forever (observed live 2026-07-28: "blocked the turn from ending 9
			// consecutive times", every turn). The loop is bounded UPSTREAM by the
			// stop_hook_active re-entrancy guard in hook-entry.ts, which yields on
			// the second and later passes — so a Stop nudge extends the turn AT
			// MOST once per new information, which is exactly the visibility the
			// nudges exist to provide. Removing the context here instead would make
			// every Stop-time finding model-invisible.
			const contextParts: string[] = [];
			if (decision.additional_context) contextParts.push(decision.additional_context);
			if (stderr) contextParts.push(stderr);
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
	const tool_input: unknown = raw.tool_input ?? {};
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
