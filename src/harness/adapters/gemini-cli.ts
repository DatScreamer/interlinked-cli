// ===========================================
// Gemini CLI adapter (experimental)
// ===========================================
// Gemini CLI is pre-1.0 as of 2026-04-23. Native events observed:
//   BeforeTool, AfterTool, AfterModel, PreCompress
// Payload shape is provisional. When Gemini CLI ships 1.0 this adapter needs
// a revisit — see docs/design/cli-hook-normalization.md.

import type { JsonObject } from "../../lib/json-types.js";
import { type ClassifierOverrides, classifyFromToolName } from "../tool-class-classifier.js";
import type { ToolClass, UnifiedHookEvent, UnifiedPhase } from "../unified-event.js";
import { makeEventId } from "../unified-event.js";
import { buildHookCommand } from "./hook-command.js";
import type { AdapterOutput, RunnerAdapter, SettingsFragment } from "./types.js";

const NATIVE_EVENTS = ["BeforeTool", "AfterTool", "AfterModel", "PreCompress"] as const;

const PHASE_MAP: Record<string, UnifiedPhase> = {
	BeforeTool: "pre-tool",
	AfterTool: "post-tool",
	AfterModel: "other",
	PreCompress: "pre-compact",
};

export interface GeminiCliAdapterOptions {
	overrides?: ClassifierOverrides | undefined;
}

export function createGeminiCliAdapter(opts: GeminiCliAdapterOptions = {}): RunnerAdapter {
	return {
		id: "gemini-cli",
		label: "Gemini CLI",
		experimental: true,
		nativeEventNames: NATIVE_EVENTS,

		detectFromEnv(env) {
			return Boolean(env.GEMINI_CLI || env.GEMINI_API_KEY || env.GEMINI_CLI_VERSION);
		},

		parseHookInput(nativeJson, nativeEventName) {
			const raw = isObject(nativeJson) ? nativeJson : {};
			const phase = PHASE_MAP[nativeEventName] ?? "other";
			const session_id = readString(raw.session_id) ?? readString(raw.sessionId) ?? "unknown";
			const cwd = readString(raw.cwd) ?? process.cwd();
			const ts = new Date().toISOString();

			const action = buildGeminiAction(nativeEventName, raw, opts.overrides);

			return {
				schema_version: "1",
				event_id: makeEventId(),
				session_id,
				ts,
				runner: "gemini-cli",
				runner_native_event: nativeEventName,
				phase,
				action,
				context: { cwd },
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
			const path = scope === "user" ? "~/.gemini/settings.json" : ".gemini/settings.json";
			const hooks: Record<string, unknown[]> = {};
			for (const event of NATIVE_EVENTS) {
				const hookCommand = buildHookCommand(binaryPath, "gemini-cli", event);
				hooks[event] = [{ command: hookCommand }];
			}
			return { path, fragment: { hooks }, mergeStrategy: "array-append" };
		},

		encodeDecision(decision, _event): AdapterOutput {
			// Gemini CLI's decision protocol is provisional; match Cursor-style
			// stdout JSON until the native shape is settled.
			const stderr = (decision.warnings ?? []).join("\n");
			if (decision.decision === "block") {
				return {
					stdout: JSON.stringify({
						allow: false,
						reason:
							decision.reason ??
							"Blocked by the interlinked harness, but no reason was attached — likely a " +
								"harness bug; re-run, or run `interlinked harness restart`, then report it.",
					}),
					stderr: stderr || undefined,
					exit_code: 2,
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
			return {
				stdout: JSON.stringify({ allow: true }),
				stderr: stderr || undefined,
				exit_code: 0,
			};
		},
	};
}

function buildGeminiAction(
	eventName: string,
	raw: JsonObject,
	overrides: ClassifierOverrides | undefined,
): UnifiedHookEvent["action"] {
	if (eventName === "BeforeTool" || eventName === "AfterTool") {
		const toolNameRaw = readString(raw.tool_name) ?? readString(raw.toolName) ?? "unknown";
		const toolInput = (raw.tool_input ?? raw.toolInput ?? raw.arguments ?? {}) as unknown;
		const tool_class: ToolClass = classifyFromToolName(
			toolNameRaw,
			toolInput,
			overrides ? { overrides } : {},
		);
		const base = {
			kind: "tool_call" as const,
			tool_name: toolNameRaw.toLowerCase(),
			tool_class,
			tool_input: toolInput,
			tool_input_redacted: toolInput,
		};
		if (eventName === "AfterTool") {
			return {
				...base,
				tool_response: raw.tool_response ?? raw.response,
				tool_error: readString(raw.tool_error) ?? readString(raw.error) ?? undefined,
			};
		}
		return base;
	}
	if (eventName === "PreCompress") {
		return { kind: "other", subkind: "pre_compact", data: raw };
	}
	return { kind: "other", subkind: eventName, data: raw };
}

function isObject(v: unknown): v is JsonObject {
	return v != null && typeof v === "object" && !Array.isArray(v);
}

function readString(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}
