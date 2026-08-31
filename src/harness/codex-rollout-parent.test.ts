import { describe, expect, it } from "vitest";
import { parseCodexRolloutText } from "./codex-rollout.js";

describe("Codex rollout parent identity", () => {
	it("preserves parent_thread_id on every child timeline record", () => {
		const text = [
			{
				timestamp: "2026-08-30T10:00:00Z",
				type: "session_meta",
				payload: {
					id: "child-thread",
					session_id: "root-thread",
					cwd: "/repo",
					source: {
						subagent: {
							thread_spawn: {
								parent_thread_id: "root-thread",
								agent_nickname: "reviewer",
							},
						},
					},
				},
			},
			{
				timestamp: "2026-08-30T10:00:00.500Z",
				type: "session_meta",
				payload: {
					id: "root-thread",
					session_id: "root-thread",
					cwd: "/repo",
					source: { cli: true },
				},
			},
			{
				timestamp: "2026-08-30T10:00:01Z",
				type: "response_item",
				payload: {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "Done." }],
				},
			},
		].map((entry) => JSON.stringify(entry)).join("\n");

		expect(parseCodexRolloutText(text)).toEqual([
			expect.objectContaining({
				session: "child-thread",
				agent_id: "child-thread",
				parent_agent: "root-thread",
				is_sidechain: true,
			}),
		]);
	});
});
