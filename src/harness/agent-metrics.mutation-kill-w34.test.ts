import { afterEach, describe, expect, it, vi } from "vitest";
import { summarizeAgentTranscript } from "./agent-metrics.js";

// Raw JSONL builders — several cases need field types the companion test's
// `assistant()` helper can't produce (numeric ids/names/models, non-array
// content, out-of-range numbers), so these entries are hand-built strings.

describe("agent-metrics — mutation-kill w34 (survivor-targeted)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// addUsage: `typeof v === "number" && Number.isFinite(v)`. A number that
	// IS typeof "number" but not finite (Infinity, via JSON overflow literal
	// 1e400) must still be coerced to 0, never summed in as-is.
	// test-contract: invariant — token accumulation never admits a non-finite number
	it("addUsage ignores a typeof-number-but-non-finite value (Infinity via overflow literal)", () => {
		const text =
			'{"type":"assistant","timestamp":"2026-08-07T22:00:00.000Z","message":{"role":"assistant","content":[],"usage":{"output_tokens":1e400}}}';
		const m = summarizeAgentTranscript(text);
		expect(m.tokens.output).toBe(0);
	});

	// foldToolUse: `typeof block.name === "string" && block.name`. A truthy
	// non-string name must fall back to "unknown", not be used as the tool key.
	// test-contract: invariant — a non-string tool name is never used as a tools-map key
	it('foldToolUse falls back to "unknown" for a non-string truthy tool name', () => {
		const text =
			'{"type":"assistant","timestamp":"2026-08-07T22:00:00.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":42}]}}';
		const m = summarizeAgentTranscript(text);
		expect(m.tools).toEqual({ unknown: 1 });
	});

	// foldToolUse: `typeof block.id !== "string" || !block.id`. A non-string
	// truthy id must be rejected, not pushed into tool_use_ids.
	// test-contract: invariant — tool_use_ids never contains a non-string id
	it("foldToolUse rejects a non-string tool id", () => {
		const text =
			'{"type":"assistant","timestamp":"2026-08-07T22:00:00.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":123,"name":"Bash"}]}}';
		const m = summarizeAgentTranscript(text);
		expect(m.tool_calls).toBe(1);
		expect(m.tool_use_ids).toEqual([]);
		expect(m.tools).toEqual({ Bash: 1 });
	});

	// foldThinking: `typeof block.thinking === "string"`. A thinking block
	// with no `thinking` field must not attempt `.trim()` on it (would throw).
	// test-contract: invariant — a missing thinking field never crashes the fold
	it("foldThinking does not crash or count a block with no thinking field", () => {
		const text =
			'{"type":"assistant","timestamp":"2026-08-07T22:00:00.000Z","message":{"role":"assistant","content":[{"type":"thinking"}]}}';
		let m: ReturnType<typeof summarizeAgentTranscript> | undefined;
		expect(() => {
			m = summarizeAgentTranscript(text);
		}).not.toThrow();
		expect(m?.thinking_blocks).toBe(1);
		expect(m?.thinking_blocks_with_text).toBe(0);
	});

	// foldThinking: `block.thinking.trim()`. Whitespace-only thinking text
	// must not count as text-bearing once trimmed.
	// test-contract: invariant — thinking_blocks_with_text only counts non-whitespace text
	it("foldThinking treats whitespace-only thinking as textless", () => {
		const text =
			'{"type":"assistant","timestamp":"2026-08-07T22:00:00.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"   "}]}}';
		const m = summarizeAgentTranscript(text);
		expect(m.thinking_blocks).toBe(1);
		expect(m.thinking_blocks_with_text).toBe(0);
	});

	// foldContentBlock: `block.type === "thinking"`. A non-tool_use,
	// non-thinking content block (e.g. "text") must not be folded as thinking.
	// test-contract: invariant — a plain text content block is never counted as thinking
	it("foldContentBlock ignores a plain text content block", () => {
		const text =
			'{"type":"assistant","timestamp":"2026-08-07T22:00:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}';
		const m = summarizeAgentTranscript(text);
		expect(m.thinking_blocks).toBe(0);
		expect(m.tool_calls).toBe(0);
	});

	// foldAssistantEntry: `typeof model === "string" && model`. A truthy
	// non-string model value must not be recorded in the models list.
	// test-contract: invariant — models list only ever contains string model ids
	it("foldAssistantEntry ignores a non-string truthy model value", () => {
		const text =
			'{"type":"assistant","timestamp":"2026-08-07T22:00:00.000Z","message":{"role":"assistant","model":42,"content":[]}}';
		const m = summarizeAgentTranscript(text);
		expect(m.models).toEqual([]);
	});

	// foldAssistantEntry: `!Array.isArray(content)`. A non-array `content`
	// (a plain object) must be skipped, not iterated with `for...of`.
	// test-contract: invariant — a non-array content field never crashes the summarizer
	it("foldAssistantEntry does not crash when content is a non-array object", () => {
		const text =
			'{"type":"assistant","timestamp":"2026-08-07T22:00:00.000Z","message":{"role":"assistant","content":{"foo":"bar"}}}';
		let m: ReturnType<typeof summarizeAgentTranscript> | undefined;
		expect(() => {
			m = summarizeAgentTranscript(text);
		}).not.toThrow();
		expect(m?.tool_calls).toBe(0);
	});

	// foldAssistantEntry: `isJsonObject(raw)`. A `null` element inside content
	// must be skipped, never passed to foldContentBlock (which reads `.type`).
	// test-contract: invariant — a null content element never crashes the summarizer
	it("foldAssistantEntry does not crash on a null content element", () => {
		const text =
			'{"type":"assistant","timestamp":"2026-08-07T22:00:00.000Z","message":{"role":"assistant","content":[null,{"type":"tool_use","id":"toolu_z","name":"Bash"}]}}';
		let m: ReturnType<typeof summarizeAgentTranscript> | undefined;
		expect(() => {
			m = summarizeAgentTranscript(text);
		}).not.toThrow();
		expect(m?.tool_calls).toBe(1);
		expect(m?.tools).toEqual({ Bash: 1 });
	});

	// foldTimestamp: `typeof ts !== "string" || !ts`. A non-string truthy
	// timestamp must be rejected, not folded into first_ts/last_ts.
	// test-contract: invariant — first_ts/last_ts are only ever set from string timestamps
	it("foldTimestamp rejects a non-string timestamp value", () => {
		const text = '{"type":"user","timestamp":12345,"message":{}}';
		const m = summarizeAgentTranscript(text);
		expect(m.first_ts).toBeNull();
		expect(m.last_ts).toBeNull();
	});

	// foldTimestamp: `ts < m.first_ts` and `m.last_ts === null || ts > m.last_ts`.
	// Out-of-order timestamps must still yield the true min/max, not just the
	// first/last one seen.
	// test-contract: invariant — first_ts is the true min and last_ts the true max seen
	it("foldTimestamp tracks true min/max across out-of-order entries", () => {
		const text = ['{"type":"user","timestamp":"C"}', '{"type":"user","timestamp":"B"}'].join("\n");
		const m = summarizeAgentTranscript(text);
		expect(m.first_ts).toBe("B");
		expect(m.last_ts).toBe("C");
	});

	// spanMs: `!Number.isFinite(a) || !Number.isFinite(b)`. When both
	// endpoints fail to parse as dates, duration must be null, not NaN.
	// test-contract: invariant — duration_ms is never NaN when both dates fail to parse
	it("spanMs yields null when both endpoints fail to parse as dates", () => {
		const text = ['{"type":"user","timestamp":"aaa"}', '{"type":"user","timestamp":"bbb"}'].join("\n");
		const m = summarizeAgentTranscript(text);
		expect(m.duration_ms).toBeNull();
	});

	// spanMs: `!Number.isFinite(a) || !Number.isFinite(b)`. When only one
	// endpoint fails to parse as a date, duration must still be null.
	// test-contract: invariant — duration_ms is never NaN when exactly one date fails to parse
	it("spanMs yields null when only one endpoint fails to parse as a date", () => {
		const text = [
			'{"type":"user","timestamp":"2026-01-01T00:00:00.000Z"}',
			'{"type":"user","timestamp":"zzz-invalid"}',
		].join("\n");
		const m = summarizeAgentTranscript(text);
		expect(m.duration_ms).toBeNull();
	});

	// summarizeAgentTranscript: `line.trim()` feeding `!trimmed`. A
	// whitespace-only line must be skipped before any JSON.parse attempt.
	// test-contract: invariant — a blank line is never handed to JSON.parse
	it("skips a whitespace-only line without attempting to parse it", () => {
		const parseSpy = vi.spyOn(JSON, "parse");
		const m = summarizeAgentTranscript("   ");
		expect(m.transcript_entries).toBe(0);
		expect(parseSpy).not.toHaveBeenCalled();
	});

	// summarizeAgentTranscript: `entry.type === "assistant" && isJsonObject(message)`.
	// A non-assistant entry must not be folded as an assistant turn, even
	// when its message carries usage-shaped fields.
	// test-contract: invariant — only entries with type "assistant" contribute assistant turns
	it("does not fold a non-assistant entry's message even when it has usage-shaped fields", () => {
		const text =
			'{"type":"user","timestamp":"2026-08-07T22:00:00.000Z","message":{"usage":{"output_tokens":5}}}';
		const m = summarizeAgentTranscript(text);
		expect(m.assistant_turns).toBe(0);
		expect(m.tokens.output).toBe(0);
	});
});
