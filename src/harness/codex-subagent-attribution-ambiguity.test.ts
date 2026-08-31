import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCodexSubagentAttribution } from "./codex-subagent-attribution.js";
import type { HarnessEvent } from "./types.js";

const EVENT_TS = "2026-08-30T10:00:05.000Z";

function event(): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "root-thread",
		agent_source: "codex",
		timestamp: EVENT_TS,
		cwd: "/repo",
		tool_name: "Bash",
		tool_input: { command: "npm test" },
	};
}

function rollout(subagentId: string, task: string, callTimestamp: string): string {
	return [
		{
			timestamp: "2026-08-30T10:00:00.000Z",
			type: "session_meta",
			payload: {
				id: subagentId,
				cwd: "/repo",
				source: {
					subagent: {
						thread_spawn: {
							parent_thread_id: "root-thread",
							agent_path: task,
						},
					},
				},
			},
		},
		{
			timestamp: callTimestamp,
			type: "response_item",
			payload: {
				type: "custom_tool_call",
				name: "exec",
				call_id: `call-${subagentId}`,
				input: "const result = await tools.exec_command({cmd: \"npm test\"});",
			},
		},
	].map((row) => JSON.stringify(row)).join("\n");
}

function tempRollout(name: string, text: string): string {
	const dir = mkdtempSync(join(tmpdir(), "codex-attribution-ambiguity-"));
	const path = join(dir, `rollout-${name}.jsonl`);
	writeFileSync(path, text);
	return path;
}

describe("Codex pending-call attribution ambiguity", () => {
	it("declines to guess when indistinguishable pending calls belong to two actors", () => {
		const first = tempRollout(
			"first",
			rollout("child-a", "/root/task_a", "2026-08-30T10:00:04.800Z"),
		);
		const second = tempRollout(
			"second",
			rollout("child-b", "/root/task_b", "2026-08-30T10:00:04.900Z"),
		);

		expect(
			resolveCodexSubagentAttribution(event(), {
				rolloutPaths: [first, second],
				nowMs: Date.parse(EVENT_TS),
			}),
		).toBeNull();
	});

	it("accepts duplicate pending evidence when it identifies one actor", () => {
		const first = tempRollout(
			"first",
			rollout("child-a", "/root/task_a", "2026-08-30T10:00:04.800Z"),
		);
		const duplicate = tempRollout(
			"duplicate",
			rollout("child-a", "/root/task_a", "2026-08-30T10:00:04.900Z"),
		);

		expect(
			resolveCodexSubagentAttribution(event(), {
				rolloutPaths: [first, duplicate],
				nowMs: Date.parse(EVENT_TS),
			})?.subagent_id,
		).toBe("child-a");
	});
});
