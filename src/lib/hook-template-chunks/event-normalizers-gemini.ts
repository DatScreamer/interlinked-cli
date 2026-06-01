// Extracted from event-normalizers.ts (decomposed for the 1500-line cap).
// This is DATA — part of the body of the generated
// `.interlinked/hooks/interlinked-activity.mjs`. Do NOT edit escape sequences
// (`\\s`, `\\n`, `\\*`, `\\u0000`, etc.) — they are the source form for the
// runtime script (`\\s` here becomes `\s` in the emitted .mjs).
//
// Gemini CLI normalizer (BeforeTool/AfterTool/AfterModel PascalCase variant).
// Concatenated verbatim by event-normalizers.ts into EVENT_NORMALIZERS_CHUNK;
// the join is direct (no separators) so the emitted bytes are unchanged.

export const GEMINI_NORMALIZERS = `// --- Gemini ---

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
        const toolResponseRaw = input.tool_response || null;
        const toolResponseBytes = toolResponseRaw === null ? 0
            : typeof toolResponseRaw === "string" ? Buffer.byteLength(toolResponseRaw)
            : Buffer.byteLength(JSON.stringify(toolResponseRaw));
        const toolResponse = capToolResponse(toolResponseRaw);
        // Folded failures: Gemini delivers tool failures on AfterTool with
        // tool_response.success === false. Without this gate, Channels 2/3/5/6
        // would never see Gemini failures.
        const responseSaysFailed = toolResponseRaw && typeof toolResponseRaw === "object"
            && toolResponseRaw.success === false;
        const isError = !!input.error || responseSaysFailed;
        const result = {
            event_type: "tool_use", tool_name: toolName,
            tool_input_summary: summarize(toolName, toolInput),
            hook_event: "AfterTool",
            tool_input: toolInput, tool_response: toolResponse,
            duration_ms: input.duration || input.duration_ms || null,
            tool_output_bytes: toolResponseBytes,
            status: isError ? "error" : "success",
        };
        const filePath = extractFilePath(toolName, toolInput);
        if (filePath) result.files_modified = [filePath];
        attachEditMetrics(result, toolName, toolInput, toolResponseRaw);
        attachOutcome(result, toolName, toolResponseRaw, input.error || null);
        return result;
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

`;
