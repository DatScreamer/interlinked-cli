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
});
