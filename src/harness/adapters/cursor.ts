// ===========================================
// Cursor adapter
// ===========================================
// Cursor hook events (as of 2026-04-23):
//   beforeShellExecution, afterShellExecution,
//   beforeMcpToolExecution, afterMcpToolExecution,
//   beforeSubmitPrompt, beforeReadFile
// Payload shape varies per event — see Cursor docs at implementation time.
// Decision via stdout JSON: `{ allow: bool, ask?: bool, reason?: string }`.

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
	"beforeShellExecution",
	"afterShellExecution",
	"beforeMcpToolExecution",
	"afterMcpToolExecution",
	"beforeSubmitPrompt",
	"beforeReadFile",
] as const;

const PHASE_MAP: Record<string, UnifiedPhase> = {
	beforeShellExecution: "pre-tool",
	afterShellExecution: "post-tool",
	beforeMcpToolExecution: "pre-tool",
	afterMcpToolExecution: "post-tool",
	beforeSubmitPrompt: "user-prompt",
	beforeReadFile: "pre-tool",
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
			const path = scope === "user" ? "~/.cursor/settings.json" : ".cursor/settings.json";
			const hooks: Record<string, unknown[]> = {};
			for (const event of NATIVE_EVENTS) {
				const hookCommand = buildHookCommand(binaryPath, "cursor", event);
				hooks[event] = [{ command: hookCommand }];
			}
			return { path, fragment: { hooks }, mergeStrategy: "array-append" };
		},

		encodeDecision(decision, _event): AdapterOutput {
			const stderr = (decision.warnings ?? []).join("\n");
			if (decision.decision === "block") {
				return {
					stdout: JSON.stringify({
						allow: false,
						reason: decision.reason ?? "Blocked by interlinked harness",
					}),
					stderr: stderr || undefined,
					exit_code: 0,
				};
			}
			if (decision.decision === "ask") {
				return {
					stdout: JSON.stringify({
						ask: true,
						reason: decision.reason ?? "Confirmation required",
					}),
					stderr: stderr || undefined,
					exit_code: 0,
				};
			}
			// allow
			const payload: JsonObject = { allow: true };
			if (decision.additional_context) {
				payload.additional_context = decision.additional_context;
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
	if (eventName === "beforeMcpToolExecution" || eventName === "afterMcpToolExecution") {
		const toolNameRaw = readString(raw.tool_name) ?? readString(raw.name) ?? "unknown";
		const toolInput = (raw.arguments ?? raw.tool_input ?? raw.args ?? {}) as unknown;
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
