import { describe, expect, it } from "vitest";
import { createCodexAdapter } from "./codex.js";

const adapter = createCodexAdapter();

describe("Codex adapter survivor contracts", () => {
    // test-contract: array and null tool inputs are rejected while a real object is preserved.
    it("narrows tool input to non-array objects", () => {
        const arrayEvent = adapter.parseHookInput({ tool_name: "Bash", tool_input: ["x"] }, "PreToolUse");
        const nullEvent = adapter.parseHookInput({ tool_name: "Bash", tool_input: null }, "PreToolUse");
        const objectEvent = adapter.parseHookInput({ tool_name: "Bash", tool_input: { command: "ls" } }, "PreToolUse");
        expect(arrayEvent.action).toMatchObject({ tool_input: {}, tool_input_redacted: {} });
        expect(nullEvent.action).toMatchObject({ tool_input: {} });
        expect(objectEvent.action).toMatchObject({ tool_input: { command: "ls" } });
    });

    // test-contract: PostToolUse alone carries response and error fields; other tool events do not.
    it("adds post-tool response and error only for PostToolUse", () => {
        const post = adapter.parseHookInput(
            { tool_name: "Bash", tool_input: {}, tool_response: "ok", tool_error: "failed" },
            "PostToolUse",
        );
        const pre = adapter.parseHookInput(
            { tool_name: "Bash", tool_input: {}, tool_response: "ok", tool_error: "failed" },
            "PreToolUse",
        );
        expect(post.action).toMatchObject({ tool_response: "ok", tool_error: "failed" });
        expect(pre.action).not.toHaveProperty("tool_response");
        expect(pre.action).not.toHaveProperty("tool_error");
    });

    // test-contract: unknown and non-string tool names use the documented unknown fallback.
    it("normalizes a non-string tool name to unknown", () => {
        const event = adapter.parseHookInput({ tool_name: 42, tool_input: {} }, "PreToolUse");
        expect(event.action).toMatchObject({ kind: "tool_call", tool_name: "unknown" });
    });

    // test-contract: PermissionRequest is a tool action and maps allow to Codex permission output.
    it("keeps PermissionRequest in the tool-call branch", () => {
        const event = adapter.parseHookInput({ tool_name: "Bash", tool_input: {} }, "PermissionRequest");
        expect(event.action.kind).toBe("tool_call");
        expect(JSON.parse(adapter.encodeDecision({ decision: "allow" }, event).stdout ?? "")).toEqual({
            hookSpecificOutput: {
                hookEventName: "PermissionRequest",
                decision: { behavior: "allow" },
            },
        });
    });

    // test-contract: known lifecycle events retain their distinct canonical phases.
    it("uses canonical lifecycle phases", () => {
        expect(adapter.parseHookInput({}, "SessionStart").phase).toBe("session-start");
        expect(adapter.parseHookInput({}, "Stop").phase).toBe("session-end");
        expect(adapter.parseHookInput({}, "PreToolUse").phase).toBe("pre-tool");
    });

    // test-contract: rendered configuration identifies the user path and array-append merge strategy.
    it("renders the stable settings contract", () => {
        const fragment = adapter.renderSettingsFragment("/bin/hook", "user");
        expect(fragment.path).toBe("~/.codex/hooks.json");
        expect(fragment.mergeStrategy).toBe("array-append");
    });

    // test-contract: PostToolUse and non-PostToolUse entries are independently rendered with empty matchers.
    it("renders one matcher entry for every native event", () => {
        const fragment = adapter.renderSettingsFragment("/bin/hook", "project");
        const hooks = (fragment.fragment as { hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string }> }> | undefined> }).hooks;
        const names = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop"];
        for (const name of names) {
            const entry = hooks[name]?.[0];
            expect(entry).toBeDefined();
            expect(entry?.matcher).toBe("");
            expect(entry?.hooks[0]?.type).toBe("command");
        }
    });

    // test-contract: allow diagnostics preserve warning text and append additional context with one newline.
    it("encodes allow diagnostics exactly", () => {
        const event = adapter.parseHookInput({}, "PreToolUse");
        expect(adapter.encodeDecision({ decision: "allow", warnings: ["w1"] }, event).stderr).toBe("w1");
        expect(adapter.encodeDecision({ decision: "allow", additional_context: "context" }, event).stderr).toBe("context");
        expect(adapter.encodeDecision({ decision: "allow", warnings: ["w1"], additional_context: "context" }, event).stderr).toBe("w1\ncontext");
        expect(adapter.encodeDecision({ decision: "allow" }, event)).toEqual({ exit_code: 0 });
    });

    // test-contract: block diagnostics omit stderr without warnings and preserve each warning joined by newline.
    it("encodes block diagnostics exactly", () => {
        const event = adapter.parseHookInput({}, "PreToolUse");
        expect(adapter.encodeDecision({ decision: "block", reason: "no" }, event)).toEqual({
            stdout: JSON.stringify({ decision: "block", reason: "no" }),
            stderr: undefined,
            exit_code: 0,
        });
        expect(adapter.encodeDecision({ decision: "block", reason: "no", warnings: ["w1", "w2"] }, event)).toEqual({
            stdout: JSON.stringify({ decision: "block", reason: "no" }),
            stderr: "w1\nw2",
            exit_code: 0,
        });
    });

    // test-contract: the envelope and unknown-event fallback retain their literal schema and action values.
    it("preserves schema and unknown defaults", () => {
        const event = adapter.parseHookInput({ session_id: "s" }, "Unexpected");
        expect(event.schema_version).toBe("1");
        expect(event.action).toEqual({
            kind: "other",
            subkind: "Unexpected",
            data: { session_id: "s" },
        });
        expect(adapter.parseHookInput({}, "SessionStart").session_id).toBe("unknown");
    });
});
