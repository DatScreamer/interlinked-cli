// Extracted from hooks-template.ts.
// This is DATA — the body of the generated `.interlinked/hooks/interlinked-activity.mjs`.
// This chunk is nested inside `main()` in the generated script, so its leading
// indentation (4 spaces) is part of the emitted source.
//
// Each provider expects a different stdout JSON shape on hook decisions.
// The harness returns a provider-agnostic decision; this chunk emits the
// per-provider translation. Shape is split into per-provider formatter
// functions so the dispatcher stays at depth 1 and adding a new provider
// is a one-line registry change rather than another nested switch.

/** Public API — consumed by buildHookScript in hooks-template.ts. */
export const PROVIDER_RESPONSES_CHUNK = `    // ═══════════════════════════════════════════
    // Provider-specific response formatting
    // ═══════════════════════════════════════════
    //
    // CRITICAL: Claude Code validates hookSpecificOutput.hookEventName against
    // the incoming event name. Responses must echo back the actual event
    // (PostToolUse vs PostToolUseFailure, PreToolUse vs PermissionRequest)
    // or Claude Code rejects them with "Hook returned incorrect event name".
    //
    // Codex CLI shipped its hook contract using Claude Code's vocabulary, so
    // for PreToolUse/PostToolUse blocks the legacy {decision:"block", reason}
    // shape works for both. Advisory PostToolUse feedback travels as
    // hookSpecificOutput.additionalContext so the tool result stands and the
    // agent gets follow-up guidance. Codex's PermissionRequest uses a distinct
    // hookSpecificOutput.decision.behavior shape — handled in formatCodexResponse.

    function formatClaudeResponse(responseType, data, preEventEcho, postEventEcho) {
        if (responseType === "pre_block_grep") {
            return { hookSpecificOutput: {
                hookEventName: preEventEcho,
                permissionDecision: "deny",
                permissionDecisionReason: data.reason,
            }};
        }
        if (responseType === "pre_block") {
            return { decision: "block", reason: data.reason };
        }
        if (responseType === "pre_ask") {
            // Surface Claude Code's permission prompt so the user confirms
            // per-call. \`systemMessage\` is the user-only channel — shown in
            // the permission UI but NOT included in the model context. The
            // content scanner uses it to surface raw flagged PII while
            // keeping permissionDecisionReason agent-safe.
            const askResp = { hookSpecificOutput: {
                hookEventName: preEventEcho,
                permissionDecision: "ask",
                permissionDecisionReason: data.reason,
            }};
            if (data.systemMessage) askResp.systemMessage = data.systemMessage;
            return askResp;
        }
        if (responseType === "post_block") {
            return { decision: "block", reason: data.reason };
        }
        if (responseType === "post_warn") {
            return { hookSpecificOutput: {
                hookEventName: postEventEcho,
                additionalContext: data.summary,
            }};
        }
        if (responseType === "post_success") {
            return { hookSpecificOutput: {
                hookEventName: postEventEcho,
                additionalContext: data.summary,
            }};
        }
        return {};
    }

    function formatCopilotResponse(responseType, data) {
        if (responseType === "pre_block" || responseType === "pre_block_grep" || responseType === "pre_ask") {
            // Copilot has no "ask" primitive — collapse to deny so the user
            // sees the reason and can retry deliberately.
            return { permissionDecision: "deny", permissionDecisionReason: data.reason };
        }
        if (responseType === "post_block" || responseType === "post_warn") {
            // Copilot postToolUse is observation-only — write to stderr instead.
            if (data.reason) process.stderr.write(data.reason + "\\n");
            return {};
        }
        return {};
    }

    function codexPermissionDeny(reason) {
        return { hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "deny", message: reason },
        }};
    }

    function formatCodexResponse(responseType, data, postEventEcho, incomingEvent) {
        const isPermissionRequest = incomingEvent === "PermissionRequest";
        if (responseType === "pre_block_grep" || responseType === "pre_block" || responseType === "pre_ask") {
            // Codex has no documented "ask" primitive — collapse to a hard
            // block. PermissionRequest uses a dedicated decision shape; for
            // PreToolUse the legacy {decision:"block"} form is accepted.
            if (isPermissionRequest) return codexPermissionDeny(data.reason);
            return { decision: "block", reason: data.reason };
        }
        if (responseType === "post_block") {
            // Codex PostToolUse: legacy block shape replaces the tool result
            // with the hook reason and continues the model from there.
            return { decision: "block", reason: data.reason };
        }
        if (responseType === "post_warn") {
            return { hookSpecificOutput: {
                hookEventName: postEventEcho,
                additionalContext: data.summary,
            }};
        }
        if (responseType === "post_success") {
            return { hookSpecificOutput: {
                hookEventName: postEventEcho,
                additionalContext: data.summary,
            }};
        }
        return {};
    }

    function formatProviderResponse(responseType, data) {
        // Resolve the event name to echo. For Claude/Codex, must match the
        // incoming hook_event_name exactly. For Copilot, this is a no-op.
        const incomingEvent = data.hookEventName || hookEvent;
        const isPreEvent = incomingEvent === "PreToolUse" || incomingEvent === "BeforeTool" || incomingEvent === "PermissionRequest";
        const preEventEcho = isPreEvent ? incomingEvent : "PreToolUse";
        const postEventEcho = !isPreEvent ? incomingEvent : "PostToolUse";

        if (detectedClient === "copilot") return formatCopilotResponse(responseType, data);
        if (detectedClient === "codex") return formatCodexResponse(responseType, data, postEventEcho, incomingEvent);
        return formatClaudeResponse(responseType, data, preEventEcho, postEventEcho);
    }`;
