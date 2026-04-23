import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock local-activity
vi.mock("../local-activity.js", () => ({
	readLocalActivity: vi.fn(),
	appendLocalActivity: vi.fn(),
}));

import { appendLocalActivity, readLocalActivity } from "../local-activity.js";
import { exportTrace, importTrace } from "../trace.js";

const mockReadLocal = vi.mocked(readLocalActivity);
const mockAppendLocal = vi.mocked(appendLocalActivity);

beforeEach(() => {
	vi.clearAllMocks();
});

describe("exportTrace", () => {
	it("exports events as JSON document", () => {
		mockReadLocal.mockReturnValue([
			{
				ts: "2025-01-01T10:00:00Z",
				agent: "agent-1",
				type: "tool_use",
				tool: "Edit",
				summary: "src/index.ts",
				session: "s1",
				hook: "PostToolUse",
			},
			{
				ts: "2025-01-01T10:01:00Z",
				agent: "agent-1",
				type: "session_end",
				tool: null,
				summary: null,
				session: "s1",
				hook: "SessionEnd",
			},
		]);

		const result = exportTrace({ format: "json" });
		const doc = JSON.parse(result);

		expect(doc.format).toBe("interlinked-trace");
		expect(doc.version).toBe(1);
		expect(doc.spans).toHaveLength(2);
		expect(doc.spans[0].name).toBe("tool_use");
		expect(doc.spans[0].attributes.agent).toBe("agent-1");
		expect(doc.spans[0].attributes.tool).toBe("Edit");
	});

	it("exports as JSONL", () => {
		mockReadLocal.mockReturnValue([
			{
				ts: "2025-01-01T10:00:00Z",
				agent: "agent-1",
				type: "tool_use",
				tool: "Read",
				summary: "file.ts",
				session: "s1",
				hook: "PostToolUse",
			},
		]);

		const result = exportTrace({ format: "jsonl" });
		const lines = result.trim().split("\n");
		expect(lines).toHaveLength(1);

		const span = JSON.parse(lines[0]);
		expect(span.name).toBe("tool_use");
	});

	it("handles empty activity", () => {
		mockReadLocal.mockReturnValue([]);

		const result = exportTrace({ format: "json" });
		const doc = JSON.parse(result);
		expect(doc.spans).toHaveLength(0);
	});

	it("passes through v2 fields (tokens, parent_agent)", () => {
		mockReadLocal.mockReturnValue([
			{
				ts: "2025-01-01T10:00:00Z",
				agent: "agent-1",
				type: "subagent_stop",
				tool: "worker-1",
				summary: null,
				session: "s1",
				hook: "SubagentStop",
				tokens: { input: 1000, output: 500 },
				parent_agent: "lead",
				subagent_id: "sub-1",
			},
		]);

		const result = exportTrace({ format: "json" });
		const doc = JSON.parse(result);
		expect(doc.spans[0].attributes.tokens).toEqual({ input: 1000, output: 500 });
		expect(doc.spans[0].attributes.parent_agent).toBe("lead");
	});
});

describe("importTrace", () => {
	it("imports JSON document format", () => {
		mockReadLocal.mockReturnValue([]);

		const doc = {
			format: "interlinked-trace",
			version: 1,
			exported_at: "2025-01-01T00:00:00Z",
			spans: [
				{
					trace_id: "s1",
					span_id: "span-0",
					name: "tool_use",
					timestamp: "2025-01-01T10:00:00Z",
					attributes: { agent: "agent-1", tool: "Edit", summary: "file.ts" },
				},
			],
		};

		const result = importTrace(JSON.stringify(doc));
		expect(result.imported).toBe(1);
		expect(result.skipped).toBe(0);
		expect(mockAppendLocal).toHaveBeenCalledOnce();
	});

	it("imports JSONL format", () => {
		mockReadLocal.mockReturnValue([]);

		const jsonl = [
			JSON.stringify({
				trace_id: "s1",
				span_id: "span-0",
				name: "tool_use",
				timestamp: "2025-01-01T10:00:00Z",
				attributes: { agent: "a1" },
			}),
			JSON.stringify({
				trace_id: "s1",
				span_id: "span-1",
				name: "session_end",
				timestamp: "2025-01-01T10:01:00Z",
				attributes: { agent: "a1" },
			}),
		].join("\n");

		const result = importTrace(jsonl);
		expect(result.imported).toBe(2);
	});

	it("deduplicates existing events", () => {
		mockReadLocal.mockReturnValue([
			{ ts: "2025-01-01T10:00:00Z", agent: "agent-1", type: "tool_use" },
		]);

		const doc = {
			format: "interlinked-trace",
			version: 1,
			exported_at: "2025-01-01T00:00:00Z",
			spans: [
				{
					trace_id: "s1",
					span_id: "span-0",
					name: "tool_use",
					timestamp: "2025-01-01T10:00:00Z",
					attributes: { agent: "agent-1" },
				},
				{
					trace_id: "s1",
					span_id: "span-1",
					name: "session_end",
					timestamp: "2025-01-01T10:01:00Z",
					attributes: { agent: "agent-1" },
				},
			],
		};

		const result = importTrace(JSON.stringify(doc));
		expect(result.imported).toBe(1); // Only session_end is new
		expect(result.skipped).toBe(1); // tool_use already exists
	});

	it("handles empty input", () => {
		const result = importTrace("");
		expect(result.imported).toBe(0);
		expect(result.skipped).toBe(0);
	});

	it("round-trips export → import", () => {
		const events = [
			{
				ts: "2025-01-01T10:00:00Z",
				agent: "agent-1",
				type: "tool_use",
				tool: "Read",
				summary: "file.ts",
				session: "s1",
				hook: "PostToolUse",
			},
		];
		mockReadLocal.mockReturnValueOnce(events); // for export
		mockReadLocal.mockReturnValueOnce([]); // for import dedup check

		const exported = exportTrace({ format: "json" });
		const result = importTrace(exported);

		expect(result.imported).toBe(1);
		expect(result.skipped).toBe(0);
	});
});
