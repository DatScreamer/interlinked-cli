import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildStandardAction, normalizeNativeHookEvent, normalizeToolName } from "./normalization.js";
import { CODEX_CAPABILITIES } from "./provider-capabilities.js";

function normalize(nativeJson: unknown, nativeEventName = "PreToolUse") {
	return normalizeNativeHookEvent({
		runner: "codex",
		capabilities: CODEX_CAPABILITIES,
		nativeEventName,
		nativeJson,
		now: () => new Date("2026-08-30T12:34:56.000Z"),
		makeEventId: () => "evt-fixed",
		buildAction: ({ raw, phase }) =>
			buildStandardAction({ raw, phase, nativeEventName }),
	});
}

describe("normalizeNativeHookEvent", () => {
	it("constructs a deterministic canonical envelope with provider metadata", () => {
		const event = normalize({
			sessionId: "session-1",
			cwd: "/repo",
			workspaceRoot: "/repo",
			toolUseId: "tool-1",
			turnId: "turn-1",
			parentEventId: "parent-1",
			cli_version: "1.2.3",
			model: "vendor-model-v6",
			transcriptPath: "/tmp/t.jsonl",
			permissionMode: "default",
			agentId: "agent-1",
			agentRole: "reviewer",
			toolName: "ApplyPatch",
			toolInput: { patch: "*** Begin Patch" },
		});
		expect(event).toMatchObject({
			schema_version: "1",
			event_id: "evt-fixed",
			session_id: "session-1",
			tool_use_id: "tool-1",
			turn_id: "turn-1",
			parent_event_id: "parent-1",
			runner_version: "1.2.3",
			ts: "2026-08-30T12:34:56.000Z",
			runner: "codex",
			phase: "pre-tool",
			action: { kind: "tool_call", tool_name: "apply_patch" },
			context: {
				cwd: "/repo",
				workspace_root: "/repo",
				model: "vendor-model-v6",
				transcript_path: "/tmp/t.jsonl",
				permission_mode: "default",
				agent: { id: "agent-1", role: "reviewer" },
			},
		});
	});

	it("falls back safely for non-object payloads and unknown events", () => {
		const event = normalize(null, "FutureEvent");
		expect(event).toMatchObject({
			session_id: "unknown",
			phase: "other",
			action: { kind: "other", subkind: "FutureEvent", data: {} },
		});
	});

	it("keeps post-compaction distinct from pre-compaction", () => {
		expect(normalize({}, "PreCompact").phase).toBe("pre-compact");
		expect(normalize({}, "PostCompact").phase).toBe("post-compact");
	});
});

describe("normalizeToolName properties", () => {
	it("is idempotent for arbitrary Unicode strings", () => {
		fc.assert(
			fc.property(fc.string(), (value) => {
				const once = normalizeToolName(value);
				expect(normalizeToolName(once)).toBe(once);
			}),
		);
	});

	it("normalizes common provider spellings to the same value", () => {
		expect(["ApplyPatch", "apply-patch", "apply.patch", "apply patch"].map(normalizeToolName)).toEqual([
			"apply_patch",
			"apply_patch",
			"apply_patch",
			"apply_patch",
		]);
	});
});
