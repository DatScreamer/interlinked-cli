// G1 SSE reassembly — pins the Messages streaming contract the proxy relies
// on (docs/design/reproducibility/g1-inference-capture.md): stop_reason/usage
// arrive in message_delta (message_stop is only a terminator), tool_use input
// arrives as partial-JSON fragments keyed by block index, thinking carries a
// signature delta, and chunk boundaries need not align with event boundaries.

import { describe, expect, it } from "vitest";
import { createSseReassembler } from "./sse-reassembly.js";

function sse(event: string, data: object): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const FIXTURE: string =
	sse("message_start", {
		type: "message_start",
		message: {
			id: "msg_01",
			model: "vendor-model-v6",
			role: "assistant",
			usage: { input_tokens: 120, cache_read_input_tokens: 40 },
		},
	}) +
	sse("content_block_start", {
		type: "content_block_start",
		index: 0,
		content_block: { type: "thinking", thinking: "" },
	}) +
	sse("content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "thinking_delta", thinking: "let me look" },
	}) +
	sse("content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "signature_delta", signature: "sig-abc" },
	}) +
	sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
	sse("content_block_start", {
		type: "content_block_start",
		index: 1,
		content_block: { type: "text", text: "" },
	}) +
	sse("content_block_delta", {
		type: "content_block_delta",
		index: 1,
		delta: { type: "text_delta", text: "Reading the file" },
	}) +
	sse("content_block_delta", {
		type: "content_block_delta",
		index: 1,
		delta: { type: "text_delta", text: " now." },
	}) +
	sse("content_block_stop", { type: "content_block_stop", index: 1 }) +
	sse("content_block_start", {
		type: "content_block_start",
		index: 2,
		content_block: { type: "tool_use", id: "toolu_777", name: "Read", input: {} },
	}) +
	sse("content_block_delta", {
		type: "content_block_delta",
		index: 2,
		delta: { type: "input_json_delta", partial_json: '{"file_pa' },
	}) +
	sse("content_block_delta", {
		type: "content_block_delta",
		index: 2,
		delta: { type: "input_json_delta", partial_json: 'th": "/x.ts"}' },
	}) +
	sse("content_block_stop", { type: "content_block_stop", index: 2 }) +
	sse("message_delta", {
		type: "message_delta",
		delta: { stop_reason: "tool_use", stop_sequence: null },
		usage: { output_tokens: 55 },
	}) +
	sse("message_stop", { type: "message_stop" });

describe("createSseReassembler", () => {
	it("reassembles the full message from one push", () => {
		const r = createSseReassembler();
		r.push(FIXTURE);
		const msg = r.finish();
		if (!msg) throw new Error("expected a reassembled message");
		expect(msg.id).toBe("msg_01");
		expect(msg.stop_reason).toBe("tool_use");
		// usage merges input side (message_start) with output side (message_delta)
		expect(msg.usage).toEqual({
			input_tokens: 120,
			cache_read_input_tokens: 40,
			output_tokens: 55,
		});
		// SAFETY: finish() always sets content to the ordered block array.
		const content = msg.content as Array<Record<string, unknown>>;
		expect(content).toHaveLength(3);
		expect(content[0]).toMatchObject({ type: "thinking", thinking: "let me look", signature: "sig-abc" });
		expect(content[1]).toMatchObject({ type: "text", text: "Reading the file now." });
		expect(content[2]).toMatchObject({
			type: "tool_use",
			id: "toolu_777",
			name: "Read",
			input: { file_path: "/x.ts" },
		});
	});

	it("is chunk-boundary agnostic (splits mid-line, mid-JSON, mid-event)", () => {
		const r = createSseReassembler();
		for (let i = 0; i < FIXTURE.length; i += 7) {
			r.push(FIXTURE.slice(i, i + 7));
		}
		const msg = r.finish();
		if (!msg) throw new Error("expected a reassembled message");
		expect(msg.stop_reason).toBe("tool_use");
		// SAFETY: finish() always sets content to the ordered block array.
		const content = msg.content as Array<Record<string, unknown>>;
		expect(content[2]).toMatchObject({ input: { file_path: "/x.ts" } });
	});

	it("keeps unparseable tool input raw instead of throwing", () => {
		const r = createSseReassembler();
		r.push(sse("message_start", { type: "message_start", message: { id: "m" } }));
		r.push(
			sse("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "t1", name: "X", input: {} },
			}),
		);
		r.push(
			sse("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"broken:' },
			}),
		);
		r.push(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
		const msg = r.finish();
		// SAFETY: finish() always sets content to the ordered block array.
		const blocks = msg?.content as Array<Record<string, unknown>>;
		expect(blocks[0]?.input_raw).toBe('{"broken:');
	});

	it("returns null when no message_start ever arrived", () => {
		const r = createSseReassembler();
		r.push(sse("ping", { type: "ping" }));
		expect(r.finish()).toBeNull();
	});

	it("ignores unknown events and non-JSON data lines", () => {
		const r = createSseReassembler();
		r.push("event: mystery\ndata: not-json\n\n");
		r.push(sse("message_start", { type: "message_start", message: { id: "m2" } }));
		r.push(sse("wat", { type: "wat", index: 9 }));
		const msg = r.finish();
		expect(msg?.id).toBe("m2");
		expect(msg?.content).toEqual([]);
	});

	it("flushes a final event that lacks the trailing blank line", () => {
		const r = createSseReassembler();
		r.push(sse("message_start", { type: "message_start", message: { id: "m3" } }));
		// message_delta with no trailing \n\n — only finish() can see it.
		r.push('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}');
		const msg = r.finish();
		expect(msg?.stop_reason).toBe("end_turn");
	});
});
