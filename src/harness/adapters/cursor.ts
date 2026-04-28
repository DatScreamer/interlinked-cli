// ===========================================
// Cursor adapter
// ===========================================
// Cursor hook events (per https://cursor.com/docs/hooks, as of 2026-04):
//   beforeShellExecution, afterShellExecution,
//   beforeMCPExecution, afterMCPExecution,
//   beforeReadFile, afterFileEdit, beforeSubmitPrompt,
//   sessionStart, sessionEnd, stop, preToolUse, postToolUse
//
// Payload shape varies per event — adapter is tolerant of unknown fields.
//
// Decision via stdout JSON (gate hooks):
//   { permission: "allow"|"deny"|"ask", userMessage?, agentMessage?, continue?, updated_input? }
//
// Cursor SUPPORTS "ask" as a first-class primitive — when our harness returns
// `decision: "ask"`, we map to `permission: "ask"` so the user sees an
// interactive prompt rather than a blanket deny. This is the parity that
// makes Cursor support meaningfully different from Copilot/Codex/Gemini.

import type { JsonObject } from "../../lib/json-types.js";
import {
	type ClassifierOverrides,
	classifyCommand,
	classifyFromToolName,
} from "../tool-class-classifier.js";
import type { ToolClass, UnifiedHookEvent, UnifiedPhase } from "../unified-event.js";
import { makeEventId } from "../unified-event.js";
import { buildHookCommand } from "./hook-command.js";
import type { AdapterOutput, RunnerAdapter, SettingsFragment } from "./types.js";

const NATIVE_EVENTS = [
	"sessionStart",
	"sessionEnd",
	"stop",
	"beforeSubmitPrompt",
	"beforeShellExecution",
	"afterShellExecution",
	"beforeMCPExecution",
	"afterMCPExecution",
	"beforeReadFile",
	"afterFileEdit",
	"preToolUse",
	"postToolUse",
] as const;

// Events that are gated (the harness can block / ask) — these get
// `failClosed: true` in the settings fragment and are eligible to receive a
// `permission` field in the decision response.
const GATED_EVENTS = new Set<string>([
	"beforeShellExecution",
	"beforeMCPExecution",
	"beforeReadFile",
	"preToolUse",
]);

const PHASE_MAP: Record<string, UnifiedPhase> = {
	sessionStart: "other",
	sessionEnd: "other",
	stop: "other",
	beforeSubmitPrompt: "user-prompt",
	beforeShellExecution: "pre-tool",
	afterShellExecution: "post-tool",
	beforeMCPExecution: "pre-tool",
	afterMCPExecution: "post-tool",
	beforeReadFile: "pre-tool",
	afterFileEdit: "post-tool",
	preToolUse: "pre-tool",
	postToolUse: "post-tool",
};

export interface CursorAdapterOptions {
	overrides?: ClassifierOverrides;
}

export function createCursorAdapter(opts: CursorAdapterOptions = {}): RunnerAdapter {
	return {
		id: "cursor",
		label: "Cursor",
		nativeEventNames: NATIVE_EVENTS,

		detectFromEnv(env) {
			return Boolean(env.CURSOR_SESSION_ID || env.CURSOR_TRACE_ID || env.CURSOR_API_URL);
		},

		parseHookInput(nativeJson, nativeEventName) {
			const raw = isObject(nativeJson) ? nativeJson : {};
			const phase = PHASE_MAP[nativeEventName] ?? "other";
			const session_id = readString(raw.session_id) ?? readString(raw.sessionId) ?? "unknown";
			const cwd = readString(raw.cwd) ?? readString(raw.workspace_root) ?? process.cwd();
			const ts = new Date().toISOString();

			const action = buildCursorAction(nativeEventName, raw, opts.overrides);

			return {
				schema_version: "1",
				event_id: makeEventId(),
				session_id,
				ts,
				runner: "cursor",
				runner_native_event: nativeEventName,
				phase,
				action,
				context: { cwd },
				raw,
			};
		},

		classifyToolClass(toolName, toolInput) {
			return classifyFromToolName(toolName, toolInput, { overrides: opts.overrides });
		},

		renderSettingsFragment(binaryPath, scope): SettingsFragment {
			// Cursor's hook config file is `hooks.json` (not `settings.json`);
			// per docs the file is searched at `~/.cursor/hooks.json` (user)
			// or `<project>/.cursor/hooks.json` (project).
			const path = scope === "user" ? "~/.cursor/hooks.json" : ".cursor/hooks.json";
			const hooks: Record<string, unknown[]> = {};
			for (const event of NATIVE_EVENTS) {
				const hookCommand = buildHookCommand(binaryPath, "cursor", event);
				const entry: JsonObject = { command: hookCommand, type: "command" };
				if (GATED_EVENTS.has(event)) {
					entry.failClosed = true;
				}
				hooks[event] = [entry];
			}
			return { path, fragment: { version: 1, hooks }, mergeStrategy: "array-append" };
		},

		encodeDecision(decision, event): AdapterOutput {
			const stderr = (decision.warnings ?? []).join("\n");
			const isGated = GATED_EVENTS.has(event.runner_native_event);
			if (decision.decision === "block") {
				if (!isGated) {
					// Lifecycle / observation hook — surface the reason via
					// stderr so the user sees it but don't claim we can
					// rewind the action.
					return { stdout: undefined, stderr: decision.reason || stderr || undefined, exit_code: 0 };
				}
				return {
					stdout: JSON.stringify({
						permission: "deny",
						agentMessage: decision.reason ?? "Blocked by interlinked harness",
						userMessage: decision.reason ?? "Blocked by interlinked harness",
					}),
					stderr: stderr || undefined,
					exit_code: 0,
				};
			}
			if (decision.decision === "ask") {
				if (!isGated) {
					return { stdout: undefined, stderr: decision.reason || stderr || undefined, exit_code: 0 };
				}
				const userMsg = decision.system_message || decision.reason || "Confirmation required";
				return {
					stdout: JSON.stringify({
						permission: "ask",
						agentMessage: decision.reason ?? "Confirmation required",
						userMessage: userMsg,
					}),
					stderr: stderr || undefined,
					exit_code: 0,
				};
			}
			// allow
			if (!isGated) {
				return { stdout: undefined, stderr: stderr || undefined, exit_code: 0 };
			}
			const payload: JsonObject = { permission: "allow" };
			if (decision.additional_context) {
				payload.agentMessage = decision.additional_context;
			}
			return {
				stdout: JSON.stringify(payload),
				stderr: stderr || undefined,
				exit_code: 0,
			};
		},
	};
}

function buildCursorAction(
	eventName: string,
	raw: JsonObject,
	overrides: ClassifierOverrides | undefined,
): UnifiedHookEvent["action"] {
	if (eventName === "beforeSubmitPrompt") {
		return { kind: "user_prompt", text: readString(raw.prompt) ?? "" };
	}
	if (eventName === "beforeShellExecution" || eventName === "afterShellExecution") {
		const command = readString(raw.command) ?? "";
		return {
			kind: "shell_command",
			command,
			cwd: readString(raw.cwd) ?? undefined,
			tool_class: classifyCommand(command, overrides?.command_substrings ?? []),
		};
	}
	if (eventName === "beforeReadFile") {
		return {
			kind: "file_operation",
			operation: "read",
			path: readString(raw.path) ?? readString(raw.file_path) ?? "",
			tool_class: "read",
		};
	}
	if (eventName === "beforeMCPExecution" || eventName === "afterMCPExecution") {
		const toolNameRaw = readString(raw.tool_name) ?? readString(raw.name) ?? "unknown";
		// Cursor sends tool_input as a JSON string for MCP events; parse so
		// downstream classification can inspect fields.
		let toolInput: unknown = raw.arguments ?? raw.tool_input ?? raw.args ?? {};
		if (typeof toolInput === "string") {
			try {
				toolInput = JSON.parse(toolInput);
			} catch (parseErr) {
				// Cursor passes opaque strings for some MCP servers; the
				// classifier tolerates string inputs, so we keep the raw
				// value and continue. `void parseErr` documents the swallow
				// so the harness's empty-catch rule doesn't fire.
				void parseErr;
			}
		}
		const tool_class: ToolClass = classifyFromToolName(toolNameRaw, toolInput, { overrides });
		return {
			kind: "tool_call",
			tool_name: toolNameRaw.toLowerCase(),
			tool_class,
			tool_input: toolInput,
			tool_input_redacted: toolInput,
		};
	}
	if (eventName === "afterFileEdit") {
		return {
			kind: "file_operation",
			operation: "edit",
			path: readString(raw.file_path) ?? "",
			tool_class: "modify",
		};
	}
	if (eventName === "preToolUse" || eventName === "postToolUse") {
		const toolNameRaw = readString(raw.tool_name) ?? "unknown";
		const toolInput: unknown = raw.tool_input ?? {};
		const tool_class: ToolClass = classifyFromToolName(toolNameRaw, toolInput, { overrides });
		return {
			kind: "tool_call",
			tool_name: toolNameRaw.toLowerCase(),
			tool_class,
			tool_input: toolInput,
			tool_input_redacted: toolInput,
		};
	}
	return { kind: "other", subkind: eventName, data: raw };
}

function isObject(v: unknown): v is JsonObject {
	return v != null && typeof v === "object" && !Array.isArray(v);
}

function readString(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}
