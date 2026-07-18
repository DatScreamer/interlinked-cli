import { describe, expect, it } from "vitest";
import { parseCodexRolloutText } from "./codex-rollout.js";

// A synthetic Codex rollout covering every entry family we map.
const rollout = [
	{ timestamp: "2026-07-18T18:40:04.725Z", type: "session_meta", payload: { session_id: "sess-1", cwd: "/repo", model_provider: "openai" } },
	{ timestamp: "2026-07-18T18:40:05.000Z", type: "response_item", payload: { type: "turn_context", model: "oai-model-v6" } },
	{ timestamp: "2026-07-18T18:40:06.000Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "Review these files." }] } },
	{ timestamp: "2026-07-18T18:40:07.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
	{ timestamp: "2026-07-18T18:40:16.000Z", type: "event_msg", payload: { type: "agent_message", message: "I'll inspect the substrate files.", phase: "commentary" } },
	{ timestamp: "2026-07-18T18:40:17.000Z", type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "rg --files src", call_id: "call_1", id: "ctc_1" } },
	{ timestamp: "2026-07-18T18:40:18.000Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_1", output: [{ type: "input_text", text: "src/a.ts\nsrc/b.ts" }] } },
	{ timestamp: "2026-07-18T18:42:14.000Z", type: "response_item", payload: { type: "function_call", name: "wait", arguments: '{"cell_id":"5"}', call_id: "call_2" } },
	{ timestamp: "2026-07-18T18:42:23.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call_2", output: [{ type: "input_text", text: "Script completed" }] } },
	{ timestamp: "2026-07-18T19:22:27.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "1. [severity: high] a bug." }] } },
]
	.map((e) => JSON.stringify(e))
	.join("\n");

describe("parseCodexRolloutText", () => {
	const recs = parseCodexRolloutText(rollout);
	const byCat = (c: string) => recs.filter((r) => r.category === c);

	it("stamps every record with provider codex and the session id", () => {
		expect(recs.length).toBeGreaterThan(0);
		expect(recs.every((r) => r.provider === "codex")).toBe(true);
		expect(recs.every((r) => r.session === "sess-1")).toBe(true);
		expect(recs.every((r) => r.schema === "timeline.v1")).toBe(true);
	});

	it("maps developer/user messages to user_prompt and assistant to agent_message", () => {
		expect(byCat("user_prompt").map((r) => r.text)).toEqual(["Review these files."]);
		expect(byCat("agent_message")[0]?.text).toContain("a bug");
		expect(byCat("agent_message")[0]?.role).toBe("assistant");
	});

	it("captures streamed commentary as agent_thinking", () => {
		expect(byCat("agent_thinking").map((r) => r.text)).toEqual(["I'll inspect the substrate files."]);
	});

	it("maps function_call and custom_tool_call to tool_use with raw input", () => {
		const tools = byCat("tool_use");
		expect(tools.map((r) => r.tool_name).sort()).toEqual(["exec", "wait"]);
		expect(tools.find((r) => r.tool_name === "exec")?.tool_input).toBe("rg --files src");
		expect(tools.find((r) => r.tool_name === "wait")?.tool_input).toBe('{"cell_id":"5"}');
		expect(tools.find((r) => r.tool_name === "exec")?.tool_use_id).toBe("call_1");
	});

	it("maps *_output to tool_result with raw flattened content", () => {
		const results = byCat("tool_result");
		expect(results.find((r) => r.tool_use_id === "call_1")?.text).toBe("src/a.ts\nsrc/b.ts");
		expect(results.find((r) => r.tool_use_id === "call_2")?.text).toBe("Script completed");
	});

	it("labels model-bearing records with the discovered model slug", () => {
		expect(byCat("agent_message")[0]?.model).toBe("oai-model-v6");
		expect(byCat("tool_use")[0]?.model).toBe("oai-model-v6");
		// user prompts are input TO the model — no model label (parity with Claude).
		expect(byCat("user_prompt")[0]?.model).toBeUndefined();
	});

	it("uses a stable codex:<session>:<line> dedup key so re-parses match", () => {
		const again = parseCodexRolloutText(rollout);
		expect(again.map((r) => `${r.uuid}#${r.seq}`)).toEqual(recs.map((r) => `${r.uuid}#${r.seq}`));
		expect(recs.every((r) => r.uuid.startsWith("codex:sess-1:"))).toBe(true);
	});

	it("skips lifecycle events and returns [] without a session_meta", () => {
		expect(byCat("event")).toEqual([]); // task_started produced nothing
		expect(parseCodexRolloutText('{"type":"event_msg","payload":{"type":"task_started"}}')).toEqual([]);
		expect(parseCodexRolloutText("not json\n\n")).toEqual([]);
	});

	it("scrubs natural-language text but leaves tool I/O raw", () => {
		// A fabricated secret in a prompt is scrubbed; the same shape in tool
		// input/result is preserved (RAW parity with the Claude parser).
		const sk = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCD";
		const doc = [
			JSON.stringify({ timestamp: "2026-07-18T18:40:04Z", type: "session_meta", payload: { session_id: "s2", cwd: "/r" } }),
			JSON.stringify({ timestamp: "2026-07-18T18:40:05Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `key ${sk} here` }] } }),
			JSON.stringify({ timestamp: "2026-07-18T18:40:06Z", type: "response_item", payload: { type: "function_call_output", call_id: "c", output: [{ type: "input_text", text: `key ${sk} here` }] } }),
		].join("\n");
		const r = parseCodexRolloutText(doc);
		expect(r.find((x) => x.category === "user_prompt")?.text).not.toContain(sk);
		expect(r.find((x) => x.category === "tool_result")?.text).toContain(sk);
	});
});
