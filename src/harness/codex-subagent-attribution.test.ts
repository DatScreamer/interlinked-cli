import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessEvent } from "./types.js";
import {
    enrichCodexSubagentAttribution,
    parseCodexAttributionRollout,
    resolveCodexSubagentAttribution,
} from "./codex-subagent-attribution.js";
import { eventAttributionFields } from "./event-attribution-fields.js";

const TS = "2026-08-20T15:48:53.313Z";

function event(overrides: Partial<HarnessEvent> = {}): HarnessEvent {
    return {
        hook_event: "PreToolUse",
        session_id: "parent-thread",
        agent_source: "codex",
        timestamp: TS,
        cwd: "/repo",
        tool_name: "Bash",
        tool_input: { command: "sed -n '1,40p' src/a.ts" },
        tool_use_id: "exec-123",
        ...overrides,
    };
}

function rollout(options: { completed?: boolean; subagent?: boolean } = {}): string {
    const source = options.subagent === false
        ? { cli: true }
        : {
                subagent: {
                    thread_spawn: {
                        parent_thread_id: "parent-thread",
                        agent_path: "/root/kill_a_survivors",
                        agent_nickname: "Curie",
                    },
                },
            };
    const rows: unknown[] = [
        {
            timestamp: "2026-08-20T15:48:40.000Z",
            type: "session_meta",
            payload: { id: "sub-thread", source, cwd: "/repo" },
        },
        {
            timestamp: "2026-08-20T15:48:41.000Z",
            type: "turn_context",
            payload: { model: "gpt-5.6-luna", effort: "medium" },
        },
        {
            timestamp: "2026-08-20T15:48:53.263Z",
            type: "response_item",
            payload: {
                type: "custom_tool_call",
                name: "exec",
                call_id: "call-1",
                input: "const r = await tools.exec_command({cmd:\"sed -n '1,40p' src/a.ts\"});",
            },
        },
    ];
    if (options.completed) {
        rows.push({
            timestamp: "2026-08-20T15:48:54.742Z",
            type: "event_msg",
            payload: { type: "item_completed", item: { type: "CommandExecution", id: "exec-123" } },
        });
    }
    return rows.map((row) => JSON.stringify(row)).join("\n");
}

function tempRollout(text: string): string {
    const dir = mkdtempSync(join(tmpdir(), "codex-attribution-"));
    const path = join(dir, "rollout-test.jsonl");
    writeFileSync(path, text);
    return path;
}

describe("parseCodexAttributionRollout", () => {
    it("reads current Codex thread_spawn identity, model, cwd, and execution ids", () => {
        const parsed = parseCodexAttributionRollout(rollout({ completed: true }));
        expect(parsed.attribution).toEqual({
            subagent_id: "sub-thread",
            agent_name: "/root/kill_a_survivors",
            parent_agent: "parent-thread",
            model: "gpt-5.6-luna",
        });
        expect(parsed.cwd).toBe("/repo");
        expect(parsed.executionIds.has("exec-123")).toBe(true);
    });

    it("does not invent attribution for a root Codex rollout", () => {
        expect(parseCodexAttributionRollout(rollout({ subagent: false })).attribution).toBeNull();
    });
});

describe("resolveCodexSubagentAttribution", () => {
    it("uses the exact completed execution id for PostToolUse", () => {
        const path = tempRollout(rollout({ completed: true }));
        const resolved = resolveCodexSubagentAttribution(
            event({ hook_event: "PostToolUse" }),
            { rolloutPaths: [path], nowMs: Date.parse(TS) },
        );
        expect(resolved?.subagent_id).toBe("sub-thread");
        expect(resolved?.model).toBe("gpt-5.6-luna");
    });

    it("matches the pending rollout call for PreToolUse before completion", () => {
        const path = tempRollout(rollout());
        expect(
            resolveCodexSubagentAttribution(event(), {
                rolloutPaths: [path],
                nowMs: Date.parse(TS),
            })?.agent_name,
        ).toBe("/root/kill_a_survivors");
    });

    it("rejects a pending call from another cwd or with another command", () => {
        const path = tempRollout(rollout());
        expect(resolveCodexSubagentAttribution(event({ cwd: "/other" }), { rolloutPaths: [path] })).toBeNull();
        expect(
            resolveCodexSubagentAttribution(
                event({ tool_input: { command: "npm test" } }),
                { rolloutPaths: [path] },
            ),
        ).toBeNull();
    });

    it("preserves native fields and fills only missing identity", () => {
        const path = tempRollout(rollout({ completed: true }));
        const target = event({ agent_name: "native-name" });
        enrichCodexSubagentAttribution(target, { rolloutPaths: [path] });
        expect(target.agent_name).toBe("native-name");
        expect(eventAttributionFields(target)).toEqual({
            subagent_id: "sub-thread",
            model: "gpt-5.6-luna",
            parent_agent: "parent-thread",
        });
    });
});
