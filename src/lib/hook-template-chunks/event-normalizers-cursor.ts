// @codegen-data — template-string carrier for the generated .mjs hook; no
// hand-written runtime logic to unit-test (exempts the every-file-tested gate).
// Extracted from event-normalizers.ts (decomposed for the 1500-line cap).
// This is DATA — part of the body of the generated
// `.interlinked/hooks/interlinked-activity.mjs`. Do NOT edit escape sequences
// (`\\s`, `\\n`, `\\*`, `\\u0000`, etc.) — they are the source form for the
// runtime script (`\\s` here becomes `\s` in the emitted .mjs).
//
// Cursor IDE normalizer (per-tool gates + lifecycle hooks mapped to canonical records).
// Concatenated verbatim by event-normalizers.ts into EVENT_NORMALIZERS_CHUNK;
// the join is direct (no separators) so the emitted bytes are unchanged.

export const CURSOR_NORMALIZERS = `// --- Cursor IDE ---
//
// Cursor exposes per-tool gates (beforeShellExecution, beforeMCPExecution /
// beforeMcpToolExecution,
// beforeReadFile), file-edit observation (afterFileEdit), prompt + lifecycle
// hooks (beforeSubmitPrompt, sessionStart, sessionEnd, stop), plus generic
// preToolUse/postToolUse aliases. Each event has its own native shape; we
// translate to the canonical record so the rest of the harness pipeline
// (rule matching on tool_name + tool_input.command) stays agent-agnostic.
//
// Mapping rationale:
//   - beforeShellExecution → tool_name: "Bash", tool_input.command   (matches Bash rules)
//   - beforeMCPExecution / beforeMcpToolExecution
//                        → tool_name: input.tool_name (MCP-prefixed) (matches MCP rules)
//   - beforeReadFile       → tool_name: "Read", tool_input.file_path (matches Read rules)
//   - afterFileEdit        → tool_name: "Edit", tool_input.{file_path, edits} (matches PostToolUse Edit)
//   - beforeSubmitPrompt   → UserPromptSubmit (PII scan path)
//   - preToolUse/postToolUse → identity passthrough (Cursor's generic aliases)
//   - sessionStart/sessionEnd/stop → lifecycle records

function envelopeFieldsCursor(input) {
    // Cursor sends workspace_roots (array). The harness expects cwd as a
    // single string — pick the first root; absent if neither side has one.
    const cwd = input.cwd || (Array.isArray(input.workspace_roots) && input.workspace_roots[0]) || null;
    return {
        cwd,
        session_id_hint: input.conversation_id || input.generation_id || null,
        cursor_version: input.cursor_version || null,
        conversation_id: input.conversation_id || null,
        generation_id: input.generation_id || null,
    };
}

const CURSOR_DISPATCH = {
    sessionStart: (input, env) => ({
        event_type: "session_start", tool_name: null, tool_input_summary: null,
        hook_event: "SessionStart",
        source: input.source || null, model: input.model || null,
        ...env,
    }),
    sessionEnd: (input, env) => ({
        event_type: "session_end", tool_name: null, tool_input_summary: null,
        hook_event: "SessionEnd",
        reason: input.reason || null,
        ...env,
    }),
    stop: (input, env) => ({
        event_type: "agent_stop", tool_name: null, tool_input_summary: null,
        hook_event: "Stop",
        stop_reason: input.status || null,
        loop_count: input.loop_count || 0,
        ...env,
    }),
    beforeSubmitPrompt: (input, env) => {
        const prompt = input.prompt || "";
        return {
            event_type: "user_prompt", tool_name: null,
            tool_input_summary: truncate(prompt, 200),
            hook_event: "UserPromptSubmit",
            prompt: prompt || null,
            prompt_chars: prompt.length,
            ...env,
        };
    },
    beforeShellExecution: (input, env) => {
        // Cursor's shell hook fires on terminal commands. Map to Bash so
        // existing destructive-command rules apply directly.
        const toolInput = { command: input.command || "" };
        return {
            event_type: "tool_use_start", tool_name: "Bash",
            tool_input_summary: summarize("Bash", toolInput),
            hook_event: "PreToolUse",
            tool_input: toolInput,
            tool_input_bytes: Buffer.byteLength(JSON.stringify(toolInput)),
            ...env,
        };
    },
    beforeMCPExecution: (input, env) => {
        // Alias to beforeMcpToolExecution for Cursor builds that use the
        // lower-cased "cpTool" event spelling.
        return CURSOR_DISPATCH.beforeMcpToolExecution(input, env);
    },
    beforeMcpToolExecution: (input, env) => {
        // Cursor sends tool_input as an escaped JSON string per its docs;
        // parse so harness rules can pattern-match against fields directly.
        let parsedInput = {};
        if (typeof input.tool_input === "string") {
            try { parsedInput = JSON.parse(input.tool_input); } catch { parsedInput = { _raw: input.tool_input }; }
        } else if (input.tool_input && typeof input.tool_input === "object") {
            parsedInput = input.tool_input;
        }
        const toolName = input.tool_name || null;
        return {
            event_type: "tool_use_start", tool_name: toolName,
            tool_input_summary: summarize(toolName, parsedInput),
            hook_event: "PreToolUse",
            tool_input: parsedInput,
            tool_input_bytes: Buffer.byteLength(JSON.stringify(parsedInput)),
            ...env,
        };
    },
    beforeReadFile: (input, env) => {
        const toolInput = { file_path: input.file_path || "" };
        return {
            event_type: "tool_use_start", tool_name: "Read",
            tool_input_summary: summarize("Read", toolInput),
            hook_event: "PreToolUse",
            tool_input: toolInput,
            ...env,
        };
    },
    afterFileEdit: (input, env) => {
        const filePath = input.file_path || "";
        const edits = Array.isArray(input.edits) ? input.edits : [];
        // Cursor only sends afterFileEdit (no before-counterpart in our
        // event set) — surface as PostToolUse Edit so quality + structural
        // checks fire on the modified file.
        const firstEdit = edits[0] || {};
        const toolInput = {
            file_path: filePath,
            old_string: firstEdit.old_string || "",
            new_string: firstEdit.new_string || "",
            edits,
        };
        const result = {
            event_type: "tool_use", tool_name: "Edit",
            tool_input_summary: summarize("Edit", toolInput),
            hook_event: "PostToolUse",
            tool_input: toolInput,
            tool_response: null,
            duration_ms: null,
            tool_output_bytes: 0,
            status: "success",
            files_modified: filePath ? [filePath] : [],
            ...env,
        };
        return attachEditMetrics(result, "Edit", toolInput, null);
    },
    preToolUse: (input, env) => {
        // Cursor's generic preToolUse alias — payload shape mirrors
        // PreToolUse on Claude. Pass through.
        const toolInput = input.tool_input || {};
        return {
            event_type: "tool_use_start", tool_name: input.tool_name || null,
            tool_input_summary: summarize(input.tool_name, toolInput),
            hook_event: "PreToolUse",
            tool_input: toolInput,
            tool_input_bytes: Buffer.byteLength(JSON.stringify(toolInput)),
            ...env,
        };
    },
    postToolUse: (input, env) => {
        const toolName = input.tool_name || null;
        const toolInput = input.tool_input || {};
        // Cursor's postToolUse delivers tool_output as a JSON-stringified
        // payload (per docs); other variants may put structured data in
        // tool_response. Accept both so the harness sees output content.
        const toolResponseRaw = input.tool_response ?? input.tool_output ?? null;
        const toolResponse = capToolResponse(toolResponseRaw);
        // Folded failures: Cursor opt-in path where it routes tool failures
        // onto the generic postToolUse instead of the dedicated
        // postToolUseFailure event. Detect via top-level error_message /
        // failure_type, or response.success === false.
        const responseSaysFailed = toolResponseRaw && typeof toolResponseRaw === "object"
            && toolResponseRaw.success === false;
        const isError = !!(input.error || input.error_message || input.failure_type) || responseSaysFailed;
        const errorDetail = input.error || input.error_message || null;
        const result = {
            event_type: "tool_use", tool_name: toolName,
            tool_input_summary: summarize(toolName, toolInput),
            hook_event: "PostToolUse",
            tool_input: toolInput, tool_response: toolResponse,
            duration_ms: input.duration_ms || input.duration || null,
            tool_output_bytes: toolResponseRaw === null ? 0 : Buffer.byteLength(typeof toolResponseRaw === "string" ? toolResponseRaw : JSON.stringify(toolResponseRaw)),
            status: isError ? "error" : "success",
            ...env,
        };
        const filePath = extractFilePath(toolName, toolInput);
        if (filePath) result.files_modified = [filePath];
        attachEditMetrics(result, toolName, toolInput, toolResponseRaw);
        attachOutcome(result, toolName, toolResponseRaw, errorDetail);
        return result;
    },
    postToolUseFailure: (input, env) => {
        // Cursor failure shape: { tool_name, tool_input, error_message,
        // failure_type: "error"|"timeout"|"permission_denied",
        // duration, is_interrupt }. Map to canonical PostToolUseFailure
        // so attachOutcome's error_category + the error_history pipeline fire.
        const toolName = input.tool_name || null;
        const toolInput = input.tool_input || {};
        const errorDetail = input.error_message || input.error || null;
        const result = {
            event_type: "tool_use_error", tool_name: toolName,
            tool_input_summary: errorDetail
                ? truncate(String(errorDetail), 200)
                : summarize(toolName, toolInput),
            hook_event: "PostToolUseFailure",
            tool_input: toolInput,
            error: errorDetail,
            failure_type: input.failure_type || null,
            is_interrupt: input.is_interrupt || false,
            tool_use_id: input.tool_use_id || null,
            duration_ms: input.duration || null,
            status: "error",
            ...env,
        };
        // attachOutcome populates tool_outcome / error_message / stderr /
        // tool_response_sha256 — without this, downstream Phase 1 channels
        // (triage, recovery, recurrence) had no canonical fields to read.
        attachOutcome(result, toolName, input.tool_response || null, errorDetail);
        return result;
    },
    subagentStart: (input, env) => ({
        event_type: "subagent_start", tool_name: input.subagent_type || null,
        tool_input_summary: truncate(input.task || "", 200),
        hook_event: "SubagentStart",
        // Map Cursor's snake_case schema onto the canonical Claude shape so
        // downstream consumers don't need to special-case the runner.
        parent_agent: input.parent_conversation_id || null,
        subagent_id: input.subagent_id || null,
        agent_type: input.subagent_type || null,
        agent_transcript_path: null,
        ...env,
    }),
    subagentStop: (input, env) => ({
        event_type: "subagent_stop", tool_name: input.subagent_type || null,
        tool_input_summary: truncate(input.summary || input.task || "", 200),
        hook_event: "SubagentStop",
        parent_agent: null,
        subagent_id: null,
        agent_type: input.subagent_type || null,
        agent_transcript_path: input.agent_transcript_path || null,
        last_assistant_message: input.summary || null,
        duration_ms: input.duration_ms || null,
        status: input.status || null,
        tool_call_count: input.tool_call_count || 0,
        message_count: input.message_count || 0,
        ...env,
    }),
    preCompact: (input, env) => ({
        event_type: "context_compact", tool_name: null, tool_input_summary: null,
        hook_event: "PreCompact",
        trigger: input.trigger || null,
        custom_instructions: null,
        context_size_hint: input.context_tokens || null,
        context_usage_percent: input.context_usage_percent || null,
        messages_to_compact: input.messages_to_compact || null,
        ...env,
    }),
};

function normalizeCursorUnknown(hookEvent, input, env) {
    return {
        event_type: hookEvent ? hookEvent.toLowerCase() : "unknown",
        tool_name: input.tool_name || null,
        tool_input_summary: summarize(input.tool_name, input.tool_input || {}),
        hook_event: hookEvent,
        tool_input: input.tool_input || null,
        ...env,
    };
}

function normalizeCursorEvent(input) {
    const hookEvent = input.hook_event_name || "unknown";
    const env = envelopeFieldsCursor(input);
    const handler = CURSOR_DISPATCH[hookEvent];
    return handler ? handler(input, env) : normalizeCursorUnknown(hookEvent, input, env);
}`;
