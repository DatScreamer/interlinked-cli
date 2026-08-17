import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HarnessEvent } from "../types.js";
import { captureAgentIoLifecycle, captureAgentIoSpawn } from "./capture.js";
import { resetPendingSpawns } from "./pending-spawn.js";
import { readAgentIoRecords } from "./read.js";
import { agentIoLogPath } from "./store.js";

let tmp = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-agent-io-"));
	resetPendingSpawns();
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function ev(partial: Partial<HarnessEvent> = {}): HarnessEvent {
	return {
		hook_event: "PreToolUse",
		session_id: "sess-1",
		agent_source: "claude",
		timestamp: "2026-08-14T21:30:56.461Z",
		cwd: tmp,
		...partial,
	};
}

/** A minimal but shape-faithful sub-agent transcript. */
function transcript(lines: object[]): string {
	const path = join(tmp, "agent-abc.jsonl");
	writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	return path;
}

describe("captureAgentIoSpawn — positive (must fire)", () => {
	it("P1: captures the Claude Agent prompt as a spawn_prompt input row", () => {
		const written = captureAgentIoSpawn(
			ev({
				tool_name: "Agent",
				tool_use_id: "toolu_1",
				tool_input: { subagent_type: "fork", description: "audit", prompt: "Do the thing carefully" },
			}),
			tmp,
		);
		expect(written).toBe(2);
		const rows = readAgentIoRecords(tmp);
		const prompt = rows.find((r) => r.kind === "spawn_prompt");
		expect(prompt?.content).toBe("Do the thing carefully");
		expect(prompt?.direction).toBe("input");
		expect(prompt?.source).toBe("spawn_tool");
		expect(prompt?.spawn_tool_use_id).toBe("toolu_1");
		expect(prompt?.agent_label).toBe("fork");
		expect(prompt?.content_status).toBe("captured");
		expect(prompt?.input_capturable).toBe(true);
		expect(prompt?.content_sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("P2: records the Codex task label AND a typed placeholder for the encrypted message", () => {
		const written = captureAgentIoSpawn(
			ev({
				agent_source: "codex",
				tool_name: "collaborationspawn_agent",
				tool_use_id: "call_9",
				tool_input: {
					task_name: "kill_auth_mutants",
					model: "vendor-llm-5.6-luna",
					reasoning_effort: "high",
					message: "gAAAAABo1234encryptedpayload",
				},
			}),
			tmp,
		);
		expect(written).toBe(2);
		const rows = readAgentIoRecords(tmp);
		const label = rows.find((r) => r.kind === "task_label");
		expect(label?.runner).toBe("codex");
		expect(label?.content).toContain("kill_auth_mutants");
		expect(label?.content).toContain("vendor-llm-5.6-luna");
		expect(label?.agent_label).toBe("kill_auth_mutants");

		const prompt = rows.find((r) => r.kind === "spawn_prompt");
		expect(prompt?.content).toBeNull();
		expect(prompt?.content_status).toBe("encrypted_by_runner");
		expect(prompt?.input_capturable).toBe(false);
		expect(prompt?.uncapturable_reason).toMatch(/Fernet/);
		// The row still exists: the gap is a recorded fact, not a missing row.
		expect(prompt?.content_sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("P3: records an 'unavailable' placeholder when the spawn call carries no prompt at all", () => {
		captureAgentIoSpawn(ev({ tool_name: "Task", tool_input: { subagent_type: "worker" } }), tmp);
		const rows = readAgentIoRecords(tmp);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.content_status).toBe("unavailable");
		expect(rows[0]?.input_capturable).toBe(false);
	});
});

describe("captureAgentIoSpawn — negative (must not fire)", () => {
	it("N1: writes nothing for a non-spawn tool", () => {
		expect(captureAgentIoSpawn(ev({ tool_name: "Write", tool_input: { prompt: "x" } }), tmp)).toBe(0);
		expect(existsSync(agentIoLogPath(tmp))).toBe(false);
	});

	it("N2: writes nothing on a dry-run event — no log, no directory", () => {
		const written = captureAgentIoSpawn(
			ev({ tool_name: "Agent", dry_run: true, tool_input: { prompt: "simulated" } }),
			tmp,
		);
		expect(written).toBe(0);
		expect(existsSync(agentIoLogPath(tmp))).toBe(false);
		expect(existsSync(join(tmp, ".interlinked", "agent-io"))).toBe(false);
	});

	it("N3: writes nothing on PostToolUse of a spawn tool (input is a PreToolUse fact)", () => {
		expect(
			captureAgentIoSpawn(ev({ hook_event: "PostToolUse", tool_name: "Agent", tool_input: { prompt: "x" } }), tmp),
		).toBe(0);
	});
});

describe("captureAgentIoLifecycle — positive (must fire)", () => {
	it("P4: SubagentStart writes the identity row and binds the pending spawn call", () => {
		captureAgentIoSpawn(
			ev({ tool_name: "Agent", tool_use_id: "toolu_7", tool_input: { subagent_type: "fork", prompt: "p" } }),
			tmp,
		);
		const written = captureAgentIoLifecycle(
			ev({ hook_event: "SubagentStart", subagent_id: "a1", agent_type: "fork" }),
			tmp,
			{ agentLabel: "fork" },
		);
		expect(written).toBe(1);
		const identity = readAgentIoRecords(tmp).find((r) => r.agent_id === "a1");
		expect(identity?.spawn_tool_use_id).toBe("toolu_7");
		expect(identity?.content_status).toBe("unavailable");
		expect(identity?.input_capturable).toBe(false);
	});

	it("P5: SubagentStop writes final_message, structured_result and the transcript-head prompt", () => {
		const path = transcript([
			{ type: "user", message: { role: "user", content: "The original instruction" } },
			{
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "tool_use", id: "t1", name: "StructuredOutput", input: { verdict: "ok", n: 3 } }],
				},
			},
			{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "All green." }] } },
		]);
		const written = captureAgentIoLifecycle(
			ev({ hook_event: "SubagentStop", subagent_id: "a2", agent_transcript_path: path }),
			tmp,
			{
				finalMessage: { text: "All green.", source: "payload" },
				agentLabel: "general-purpose",
				agentLabelSource: "start_event",
			},
		);
		expect(written).toBe(3);
		const rows = readAgentIoRecords(tmp);
		expect(rows.map((r) => r.kind).sort()).toEqual(["final_message", "spawn_prompt", "structured_result"]);
		const structured = rows.find((r) => r.kind === "structured_result");
		expect(structured?.content).toBe(JSON.stringify({ verdict: "ok", n: 3 }));
		expect(structured?.source).toBe("structured_output");
		const prompt = rows.find((r) => r.kind === "spawn_prompt");
		expect(prompt?.content).toBe("The original instruction");
		expect(prompt?.source).toBe("transcript");
		expect(prompt?.direction).toBe("input");
	});

	it("P6: carries token totals and tool_use_ids onto the output rows", () => {
		const path = transcript([{ type: "user", message: { role: "user", content: "go" } }]);
		captureAgentIoLifecycle(
			ev({ hook_event: "SubagentStop", subagent_id: "a3", agent_transcript_path: path }),
			tmp,
			{
				finalMessage: { text: "done", source: "transcript" },
				metrics: {
					assistant_turns: 2,
					tool_calls: 1,
					tools: { Read: 1 },
					tool_use_ids: ["toolu_a"],
					tool_use_ids_truncated: false,
					models: ["claude-test-5"],
					tokens: { input: 10, output: 20, cache_read: 30, cache_creation: 40 },
					thinking_blocks: 0,
					thinking_blocks_with_text: 0,
					first_ts: null,
					last_ts: null,
					duration_ms: null,
					transcript_entries: 1,
				},
			},
		);
		const final = readAgentIoRecords(tmp).find((r) => r.kind === "final_message");
		expect(final?.tokens).toEqual({ input: 10, output: 20, cache_read: 30, cache_creation: 40 });
		expect(final?.tool_use_ids).toEqual(["toolu_a"]);
	});
});

describe("captureAgentIoLifecycle — negative (must not fire)", () => {
	it("N4: writes nothing on a dry-run stop event", () => {
		const path = transcript([{ type: "user", message: { role: "user", content: "go" } }]);
		const written = captureAgentIoLifecycle(
			ev({ hook_event: "SubagentStop", subagent_id: "a4", agent_transcript_path: path, dry_run: true }),
			tmp,
			{ finalMessage: { text: "done", source: "payload" } },
		);
		expect(written).toBe(0);
		expect(existsSync(agentIoLogPath(tmp))).toBe(false);
	});

	it("N5: writes nothing for an unrelated lifecycle event", () => {
		expect(captureAgentIoLifecycle(ev({ hook_event: "SessionStart" }), tmp)).toBe(0);
	});

	it("N6: emits no structured_result row when the agent returned prose only", () => {
		const path = transcript([
			{ type: "user", message: { role: "user", content: "go" } },
			{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "prose only" }] } },
		]);
		captureAgentIoLifecycle(ev({ hook_event: "SubagentStop", subagent_id: "a5", agent_transcript_path: path }), tmp, {
			finalMessage: { text: "prose only", source: "payload" },
		});
		const kinds = readAgentIoRecords(tmp).map((r) => r.kind);
		expect(kinds).not.toContain("structured_result");
	});
});
