import { describe, expect, it } from "vitest";
import { parseTranscriptEntry, parseTranscriptText } from "./transcript-record.js";

// A minimal valid assistant entry with the given content blocks.
function assistant(content: unknown[], model = "claude-test-5") {
	return {
		type: "assistant",
		uuid: "u-assistant",
		timestamp: "2026-06-28T12:24:50.271Z",
		sessionId: "sess-1",
		cwd: "/repo",
		gitBranch: "main",
		version: "2.1.0",
		message: { role: "assistant", model, content },
	};
}

function user(content: unknown) {
	return {
		type: "user",
		uuid: "u-user",
		timestamp: "2026-06-28T12:24:49.000Z",
		sessionId: "sess-1",
		message: { role: "user", content },
	};
}

describe("parseTranscriptEntry — positive cases", () => {
	it("emits an agent_message for an assistant text block, labeled with the model", () => {
		const recs = parseTranscriptEntry(assistant([{ type: "text", text: "This is squarely a test." }]));
		expect(recs).toHaveLength(1);
		const r = recs[0];
		expect(r?.category).toBe("agent_message");
		expect(r?.role).toBe("assistant");
		expect(r?.model).toBe("claude-test-5");
		expect(r?.text).toBe("This is squarely a test.");
		expect(r?.scrubbed).toBe(true);
		expect(r?.git_branch).toBe("main");
	});

	it("emits an agent_thinking record for a thinking block", () => {
		const recs = parseTranscriptEntry(assistant([{ type: "thinking", thinking: "let me reason" }]));
		expect(recs).toHaveLength(1);
		expect(recs[0]?.category).toBe("agent_thinking");
		expect(recs[0]?.text).toBe("let me reason");
	});

	it("emits a tool_use record carrying name, input, and id", () => {
		const recs = parseTranscriptEntry(
			assistant([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }]),
		);
		expect(recs).toHaveLength(1);
		expect(recs[0]?.category).toBe("tool_use");
		expect(recs[0]?.tool_name).toBe("Bash");
		expect(recs[0]?.tool_use_id).toBe("toolu_1");
		expect(recs[0]?.tool_input).toEqual({ command: "ls" });
	});

	it("emits a user_prompt for a bare-string user message", () => {
		const recs = parseTranscriptEntry(user("hello there"));
		expect(recs).toHaveLength(1);
		expect(recs[0]?.category).toBe("user_prompt");
		expect(recs[0]?.role).toBe("user");
		expect(recs[0]?.text).toBe("hello there");
	});

	it("emits a tool_result (with is_error) from a user content array", () => {
		const recs = parseTranscriptEntry(
			user([{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "boom" }]),
		);
		expect(recs).toHaveLength(1);
		expect(recs[0]?.category).toBe("tool_result");
		expect(recs[0]?.tool_use_id).toBe("toolu_1");
		expect(recs[0]?.is_error).toBe(true);
		expect(recs[0]?.text).toBe("boom");
	});

	it("carries a sidechain entry's agentId as agent_id (subagent attribution)", () => {
		const entry = {
			...assistant([{ type: "text", text: "subagent result" }]),
			agentId: "af2124f",
			isSidechain: true,
		};
		const recs = parseTranscriptEntry(entry);
		expect(recs).toHaveLength(1);
		expect(recs[0]?.agent_id).toBe("af2124f");
	});

	it("leaves agent_id undefined for main-session entries (JSON round-trip drops it)", () => {
		const recs = parseTranscriptEntry(assistant([{ type: "text", text: "main turn" }]));
		expect(recs[0]?.agent_id).toBeUndefined();
		expect(JSON.parse(JSON.stringify(recs[0]))).not.toHaveProperty("agent_id");
	});

	it("decomposes a multi-block assistant turn into ordered records (seq = block index)", () => {
		const recs = parseTranscriptEntry(
			assistant([
				{ type: "text", text: "first I'll explain" },
				{ type: "tool_use", id: "toolu_9", name: "Read", input: {} },
			]),
		);
		expect(recs.map((r) => r.category)).toEqual(["agent_message", "tool_use"]);
		expect(recs.map((r) => r.seq)).toEqual([0, 1]);
		// uuid#seq is the stable dedup key
		expect(`${recs[0]?.uuid}#${recs[0]?.seq}`).toBe("u-assistant#0");
		expect(`${recs[1]?.uuid}#${recs[1]?.seq}`).toBe("u-assistant#1");
	});
});

describe("parseTranscriptEntry — negative cases (must produce no records)", () => {
	it("drops an entry missing uuid", () => {
		expect(parseTranscriptEntry({ type: "assistant", timestamp: "t", sessionId: "s", message: { content: [] } })).toEqual(
			[],
		);
	});

	it("drops an entry missing a timestamp", () => {
		expect(parseTranscriptEntry({ type: "assistant", uuid: "x", sessionId: "s", message: { content: [] } })).toEqual([]);
	});

	it("drops a non-user/assistant entry type (system, mode, …)", () => {
		expect(parseTranscriptEntry({ type: "system", uuid: "x", timestamp: "t", sessionId: "s" })).toEqual([]);
	});

	it("drops a whitespace-only assistant text block", () => {
		expect(parseTranscriptEntry(assistant([{ type: "text", text: "   \n  " }]))).toEqual([]);
	});

	it("drops non-object input", () => {
		expect(parseTranscriptEntry(null)).toEqual([]);
		expect(parseTranscriptEntry(42)).toEqual([]);
		expect(parseTranscriptEntry("a string")).toEqual([]);
	});
});

describe("parseTranscriptText", () => {
	it("parses multiple JSONL lines and preserves file order", () => {
		const lines = [
			JSON.stringify(user("a question")),
			JSON.stringify(assistant([{ type: "text", text: "an answer" }])),
		].join("\n");
		const recs = parseTranscriptText(lines);
		expect(recs.map((r) => r.category)).toEqual(["user_prompt", "agent_message"]);
	});

	it("skips blank and truncated/non-JSON lines without throwing", () => {
		const lines = ["", "  ", "{not valid json", JSON.stringify(assistant([{ type: "text", text: "ok" }])), "{trailing"].join(
			"\n",
		);
		const recs = parseTranscriptText(lines);
		expect(recs).toHaveLength(1);
		expect(recs[0]?.category).toBe("agent_message");
	});
});
