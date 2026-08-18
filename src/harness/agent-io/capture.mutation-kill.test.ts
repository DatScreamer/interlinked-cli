// ===========================================
// capture.ts — mutation-kill companion
// ===========================================
// Targets the residual mutation survivors on src/harness/agent-io/capture.ts
// (fleet-r3 wave, PASS-1). Each case asserts an exact, pre-existing behavior
// of the capture surface — never "kills mutant <id>" — per
// scratch/fleet-r3/CONTRACT-W6.md's test-contract receipt rule.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../types.js";
import {
	captureAgentIoLifecycle,
	captureAgentIoSpawn,
	spawnPromptRow,
	taskLabelContent,
} from "./capture.js";
import { resetPendingSpawns } from "./pending-spawn.js";
import { readAgentIoRecords } from "./read.js";
import { agentIoLogPath } from "./store.js";
import * as storeModule from "./store.js";

let tmp = "";
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "interlinked-agent-io-mk-"));
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

describe("inputString (via the exported surfaces that call it)", () => {
	// test-contract: boundary — a spawn event whose tool_input is entirely
	// absent must not throw; it degrades to the "no prompt found" placeholder
	// (the optional chaining in `inputString` is what makes that safe).
	it("K1: an entirely-absent tool_input degrades to the unavailable placeholder without throwing", () => {
		const written = captureAgentIoSpawn(ev({ tool_name: "Task" }), tmp);
		expect(written).toBe(1);
		const rows = readAgentIoRecords(tmp);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.content_status).toBe("unavailable");
		expect(rows[0]?.input_capturable).toBe(false);
	});

	// test-contract: boundary — a whitespace-only prompt string is not a real
	// instruction; `inputString` must treat it the same as an absent field
	// (that is the entire point of the `.trim()` check).
	it("K2: a whitespace-only prompt is treated as absent, not as captured content", () => {
		captureAgentIoSpawn(ev({ tool_name: "Agent", tool_input: { prompt: "   " } }), tmp);
		const row = readAgentIoRecords(tmp)[0];
		expect(row?.content_status).toBe("unavailable");
		expect(row?.content).toBeNull();
	});
});

describe("spawnPromptRow — positional field fallbacks (public API)", () => {
	// test-contract: public-api — `firstInputString`'s key order documents
	// that a bare "task" field is a legitimate prompt source; spawnPromptRow
	// must actually reach it, not just list it.
	it("K3: falls back to the 'task' field when prompt/message are absent", () => {
		const row = spawnPromptRow(
			{ ts: "2026-08-14T21:30:56.461Z", seq: null, session: "sess-1", runner: "claude-code", cwd: tmp },
			{ task: "Do the deploy" },
			null,
			null,
		);
		expect(row.raw).toBe("Do the deploy");
		expect(row.content_status).toBe("captured");
	});

	// test-contract: public-api — same contract for the fourth fallback key,
	// "instructions".
	it("K4: falls back to the 'instructions' field when prompt/message/task are absent", () => {
		const row = spawnPromptRow(
			{ ts: "2026-08-14T21:30:56.461Z", seq: null, session: "sess-1", runner: "claude-code", cwd: tmp },
			{ instructions: "Read the spec" },
			null,
			null,
		);
		expect(row.raw).toBe("Read the spec");
		expect(row.content_status).toBe("captured");
	});

	// test-contract: public-api — the placeholder's `uncapturable_reason` is a
	// stable, documented string; it must not silently go blank.
	it("K5: names the exact reason when no prompt field matches at all", () => {
		const row = spawnPromptRow(
			{ ts: "2026-08-14T21:30:56.461Z", seq: null, session: "sess-1", runner: "claude-code", cwd: tmp },
			{},
			null,
			null,
		);
		expect(row.content_status).toBe("unavailable");
		expect(row.uncapturable_reason).toBe("spawn call carried no prompt/message field");
	});
});

describe("taskLabelContent — public API", () => {
	// test-contract: public-api — the function's whole point is that a plain
	// task name (no model/effort) stays a BARE string, not JSON, so a reader
	// doesn't have to JSON.parse the common case.
	it("K6: returns the bare task name when neither model nor reasoning_effort is present", () => {
		expect(taskLabelContent(undefined, "bare")).toBe("bare");
	});

	// test-contract: public-api — model-only input must still serialize (not
	// take the bare-string early exit), with reasoning_effort explicitly null.
	it("K7: serializes {model, reasoning_effort:null} once model is present", () => {
		expect(taskLabelContent({ model: "vendor-llm-5.6-luna" }, "kill_auth_mutants")).toBe(
			JSON.stringify({ task_name: "kill_auth_mutants", model: "vendor-llm-5.6-luna", reasoning_effort: null }),
		);
	});

	// test-contract: public-api — mirror of K7 for the other optional field.
	it("K8: serializes {model:null, reasoning_effort} once reasoning_effort is present", () => {
		expect(taskLabelContent({ reasoning_effort: "high" }, "kill_auth_mutants")).toBe(
			JSON.stringify({ task_name: "kill_auth_mutants", model: null, reasoning_effort: "high" }),
		);
	});
});

describe("rowBase (via captureAgentIoSpawn)", () => {
	// test-contract: invariant — `seq` (the daemon's per-session ordinal) and
	// `session` are the two fields a later reader joins activity.jsonl rows
	// by; a truthy value of either must reach the stored row unchanged.
	it("K9: a real seq and session_id both reach the stored row unchanged", () => {
		captureAgentIoSpawn(
			ev({ tool_name: "Agent", seq: 5, session_id: "sess-99", tool_input: { prompt: "hi" } }),
			tmp,
		);
		const row = readAgentIoRecords(tmp)[0];
		expect(row?.seq).toBe(5);
		expect(row?.session).toBe("sess-99");
	});
});

describe("captureAgentIoSpawn — public API", () => {
	// test-contract: invariant — `event.cwd` must win over the fallback cwd
	// argument when both are set; the fallback exists only for a runner that
	// never sent one.
	it("K10: writes under event.cwd, not the fallback, when both are set", () => {
		const tmp2 = mkdtempSync(join(tmpdir(), "interlinked-agent-io-mk-fallback-"));
		try {
			const written = captureAgentIoSpawn(
				ev({ tool_name: "Agent", cwd: tmp, tool_input: { prompt: "hi" } }),
				tmp2,
			);
			expect(written).toBe(1);
			expect(existsSync(agentIoLogPath(tmp))).toBe(true);
			expect(existsSync(agentIoLogPath(tmp2))).toBe(false);
		} finally {
			rmSync(tmp2, { recursive: true, force: true });
		}
	});

	// test-contract: invariant — `agent_type` is the third-choice label key
	// (sent when subagent_type/task_name are absent); the fallback chain must
	// actually reach it.
	it("K11: falls back to the agent_type field for the spawn label", () => {
		captureAgentIoSpawn(ev({ tool_name: "Agent", tool_input: { agent_type: "reviewer", prompt: "p" } }), tmp);
		const row = readAgentIoRecords(tmp).find((r) => r.kind === "spawn_prompt");
		expect(row?.agent_label).toBe("reviewer");
	});

	// test-contract: invariant — the task_label row's fixed fields (role,
	// source, agent_label_source, content_status) are part of its documented
	// shape (module header: "the label row's content holds the whole triple").
	it("K12: the task_label row carries its fixed field values exactly", () => {
		captureAgentIoSpawn(ev({ tool_name: "Agent", tool_input: { task_name: "abc", prompt: "go" } }), tmp);
		const label = readAgentIoRecords(tmp).find((r) => r.kind === "task_label");
		expect(label?.role).toBe("user");
		expect(label?.source).toBe("spawn_tool");
		expect(label?.agent_label_source).toBe("spawn_tool");
		expect(label?.content_status).toBe("captured");
	});

	// test-contract: invariant — the log callback is a diagnostic surface, not
	// decorative; it must fire exactly when rows were actually written, with
	// the documented text.
	it("K13: logs the exact row count and tool name when rows were written", () => {
		const logs: string[] = [];
		const written = captureAgentIoSpawn(
			ev({
				tool_name: "Agent",
				tool_input: { subagent_type: "fork", description: "audit", prompt: "Do the thing carefully" },
			}),
			tmp,
			(m) => logs.push(m),
		);
		expect(written).toBe(2);
		expect(logs).toEqual(["Agent I/O: 2 input row(s) from Agent"]);
	});

	// test-contract: invariant — the log gate is `written > 0`; when the store
	// reports zero rows written, nothing should be logged.
	it("K14: logs nothing when the store reports zero rows written", () => {
		const spy = vi.spyOn(storeModule, "recordAgentIo").mockReturnValue(0);
		try {
			const logs: string[] = [];
			const written = captureAgentIoSpawn(
				ev({ tool_name: "Agent", tool_input: { prompt: "hi" } }),
				tmp,
				(m) => logs.push(m),
			);
			expect(written).toBe(0);
			expect(logs).toHaveLength(0);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("stopRows (via captureAgentIoLifecycle SubagentStop)", () => {
	// test-contract: invariant — `extras.finalMessage` is the caller-resolved
	// payload text; when it is absent, no final_message row may appear (no
	// fabricated content).
	it("K15: skips the final_message row entirely when extras carry none", () => {
		const path = transcript([{ type: "user", message: { role: "user", content: "go" } }]);
		const written = captureAgentIoLifecycle(
			ev({ hook_event: "SubagentStop", subagent_id: "aX", agent_transcript_path: path }),
			tmp,
			{},
		);
		expect(written).toBe(1);
		expect(readAgentIoRecords(tmp).map((r) => r.kind)).toEqual(["spawn_prompt"]);
	});

	// test-contract: boundary — a transcript path that does not resolve to a
	// real file (deleted / never written) must degrade to payload-only output,
	// per the module header's "fail-open, best-effort" contract — never throw.
	it("K16: an unreadable transcript path degrades to payload-only output", () => {
		const missingPath = join(tmp, "does-not-exist.jsonl");
		const written = captureAgentIoLifecycle(
			ev({ hook_event: "SubagentStop", subagent_id: "aY", agent_transcript_path: missingPath }),
			tmp,
			{ finalMessage: { text: "done", source: "payload" } },
		);
		expect(written).toBe(1);
		expect(readAgentIoRecords(tmp).map((r) => r.kind)).toEqual(["final_message"]);
	});

	// test-contract: invariant — every row `stopRows` emits carries the SAME
	// identity (agent_id/agent_label/agent_label_source) and the correct
	// role/content_status for its own kind, per the agent-io.v1 record shape.
	it("K17: every stop row carries the exact identity, role and content_status for its kind", () => {
		const path = transcript([
			{ type: "user", message: { role: "user", content: "original instruction" } },
			{
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "tool_use", id: "t1", name: "StructuredOutput", input: { ok: true } }],
				},
			},
		]);
		captureAgentIoLifecycle(
			ev({ hook_event: "SubagentStop", subagent_id: "aZ", agent_transcript_path: path }),
			tmp,
			{
				finalMessage: { text: "final text", source: "payload" },
				agentLabel: "some-label",
				agentLabelSource: "start_event",
			},
		);
		const rows = readAgentIoRecords(tmp);
		expect(rows).toHaveLength(3);
		for (const row of rows) {
			expect(row.agent_id).toBe("aZ");
			expect(row.agent_label).toBe("some-label");
			expect(row.agent_label_source).toBe("start_event");
		}
		const final = rows.find((r) => r.kind === "final_message");
		expect(final?.role).toBe("assistant");
		expect(final?.content_status).toBe("captured");
		const structured = rows.find((r) => r.kind === "structured_result");
		expect(structured?.role).toBe("assistant");
		expect(structured?.content_status).toBe("captured");
		const prompt = rows.find((r) => r.kind === "spawn_prompt");
		expect(prompt?.role).toBe("user");
		expect(prompt?.content_status).toBe("captured");
	});
});

describe("startRow (via captureAgentIoLifecycle SubagentStart)", () => {
	// test-contract: boundary — a SubagentStart with no matching pending spawn
	// (nothing remembered, or a type mismatch) must still write the identity
	// row with a null bridge id — never throw.
	it("K18: writes the identity row with a null spawn_tool_use_id when nothing is pending", () => {
		const written = captureAgentIoLifecycle(ev({ hook_event: "SubagentStart", subagent_id: "b1" }), tmp);
		expect(written).toBe(1);
		const row = readAgentIoRecords(tmp)[0];
		expect(row?.spawn_tool_use_id).toBeNull();
	});

	// test-contract: invariant — the identity row's fixed fields are its
	// entire documented purpose (module header: "the identity row… keeps the
	// gap visible"); every one of them must hold its exact value.
	it("K19: the identity row carries its exact kind/role/source/label/reason", () => {
		captureAgentIoLifecycle(
			ev({ hook_event: "SubagentStart", subagent_id: "b2" }),
			tmp,
			{ agentLabel: "worker-x" },
		);
		const row = readAgentIoRecords(tmp)[0];
		expect(row?.kind).toBe("spawn_prompt");
		expect(row?.role).toBe("user");
		expect(row?.source).toBe("payload");
		expect(row?.agent_label).toBe("worker-x");
		expect(row?.agent_label_source).toBe("payload");
		expect(row?.uncapturable_reason).toBe(
			"SubagentStart carries no prompt; the spawn call and the transcript head are the capture points",
		);
	});
});

describe("captureAgentIoLifecycle — public API", () => {
	// test-contract: invariant — the hook_event guard is what keeps an
	// unrelated lifecycle event (SessionStart, etc.) from ever reaching
	// stopRows; this must hold even when extras happen to carry a message.
	it("K20: a non-lifecycle hook event writes nothing, even with a final message in extras", () => {
		const written = captureAgentIoLifecycle(
			ev({ hook_event: "SessionStart", subagent_id: "should-be-ignored" }),
			tmp,
			{ finalMessage: { text: "leaked", source: "payload" } },
		);
		expect(written).toBe(0);
		expect(existsSync(agentIoLogPath(tmp))).toBe(false);
	});

	// test-contract: invariant — the SubagentStop log line names every row
	// kind written, comma-separated, in push order — the diagnostic text a
	// human reads when triaging a capture gap.
	it("K21: SubagentStop logs the exact row count, agent id and comma-joined kinds", () => {
		const path = transcript([
			{ type: "user", message: { role: "user", content: "go" } },
			{
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "tool_use", id: "t1", name: "StructuredOutput", input: { ok: true } }],
				},
			},
		]);
		const logs: string[] = [];
		const written = captureAgentIoLifecycle(
			ev({ hook_event: "SubagentStop", subagent_id: "c2", agent_transcript_path: path }),
			tmp,
			{ finalMessage: { text: "done", source: "payload" } },
			(m) => logs.push(m),
		);
		expect(written).toBe(3);
		expect(logs).toEqual(["Agent I/O: 3 row(s) for c2 (final_message, structured_result, spawn_prompt)"]);
	});

	// test-contract: invariant — same log gate as K14, for the SubagentStop
	// branch's own `written > 0` check.
	it("K22: SubagentStop logs nothing when the store reports zero rows written", () => {
		const path = transcript([{ type: "user", message: { role: "user", content: "go" } }]);
		const spy = vi.spyOn(storeModule, "recordAgentIo").mockReturnValue(0);
		try {
			const logs: string[] = [];
			const written = captureAgentIoLifecycle(
				ev({ hook_event: "SubagentStop", subagent_id: "c3", agent_transcript_path: path }),
				tmp,
				{ finalMessage: { text: "done", source: "payload" } },
				(m) => logs.push(m),
			);
			expect(written).toBe(0);
			expect(logs).toHaveLength(0);
		} finally {
			spy.mockRestore();
		}
	});

	// test-contract: invariant — the SubagentStart branch logs a distinct,
	// shorter message ("identity row for …") than the Stop branch.
	it("K23: SubagentStart logs the exact identity-row message", () => {
		const logs: string[] = [];
		const written = captureAgentIoLifecycle(
			ev({ hook_event: "SubagentStart", subagent_id: "c4" }),
			tmp,
			{},
			(m) => logs.push(m),
		);
		expect(written).toBe(1);
		expect(logs).toEqual(["Agent I/O: identity row for c4"]);
	});

	// test-contract: invariant — same log gate as K14/K22, for the
	// SubagentStart branch's own `written > 0` check.
	it("K24: SubagentStart logs nothing when the store reports zero rows written", () => {
		const spy = vi.spyOn(storeModule, "recordAgentIo").mockReturnValue(0);
		try {
			const logs: string[] = [];
			const written = captureAgentIoLifecycle(
				ev({ hook_event: "SubagentStart", subagent_id: "c5" }),
				tmp,
				{},
				(m) => logs.push(m),
			);
			expect(written).toBe(0);
			expect(logs).toHaveLength(0);
		} finally {
			spy.mockRestore();
		}
	});

	// test-contract: invariant — mirror of K10 for the lifecycle entry point:
	// event.cwd must win over the fallback cwd for SubagentStart too.
	it("K25: SubagentStart writes under event.cwd, not the fallback, when both are set", () => {
		const tmp2 = mkdtempSync(join(tmpdir(), "interlinked-agent-io-mk-fallback2-"));
		try {
			const written = captureAgentIoLifecycle(
				ev({ hook_event: "SubagentStart", subagent_id: "c6", cwd: tmp }),
				tmp2,
			);
			expect(written).toBe(1);
			expect(existsSync(agentIoLogPath(tmp))).toBe(true);
			expect(existsSync(agentIoLogPath(tmp2))).toBe(false);
		} finally {
			rmSync(tmp2, { recursive: true, force: true });
		}
	});
});
