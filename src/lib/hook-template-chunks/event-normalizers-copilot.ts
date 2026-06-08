// @codegen-data — template-string carrier for the generated .mjs hook; no
// hand-written runtime logic to unit-test (exempts the every-file-tested gate).
// Extracted from event-normalizers.ts (decomposed for the 1500-line cap).
// This is DATA — part of the body of the generated
// `.interlinked/hooks/interlinked-activity.mjs`. Do NOT edit escape sequences
// (`\\s`, `\\n`, `\\*`, `\\u0000`, etc.) — they are the source form for the
// runtime script (`\\s` here becomes `\s` in the emitted .mjs).
//
// GitHub Copilot CLI normalizer (camelCase, shape inferred from payload).
// Concatenated verbatim by event-normalizers.ts into EVENT_NORMALIZERS_CHUNK;
// the join is direct (no separators) so the emitted bytes are unchanged.

export const COPILOT_NORMALIZERS = `// --- Copilot ---
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

function copilotPostToolEvent(toolName, toolInput, toolResponseRaw, input) {
    const toolResponseBytes = toolResponseRaw === null ? 0
        : typeof toolResponseRaw === "string" ? Buffer.byteLength(toolResponseRaw)
        : Buffer.byteLength(JSON.stringify(toolResponseRaw));
    const toolResponse = capToolResponse(toolResponseRaw);
    // Folded failures: Copilot delivers tool failures on postToolUse with
    // toolResult.resultType === "failure" (the dedicated errorOccurred event
    // is for non-tool errors). The previous condition ignored this field, so
    // Copilot tool failures landed flagged status:"success".
    const resultTypeFailed = toolResponseRaw && typeof toolResponseRaw === "object"
        && toolResponseRaw.resultType === "failure";
    const isError = !!(input.error || input.errorCode || input.error_code) || resultTypeFailed;
    const result = {
        event_type: "tool_use", tool_name: toolName,
        tool_input_summary: summarize(toolName, toolInput),
        hook_event: "PostToolUse",
        tool_input: toolInput, tool_response: toolResponse,
        duration_ms: input.duration || null,
        tool_output_bytes: toolResponseBytes,
        status: isError ? "error" : "success",
    };
    const filePath = extractFilePath(toolName, toolInput);
    if (filePath) result.files_modified = [filePath];
    attachEditMetrics(result, toolName, toolInput, toolResponseRaw);
    attachOutcome(result, toolName, toolResponseRaw, input.error || input.errorCode || input.error_code || null);
    return result;
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
}

`;
