import { describe, expect, it } from "vitest";
import {
	type AgentTranscriptMetrics,
	emptyAgentMetrics,
	MAX_TOOL_USE_IDS,
	summarizeAgentTranscript,
} from "./agent-metrics.js";

/** One assistant transcript entry, shaped like Claude Code writes them. */
function assistant(opts: {
	ts?: string;
	model?: string;
	usage?: Record<string, number>;
	content?: unknown[];
}): string {
	return JSON.stringify({
		type: "assistant",
		timestamp: opts.ts ?? "2026-08-07T22:00:00.000Z",
		uuid: "u1",
		message: {
			role: "assistant",
			...(opts.model === undefined ? {} : { model: opts.model }),
			...(opts.usage === undefined ? {} : { usage: opts.usage }),
			content: opts.content ?? [],
		},
	});
}

function toolUse(name: string, id: string): Record<string, unknown> {
	return { type: "tool_use", name, id, input: { x: 1 } };
}

function codexEntry(type: string, payload: Record<string, unknown>, ts: string): string {
	return JSON.stringify({ timestamp: ts, type, payload });
}

function codexTokenCount(
	lastTokenUsage: unknown,
	totalTokenUsage: unknown = {
		input_tokens: 999_999,
		cached_input_tokens: 888_888,
		cache_write_input_tokens: 777_777,
		output_tokens: 666_666,
	},
): string {
	return codexEntry(
		"event_msg",
		{
			type: "token_count",
			info: { last_token_usage: lastTokenUsage, total_token_usage: totalTokenUsage },
		},
		"2026-08-31T00:00:01.000Z",
	);
}

describe("summarizeAgentTranscript — positive (must extract)", () => {
	it("P1: sums token usage across assistant turns", () => {
		const text = [
			assistant({ usage: { input_tokens: 5, output_tokens: 100, cache_read_input_tokens: 1000 } }),
			assistant({ usage: { input_tokens: 3, output_tokens: 50, cache_creation_input_tokens: 200 } }),
		].join("\n");
		const m = summarizeAgentTranscript(text);
		expect(m.tokens).toEqual({ input: 8, output: 150, cache_read: 1000, cache_creation: 200 });
		expect(m.assistant_turns).toBe(2);
	});

	it("P2: counts tool calls per tool and records their ids", () => {
		const text = [
			assistant({ content: [toolUse("Bash", "toolu_a"), toolUse("Read", "toolu_b")] }),
			assistant({ content: [toolUse("Bash", "toolu_c")] }),
		].join("\n");
		const m = summarizeAgentTranscript(text);
		expect(m.tool_calls).toBe(3);
		expect(m.tools).toEqual({ Bash: 2, Read: 1 });
		expect(m.tool_use_ids).toEqual(["toolu_a", "toolu_b", "toolu_c"]);
		expect(m.tool_use_ids_truncated).toBe(false);
	});

	it("P3: records distinct models in first-seen order", () => {
		const text = [
			assistant({ model: "vendor-model-v5", usage: { output_tokens: 1 } }),
			assistant({ model: "vendor-model-v5", usage: { output_tokens: 1 } }),
			assistant({ model: "vendor-model-v4-mini", usage: { output_tokens: 1 } }),
		].join("\n");
		expect(summarizeAgentTranscript(text).models).toEqual([
			"vendor-model-v5",
			"vendor-model-v4-mini",
		]);
	});

	it("P4: derives duration from the transcript time span", () => {
		const text = [
			assistant({ ts: "2026-08-07T22:00:00.000Z" }),
			assistant({ ts: "2026-08-07T22:01:30.000Z" }),
		].join("\n");
		const m = summarizeAgentTranscript(text);
		expect(m.first_ts).toBe("2026-08-07T22:00:00.000Z");
		expect(m.last_ts).toBe("2026-08-07T22:01:30.000Z");
		expect(m.duration_ms).toBe(90_000);
	});

	it("P5: separates thinking blocks that carry text from empty ones", () => {
		const text = [
			assistant({ content: [{ type: "thinking", thinking: "", signature: "sig" }] }),
			assistant({ content: [{ type: "thinking", thinking: "real reasoning", signature: "sig" }] }),
		].join("\n");
		const m = summarizeAgentTranscript(text);
		expect(m.thinking_blocks).toBe(2);
		expect(m.thinking_blocks_with_text).toBe(1);
	});

	it("P6: caps the id list but keeps the counts exact", () => {
		const blocks = Array.from({ length: MAX_TOOL_USE_IDS + 5 }, (_, i) => toolUse("Bash", `t${i}`));
		const m = summarizeAgentTranscript(assistant({ content: blocks }));
		expect(m.tool_calls).toBe(MAX_TOOL_USE_IDS + 5);
		expect(m.tool_use_ids).toHaveLength(MAX_TOOL_USE_IDS);
		expect(m.tool_use_ids_truncated).toBe(true);
	});
});

describe("summarizeAgentTranscript — negative (must not fire / must stay empty)", () => {
	const empty: AgentTranscriptMetrics = emptyAgentMetrics();

	it("N1: empty input yields empty metrics", () => {
		expect(summarizeAgentTranscript("")).toEqual(empty);
	});

	it("N2: malformed lines are skipped, not thrown on", () => {
		const text = ["not json at all", "{partial", assistant({ usage: { output_tokens: 7 } })].join("\n");
		const m = summarizeAgentTranscript(text);
		expect(m.tokens.output).toBe(7);
		expect(m.transcript_entries).toBe(1);
	});

	it("N3: user entries contribute no turns, tokens, or tool calls", () => {
		const text = JSON.stringify({
			type: "user",
			timestamp: "2026-08-07T22:00:00.000Z",
			uuid: "u2",
			message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
		});
		const m = summarizeAgentTranscript(text);
		expect(m.assistant_turns).toBe(0);
		expect(m.tool_calls).toBe(0);
		expect(m.tokens).toEqual(empty.tokens);
		expect(m.transcript_entries).toBe(1);
	});

	it("N4: an assistant turn without usage adds no turn but still counts tools", () => {
		const m = summarizeAgentTranscript(assistant({ content: [toolUse("Bash", "toolu_x")] }));
		expect(m.assistant_turns).toBe(0);
		expect(m.tool_calls).toBe(1);
	});

	it("N5: non-numeric usage values are ignored rather than coerced", () => {
		const text = JSON.stringify({
			type: "assistant",
			timestamp: "2026-08-07T22:00:00.000Z",
			uuid: "u3",
			// SAFETY: deliberately malformed usage — the summarizer must not coerce it.
			message: { role: "assistant", usage: { output_tokens: "lots", input_tokens: null }, content: [] },
		});
		expect(summarizeAgentTranscript(text).tokens).toEqual(empty.tokens);
	});

	it("N6: a single timestamp yields no duration", () => {
		const m = summarizeAgentTranscript(assistant({ ts: "2026-08-07T22:00:00.000Z" }));
		expect(m.duration_ms).toBeNull();
	});

	it("N7: a bare JSON array line is skipped (object-shape gate on the entry itself)", () => {
		const text = [JSON.stringify(["not", "an", "entry"]), assistant({ usage: { output_tokens: 3 } })].join(
			"\n",
		);
		const m = summarizeAgentTranscript(text);
		expect(m.transcript_entries).toBe(1);
		expect(m.tokens.output).toBe(3);
	});

	it("N8: a non-object element inside content is skipped without crashing or counting", () => {
		const text = JSON.stringify({
			type: "assistant",
			timestamp: "2026-08-07T22:00:00.000Z",
			uuid: "u4",
			// SAFETY: deliberately malformed content elements — a bare array and a
			// string sit alongside a real tool_use block.
			message: { role: "assistant", content: [["nested", "array"], "bare string", toolUse("Bash", "toolu_y")] },
		});
		const m = summarizeAgentTranscript(text);
		expect(m.tool_calls).toBe(1);
		expect(m.tools).toEqual({ Bash: 1 });
	});

	it("N9: an array-valued usage is rejected (object-shape gate), not coerced into a turn", () => {
		const text = JSON.stringify({
			type: "assistant",
			timestamp: "2026-08-07T22:00:00.000Z",
			uuid: "u5",
			// SAFETY: usage deliberately shaped as an array, not an object.
			message: { role: "assistant", usage: [1, 2, 3], content: [] },
		});
		const m = summarizeAgentTranscript(text);
		expect(m.assistant_turns).toBe(0);
		expect(m.tokens).toEqual(empty.tokens);
	});
});

describe("summarizeAgentTranscript — Codex 0.151 rollouts", () => {
	it("sums only incremental last_token_usage and maps every token field", () => {
		const text = [
			codexTokenCount({
				input_tokens: 120,
				cached_input_tokens: 80,
				cache_write_input_tokens: 12,
				output_tokens: 25,
				reasoning_output_tokens: 9,
				total_tokens: 145,
			}),
			codexTokenCount({
				input_tokens: 30,
				cached_input_tokens: 20,
				cache_write_input_tokens: 3,
				output_tokens: 5,
				reasoning_output_tokens: 2,
				total_tokens: 35,
			}),
		].join("\n");

		const m = summarizeAgentTranscript(text);

		expect(m.assistant_turns).toBe(2);
		expect(m.tokens).toEqual({ input: 150, output: 30, cache_read: 100, cache_creation: 15 });
	});

	it("records turn_context models in first-seen order", () => {
		const text = [
			codexEntry("turn_context", { model: "gpt-5.6-sol" }, "2026-08-31T00:00:00.000Z"), // REAL_WORLD_VERSION_FIXTURE_OK — exact current Codex 0.151 rollout model fixture.
			codexEntry("turn_context", { model: "gpt-5.6-sol" }, "2026-08-31T00:00:02.000Z"), // REAL_WORLD_VERSION_FIXTURE_OK — exact current Codex 0.151 rollout model fixture.
			codexEntry("turn_context", { model: "gpt-5.6-luna" }, "2026-08-31T00:00:03.000Z"), // REAL_WORLD_VERSION_FIXTURE_OK — exact current Codex 0.151 rollout model fixture.
		].join("\n");

		expect(summarizeAgentTranscript(text).models).toEqual(["gpt-5.6-sol", "gpt-5.6-luna"]); // REAL_WORLD_VERSION_FIXTURE_OK — exact current Codex 0.151 rollout model fixture.
	});

	it("counts function_call and custom_tool_call rows with stable join ids", () => {
		const text = [
			codexEntry(
				"response_item",
				{ type: "function_call", name: "list_agents", call_id: "call_1", id: "fc_1" },
				"2026-08-31T00:00:04.000Z",
			),
			codexEntry(
				"response_item",
				{ type: "custom_tool_call", name: "exec", call_id: "call_2", id: "ctc_2" },
				"2026-08-31T00:00:05.000Z",
			),
			codexEntry(
				"response_item",
				{ type: "custom_tool_call", name: "exec", id: "ctc_fallback" },
				"2026-08-31T00:00:06.000Z",
			),
		].join("\n");

		const m = summarizeAgentTranscript(text);

		expect(m.tool_calls).toBe(3);
		expect(m.tools).toEqual({ list_agents: 1, exec: 2 });
		expect(m.tool_use_ids).toEqual(["call_1", "call_2", "ctc_fallback"]);
	});

	it("fails soft on unstable nested shapes without consuming cumulative totals", () => {
		const text = [
			codexTokenCount(null),
			codexEntry("event_msg", { type: "token_count", info: [] }, "2026-08-31T00:00:07.000Z"),
			codexEntry("event_msg", { type: "token_count", info: { last_token_usage: [] } }, "2026-08-31T00:00:08.000Z"),
			codexEntry("turn_context", { model: 56 }, "2026-08-31T00:00:09.000Z"),
			codexEntry(
				"response_item",
				{ type: "function_call", name: 17, call_id: 42 },
				"2026-08-31T00:00:10.000Z",
			),
		].join("\n");

		const m = summarizeAgentTranscript(text);

		expect(m.assistant_turns).toBe(0);
		expect(m.tokens).toEqual(emptyAgentMetrics().tokens);
		expect(m.models).toEqual([]);
		expect(m.tool_calls).toBe(1);
		expect(m.tools).toEqual({ unknown: 1 });
		expect(m.tool_use_ids).toEqual([]);
	});

	it("preserves Claude metrics when Claude and Codex rows are summarized together", () => {
		const text = [
			assistant({
				model: "claude-model",
				usage: {
					input_tokens: 5,
					output_tokens: 7,
					cache_read_input_tokens: 11,
					cache_creation_input_tokens: 13,
				},
				content: [toolUse("Bash", "toolu_claude")],
			}),
			codexTokenCount({
				input_tokens: 17,
				cached_input_tokens: 19,
				cache_write_input_tokens: 23,
				output_tokens: 29,
			}),
			codexEntry("turn_context", { model: "gpt-5.6-sol" }, "2026-08-31T00:00:11.000Z"), // REAL_WORLD_VERSION_FIXTURE_OK — exact current Codex 0.151 rollout model fixture.
		].join("\n");

		const m = summarizeAgentTranscript(text);

		expect(m.assistant_turns).toBe(2);
		expect(m.tokens).toEqual({ input: 22, output: 36, cache_read: 30, cache_creation: 36 });
		expect(m.models).toEqual(["claude-model", "gpt-5.6-sol"]); // REAL_WORLD_VERSION_FIXTURE_OK — exact current Codex 0.151 rollout model fixture.
		expect(m.tools).toEqual({ Bash: 1 });
	});
});
