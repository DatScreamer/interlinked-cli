// Extracted from hooks-template.ts.
// This is DATA — the body of the generated `.interlinked/hooks/interlinked-activity.mjs`.
// This chunk is nested inside `main()` in the generated script, so its leading
// indentation (4 spaces) is part of the emitted source.

/** Public API — consumed by buildHookScript in hooks-template.ts. */
export const PROVIDER_RESPONSES_CHUNK = `    // ═══════════════════════════════════════════
    // Provider-specific response formatting
    // ═══════════════════════════════════════════
    // Each provider expects a different stdout JSON shape.
    // The harness returns a provider-agnostic HarnessDecision; this function
    // translates it into the format each agent understands.
    //
    // CRITICAL: Claude Code validates hookSpecificOutput.hookEventName against
    // the incoming event name. Responses must echo back the actual event
    // (PostToolUse vs PostToolUseFailure, PreToolUse vs PermissionRequest)
    // or Claude Code rejects them with "Hook returned incorrect event name".
    function formatProviderResponse(responseType, data) {
        // Resolve the event name to echo. For Claude, must match the incoming
        // hook_event_name exactly. For other providers (Copilot), this is a no-op.
        const incomingEvent = data.hookEventName || hookEvent;
        const isPreEvent = incomingEvent === "PreToolUse" || incomingEvent === "BeforeTool" || incomingEvent === "PermissionRequest";
        const preEventEcho = isPreEvent ? incomingEvent : "PreToolUse";
        const postEventEcho = !isPreEvent ? incomingEvent : "PostToolUse";

        switch (detectedClient) {
            case "copilot":
                switch (responseType) {
                    case "pre_block":
                    case "pre_block_grep":
                    case "pre_ask":
                        // Copilot has no "ask" primitive — collapse to deny.
                        // User must retry after inspecting the reason.
                        return { permissionDecision: "deny", permissionDecisionReason: data.reason };
                    case "post_block":
                        // Copilot postToolUse is observation-only — write to stderr instead
                        if (data.reason) process.stderr.write(data.reason + "\\n");
                        return {};
                    case "post_success":
                        return {};
                    default:
                        return {};
                }
            case "claude":
            default:
                switch (responseType) {
                    case "pre_block_grep":
                        return { hookSpecificOutput: {
                            hookEventName: preEventEcho,
                            permissionDecision: "deny",
                            permissionDecisionReason: data.reason,
                        }};
                    case "pre_block":
                        return { decision: "block", reason: data.reason };
                    case "pre_ask": {
                        // Surface Claude Code's permission prompt so the user
                        // confirms per-call. Matches pre_block registry phase.
                        //
                        // \`systemMessage\` (top-level, universal) is the
                        // user-only channel per the Claude Code hooks reference
                        // — shown in the permission UI but NOT included in the
                        // model's context window. The content scanner uses it
                        // to surface raw flagged PII values while keeping
                        // permissionDecisionReason agent-safe.
                        const askResp = { hookSpecificOutput: {
                            hookEventName: preEventEcho,
                            permissionDecision: "ask",
                            permissionDecisionReason: data.reason,
                        }};
                        if (data.systemMessage) askResp.systemMessage = data.systemMessage;
                        return askResp;
                    }
                    case "post_block":
                        return { decision: "block", reason: data.reason };
                    case "post_success":
                        return { hookSpecificOutput: {
                            hookEventName: postEventEcho,
                            additionalContext: data.summary,
                        }};
                    default:
                        return {};
                }
        }
    }`;
