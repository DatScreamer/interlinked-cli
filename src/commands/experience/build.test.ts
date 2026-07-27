// Experience builder — projects timeline/collection/activity logs into
// trajectory-v1 (Letta interop) and trajectory-ix.v1 (annotated) records.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildExperience } from "./build.js";
import type {
	ExperienceAssistantRecord,
	ExperienceMetaRecord,
	ExperienceToolResultRecord,
	ExperienceUserRecord,
	IxExperienceRecord,
	IxMetaExtras,
} from "./types.js";

const SESSION = "sess-a";

let dir: string;

function writeJsonl(rel: string, rows: object[]): void {
	writeFileSync(join(dir, rel), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

function timelineRow(over: Record<string, unknown>): object {
	return {
		schema: "timeline.v1",
		session: SESSION,
		uuid: `u-${String(over.ts)}`,
		seq: 0,
		provider: "claude-code",
		role: "assistant",
		...over,
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "experience-build-"));
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeBasicTimeline(): void {
	writeJsonl(".interlinked/timeline.jsonl", [
		timelineRow({
			ts: "2026-07-27T10:00:00.000Z",
			category: "user_prompt",
			role: "user",
			text: "Fix the bug.",
			cwd: "/repo",
			git_branch: "main",
		}),
		timelineRow({
			ts: "2026-07-27T10:00:01.000Z",
			category: "agent_thinking",
			model: "model-x",
			text: "Read first, then edit.",
		}),
		timelineRow({
			ts: "2026-07-27T10:00:02.000Z",
			category: "tool_use",
			model: "model-x",
			tool_name: "Bash",
			tool_use_id: "toolu_1",
			tool_input: { command: "npx vitest run src/a.test.ts" },
		}),
		timelineRow({
			ts: "2026-07-27T10:00:03.000Z",
			category: "tool_result",
			role: "user",
			tool_use_id: "toolu_1",
			text: "1 passed",
		}),
		timelineRow({
			ts: "2026-07-27T10:00:04.000Z",
			category: "agent_message",
			model: "model-x",
			text: "Done — test passes.",
		}),
		// Another session's record: must be filtered out.
		timelineRow({
			ts: "2026-07-27T10:00:05.000Z",
			category: "agent_message",
			session: "sess-other",
			text: "not ours",
		}),
	]);
}

describe("buildExperience — letta format", () => {
	it("projects categories onto the trajectory-v1 spine, meta first, other sessions filtered", () => {
		writeBasicTimeline();
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		const roles = built.records.map((r) => r.role);
		expect(roles).toEqual(["meta", "user", "reasoning", "assistant", "tool", "assistant"]);
	});

	it("derives the meta record from the earliest rows carrying each field", () => {
		writeBasicTimeline();
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		// SAFETY: record 0 is the meta record by construction (previous test).
		const meta = built.records[0] as ExperienceMetaRecord;
		expect(meta).toEqual({
			role: "meta",
			source: "claude-code",
			cwd: "/repo",
			git_branch: "main",
			model: "model-x",
		});
	});

	it("carries user content and timestamps through verbatim", () => {
		writeBasicTimeline();
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		// SAFETY: record 1's role is pinned to "user" by the spine-order test.
		const user = built.records[1] as ExperienceUserRecord;
		expect(user.content).toBe("Fix the bug.");
		expect(user.timestamp).toBe("2026-07-27T10:00:00.000Z");
	});

	it("maps tool_use to assistant tool_calls with JSON-encoded args", () => {
		writeBasicTimeline();
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		// SAFETY: record 3's role is pinned to "assistant" by the spine-order test.
		const call = built.records[3] as ExperienceAssistantRecord;
		expect(call.content).toBeNull();
		expect(call.tool_calls).toEqual([
			{
				id: "toolu_1",
				name: "Bash",
				args: JSON.stringify({ command: "npx vitest run src/a.test.ts" }),
			},
		]);
	});

	it("maps tool_result to a tool record linked by tool_call_id", () => {
		writeBasicTimeline();
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		// SAFETY: record 4's role is pinned to "tool" by the spine-order test.
		const result = built.records[4] as ExperienceToolResultRecord;
		expect(result.tool_call_id).toBe("toolu_1");
		expect(result.content).toBe("1 passed");
	});

	it("reports scan diagnostics for a complete read", () => {
		writeBasicTimeline();
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		expect(built.diagnostics.timeline_records).toBe(5);
		expect(built.diagnostics.scan_truncated).toBe(false);
	});

	it("returns empty records with zero diagnostics when no logs exist", () => {
		const built = buildExperience({ dir, sessionId: SESSION, format: "letta" });
		expect(built.records).toEqual([]);
		expect(built.diagnostics.timeline_records).toBe(0);
	});

	it("truncates long tool results with an explicit marker, never silently", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "tool_result",
				role: "user",
				tool_use_id: "toolu_big",
				text: "x".repeat(5000),
			}),
		]);
		const built = buildExperience({
			dir,
			sessionId: SESSION,
			format: "letta",
			truncateChars: 100,
		});
		// SAFETY: the only spine row is a tool_result, so record 1 is the tool record.
		const result = built.records[1] as ExperienceToolResultRecord;
		expect(result.content.startsWith("x".repeat(100))).toBe(true);
		expect(result.content).toContain("[interlinked: truncated 5000 chars total]");
		expect(built.diagnostics.truncated_records).toBe(1);
	});
});

describe("buildExperience — ix format", () => {
	it("joins collection outcomes and guard verdicts by tool_use_id", () => {
		writeBasicTimeline();
		writeJsonl(".interlinked/collection.jsonl", [
			{
				schema: "collection.v1",
				kind: "tool_event",
				ts: "2026-07-27T10:00:03.000Z",
				session_id: SESSION,
				tool_use_id: "toolu_1",
				seq: 7,
				phase: "post",
				outcome: "error",
				tool_class: "shell_exec",
				provider_tool: "Bash",
				action: { command: "npx vitest run src/a.test.ts" },
				observation: { duration_ms: 1234, exit_code: 1 },
			},
		]);
		writeJsonl(".interlinked/activity.jsonl", [
			{
				schema_version: 5,
				ts: "2026-07-27T10:00:02.500Z",
				type: "guard_warn",
				tool: "Bash",
				tool_use_id: "toolu_1",
				guard_decision: "allow",
				guard_rule_id: "builtin-example",
				guard_reason: "careful",
			},
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });

		// SAFETY: spine order pins record 3 to the tool_use (assistant) record.
		const call = built.records[3] as IxExperienceRecord & { ix?: Record<string, unknown> };
		expect(call.ix).toMatchObject({
			seq: 7,
			tool_class: "shell_exec",
			is_verification: true,
			episode: 0,
			guard: { decision: "warn", rule_id: "builtin-example", reason: "careful" },
		});

		// SAFETY: spine order pins record 4 to the tool_result record.
		const result = built.records[4] as IxExperienceRecord & { ix?: Record<string, unknown> };
		expect(result.ix).toMatchObject({ outcome: "error", duration_ms: 1234 });

		expect(built.diagnostics.collection_joined).toBe(1);
		expect(built.diagnostics.guard_joined).toBe(1);
	});

	it("stamps ix_meta counts and increments episodes per user prompt", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "user_prompt",
				role: "user",
				text: "First task",
			}),
			timelineRow({
				ts: "2026-07-27T10:00:01.000Z",
				category: "agent_message",
				text: "ok",
			}),
			timelineRow({
				ts: "2026-07-27T10:00:02.000Z",
				category: "user_prompt",
				role: "user",
				text: "Second task",
			}),
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });
		// SAFETY: ix builds always emit the annotated meta record first.
		const meta = built.records[0] as ExperienceMetaRecord & {
			schema: string;
			ix_meta: IxMetaExtras;
		};
		expect(meta.schema).toBe("trajectory-ix.v1");
		expect(meta.ix_meta.session_id).toBe(SESSION);
		expect(meta.ix_meta.records).toBe(3);
		expect(meta.ix_meta.episodes).toBe(2);
		expect(meta.ix_meta.guard_blocks).toBe(0);

		// SAFETY: fixture order — meta, user, assistant, second user prompt.
		const second = built.records[3] as IxExperienceRecord & { ix?: { episode?: number } };
		expect(second.ix?.episode).toBe(1);
	});

	it("marks blocked calls from guard_block records", () => {
		writeJsonl(".interlinked/timeline.jsonl", [
			timelineRow({
				ts: "2026-07-27T10:00:00.000Z",
				category: "tool_use",
				tool_name: "Bash",
				tool_use_id: "toolu_blocked",
				tool_input: { command: "rm -rf /" },
			}),
		]);
		writeJsonl(".interlinked/activity.jsonl", [
			{
				schema_version: 5,
				ts: "2026-07-27T10:00:00.100Z",
				type: "guard_block",
				tool: "Bash",
				tool_use_id: "toolu_blocked",
				guard_decision: "block",
				guard_rule_id: "builtin-rm-rf",
				guard_reason: "BLOCKED: recursive deletion",
			},
		]);
		const built = buildExperience({ dir, sessionId: SESSION, format: "ix" });
		// SAFETY: the only spine row is the blocked tool_use (assistant) record.
		const call = built.records[1] as IxExperienceRecord & {
			ix?: { guard?: { decision: string; rule_id: string | null } };
		};
		expect(call.ix?.guard).toEqual({
			decision: "block",
			rule_id: "builtin-rm-rf",
			reason: "BLOCKED: recursive deletion",
		});
		// SAFETY: ix builds always emit the annotated meta record first.
		const meta = built.records[0] as ExperienceMetaRecord & { ix_meta: IxMetaExtras };
		expect(meta.ix_meta.guard_blocks).toBe(1);
	});
});
