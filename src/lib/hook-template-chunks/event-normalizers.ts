// Extracted from hooks-template.ts.
// This is DATA — the body of the generated `.interlinked/hooks/interlinked-activity.mjs`.
// Do not edit escape sequences (`\\s`, `\\n`, `\\*`, etc.) — they are the source form
// for the runtime script. `\\s` in this file becomes `\s` in the emitted .mjs.

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

function normalizeClaudeEvent(input) {
    const hookEvent = input.hook_event_name || "unknown";
    const env = envelopeFieldsClaude(input);

    // Extract token usage from Stop/SubagentStop events
    let tokens = null;
    if (input.usage || input.token_usage) {
        const u = input.usage || input.token_usage;
        tokens = {};
        if (u.input_tokens) tokens.input = u.input_tokens;
        if (u.output_tokens) tokens.output = u.output_tokens;
        if (u.cache_read_input_tokens) tokens.cache_read = u.cache_read_input_tokens;
        if (u.cache_creation_input_tokens) tokens.cache_creation = u.cache_creation_input_tokens;
        if (u.thinking_tokens || u.reasoning_tokens) tokens.thinking = u.thinking_tokens || u.reasoning_tokens;
        if (Object.keys(tokens).length === 0) tokens = null;
    }

    // Extract duration from PostToolUse events
    const duration_ms = input.duration_ms || input.durationMs || null;

    switch (hookEvent) {
        case "SessionStart":
            return { event_type: "session_start", tool_name: null, tool_input_summary: null, hook_event: hookEvent,
                source: input.source || null, model: input.model || null, agent_type: input.agent_type || null,
                cli_version: input.cli_version || input.claude_code_version || null,
                available_tools_count: Array.isArray(input.available_tools) ? input.available_tools.length : null,
                ...env };
        case "SessionEnd":
            return { event_type: "session_end", tool_name: null, tool_input_summary: null, hook_event: hookEvent, tokens,
                reason: input.reason || null, duration_ms, ...env };
        case "Stop":
            return { event_type: "agent_stop", tool_name: null, tool_input_summary: null, hook_event: hookEvent, tokens,
                stop_hook_active: input.stop_hook_active || false,
                stop_reason: input.stop_reason || null,
                last_assistant_message: input.last_assistant_message || null, ...env };
        case "UserPromptSubmit": {
            const prompt = input.prompt || input.user_prompt || "";
            return { event_type: "user_prompt", tool_name: null, tool_input_summary: truncate(prompt, 200), hook_event: hookEvent,
                prompt: prompt || null,
                prompt_chars: prompt ? prompt.length : 0, ...env };
        }
        case "PreToolUse": {
            const preToolInput = input.tool_input || {};
            const toolInputBytes = Buffer.byteLength(JSON.stringify(preToolInput));
            return { event_type: "tool_use_start", tool_name: input.tool_name || null, tool_input_summary: summarize(input.tool_name, preToolInput), hook_event: hookEvent,
                tool_input: preToolInput, tool_use_id: input.tool_use_id || null,
                tool_input_bytes: toolInputBytes, ...env };
        }
        case "PostToolUse": {
            const toolName = input.tool_name || null;
            const toolInput = input.tool_input || {};
            const toolResponse = input.tool_response || null;
            const toolResponseBytes = toolResponse === null ? 0
                : typeof toolResponse === "string" ? Buffer.byteLength(toolResponse)
                : Buffer.byteLength(JSON.stringify(toolResponse));
            const result = { event_type: "tool_use", tool_name: toolName, tool_input_summary: summarize(toolName, toolInput), hook_event: hookEvent, duration_ms,
                tool_input: toolInput, tool_response: toolResponse, tool_use_id: input.tool_use_id || null,
                tool_output_bytes: toolResponseBytes,
                status: "success", ...env };
            const filePath = extractFilePath(toolName, toolInput);
            if (filePath) result.files_modified = [filePath];
            return attachEditMetrics(result, toolName, toolInput, toolResponse);
        }
        case "PostToolUseFailure": {
            const failToolName = input.tool_name || null;
            const failInput = input.tool_input || {};
            const errorDetail = input.error || input.tool_error || input.message || null;
            const summary = errorDetail
                ? truncate(String(errorDetail), 200)
                : summarize(failToolName, failInput);
            return { event_type: "tool_use_error", tool_name: failToolName, tool_input_summary: summary, hook_event: hookEvent,
                tool_input: failInput, error: errorDetail, is_interrupt: input.is_interrupt || false, tool_use_id: input.tool_use_id || null,
                error_category: categorizeToolError(input),
                status: "error", ...env };
        }
        case "SubagentStart":
            return { event_type: "subagent_start", tool_name: input.agent_type || null, tool_input_summary: null, hook_event: hookEvent,
                parent_agent: input.parent_agent_name || null, subagent_id: input.agent_id || null, agent_type: input.agent_type || null,
                agent_transcript_path: input.agent_transcript_path || null, ...env };
        case "SubagentStop":
            return { event_type: "subagent_stop", tool_name: input.agent_type || null, tool_input_summary: null, hook_event: hookEvent,
                parent_agent: input.parent_agent_name || null, subagent_id: input.agent_id || null, tokens, agent_type: input.agent_type || null,
                agent_transcript_path: input.agent_transcript_path || null,
                last_assistant_message: input.last_assistant_message || null,
                duration_ms, ...env };
        case "Notification":
            return { event_type: "notification", tool_name: null, tool_input_summary: truncate(input.message || "", 200), hook_event: hookEvent,
                notification_type: input.notification_type || null, notification_title: input.title || null,
                notification_message: input.message || null, ...env };
        case "PreCompact":
            return { event_type: "context_compact", tool_name: null, tool_input_summary: null, hook_event: hookEvent,
                trigger: input.trigger || null, custom_instructions: input.custom_instructions || null,
                context_size_hint: input.context_size || input.token_count || null, ...env };
        case "TaskCompleted":
            return { event_type: "task_completed", tool_name: null, tool_input_summary: truncate(input.task_subject || input.task_id || "", 200), hook_event: hookEvent,
                task_id: input.task_id || null, task_subject: input.task_subject || null, task_description: input.task_description || null,
                teammate_name: input.teammate_name || null, team_name: input.team_name || null, ...env };
        case "TeammateIdle":
            return { event_type: "teammate_idle", tool_name: input.teammate_name || null, tool_input_summary: null, hook_event: hookEvent,
                teammate_name: input.teammate_name || null, team_name: input.team_name || null, ...env };
        case "PermissionRequest": {
            const permToolName = input.tool_name || null;
            const permToolInput = input.tool_input || {};
            return { event_type: "permission_request", tool_name: permToolName, tool_input_summary: summarize(permToolName, permToolInput), hook_event: hookEvent,
                tool_input: permToolInput,
                permission_suggestions: input.permission_suggestions || null,
                permission_mode: input.permission_mode || null, ...env };
        }
        default:
            return { event_type: hookEvent ? hookEvent.toLowerCase() : "unknown", tool_name: input.tool_name || null, tool_input_summary: summarize(input.tool_name, input.tool_input || {}), hook_event: hookEvent,
                tool_input: input.tool_input || null, ...env };
    }
}

function normalizeGeminiEvent(input) {
    const hookEvent = input.hook_event_name || "unknown";
    switch (hookEvent) {
        case "SessionStart":
            return { event_type: "session_start", tool_name: null, tool_input_summary: null, hook_event: hookEvent,
                source: input.source || null, model: input.model || null };
        case "SessionEnd":
            return { event_type: "session_end", tool_name: null, tool_input_summary: null, hook_event: hookEvent,
                reason: input.reason || input.stopReason || null };
        case "BeforeAgent":
            return { event_type: "user_prompt", tool_name: null, tool_input_summary: truncate(input.prompt || "", 200), hook_event: hookEvent,
                prompt: input.prompt || null,
                prompt_chars: input.prompt ? input.prompt.length : 0 };
        case "AfterAgent":
            return { event_type: "agent_stop", tool_name: null, tool_input_summary: truncate(input.reason || input.stopReason || input.systemMessage || "", 200), hook_event: hookEvent,
                reason: input.reason || input.stopReason || null,
                system_message: input.systemMessage || null };
        case "BeforeTool": {
            const toolInput = input.tool_input || {};
            return { event_type: "tool_use_start", tool_name: input.tool_name || null, tool_input_summary: summarize(input.tool_name, toolInput), hook_event: hookEvent,
                tool_input: toolInput,
                tool_input_bytes: Buffer.byteLength(JSON.stringify(toolInput)) };
        }
        case "AfterTool": {
            const toolName = input.tool_name || null;
            const toolInput = input.tool_input || {};
            const toolResponse = input.tool_response || null;
            const toolResponseBytes = toolResponse === null ? 0
                : typeof toolResponse === "string" ? Buffer.byteLength(toolResponse)
                : Buffer.byteLength(JSON.stringify(toolResponse));
            const result = { event_type: "tool_use", tool_name: toolName, tool_input_summary: summarize(toolName, toolInput), hook_event: hookEvent,
                tool_input: toolInput, tool_response: toolResponse,
                duration_ms: input.duration || input.duration_ms || null,
                tool_output_bytes: toolResponseBytes,
                status: input.error ? "error" : "success" };
            const filePath = extractFilePath(toolName, toolInput);
            if (filePath) result.files_modified = [filePath];
            return attachEditMetrics(result, toolName, toolInput, toolResponse);
        }
        case "AfterModel": {
            let tokens = null;
            const usage = input.llm_response && input.llm_response.usageMetadata;
            if (usage) {
                tokens = {};
                if (usage.promptTokenCount) tokens.input = usage.promptTokenCount;
                if (usage.candidatesTokenCount) tokens.output = usage.candidatesTokenCount;
                if (usage.thoughtsTokenCount) tokens.thinking = usage.thoughtsTokenCount;
                if (usage.cachedContentTokenCount) tokens.cache_read = usage.cachedContentTokenCount;
                if (Object.keys(tokens).length === 0) tokens = null;
            }
            const model = (input.llm_request && input.llm_request.model)
                || (input.llm_response && input.llm_response.model)
                || null;
            const lastMessage = (input.llm_response && input.llm_response.text)
                || (input.llm_response && input.llm_response.candidates && input.llm_response.candidates[0] && input.llm_response.candidates[0].content && input.llm_response.candidates[0].content.parts && input.llm_response.candidates[0].content.parts[0] && input.llm_response.candidates[0].content.parts[0].text)
                || null;
            return { event_type: "model_response", tool_name: model, tool_input_summary: null, hook_event: hookEvent,
                tokens, model, last_assistant_message: lastMessage,
                finish_reason: (input.llm_response && input.llm_response.finishReason) || null };
        }
        case "PreCompress":
            return { event_type: "context_compact", tool_name: null, tool_input_summary: null, hook_event: hookEvent,
                trigger: input.trigger || null,
                context_size_hint: input.context_size || null };
        case "Notification":
            return { event_type: "notification", tool_name: null, tool_input_summary: truncate(input.message || "", 200), hook_event: hookEvent,
                notification_type: input.type || input.notification_type || null,
                notification_title: input.title || null,
                notification_message: input.message || null };
        default:
            return { event_type: hookEvent ? hookEvent.toLowerCase() : "unknown", tool_name: input.tool_name || null, tool_input_summary: summarize(input.tool_name, input.tool_input || {}), hook_event: hookEvent,
                tool_input: input.tool_input || null };
    }
}

function normalizeCopilotEvent(input) {
    // Copilot CLI does NOT send hook_event_name. We infer the event type from
    // the payload shape. toolArgs is a JSON string that needs parsing.
    let parsedArgs = null;
    const rawArgs = input.toolArgs || input.tool_args || null;
    if (typeof rawArgs === "string" && rawArgs) {
        try { parsedArgs = JSON.parse(rawArgs); } catch {
            // Not JSON — may be a raw patch string (apply_patch sends "*** Begin Patch\\n...")
            // Extract file path from patch format: "*** Update File: /path/to/file.ts"
            const patchFileMatch = rawArgs.match(/\\*\\*\\* Update File:\\s*(.+)/);
            if (patchFileMatch) {
                parsedArgs = { file_path: patchFileMatch[1].trim(), _raw_patch: rawArgs };
            } else {
                parsedArgs = {};
            }
        }
    } else if (rawArgs && typeof rawArgs === "object") {
        parsedArgs = rawArgs;
    }

    const toolName = input.toolName || input.tool_name || null;

    // Tool events: preToolUse / postToolUse
    if (toolName) {
        const hasResult = input.toolResult !== undefined || input.tool_result !== undefined;
        if (hasResult) {
            // PostToolUse
            const toolInput = parsedArgs || {};
            const toolResponse = input.toolResult || input.tool_result || null;
            const toolResponseBytes = toolResponse === null ? 0
                : typeof toolResponse === "string" ? Buffer.byteLength(toolResponse)
                : Buffer.byteLength(JSON.stringify(toolResponse));
            const result = {
                event_type: "tool_use",
                tool_name: toolName,
                tool_input_summary: summarize(toolName, toolInput),
                hook_event: "PostToolUse",
                tool_input: toolInput,
                tool_response: toolResponse,
                duration_ms: input.duration || null,
                tool_output_bytes: toolResponseBytes,
                status: input.error || input.errorCode || input.error_code ? "error" : "success",
            };
            const filePath = extractFilePath(toolName, toolInput);
            if (filePath) result.files_modified = [filePath];
            return attachEditMetrics(result, toolName, toolInput, toolResponse);
        }
        // PreToolUse
        const toolInput = parsedArgs || {};
        return {
            event_type: "tool_use_start",
            tool_name: toolName,
            tool_input_summary: summarize(toolName, toolInput),
            hook_event: "PreToolUse",
            tool_input: toolInput,
            tool_input_bytes: Buffer.byteLength(JSON.stringify(toolInput)),
        };
    }

    // Lifecycle events (no toolName)
    if (input.prompt !== undefined && input.source === undefined) {
        return {
            event_type: "user_prompt",
            tool_name: null,
            tool_input_summary: truncate(input.prompt || "", 200),
            hook_event: "UserPromptSubmit",
            prompt: input.prompt || null,
            prompt_chars: input.prompt ? input.prompt.length : 0,
        };
    }
    if (input.source !== undefined || input.initialPrompt !== undefined || input.initial_prompt !== undefined) {
        return {
            event_type: "session_start",
            tool_name: null,
            tool_input_summary: null,
            hook_event: "SessionStart",
            source: input.source || null,
        };
    }
    if (input.reason !== undefined) {
        return {
            event_type: "session_end",
            tool_name: null,
            tool_input_summary: null,
            hook_event: "SessionEnd",
            reason: input.reason || null,
        };
    }
    if (input.error || input.errorCode || input.error_code) {
        return {
            event_type: "tool_use_error",
            tool_name: null,
            tool_input_summary: truncate(String(input.error || ""), 200),
            hook_event: "PostToolUseFailure",
            error: input.error || null,
            status: "error",
        };
    }

    // Unknown event — pass through with minimal normalization
    return {
        event_type: "unknown",
        tool_name: null,
        tool_input_summary: null,
        hook_event: "Unknown",
    };
}`;
