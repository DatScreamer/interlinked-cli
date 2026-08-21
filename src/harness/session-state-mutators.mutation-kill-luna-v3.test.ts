import { describe, expect, it } from "vitest";
import {
    acknowledgeChecks,
    appendStubsCapped,
    createFreshSession,
    isAcknowledged,
    trackCommand,
    trackFileOperations,
    trackToolCall,
} from "./session-state-mutators.js";
import type { HarnessEvent } from "./types.js";

function event(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
    return {
        hook_event: "PostToolUse",
        session_id: "session-1",
        agent_source: "claude",
        timestamp: "2026-08-20T00:00:00.000Z",
        cwd: "/repo",
        ...overrides,
    };
}

describe("session state mutators", () => {
    // test-contract: a fresh trajectory preserves explicit agent identity and false boolean defaults.
    it("creates the documented fresh-session defaults", () => {
        const session = createFreshSession(event({ agent_name: "agent" }), "session-1");
        expect(session.agent_name).toBe("agent");
        expect(session.mid_session_nudge_emitted).toBe(false);
        expect(session.stop_nudge_emitted).toBe(false);
    });

    // test-contract: a two-segment path is retained as-is while longer paths are shortened to their final two segments.
    it("uses the two-segment boundary in tool sequence targets", () => {
        const session = createFreshSession(event(), "session-1");
        trackToolCall(session, event({ tool_name: "Read", tool_input: { file_path: "src/file.ts" } }));
        expect(session.tool_sequence).toEqual(["Read:src/file.ts"]);
    });

    // test-contract: command truncation occurs only beyond 200 characters, preserving an exact 200-character command.
    it("preserves a command of exactly 200 characters", () => {
        const session = createFreshSession(event(), "session-1");
        const command = "x".repeat(200);
        trackCommand(session, event({ tool_name: "Bash", tool_input: { command } }));
        expect(session.commands_run).toEqual([command]);
    });

    // test-contract: the command ring retains exactly 100 entries before evicting the oldest entry.
    it("retains exactly 100 command entries at the ring boundary", () => {
        const session = createFreshSession(event(), "session-1");
        for (let index = 0; index < 100; index++) {
            trackCommand(session, event({ tool_name: "Bash", tool_input: { command: `echo ${index}` } }));
        }
        expect(session.commands_run).toHaveLength(100);
        expect(session.commands_run[0]).toBe("echo 0");
        expect(session.commands_run[99]).toBe("echo 99");
    });

    // test-contract: a relative read records both the raw path and its cwd-resolved absolute path.
    it("records both forms of a relative read path", () => {
        const session = createFreshSession(event(), "session-1");
        trackFileOperations(session, event({
            tool_name: "Read",
            tool_input: { file_path: "src/file.ts" },
        }));
        expect(session.files_read.has("src/file.ts")).toBe(true);
        expect(session.files_read.has("/repo/src/file.ts")).toBe(true);
    });

    // test-contract: the tool sequence keeps its newest 20 entries and drops the oldest only after exceeding that bound.
    it("keeps exactly 20 tool sequence entries", () => {
        const session = createFreshSession(event(), "session-1");
        for (let index = 0; index < 20; index++) {
            trackToolCall(session, event({ tool_name: "Read", tool_input: { file_path: `file-${index}.ts` } }));
        }
        expect(session.tool_sequence).toHaveLength(20);
        expect(session.tool_sequence[0]).toBe("Read:file-0.ts");
        expect(session.tool_sequence[19]).toBe("Read:file-19.ts");
    });

    // test-contract: an empty introduced-stub list is a valid no-op and does not allocate a destination list.
    it("does not allocate stubs for an empty source", () => {
        const from = createFreshSession(event(), "from");
        const to = createFreshSession(event(), "to");
        delete to.stubs_introduced;
        appendStubsCapped(from, to);
        expect(to.stubs_introduced).toBeUndefined();
    });

    // test-contract: a missing tool name is ignored by command tracking rather than being classified as a shell tool.
    it("ignores commands without a tool name", () => {
        const session = createFreshSession(event(), "session-1");
        trackCommand(session, event({ tool_input: { command: "npm test" } }));
        expect(session.commands_run).toEqual([]);
    });

    // test-contract: a missing tool name is ignored by read/write tracking rather than being classified as a read operation.
    it("ignores file operations without a tool name", () => {
        const session = createFreshSession(event(), "session-1");
        trackFileOperations(session, event({ tool_input: { file_path: "src/file.ts" } }));
        expect(session.files_read.size).toBe(0);
        expect(session.files_written.size).toBe(0);
    });

    // test-contract: acknowledgement records the canonical file-check key and remains queryable until an edit clears it.
    it("acknowledges and queries a file check", () => {
        const session = createFreshSession(event(), "session-1");
        acknowledgeChecks(session, "src/file.ts", ["lint"]);
        expect(isAcknowledged(session, "src/file.ts", "lint")).toBe(true);
        expect(isAcknowledged(session, "src/file.ts", "test")).toBe(false);
    });
});