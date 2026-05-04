import { describe, expect, it } from "vitest";
import { type ActivityEvent, formatActivitySummary } from "../activity-utils.js";
import { estimateCost, formatTokens } from "../formatter.js";
import type { LocalActivityEvent } from "../local-activity.js";

describe("Event Schema v2 — backward compatibility", () => {
	it("v1 events parse correctly (no v2 fields)", () => {
		const v1: LocalActivityEvent = {
			ts: "2025-01-01T00:00:00.000Z",
			agent: "test-agent",
			type: "tool_use",
			tool: "Read",
			summary: "src/index.ts",
			session: "session-1",
			hook: "PostToolUse",
		};
		expect(v1.schema_version).toBeUndefined();
		expect(v1.tokens).toBeUndefined();
		expect(v1.trace_id).toBeUndefined();
		expect(v1.parent_agent).toBeUndefined();
	});

	it("v2 events include new fields", () => {
		const v2: LocalActivityEvent = {
			ts: "2025-01-01T00:00:00.000Z",
			agent: "test-agent",
			type: "tool_use",
			tool: "Edit",
			summary: "src/index.ts",
			session: "session-1",
			hook: "PostToolUse",
			schema_version: 2,
			trace_id: "trace-abc123",
			tokens: { input: 1000, output: 500 },
			duration_ms: 250,
			files_modified: ["src/index.ts"],
		};
		expect(v2.schema_version).toBe(2);
		expect(v2.tokens?.input).toBe(1000);
		expect(v2.trace_id).toBe("trace-abc123");
		expect(v2.duration_ms).toBe(250);
	});

	it("v2 subagent fields", () => {
		const v2: LocalActivityEvent = {
			ts: "2025-01-01T00:00:00.000Z",
			agent: "lead-agent",
			type: "subagent_start",
			tool: "worker-1",
			schema_version: 2,
			parent_agent: "lead-agent",
			subagent_id: "sub-123",
		};
		expect(v2.parent_agent).toBe("lead-agent");
		expect(v2.subagent_id).toBe("sub-123");
	});

	it("v2 scrubbed field", () => {
		const v2: LocalActivityEvent = {
			ts: "2025-01-01T00:00:00.000Z",
			agent: "test-agent",
			type: "tool_use",
			schema_version: 2,
			scrubbed: true,
		};
		expect(v2.scrubbed).toBe(true);
	});

	it("v2 checkpoint_id field", () => {
		const v2: LocalActivityEvent = {
			ts: "2025-01-01T00:00:00.000Z",
			agent: "test-agent",
			type: "session_start",
			schema_version: 2,
			checkpoint_id: "abc123def456",
		};
		expect(v2.checkpoint_id).toBe("abc123def456");
	});
});

describe("formatActivitySummary with tokens", () => {
	it("includes token count for tool events", () => {
		const event: ActivityEvent = {
			event_type: "tool_use",
			tool_name: "Edit",
			tool_input_summary: "src/index.ts",
			tokens: { input: 1000, output: 500 },
		};
		const result = formatActivitySummary(event);
		expect(result).toContain("Edited src/index.ts");
		expect(result).toContain("1.5k tok");
	});

	it("omits token suffix when no tokens present", () => {
		const event: ActivityEvent = {
			event_type: "tool_use",
			tool_name: "Read",
			tool_input_summary: "src/index.ts",
		};
		const result = formatActivitySummary(event);
		expect(result).toBe("Read src/index.ts");
		expect(result).not.toContain("tok");
	});

	it("omits token suffix when tokens are zero", () => {
		const event: ActivityEvent = {
			event_type: "tool_use",
			tool_name: "Read",
			tool_input_summary: "src/index.ts",
			tokens: { input: 0, output: 0 },
		};
		const result = formatActivitySummary(event);
		expect(result).not.toContain("tok");
	});

	it("shows small token counts without k suffix", () => {
		const event: ActivityEvent = {
			event_type: "tool_use",
			tool_name: "Bash",
			tool_input_summary: "ls",
			tokens: { input: 100, output: 50 },
		};
		const result = formatActivitySummary(event);
		expect(result).toContain("150 tok");
	});

	it("session_start and session_end ignore tokens", () => {
		const start: ActivityEvent = { event_type: "session_start", tokens: { input: 500 } };
		expect(formatActivitySummary(start)).toBe("Session started");
		const end: ActivityEvent = { event_type: "session_end", tokens: { input: 500 } };
		expect(formatActivitySummary(end)).toBe("Session ended");
	});
});

describe("formatTokens", () => {
	it("formats input and output", () => {
		expect(formatTokens({ input: 12000, output: 3000 })).toBe("12.0k in / 3.0k out");
	});

	it("formats small numbers without k", () => {
		expect(formatTokens({ input: 500, output: 200 })).toBe("500 in / 200 out");
	});

	it("includes cache_read when present", () => {
		expect(formatTokens({ input: 1000, output: 500, cache_read: 2000 })).toBe(
			"1.0k in / 500 out / 2.0k cache",
		);
	});

	it("returns '0 tokens' when all zero", () => {
		expect(formatTokens({ input: 0, output: 0 })).toBe("0 tokens");
	});

	it("returns '0 tokens' for empty object", () => {
		expect(formatTokens({})).toBe("0 tokens");
	});
});

describe("estimateCost", () => {
	it("returns a cost estimate with dollar sign", () => {
		const result = estimateCost({ input: 100000, output: 10000 });
		expect(result).toMatch(/^~\$/);
	});

	it("returns higher cost for opus model", () => {
		const sonnet = estimateCost({ input: 100000, output: 10000 });
		const opus = estimateCost({ input: 100000, output: 10000 }, "premium-opus-tier");
		// Extract numeric values
		const sonnetVal = Number.parseFloat(sonnet.replace("~$", ""));
		const opusVal = Number.parseFloat(opus.replace("~$", ""));
		expect(opusVal).toBeGreaterThan(sonnetVal);
	});
});
