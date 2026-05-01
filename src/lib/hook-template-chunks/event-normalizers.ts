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
// the fields in that case. \`hunks\` is the count of independent edit pairs
// (1 for Edit/Write/NotebookEdit, edits.length for MultiEdit).
function computeLocDelta(toolName, toolInput) {
    if (!toolInput) return null;
    const nl = (s) => (typeof s === "string" ? (s.match(/\\n/g) || []).length : 0);
    if (toolName === "Edit" || toolName === "str_replace" || toolName === "apply_patch") {
        return { added: nl(toolInput.new_string), removed: nl(toolInput.old_string), hunks: 1 };
    }
    if (toolName === "Write" || toolName === "create_file") {
        // No baseline for Write — report as all-added.
        return { added: nl(toolInput.content), removed: 0, hunks: 1 };
    }
    if (toolName === "MultiEdit" && Array.isArray(toolInput.edits)) {
        let added = 0, removed = 0;
        for (const e of toolInput.edits) {
            added += nl(e.new_string);
            removed += nl(e.old_string);
        }
        return { added, removed, hunks: toolInput.edits.length };
    }
    if (toolName === "NotebookEdit") {
        // Rough proxy — notebook cells aren't line-based, count content lines.
        return { added: nl(toolInput.new_source), removed: nl(toolInput.old_source), hunks: 1 };
    }
    return null;
}

// Cap value used by capStderr / capStdout. Read once per hook invocation;
// agents can override via INTERLINKED_STDERR_MAX_BYTES env var.
function streamCapBytes() {
    const raw = parseInt(process.env.INTERLINKED_STDERR_MAX_BYTES || "", 10);
    if (!Number.isFinite(raw) || raw <= 0) return 8192;
    // Hard ceiling so a typo doesn't bloat activity.jsonl.
    return Math.min(raw, 65536);
}

// Middle-truncate a string to maxBytes. Preserves head + tail + a marker
// so the most-useful diagnostic context (top of compiler output, bottom of
// test runner output) survives independently of which end carries signal.
function middleTruncateBytes(s, maxBytes) {
    if (!s) return "";
    const buf = Buffer.from(String(s), "utf8");
    if (buf.length <= maxBytes) return buf.toString("utf8");
    const half = Math.max(1, Math.floor(maxBytes / 2));
    const head = buf.slice(0, half).toString("utf8");
    const tail = buf.slice(buf.length - half).toString("utf8");
    return head + "\\n...[interlinked:truncated " + (buf.length - maxBytes) + " bytes]...\\n" + tail;
}

// SHA-256 fingerprint of the canonical write payload. Lets downstream
// retry-loop / thrashing detection compare "agent ran the exact same edit
// twice in a row" without storing the full payload twice. Returns null on
// failure (e.g., crypto unavailable in some sandboxed runtimes).
function fingerprintWrite(toolName, toolInput) {
    if (!toolInput) return null;
    let canonical = "";
    try {
        if (toolName === "Edit" || toolName === "str_replace" || toolName === "apply_patch") {
            canonical = String(toolInput.old_string || "") + "\\u0000" + String(toolInput.new_string || "");
        } else if (toolName === "Write" || toolName === "create_file") {
            canonical = String(toolInput.content || "");
        } else if (toolName === "MultiEdit") {
            canonical = JSON.stringify(toolInput.edits || []);
        } else if (toolName === "NotebookEdit") {
            canonical = String(toolInput.old_source || "") + "\\u0000" + String(toolInput.new_source || "");
        } else {
            return null;
        }
        const h = createHash("sha256");
        h.update(canonical);
        return h.digest("hex").slice(0, 16);
    } catch {
        return null;
    }
}

// Cap an arbitrary tool_response (string or object) before persisting to
// activity.jsonl. Without this, a single 'find /' or 'curl https://...'
// can land megabytes into the log; an unbounded log breaks every consumer
// (statusline reads, sync, grep). Object responses get string-cap on each
// large string field. Returns:
//   - null/undefined → unchanged
//   - small (under cap) → unchanged
//   - large string → middle-truncated string
//   - large object → shallow clone with each oversized string field
//     middle-truncated and a _truncated metadata field appended.
function capToolResponse(toolResponse) {
    if (toolResponse === null || toolResponse === undefined) return toolResponse;
    const cap = (() => {
        const raw = parseInt(process.env.INTERLINKED_TOOL_RESPONSE_MAX_BYTES || "", 10);
        if (!Number.isFinite(raw) || raw <= 0) return 32768;
        return Math.min(raw, 524288);
    })();
    if (typeof toolResponse === "string") {
        return Buffer.byteLength(toolResponse, "utf8") <= cap
            ? toolResponse
            : middleTruncateBytes(toolResponse, cap);
    }
    if (typeof toolResponse !== "object") return toolResponse;
    // Shallow-clone so we never mutate the upstream Claude Code payload.
    let totalBytes = 0;
    let truncated = false;
    const clone = Array.isArray(toolResponse) ? [] : {};
    for (const [k, v] of Object.entries(toolResponse)) {
        if (typeof v === "string") {
            const bytes = Buffer.byteLength(v, "utf8");
            totalBytes += bytes;
            if (bytes > cap) {
                clone[k] = middleTruncateBytes(v, cap);
                truncated = true;
            } else {
                clone[k] = v;
            }
        } else {
            clone[k] = v;
        }
    }
    if (truncated && !Array.isArray(clone)) {
        clone._interlinked_truncated_bytes = totalBytes;
    }
    return clone;
}

// SHA-256 fingerprint of any tool_response (string or object). Used as a
// general "exact same output" detector across all tools, not just edits.
function fingerprintResponse(toolResponse) {
    if (toolResponse === null || toolResponse === undefined) return null;
    try {
        const s = typeof toolResponse === "string" ? toolResponse : JSON.stringify(toolResponse);
        if (!s) return null;
        const h = createHash("sha256");
        h.update(s);
        return h.digest("hex").slice(0, 16);
    } catch {
        return null;
    }
}

// Derive canonical tool outcome fields from a PostToolUse / PostToolUseFailure
// payload. The shape is stable across all clients (Claude / Codex / Gemini /
// Cursor / Copilot) — downstream consumers can read tool_outcome / exit_code /
// stderr without re-parsing each client's tool_response shape.
//
// Capture policy (per the design discussion):
//   - On success: skip stderr/stdout (they're noise). Hash the response so
//     identical-output detection still works.
//   - On error: full stderr up to streamCapBytes() (default 8 KB), stdout
//     up to half that. Middle-truncate so head+tail both survive — vitest
//     puts the assertion delta at the bottom, npm install puts the error
//     at the top.
function deriveToolOutcome(toolName, toolResponse, errorDetail, status, isInterrupt) {
    const result = {
        tool_outcome: status === "error" ? "error" : "success",
        exit_code: null,
        stderr: null,
        stdout: null,
        tool_response_sha256: fingerprintResponse(toolResponse),
    };
    if (isInterrupt) {
        result.tool_outcome = "interrupted";
    }
    const cap = streamCapBytes();
    const isBash = toolName === "Bash" || toolName === "Shell" || toolName === "shell" || toolName === "run_command";

    if (isBash && toolResponse !== null && toolResponse !== undefined) {
        if (typeof toolResponse === "object") {
            const codeRaw = toolResponse.exitCode ?? toolResponse.exit_code ?? toolResponse.returncode;
            if (typeof codeRaw === "number") result.exit_code = codeRaw;
            const interrupted = toolResponse.interrupted === true;
            if (interrupted) result.tool_outcome = "interrupted";
            const failed = result.tool_outcome !== "success" || (typeof codeRaw === "number" && codeRaw !== 0);
            if (failed) {
                if (result.tool_outcome === "success") result.tool_outcome = "error";
                const respStderr = toolResponse.stderr;
                const respStdout = toolResponse.stdout;
                if (respStderr) result.stderr = middleTruncateBytes(respStderr, cap);
                if (respStdout) result.stdout = middleTruncateBytes(respStdout, Math.floor(cap / 2));
            }
        } else if (typeof toolResponse === "string" && result.tool_outcome === "error") {
            // Bash variants that stringify combined output — capture as stderr.
            result.stderr = middleTruncateBytes(toolResponse, cap);
        }
    } else if (result.tool_outcome === "error") {
        // Non-Bash failure: errorDetail OR the response string is the diagnostic.
        let msg = "";
        if (errorDetail !== null && errorDetail !== undefined) {
            msg = typeof errorDetail === "string" ? errorDetail : JSON.stringify(errorDetail);
        } else if (typeof toolResponse === "string") {
            msg = toolResponse;
        } else if (toolResponse) {
            msg = JSON.stringify(toolResponse);
        }
        if (msg) result.stderr = middleTruncateBytes(msg, cap);
    }
    return result;
}

// Attach canonical outcome fields onto a PostToolUse / PostToolUseFailure
// result record. Mutates and returns the record so per-event handlers can
// chain it after attachEditMetrics. Always sets tool_outcome; the optional
// fields are skipped when null so the on-disk row stays compact.
function attachOutcome(result, toolName, toolResponse, errorDetail) {
    const out = deriveToolOutcome(
        toolName,
        toolResponse,
        errorDetail,
        result.status,
        result.is_interrupt === true,
    );
    result.tool_outcome = out.tool_outcome;
    if (out.exit_code !== null) result.exit_code = out.exit_code;
    if (out.stderr) result.stderr = out.stderr;
    if (out.stdout) result.stdout = out.stdout;
    if (out.tool_response_sha256) result.tool_response_sha256 = out.tool_response_sha256;
    return result;
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
        result.hunks_count = loc.hunks;
    }
    const sha = fingerprintWrite(toolName, toolInput);
    if (sha) result.content_sha256 = sha;
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
        const toolResponseRaw = input.tool_response || null;
        const toolResponseBytes = toolResponseRaw === null ? 0
            : typeof toolResponseRaw === "string" ? Buffer.byteLength(toolResponseRaw)
            : Buffer.byteLength(JSON.stringify(toolResponseRaw));
        const toolResponse = capToolResponse(toolResponseRaw);
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
        attachEditMetrics(result, toolName, toolInput, toolResponseRaw);
        attachOutcome(result, toolName, toolResponseRaw, null);
        if (input.parent_tool_use_id) result.parent_tool_use_id = input.parent_tool_use_id;
        return result;
    },
    PostToolUseFailure: ({ input, env }) => {
        const failToolName = input.tool_name || null;
        const failInput = input.tool_input || {};
        const errorDetail = input.error || input.tool_error || input.message || null;
        const summary = errorDetail
            ? truncate(String(errorDetail), 200)
            : summarize(failToolName, failInput);
        const result = {
            event_type: "tool_use_error", tool_name: failToolName, tool_input_summary: summary,
            hook_event: "PostToolUseFailure",
            tool_input: failInput, error: errorDetail, is_interrupt: input.is_interrupt || false,
            tool_use_id: input.tool_use_id || null,
            error_category: categorizeToolError(input),
            status: "error",
            ...env,
        };
        attachOutcome(result, failToolName, input.tool_response || null, errorDetail);
        if (input.parent_tool_use_id) result.parent_tool_use_id = input.parent_tool_use_id;
        return result;
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
        const toolResponseRaw = input.tool_response || null;
        const toolResponseBytes = toolResponseRaw === null ? 0
            : typeof toolResponseRaw === "string" ? Buffer.byteLength(toolResponseRaw)
            : Buffer.byteLength(JSON.stringify(toolResponseRaw));
        const toolResponse = capToolResponse(toolResponseRaw);
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

function copilotPostToolEvent(toolName, toolInput, toolResponseRaw, input) {
    const toolResponseBytes = toolResponseRaw === null ? 0
        : typeof toolResponseRaw === "string" ? Buffer.byteLength(toolResponseRaw)
        : Buffer.byteLength(JSON.stringify(toolResponseRaw));
    const toolResponse = capToolResponse(toolResponseRaw);
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

// --- Cursor IDE ---
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
        const result = {
            event_type: "tool_use", tool_name: toolName,
            tool_input_summary: summarize(toolName, toolInput),
            hook_event: "PostToolUse",
            tool_input: toolInput, tool_response: toolResponse,
            duration_ms: input.duration_ms || input.duration || null,
            tool_output_bytes: toolResponseRaw === null ? 0 : Buffer.byteLength(typeof toolResponseRaw === "string" ? toolResponseRaw : JSON.stringify(toolResponseRaw)),
            status: input.error ? "error" : "success",
            ...env,
        };
        const filePath = extractFilePath(toolName, toolInput);
        if (filePath) result.files_modified = [filePath];
        attachEditMetrics(result, toolName, toolInput, toolResponseRaw);
        attachOutcome(result, toolName, toolResponseRaw, input.error || null);
        return result;
    },
    postToolUseFailure: (input, env) => {
        // Cursor failure shape: { tool_name, tool_input, error_message,
        // failure_type: "error"|"timeout"|"permission_denied",
        // duration, is_interrupt }. Map to canonical PostToolUseFailure
        // so the existing categorizeToolError + error_history pipeline fires.
        const toolName = input.tool_name || null;
        const toolInput = input.tool_input || {};
        const errorDetail = input.error_message || input.error || null;
        return {
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
