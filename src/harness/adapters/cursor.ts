// ===========================================
// Cursor adapter
// ===========================================
// Cursor hook events (per https://cursor.com/docs/hooks, as of 2026-04):
//   sessionStart, sessionEnd, stop, preCompact,
//   beforeSubmitPrompt,
//   preToolUse, postToolUse, postToolUseFailure,
//   subagentStart, subagentStop,
//   beforeShellExecution, afterShellExecution,
//   beforeMCPExecution (also seen as beforeMcpToolExecution / afterMcpToolExecution
//   in some builds — kept as defence-in-depth aliases), afterMCPExecution,
//   beforeReadFile, afterFileEdit
//
// Payload shape varies per event — adapter is tolerant of unknown fields.
//
// Response field names are SNAKE_CASE (per Cursor docs):
//   { permission: "allow"|"deny"|"ask",
//     user_message?, agent_message?, updated_input?,
//     additional_context?, updated_mcp_tool_output?, followup_message? }
//
// Per-event capability map (the docs differ by event):
//   - beforeShellExecution / beforeMCPExecution: allow|deny|ask + user/agent_message
//   - preToolUse: allow|deny only (ask accepted by schema, not enforced)
//   - beforeReadFile: allow|deny + user_message
//   - subagentStart: allow|deny + user_message (ask treated as deny)
//   - postToolUse: additional_context (model-visible PostToolUse channel —
//                  this is the parity hook with Claude Code's additionalContext)
//   - subagentStop: followup_message (auto-continue prompt)
//   - preCompact: user_message (observation only)
//   - postToolUseFailure / afterFileEdit / afterShellExecution / afterMCPExecution:
//                  no enforced output; we surface reasons via stderr (human-only)
//
// Cursor SUPPORTS "ask" as a first-class primitive on the shell/MCP gates —
// when our harness returns `decision: "ask"`, we map to `permission: "ask"`
// so the user sees an interactive prompt rather than a blanket deny. On
// gates that don't enforce ask (preToolUse / beforeReadFile / subagentStart),
// we collapse to `permission: "deny"` so the user still sees the reason and
// can refine.

import type { JsonObject } from "../../lib/json-types.js";
import { formatAskReasonWithTargets } from "../evaluator/rule-matching.js";
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
	"preCompact",
	"beforeSubmitPrompt",
	"beforeShellExecution",
	"afterShellExecution",
	"beforeMCPExecution",
	"beforeMcpToolExecution",
	"afterMCPExecution",
	"afterMcpToolExecution",
	"beforeReadFile",
	"afterFileEdit",
	"preToolUse",
	"postToolUse",
	"postToolUseFailure",
	"subagentStart",
	"subagentStop",
] as const;

// Events that are gated (we can return permission: allow|deny). These are
// `failClosed: true` in the settings fragment.
const GATED_EVENTS = new Set<string>([
	"beforeShellExecution",
	"beforeMCPExecution",
	"beforeMcpToolExecution",
	"beforeReadFile",
	"preToolUse",
	"subagentStart",
]);

// Subset of GATED_EVENTS where Cursor actually honors `permission: "ask"`.
// Per Cursor docs (2026-04): the schema accepts ask everywhere but only
// shell/MCP gates enforce it. preToolUse, beforeReadFile, subagentStart
// silently degrade — we collapse `decision: "ask"` to deny on those so the
// user still sees the reason instead of the action proceeding unguarded.
const ASK_CAPABLE_EVENTS = new Set<string>([
	"beforeShellExecution",
	"beforeMCPExecution",
	"beforeMcpToolExecution",
]);

// Post-tool events whose output supports `additional_context` — model-visible
// feedback channel (Cursor's analogue of Claude's `additionalContext`). Only
// the generic `postToolUse` carries it per the docs; specific after* hooks
// are observation-only.
const POST_CONTEXT_EVENTS = new Set<string>(["postToolUse"]);

const PHASE_MAP: Record<string, UnifiedPhase> = {
	sessionStart: "other",
	sessionEnd: "other",
	stop: "other",
	preCompact: "other",
	beforeSubmitPrompt: "user-prompt",
	beforeShellExecution: "pre-tool",
	afterShellExecution: "post-tool",
	beforeMCPExecution: "pre-tool",
	beforeMcpToolExecution: "pre-tool",
	afterMCPExecution: "post-tool",
	afterMcpToolExecution: "post-tool",
	beforeReadFile: "pre-tool",
	afterFileEdit: "post-tool",
	preToolUse: "pre-tool",
	postToolUse: "post-tool",
	postToolUseFailure: "post-tool",
	subagentStart: "pre-tool",
	subagentStop: "other",
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
			return encodeCursorDecision(decision, event.runner_native_event);
		},
	};
}

// ---------------------------------------------------------------------------
// Decision encoding — split out so the registry's `encodeDecision` is one
// line. Each decision branch has its own helper so the cold reader can scan
// "block / ask / allow" without holding the entire dispatch in their head.
// ---------------------------------------------------------------------------

const BLOCK_DECISION = "block";
const ASK_DECISION = "ask";
const DEFAULT_BLOCK_REASON = "Blocked by interlinked harness";
const DEFAULT_ASK_REASON = "Confirmation required";

function encodeCursorDecision(
	decision: import("../types.js").HarnessDecision,
	nativeEvent: string,
): AdapterOutput {
	const stderr = joinWarnings(decision.warnings);
	const isGated = GATED_EVENTS.has(nativeEvent);
	const askCapable = ASK_CAPABLE_EVENTS.has(nativeEvent);
	const postContextCapable = POST_CONTEXT_EVENTS.has(nativeEvent);

	if (decision.decision === BLOCK_DECISION) {
		return encodeCursorBlock(decision, { isGated, postContextCapable, stderr });
	}
	if (decision.decision === ASK_DECISION) {
		return encodeCursorAsk(decision, { isGated, askCapable, stderr });
	}
	return encodeCursorAllow(decision, { isGated, postContextCapable, stderr });
}

interface EncodeContext {
	isGated: boolean;
	askCapable?: boolean;
	postContextCapable?: boolean;
	stderr: string;
}

// `decision: "block"` — render as deny on a pre gate; route advisory feedback
// through `additional_context` on `postToolUse`; everything else falls
// through to stderr (human-only, model-blind).
function encodeCursorBlock(
	decision: import("../types.js").HarnessDecision,
	ctx: EncodeContext,
): AdapterOutput {
	if (ctx.isGated) {
		const reason = decision.reason ?? DEFAULT_BLOCK_REASON;
		return jsonOut(
			{ permission: "deny", agent_message: reason, user_message: reason },
			ctx.stderr,
		);
	}
	if (ctx.postContextCapable && decision.reason) {
		// Cursor's postToolUse can't roll back an executed tool, but
		// `additional_context` is the model-visible feedback channel —
		// same idea as Claude's PostToolUse `additionalContext`.
		return jsonOut({ additional_context: decision.reason }, ctx.stderr);
	}
	return stderrOut(decision.reason || ctx.stderr || undefined);
}

// `decision: "ask"` — only honored on shell + MCP gates per Cursor docs;
// elsewhere we collapse to deny so the user still sees the reason.
function encodeCursorAsk(
	decision: import("../types.js").HarnessDecision,
	ctx: EncodeContext,
): AdapterOutput {
	// Pre-append resolved targets to BOTH the agent-facing `reason` and the
	// user-facing message so the human sees the concrete file/URL/branch in
	// the prompt body. On the deny-fallback path (preToolUse / beforeReadFile
	// / subagentStart) the same enriched reason still surfaces — the user
	// hits a deny dialog with the targets attached.
	const baseReason = decision.reason ?? DEFAULT_ASK_REASON;
	const reasonWithTargets = formatAskReasonWithTargets(baseReason, decision.resolved_targets);
	const baseUserMsg = decision.system_message || decision.reason || DEFAULT_ASK_REASON;
	const userMsgWithTargets = formatAskReasonWithTargets(baseUserMsg, decision.resolved_targets);

	if (!ctx.isGated) {
		return stderrOut(reasonWithTargets || ctx.stderr || undefined);
	}
	if (ctx.askCapable) {
		return jsonOut(
			{
				permission: ASK_DECISION,
				agent_message: reasonWithTargets,
				user_message: userMsgWithTargets,
			},
			ctx.stderr,
		);
	}
	// Gated but ask-incapable (preToolUse / beforeReadFile / subagentStart).
	// Per docs Cursor accepts `ask` in the schema but does NOT enforce it on
	// these events — silently treats it as allow on preToolUse, deny on
	// subagentStart. Collapsing to deny is the safer and more consistent UX.
	return jsonOut(
		{
			permission: "deny",
			agent_message: reasonWithTargets,
			user_message: userMsgWithTargets,
		},
		ctx.stderr,
	);
}

// `decision: "allow"` — emit `permission: "allow"` on pre gates so Cursor
// proceeds; on `postToolUse` use `additional_context` for advisory model
// signal (parity with Claude's PostToolUse additionalContext channel).
function encodeCursorAllow(
	decision: import("../types.js").HarnessDecision,
	ctx: EncodeContext,
): AdapterOutput {
	if (ctx.postContextCapable && decision.additional_context) {
		return jsonOut({ additional_context: decision.additional_context }, ctx.stderr);
	}
	if (!ctx.isGated) {
		return stderrOut(ctx.stderr || undefined);
	}
	const payload: JsonObject = { permission: "allow" };
	if (decision.additional_context) {
		// Pre-event: Cursor doesn't have an additionalContext channel on
		// allow, but `agent_message` is a documented field. Use it as a
		// best-effort surface for non-blocking advisory text.
		payload.agent_message = decision.additional_context;
	}
	return jsonOut(payload, ctx.stderr);
}

function jsonOut(payload: JsonObject, stderr: string): AdapterOutput {
	return {
		stdout: JSON.stringify(payload),
		stderr: stderr || undefined,
		exit_code: 0,
	};
}

function stderrOut(stderr: string | undefined): AdapterOutput {
	return { stdout: undefined, stderr, exit_code: 0 };
}

function joinWarnings(warnings: string[] | undefined): string {
	return (warnings ?? []).join("\n");
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
	if (
		eventName === "beforeMCPExecution" ||
		eventName === "beforeMcpToolExecution" ||
		eventName === "afterMCPExecution" ||
		eventName === "afterMcpToolExecution"
	) {
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
	if (
		eventName === "preToolUse" ||
		eventName === "postToolUse" ||
		eventName === "postToolUseFailure"
	) {
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
	if (eventName === "subagentStart") {
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
	if (eventName === "subagentStop") {
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
	if (eventName === "preCompact") {
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
	return { kind: "other", subkind: eventName, data: raw };
}

function isObject(v: unknown): v is JsonObject {
	return v != null && typeof v === "object" && !Array.isArray(v);
}

function readString(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}
