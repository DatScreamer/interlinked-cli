// ===========================================
// OpenAI Codex CLI adapter (experimental)
// ===========================================
// Codex CLI native event shape is provisional as of 2026-04-23. This adapter
// uses a best-guess payload layout and normalizes to UnifiedHookEvent. Revisit
// when Codex CLI stabilizes its hook contract.

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
	"pre_tool",
	"post_tool",
	"pre_command",
	"post_command",
	"session_start",
	"session_end",
	"user_prompt",
] as const;

const PHASE_MAP: Record<string, UnifiedPhase> = {
	pre_tool: "pre-tool",
	post_tool: "post-tool",
	pre_command: "pre-tool",
	post_command: "post-tool",
	session_start: "session-start",
	session_end: "session-end",
	user_prompt: "user-prompt",
};

export interface CodexAdapterOptions {
	overrides?: ClassifierOverrides;
}

export function createCodexAdapter(opts: CodexAdapterOptions = {}): RunnerAdapter {
	return {
		id: "codex",
		label: "OpenAI Codex CLI",
		experimental: true,
		nativeEventNames: NATIVE_EVENTS,

		detectFromEnv(env) {
			return Boolean(
				env.CODEX_CLI || env.OPENAI_CODEX_CLI || env.CODEX_SESSION_ID || env.CODEX_VERSION,
			);
		},

		parseHookInput(nativeJson, nativeEventName) {
			const raw = isObject(nativeJson) ? nativeJson : {};
			const phase = PHASE_MAP[nativeEventName] ?? "other";
			const session_id = readString(raw.session_id) ?? "unknown";
			const cwd = readString(raw.cwd) ?? process.cwd();
			const ts = new Date().toISOString();

			const action = buildCodexAction(nativeEventName, raw, opts.overrides);

			return {
				schema_version: "1",
				event_id: makeEventId(),
				session_id,
				ts,
				runner: "codex",
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
			const path = scope === "user" ? "~/.codex/config.json" : ".codex/config.json";
			const hooks: Record<string, unknown[]> = {};
			for (const event of NATIVE_EVENTS) {
				const hookCommand = buildHookCommand(binaryPath, "codex", event);
				hooks[event] = [{ command: hookCommand }];
			}
			return { path, fragment: { hooks }, mergeStrategy: "array-append" };
		},

		encodeDecision(decision, _event): AdapterOutput {
			// Codex decision protocol TBD; use exit codes + stderr as a
			// conservative universal contract. Deny → exit 2; ask → exit 1
			// with reason on stderr; allow → exit 0.
			const stderr = (decision.warnings ?? []).join("\n");
			if (decision.decision === "block") {
				const reason = decision.reason ?? "Blocked by interlinked harness";
				return { stderr: stderr ? `${stderr}\n${reason}` : reason, exit_code: 2 };
			}
			if (decision.decision === "ask") {
				const note = decision.reason ?? "Confirmation required";
				return { stderr: stderr ? `${stderr}\n${note}` : note, exit_code: 1 };
			}
			let out = stderr;
			if (decision.additional_context) {
				out = out ? `${out}\n${decision.additional_context}` : decision.additional_context;
			}
			return { stderr: out || undefined, exit_code: 0 };
		},
	};
}

function buildCodexAction(
	eventName: string,
	raw: JsonObject,
	overrides: ClassifierOverrides | undefined,
): UnifiedHookEvent["action"] {
	if (eventName === "user_prompt") {
		return { kind: "user_prompt", text: readString(raw.prompt) ?? "" };
	}
	if (eventName === "session_start" || eventName === "session_end") {
		return {
			kind: "session_lifecycle",
			event: eventName === "session_start" ? "start" : "end",
		};
	}
	if (eventName === "pre_command" || eventName === "post_command") {
		const command = readString(raw.command) ?? "";
		return {
			kind: "shell_command",
			command,
			cwd: readString(raw.cwd) ?? undefined,
			tool_class: classifyCommand(command, overrides?.command_substrings ?? []),
		};
	}
	if (eventName === "pre_tool" || eventName === "post_tool") {
		const toolNameRaw = readString(raw.tool_name) ?? readString(raw.name) ?? "unknown";
		const toolInput = (raw.arguments ?? raw.tool_input ?? {}) as unknown;
		const tool_class: ToolClass = classifyFromToolName(toolNameRaw, toolInput, { overrides });
		const base = {
			kind: "tool_call" as const,
			tool_name: toolNameRaw.toLowerCase(),
			tool_class,
			tool_input: toolInput,
			tool_input_redacted: toolInput,
		};
		if (eventName === "post_tool") {
			return {
				...base,
				tool_response: raw.result ?? raw.response,
				tool_error: readString(raw.error) ?? undefined,
			};
		}
		return base;
	}
	return { kind: "other", subkind: eventName, data: raw };
}

function isObject(v: unknown): v is JsonObject {
	return v != null && typeof v === "object" && !Array.isArray(v);
}

function readString(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}
