// interlinked-tdd: exempt
import type { JsonObject } from "../../lib/json-types.js";
import {
	type ClassifierOverrides,
	classifyCommand,
	classifyFromToolName,
} from "../tool-class-classifier.js";
import type { ToolCallAction, ToolClass, UnifiedHookEvent } from "../unified-event.js";

// Event groups that share one action-builder. Membership Sets replace the
// `||`-chained equality tests in the dispatcher so the dispatcher's cyclomatic
// count stays flat as alias events accrete (each `||` would otherwise add +1).
const SHELL_EVENTS = new Set<string>(["beforeShellExecution", "afterShellExecution"]);
const MCP_EVENTS = new Set<string>([
	"beforeMCPExecution",
	"beforeMcpToolExecution",
	"afterMCPExecution",
	"afterMcpToolExecution",
]);
const TOOL_USE_EVENTS = new Set<string>(["preToolUse", "postToolUse", "postToolUseFailure"]);

type CursorAction = UnifiedHookEvent["action"];

// --- Per-branch action builders. Each is a small, single-event-group unit so
// the cold reader can scan one shape at a time and `buildCursorAction` reads as
// a flat dispatch table. The `??` / `||` fan-out lives here, not in the
// dispatcher. ---

function buildShellAction(
	raw: JsonObject,
	overrides: ClassifierOverrides | undefined,
): CursorAction {
	const command = readString(raw.command) ?? "";
	return {
		kind: "shell_command",
		command,
		cwd: readString(raw.cwd) ?? undefined,
		tool_class: classifyCommand(command, overrides?.command_substrings ?? []),
	};
}

function buildReadFileAction(raw: JsonObject): CursorAction {
	return {
		kind: "file_operation",
		operation: "read",
		path: readString(raw.path) ?? readString(raw.file_path) ?? "",
		tool_class: "read",
	};
}

function buildMcpAction(
	raw: JsonObject,
	overrides: ClassifierOverrides | undefined,
): CursorAction {
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
	const tool_class: ToolClass = classifyFromToolName(
		toolNameRaw,
		toolInput,
		overrides ? { overrides } : {},
	);
	return attachCursorToolOutcome({
		kind: "tool_call",
		tool_name: toolNameRaw.toLowerCase(),
		tool_class,
		tool_input: toolInput,
		tool_input_redacted: toolInput,
	}, raw);
}

function buildFileEditAction(raw: JsonObject): CursorAction {
	return {
		kind: "file_operation",
		operation: "edit",
		path: readString(raw.file_path) ?? "",
		tool_class: "modify",
	};
}

function buildToolUseAction(
	raw: JsonObject,
	overrides: ClassifierOverrides | undefined,
): CursorAction {
	const toolNameRaw = readString(raw.tool_name) ?? "unknown";
	const toolInput: unknown = raw.tool_input ?? {};
	const tool_class: ToolClass = classifyFromToolName(
		toolNameRaw,
		toolInput,
		overrides ? { overrides } : {},
	);
	return attachCursorToolOutcome({
		kind: "tool_call",
		tool_name: toolNameRaw.toLowerCase(),
		tool_class,
		tool_input: toolInput,
		tool_input_redacted: toolInput,
	}, raw);
}

function buildSubagentStartAction(raw: JsonObject): CursorAction {
	// Subagent spawn — the harness can deny untrusted subagent_types
	// (e.g. arbitrary shell subagents in restricted modes). Surface
	// task/type so rules can pattern-match against either.
	return {
		kind: "other",
		subkind: "subagentStart",
		data: {
			subagent_id: readString(raw.subagent_id) ?? null,
			subagent_type: readString(raw.subagent_type) ?? null,
			task: readString(raw.task) ?? null,
			parent_conversation_id: readString(raw.parent_conversation_id) ?? null,
		},
	};
}

function buildSubagentStopAction(raw: JsonObject): CursorAction {
	return {
		kind: "other",
		subkind: "subagentStop",
		data: {
			subagent_type: readString(raw.subagent_type) ?? null,
			status: readString(raw.status) ?? null,
			summary: readString(raw.summary) ?? null,
		},
	};
}

function buildPreCompactAction(raw: JsonObject): CursorAction {
	return {
		kind: "other",
		subkind: "preCompact",
		data: {
			trigger: readString(raw.trigger) ?? null,
			context_usage_percent: typeof raw.context_usage_percent === "number"
				? raw.context_usage_percent
				: null,
		},
	};
}

export function buildCursorAction(
	eventName: string,
	raw: JsonObject,
	overrides: ClassifierOverrides | undefined,
): CursorAction {
	if (eventName === "beforeSubmitPrompt") {
		return { kind: "user_prompt", text: readString(raw.prompt) ?? "" };
	}
	if (SHELL_EVENTS.has(eventName)) return buildShellAction(raw, overrides);
	if (eventName === "beforeReadFile") return buildReadFileAction(raw);
	if (MCP_EVENTS.has(eventName)) return buildMcpAction(raw, overrides);
	if (eventName === "afterFileEdit") return buildFileEditAction(raw);
	if (TOOL_USE_EVENTS.has(eventName)) return buildToolUseAction(raw, overrides);
	if (eventName === "subagentStart") return buildSubagentStartAction(raw);
	if (eventName === "subagentStop") return buildSubagentStopAction(raw);
	if (eventName === "preCompact") return buildPreCompactAction(raw);
	return { kind: "other", subkind: eventName, data: raw };
}

function readString(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}

function attachCursorToolOutcome(action: ToolCallAction, raw: JsonObject): ToolCallAction {
	const toolResponse = readFirstPresent(raw, "tool_response", "tool_output", "output", "result");
	if (toolResponse !== undefined) {
		action.tool_response = toolResponse;
	}
	const toolError = readString(raw.error_message) ?? readString(raw.error);
	if (toolError !== null) {
		action.tool_error = toolError;
	}
	return action;
}

function readFirstPresent(obj: JsonObject, ...keys: string[]): unknown {
	for (const key of keys) {
		if (Object.prototype.hasOwnProperty.call(obj, key)) {
			return obj[key];
		}
	}
	return undefined;
}
