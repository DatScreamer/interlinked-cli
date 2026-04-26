// Extracted from hooks-template.ts.
// This is DATA — the body of the generated `.interlinked/hooks/interlinked-activity.mjs`.
// Do not edit escape sequences (`\\s`, `\\n`, `\\*`, etc.) — they are the source form
// for the runtime script. `\\s` in this file becomes `\s` in the emitted .mjs.
//
// ===========================================
// Hook Event Normalization Layer
// ===========================================
// Each AI coding client emits a different hook payload shape. The .mjs
// script holds a per-client `normalizeXxxEvent(input)` function that maps
// the raw payload to a single canonical event record:
//
//   {
//     event_type: "session_start" | "tool_use_start" | "tool_use" | ...
//     tool_name: string | null
//     tool_input_summary: string | null
//     hook_event: <original native event name, preserved verbatim>
//     ...event-specific fields (tool_input, tokens, prompt, etc.)
//     ...envelope fields (cwd, transcript_path, session_id_hint)
//   }
//
// The downstream pipeline (local JSONL append, harness forwarding, server
// POST) speaks ONLY this canonical shape — adding a new client means
// authoring exactly one normalizer and a detector entry in CLIENT_HANDLERS.
//
// Per-client status:
//   - Claude Code:  PascalCase events, full 14-event vocabulary
//   - Codex CLI:    PascalCase events, Claude-compatible payloads, 6 events
//                   (delegates to normalizeClaudeEvent, tagged client_runner)
//   - Gemini CLI:   PascalCase BeforeTool/AfterTool variant
//   - Copilot CLI:  camelCase, no `hook_event_name`, shape inferred from payload
//
// Each per-client normalizer dispatches through a lookup table keyed on
// the native event name, so adding/removing an event is a one-line change
// rather than a switch-statement edit.

/** Public API — consumed by buildHookScript in hooks-template.ts. */
export const EVENT_NORMALIZERS_CHUNK = `// --- Client Normalizers ---

// Fields present on every Claude Code hook invocation: cwd + transcript_path
// + session_id. Pulling them once at the top of the normalizer means every
// event carries the agent's working directory and transcript pointer.
function envelopeFieldsClaude(input) {
    return {
        cwd: input.cwd || null,
        transcript_path: input.transcript_path || null,
        session_id_hint: input.session_id || null,
    };
}

// Classify a PostToolUseFailure so downstream tooling can group errors
// without re-parsing free-text. Heuristic; errs toward "tool_error".
function categorizeToolError(input) {
    if (input.is_interrupt) return "user_interrupt";
    const raw = String(input.error || input.tool_error || input.message || "").toLowerCase();
    if (!raw) return "unknown";
    if (raw.includes("timed out") || raw.includes("timeout")) return "timeout";
    if (raw.includes("permission") || raw.includes("denied") || raw.includes("not allowed")) return "permission";
    if (raw.includes("blocked") || raw.includes("guard")) return "blocked";
    if (raw.includes("not found") || raw.includes("enoent")) return "not_found";
    if (raw.includes("abort") || raw.includes("cancel")) return "aborted";
    return "tool_error";
}

// Step 1b — lines-of-code delta per edit. Computed from the tool_input alone
// (no filesystem I/O), so it's essentially free on every PostToolUse.
// Returns null for tools that aren't file edits — callers skip attaching
// the fields in that case.
function computeLocDelta(toolName, toolInput) {
    if (!toolInput) return null;
    const nl = (s) => (typeof s === "string" ? (s.match(/\\n/g) || []).length : 0);
    if (toolName === "Edit" || toolName === "str_replace" || toolName === "apply_patch") {
        return { added: nl(toolInput.new_string), removed: nl(toolInput.old_string) };
    }
    if (toolName === "Write" || toolName === "create_file") {
        // No baseline for Write — report as all-added.
        return { added: nl(toolInput.content), removed: 0 };
    }
    if (toolName === "MultiEdit" && Array.isArray(toolInput.edits)) {
        let added = 0, removed = 0;
        for (const e of toolInput.edits) {
            added += nl(e.new_string);
            removed += nl(e.old_string);
        }
        return { added, removed };
    }
    if (toolName === "NotebookEdit") {
        // Rough proxy — notebook cells aren't line-based, count content lines.
        return { added: nl(toolInput.new_source), removed: nl(toolInput.old_source) };
    }
    return null;
}

// Step 1b — sniff whether a Write created a new file vs updated an existing
// one. Claude Code emits distinct response strings: "File created successfully"
// for creates, "has been updated" for updates. For Edit/MultiEdit we always
// return false (can't edit what doesn't exist).
function sniffIsNewFile(toolName, toolResponse) {
    if (toolName !== "Write" && toolName !== "create_file") return false;
    if (!toolResponse) return false;
    const text = typeof toolResponse === "string" ? toolResponse : JSON.stringify(toolResponse);
    if (/file created successfully/i.test(text)) return true;
    if (/has been updated/i.test(text)) return false;
    return false;
}

// Attach loc + is_new_file + is_test_file onto a PostToolUse result object
// when the event is a file-editing tool. Helper so the switch cases stay
// narrow. Mutates and returns the passed object.
function attachEditMetrics(result, toolName, toolInput, toolResponse) {
    const loc = computeLocDelta(toolName, toolInput);
    if (loc) {
        result.lines_added = loc.added;
        result.lines_removed = loc.removed;
        result.net_loc_delta = loc.added - loc.removed;
    }
    result.is_new_file = sniffIsNewFile(toolName, toolResponse);
    const fp = toolInput && (toolInput.file_path || toolInput.path || toolInput.target_file);
    if (typeof fp === "string") {
        result.is_test_file = /(?:^|[\\/.])(?:__tests?__|tests?|spec)(?:[\\/.]|$)|\\.(?:test|spec)\\./i.test(fp);
    }
    return result;
}

// Pull token usage out of a Claude / Codex Stop or SubagentStop event.
// Either input.usage or input.token_usage is set. Returns null if no
// recognised fields are present so callers can skip the property.
function extractClaudeTokens(input) {
    const u = input.usage || input.token_usage;
    if (!u) return null;
    const tokens = {};
    if (u.input_tokens) tokens.input = u.input_tokens;
    if (u.output_tokens) tokens.output = u.output_tokens;
    if (u.cache_read_input_tokens) tokens.cache_read = u.cache_read_input_tokens;
    if (u.cache_creation_input_tokens) tokens.cache_creation = u.cache_creation_input_tokens;
    if (u.thinking_tokens || u.reasoning_tokens) tokens.thinking = u.thinking_tokens || u.reasoning_tokens;
    return Object.keys(tokens).length > 0 ? tokens : null;
}

// Build the per-event context once so each handler can pluck the fields it
// needs without re-running the same input parsing. \`tokens\` and \`duration_ms\`
// are pre-computed because half the handlers need them.
function buildClaudeContext(input) {
    return {
        input,
        env: envelopeFieldsClaude(input),
        tokens: extractClaudeTokens(input),
        duration_ms: input.duration_ms || input.durationMs || null,
    };
}

// Per-event handlers. Each takes the shared context and returns the
// canonical event record. Adding a new Claude / Codex event = add one
// handler + one entry in CLAUDE_DISPATCH below.
const CLAUDE_DISPATCH = {
    SessionStart: ({ input, env }) => ({
        event_type: "session_start", tool_name: null, tool_input_summary: null,
        hook_event: "SessionStart",
        source: input.source || null, model: input.model || null, agent_type: input.agent_type || null,
        cli_version: input.cli_version || input.claude_code_version || null,
        available_tools_count: Array.isArray(input.available_tools) ? input.available_tools.length : null,
        ...env,
    }),
    SessionEnd: ({ input, env, tokens, duration_ms }) => ({
        event_type: "session_end", tool_name: null, tool_input_summary: null,
        hook_event: "SessionEnd", tokens,
        reason: input.reason || null, duration_ms, ...env,
    }),
    Stop: ({ input, env, tokens }) => ({
        event_type: "agent_stop", tool_name: null, tool_input_summary: null,
        hook_event: "Stop", tokens,
        stop_hook_active: input.stop_hook_active || false,
        stop_reason: input.stop_reason || null,
        last_assistant_message: input.last_assistant_message || null,
        ...env,
    }),
    UserPromptSubmit: ({ input, env }) => {
        const prompt = input.prompt || input.user_prompt || "";
        return {
            event_type: "user_prompt", tool_name: null, tool_input_summary: truncate(prompt, 200),
            hook_event: "UserPromptSubmit",
            prompt: prompt || null,
            prompt_chars: prompt ? prompt.length : 0,
            ...env,
        };
    },
    PreToolUse: ({ input, env }) => {
        const toolInput = input.tool_input || {};
        return {
            event_type: "tool_use_start", tool_name: input.tool_name || null,
            tool_input_summary: summarize(input.tool_name, toolInput),
            hook_event: "PreToolUse",
            tool_input: toolInput, tool_use_id: input.tool_use_id || null,
            tool_input_bytes: Buffer.byteLength(JSON.stringify(toolInput)),
            ...env,
        };
    },
    PostToolUse: ({ input, env, duration_ms }) => {
        const toolName = input.tool_name || null;
        const toolInput = input.tool_input || {};
        const toolResponse = input.tool_response || null;
        const toolResponseBytes = toolResponse === null ? 0
            : typeof toolResponse === "string" ? Buffer.byteLength(toolResponse)
            : Buffer.byteLength(JSON.stringify(toolResponse));
        const result = {
            event_type: "tool_use", tool_name: toolName, tool_input_summary: summarize(toolName, toolInput),
            hook_event: "PostToolUse", duration_ms,
            tool_input: toolInput, tool_response: toolResponse, tool_use_id: input.tool_use_id || null,
            tool_output_bytes: toolResponseBytes,
            status: "success",
            ...env,
        };
        const filePath = extractFilePath(toolName, toolInput);
        if (filePath) result.files_modified = [filePath];
        return attachEditMetrics(result, toolName, toolInput, toolResponse);
    },
    PostToolUseFailure: ({ input, env }) => {
        const failToolName = input.tool_name || null;
        const failInput = input.tool_input || {};
        const errorDetail = input.error || input.tool_error || input.message || null;
        const summary = errorDetail
            ? truncate(String(errorDetail), 200)
            : summarize(failToolName, failInput);
        return {
            event_type: "tool_use_error", tool_name: failToolName, tool_input_summary: summary,
            hook_event: "PostToolUseFailure",
            tool_input: failInput, error: errorDetail, is_interrupt: input.is_interrupt || false,
            tool_use_id: input.tool_use_id || null,
            error_category: categorizeToolError(input),
            status: "error",
            ...env,
        };
    },
    SubagentStart: ({ input, env }) => ({
        event_type: "subagent_start", tool_name: input.agent_type || null,
        tool_input_summary: null, hook_event: "SubagentStart",
        parent_agent: input.parent_agent_name || null, subagent_id: input.agent_id || null,
        agent_type: input.agent_type || null,
        agent_transcript_path: input.agent_transcript_path || null,
        ...env,
    }),
    SubagentStop: ({ input, env, tokens, duration_ms }) => ({
        event_type: "subagent_stop", tool_name: input.agent_type || null,
        tool_input_summary: null, hook_event: "SubagentStop",
        parent_agent: input.parent_agent_name || null, subagent_id: input.agent_id || null,
        tokens, agent_type: input.agent_type || null,
        agent_transcript_path: input.agent_transcript_path || null,
        last_assistant_message: input.last_assistant_message || null,
        duration_ms,
        ...env,
    }),
    Notification: ({ input, env }) => ({
        event_type: "notification", tool_name: null,
        tool_input_summary: truncate(input.message || "", 200),
        hook_event: "Notification",
        notification_type: input.notification_type || null,
        notification_title: input.title || null,
        notification_message: input.message || null,
        ...env,
    }),
    PreCompact: ({ input, env }) => ({
        event_type: "context_compact", tool_name: null, tool_input_summary: null,
        hook_event: "PreCompact",
        trigger: input.trigger || null, custom_instructions: input.custom_instructions || null,
        context_size_hint: input.context_size || input.token_count || null,
        ...env,
    }),
    TaskCompleted: ({ input, env }) => ({
        event_type: "task_completed", tool_name: null,
        tool_input_summary: truncate(input.task_subject || input.task_id || "", 200),
        hook_event: "TaskCompleted",
        task_id: input.task_id || null, task_subject: input.task_subject || null,
        task_description: input.task_description || null,
        teammate_name: input.teammate_name || null, team_name: input.team_name || null,
        ...env,
    }),
    TeammateIdle: ({ input, env }) => ({
        event_type: "teammate_idle", tool_name: input.teammate_name || null,
        tool_input_summary: null, hook_event: "TeammateIdle",
        teammate_name: input.teammate_name || null, team_name: input.team_name || null,
        ...env,
    }),
    PermissionRequest: ({ input, env }) => {
        const permToolName = input.tool_name || null;
        const permToolInput = input.tool_input || {};
        return {
            event_type: "permission_request", tool_name: permToolName,
            tool_input_summary: summarize(permToolName, permToolInput),
            hook_event: "PermissionRequest",
            tool_input: permToolInput,
            permission_suggestions: input.permission_suggestions || null,
            permission_mode: input.permission_mode || null,
            ...env,
        };
    },
};

function normalizeClaudeUnknown(hookEvent, ctx) {
    const { input, env } = ctx;
    return {
        event_type: hookEvent ? hookEvent.toLowerCase() : "unknown",
        tool_name: input.tool_name || null,
        tool_input_summary: summarize(input.tool_name, input.tool_input || {}),
        hook_event: hookEvent,
        tool_input: input.tool_input || null,
        ...env,
    };
}

function normalizeClaudeEvent(input) {
    const hookEvent = input.hook_event_name || "unknown";
    const ctx = buildClaudeContext(input);
    const handler = CLAUDE_DISPATCH[hookEvent];
    return handler ? handler(ctx) : normalizeClaudeUnknown(hookEvent, ctx);
}

// Codex CLI shipped its hook contract using Claude Code's payload shape:
// PascalCase event names (PreToolUse, PostToolUse, PermissionRequest, ...),
// the same field set on stdin (tool_name, tool_input, tool_response, prompt,
// session_id, transcript_path, model, ...). We delegate to the Claude
// normalizer rather than maintain a parallel switch — both clients map to
// the same canonical record. Two small Codex-specific touches:
//   - tag with client_runner so provider-responses can format decisions
//     in Codex's expected shape (PermissionRequest in particular)
//   - propagate Codex's turn_id field, which Claude doesn't emit
function normalizeCodexEvent(input) {
    const result = normalizeClaudeEvent(input);
    result.client_runner = "codex";
    if (input.turn_id) result.turn_id = input.turn_id;
    return result;
}

// --- Gemini ---

function buildGeminiContext(input) {
    return { input, hookEvent: input.hook_event_name || "unknown" };
}

function extractGeminiTokens(input) {
    const usage = input.llm_response && input.llm_response.usageMetadata;
    if (!usage) return null;
    const tokens = {};
    if (usage.promptTokenCount) tokens.input = usage.promptTokenCount;
    if (usage.candidatesTokenCount) tokens.output = usage.candidatesTokenCount;
    if (usage.thoughtsTokenCount) tokens.thinking = usage.thoughtsTokenCount;
    if (usage.cachedContentTokenCount) tokens.cache_read = usage.cachedContentTokenCount;
    return Object.keys(tokens).length > 0 ? tokens : null;
}

const GEMINI_DISPATCH = {
    SessionStart: ({ input }) => ({
        event_type: "session_start", tool_name: null, tool_input_summary: null,
        hook_event: "SessionStart",
        source: input.source || null, model: input.model || null,
    }),
    SessionEnd: ({ input }) => ({
        event_type: "session_end", tool_name: null, tool_input_summary: null,
        hook_event: "SessionEnd",
        reason: input.reason || input.stopReason || null,
    }),
    BeforeAgent: ({ input }) => ({
        event_type: "user_prompt", tool_name: null,
        tool_input_summary: truncate(input.prompt || "", 200),
        hook_event: "BeforeAgent",
        prompt: input.prompt || null,
        prompt_chars: input.prompt ? input.prompt.length : 0,
    }),
    AfterAgent: ({ input }) => ({
        event_type: "agent_stop", tool_name: null,
        tool_input_summary: truncate(input.reason || input.stopReason || input.systemMessage || "", 200),
        hook_event: "AfterAgent",
        reason: input.reason || input.stopReason || null,
        system_message: input.systemMessage || null,
    }),
    BeforeTool: ({ input }) => {
        const toolInput = input.tool_input || {};
        return {
            event_type: "tool_use_start", tool_name: input.tool_name || null,
            tool_input_summary: summarize(input.tool_name, toolInput),
            hook_event: "BeforeTool",
            tool_input: toolInput,
            tool_input_bytes: Buffer.byteLength(JSON.stringify(toolInput)),
        };
    },
    AfterTool: ({ input }) => {
        const toolName = input.tool_name || null;
        const toolInput = input.tool_input || {};
        const toolResponse = input.tool_response || null;
        const toolResponseBytes = toolResponse === null ? 0
            : typeof toolResponse === "string" ? Buffer.byteLength(toolResponse)
            : Buffer.byteLength(JSON.stringify(toolResponse));
        const result = {
            event_type: "tool_use", tool_name: toolName,
            tool_input_summary: summarize(toolName, toolInput),
            hook_event: "AfterTool",
            tool_input: toolInput, tool_response: toolResponse,
            duration_ms: input.duration || input.duration_ms || null,
            tool_output_bytes: toolResponseBytes,
            status: input.error ? "error" : "success",
        };
        const filePath = extractFilePath(toolName, toolInput);
        if (filePath) result.files_modified = [filePath];
        return attachEditMetrics(result, toolName, toolInput, toolResponse);
    },
    AfterModel: ({ input }) => {
        const tokens = extractGeminiTokens(input);
        const model = (input.llm_request && input.llm_request.model)
            || (input.llm_response && input.llm_response.model)
            || null;
        const lastMessage = (input.llm_response && input.llm_response.text)
            || (input.llm_response && input.llm_response.candidates && input.llm_response.candidates[0]
                && input.llm_response.candidates[0].content
                && input.llm_response.candidates[0].content.parts
                && input.llm_response.candidates[0].content.parts[0]
                && input.llm_response.candidates[0].content.parts[0].text)
            || null;
        return {
            event_type: "model_response", tool_name: model, tool_input_summary: null,
            hook_event: "AfterModel",
            tokens, model, last_assistant_message: lastMessage,
            finish_reason: (input.llm_response && input.llm_response.finishReason) || null,
        };
    },
    PreCompress: ({ input }) => ({
        event_type: "context_compact", tool_name: null, tool_input_summary: null,
        hook_event: "PreCompress",
        trigger: input.trigger || null,
        context_size_hint: input.context_size || null,
    }),
    Notification: ({ input }) => ({
        event_type: "notification", tool_name: null,
        tool_input_summary: truncate(input.message || "", 200),
        hook_event: "Notification",
        notification_type: input.type || input.notification_type || null,
        notification_title: input.title || null,
        notification_message: input.message || null,
    }),
};

function normalizeGeminiUnknown(hookEvent, input) {
    return {
        event_type: hookEvent ? hookEvent.toLowerCase() : "unknown",
        tool_name: input.tool_name || null,
        tool_input_summary: summarize(input.tool_name, input.tool_input || {}),
        hook_event: hookEvent,
        tool_input: input.tool_input || null,
    };
}

function normalizeGeminiEvent(input) {
    const ctx = buildGeminiContext(input);
    const handler = GEMINI_DISPATCH[ctx.hookEvent];
    return handler ? handler(ctx) : normalizeGeminiUnknown(ctx.hookEvent, input);
}

// --- Copilot ---
//
// Copilot CLI does NOT send hook_event_name. Event type is inferred from
// payload shape — toolName + toolResult means PostToolUse, etc.

function parseCopilotToolArgs(rawArgs) {
    if (typeof rawArgs === "string" && rawArgs) {
        try {
            return JSON.parse(rawArgs);
        } catch {
            // Not JSON — may be a raw patch string ("*** Begin Patch\\n...")
            const patchFileMatch = rawArgs.match(/\\*\\*\\* Update File:\\s*(.+)/);
            if (patchFileMatch) {
                return { file_path: patchFileMatch[1].trim(), _raw_patch: rawArgs };
            }
            return {};
        }
    }
    if (rawArgs && typeof rawArgs === "object") return rawArgs;
    return null;
}

function copilotPostToolEvent(toolName, toolInput, toolResponse, input) {
    const toolResponseBytes = toolResponse === null ? 0
        : typeof toolResponse === "string" ? Buffer.byteLength(toolResponse)
        : Buffer.byteLength(JSON.stringify(toolResponse));
    const result = {
        event_type: "tool_use", tool_name: toolName,
        tool_input_summary: summarize(toolName, toolInput),
        hook_event: "PostToolUse",
        tool_input: toolInput, tool_response: toolResponse,
        duration_ms: input.duration || null,
        tool_output_bytes: toolResponseBytes,
        status: input.error || input.errorCode || input.error_code ? "error" : "success",
    };
    const filePath = extractFilePath(toolName, toolInput);
    if (filePath) result.files_modified = [filePath];
    return attachEditMetrics(result, toolName, toolInput, toolResponse);
}

function copilotPreToolEvent(toolName, toolInput) {
    return {
        event_type: "tool_use_start", tool_name: toolName,
        tool_input_summary: summarize(toolName, toolInput),
        hook_event: "PreToolUse",
        tool_input: toolInput,
        tool_input_bytes: Buffer.byteLength(JSON.stringify(toolInput)),
    };
}

function copilotLifecycleEvent(input) {
    if (input.prompt !== undefined && input.source === undefined) {
        return {
            event_type: "user_prompt", tool_name: null,
            tool_input_summary: truncate(input.prompt || "", 200),
            hook_event: "UserPromptSubmit",
            prompt: input.prompt || null,
            prompt_chars: input.prompt ? input.prompt.length : 0,
        };
    }
    if (input.source !== undefined || input.initialPrompt !== undefined || input.initial_prompt !== undefined) {
        return {
            event_type: "session_start", tool_name: null, tool_input_summary: null,
            hook_event: "SessionStart",
            source: input.source || null,
        };
    }
    if (input.reason !== undefined) {
        return {
            event_type: "session_end", tool_name: null, tool_input_summary: null,
            hook_event: "SessionEnd",
            reason: input.reason || null,
        };
    }
    if (input.error || input.errorCode || input.error_code) {
        return {
            event_type: "tool_use_error", tool_name: null,
            tool_input_summary: truncate(String(input.error || ""), 200),
            hook_event: "PostToolUseFailure",
            error: input.error || null,
            status: "error",
        };
    }
    return null;
}

function normalizeCopilotEvent(input) {
    const rawArgs = input.toolArgs || input.tool_args || null;
    const parsedArgs = parseCopilotToolArgs(rawArgs);
    const toolName = input.toolName || input.tool_name || null;

    if (toolName) {
        const toolInput = parsedArgs || {};
        const hasResult = input.toolResult !== undefined || input.tool_result !== undefined;
        if (hasResult) {
            const toolResponse = input.toolResult || input.tool_result || null;
            return copilotPostToolEvent(toolName, toolInput, toolResponse, input);
        }
        return copilotPreToolEvent(toolName, toolInput);
    }

    const lifecycle = copilotLifecycleEvent(input);
    if (lifecycle) return lifecycle;

    // Unknown event — pass through with minimal normalization
    return {
        event_type: "unknown", tool_name: null, tool_input_summary: null,
        hook_event: "Unknown",
    };
}`;
