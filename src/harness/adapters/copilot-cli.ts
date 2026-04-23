// ===========================================
// GitHub Copilot CLI adapter
// ===========================================
// Native events (camelCase): sessionStart, sessionEnd, userPromptSubmitted,
// preToolUse, postToolUse, errorOccurred. Payload shape based on Copilot CLI
// docs as of 2026-04-23. Decision protocol: stderr + exit 2 = deny; exit 0 =
// allow. "ask" semantics limited — Copilot surfaces as allow + note.

import type { JsonObject } from "../../lib/json-types.js";
import { type ClassifierOverrides, classifyFromToolName } from "../tool-class-classifier.js";
import type { ToolClass, UnifiedHookEvent, UnifiedPhase } from "../unified-event.js";
import { makeEventId } from "../unified-event.js";
import { buildHookCommand } from "./hook-command.js";
import type { AdapterOutput, RunnerAdapter, SettingsFragment } from "./types.js";

const NATIVE_EVENTS = [
	"sessionStart",
	"sessionEnd",
	"userPromptSubmitted",
	"preToolUse",
	"postToolUse",
	"errorOccurred",
] as const;

const PHASE_MAP: Record<string, UnifiedPhase> = {
	sessionStart: "session-start",
	sessionEnd: "session-end",
	userPromptSubmitted: "user-prompt",
	preToolUse: "pre-tool",
	postToolUse: "post-tool",
	errorOccurred: "error",
};

export interface CopilotCliAdapterOptions {
	overrides?: ClassifierOverrides;
}

export function createCopilotCliAdapter(opts: CopilotCliAdapterOptions = {}): RunnerAdapter {
	return {
		id: "copilot-cli",
		label: "GitHub Copilot CLI",
		nativeEventNames: NATIVE_EVENTS,

		detectFromEnv(env) {
			return Boolean(
				env.GH_COPILOT_CLI ||
					env.COPILOT_CLI ||
					env.GITHUB_COPILOT_CLI ||
					env.GH_COPILOT_VERSION,
			);
		},

		parseHookInput(nativeJson, nativeEventName) {
			const raw = isObject(nativeJson) ? nativeJson : {};
			const phase = PHASE_MAP[nativeEventName] ?? "other";
			const session_id = readString(raw.sessionId) ?? readString(raw.session_id) ?? "unknown";
			const cwd = readString(raw.cwd) ?? process.cwd();
			const ts = new Date().toISOString();

			const action = buildCopilotAction(nativeEventName, raw, opts.overrides);

			return {
				schema_version: "1",
				event_id: makeEventId(),
				session_id,
				ts,
				runner: "copilot-cli",
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

		renderSettingsFragment(binaryPath, _scope): SettingsFragment {
			const hooks: Record<string, unknown[]> = {};
			for (const event of NATIVE_EVENTS) {
				const hookCommand = buildHookCommand(binaryPath, "copilot-cli", event);
				hooks[event] = [{ type: "command", bash: hookCommand }];
			}
			return {
				path: ".github/hooks/hooks.json",
				fragment: { version: 1, hooks },
				mergeStrategy: "array-append",
			};
		},

		encodeDecision(decision, _event): AdapterOutput {
			const stderr = (decision.warnings ?? []).join("\n");
			if (decision.decision === "block") {
				const reason = decision.reason ?? "Blocked by interlinked harness";
				return { stderr: stderr ? `${stderr}\n${reason}` : reason, exit_code: 2 };
			}
			if (decision.decision === "ask") {
				// Copilot has limited ask semantics — surface as allow + note on stderr.
				const note = decision.reason ?? "Confirmation recommended";
				return { stderr: stderr ? `${stderr}\n${note}` : note, exit_code: 0 };
			}
			// allow
			let out = stderr;
			if (decision.additional_context) {
				out = out ? `${out}\n${decision.additional_context}` : decision.additional_context;
			}
			return { stderr: out || undefined, exit_code: 0 };
		},
	};
}

function buildCopilotAction(
	eventName: string,
	raw: JsonObject,
	overrides: ClassifierOverrides | undefined,
): UnifiedHookEvent["action"] {
	if (eventName === "userPromptSubmitted") {
		const text = readString(raw.prompt) ?? readString(raw.userPrompt) ?? "";
		return { kind: "user_prompt", text };
	}
	if (eventName === "sessionStart" || eventName === "sessionEnd") {
		return {
			kind: "session_lifecycle",
			event: eventName === "sessionStart" ? "start" : "end",
		};
	}
	if (eventName === "preToolUse" || eventName === "postToolUse") {
		const toolNameRaw = readString(raw.toolName) ?? readString(raw.tool_name) ?? "unknown";
		const toolInput = (raw.toolInput ?? raw.tool_input ?? {}) as unknown;
		const tool_class: ToolClass = classifyFromToolName(toolNameRaw, toolInput, { overrides });
		const base = {
			kind: "tool_call" as const,
			tool_name: toolNameRaw.toLowerCase(),
			tool_class,
			tool_input: toolInput,
			tool_input_redacted: toolInput,
		};
		if (eventName === "postToolUse") {
			return {
				...base,
				tool_response: raw.toolResponse ?? raw.tool_response,
				tool_error: readString(raw.toolError) ?? readString(raw.tool_error) ?? undefined,
			};
		}
		return base;
	}
	if (eventName === "errorOccurred") {
		return { kind: "other", subkind: "error", data: raw };
	}
	return { kind: "other", subkind: eventName, data: raw };
}

function isObject(v: unknown): v is JsonObject {
	return v != null && typeof v === "object" && !Array.isArray(v);
}

function readString(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}
