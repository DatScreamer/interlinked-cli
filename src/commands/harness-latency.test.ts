import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeLatencyReport } from "./harness-latency.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "harness-latency-"));
	mkdirSync(join(tmp, ".interlinked", "logs"), { recursive: true });
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function writeJsonl(records: object[]): void {
	const path = join(tmp, ".interlinked", "logs", "latency.jsonl");
	writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const sample = (overrides: Partial<Record<string, unknown>> = {}): object => ({
	schema: "v1",
	kind: "hook_decision",
	ts: "2026-04-27T20:00:00.000Z",
	hook_event: "PostToolUse",
	tool_name: "Edit",
	session_id: "s1",
	agent_source: "claude",
	decision: "allow",
	checks_ran: ["typescript", "biome_lint"],
	checks_timing_ms: 1000,
	...overrides,
});

describe("computeLatencyReport", () => {
	it("returns an empty report when the log does not exist", () => {
		// Don't write any JSONL.
		const report = computeLatencyReport(tmp);
		expect(report.total_events).toBe(0);
	});

	it("counts total events from the log", () => {
		writeJsonl([sample(), sample(), sample()]);
		const report = computeLatencyReport(tmp);
		expect(report.total_events).toBe(3);
	});

	it("groups by hook_event", () => {
		writeJsonl([
			sample({ hook_event: "PreToolUse" }),
			sample({ hook_event: "PreToolUse" }),
			sample({ hook_event: "PostToolUse" }),
		]);
		const report = computeLatencyReport(tmp);
		expect(report.by_hook_event["PreToolUse"]).toBe(2);
		expect(report.by_hook_event["PostToolUse"]).toBe(1);
	});

	it("computes p50 of checks_timing_ms for PostToolUse events", () => {
		writeJsonl([
			sample({ checks_timing_ms: 100 }),
			sample({ checks_timing_ms: 200 }),
			sample({ checks_timing_ms: 300 }),
			sample({ checks_timing_ms: 400 }),
			sample({ checks_timing_ms: 500 }),
		]);
		const report = computeLatencyReport(tmp);
		expect(report.post_tool_use.p50).toBe(300);
	});

	it("computes p99 of checks_timing_ms via nearest-rank", () => {
		const records = Array.from({ length: 100 }, (_, i) =>
			sample({ checks_timing_ms: (i + 1) * 10 }),
		);
		writeJsonl(records);
		const report = computeLatencyReport(tmp);
		// Nearest-rank: ceil(0.99 * 100) = 99, 1-indexed → index 98 → value 990.
		// (Linear-interpolation methods would yield 1000; nearest-rank is the
		// conventional choice for small N because it always returns an actual
		// observed value, not a constructed one.)
		expect(report.post_tool_use.p99).toBe(990);
	});

	it("excludes events without checks_timing_ms from percentile calculations", () => {
		writeJsonl([
			sample({ checks_timing_ms: 100 }),
			sample({ checks_timing_ms: null }),
			sample({ checks_timing_ms: 200 }),
		]);
		const report = computeLatencyReport(tmp);
		expect(report.post_tool_use.timing_count).toBe(2);
	});

	it("identifies the top slowest sessions by max-event timing", () => {
		writeJsonl([
			sample({ session_id: "fast", checks_timing_ms: 100 }),
			sample({ session_id: "slow", checks_timing_ms: 30000 }),
			sample({ session_id: "medium", checks_timing_ms: 5000 }),
		]);
		const report = computeLatencyReport(tmp);
		expect(report.slowest_sessions[0]?.session_id).toBe("slow");
		expect(report.slowest_sessions[0]?.max_timing_ms).toBe(30000);
	});

	it("ignores malformed JSON lines without crashing", () => {
		const path = join(tmp, ".interlinked", "logs", "latency.jsonl");
		writeFileSync(
			path,
			[JSON.stringify(sample()), "not valid json", JSON.stringify(sample())].join("\n") +
				"\n",
		);
		const report = computeLatencyReport(tmp);
		expect(report.total_events).toBe(2);
	});

	it("respects an explicit log_path option", () => {
		const customPath = join(tmp, "custom.jsonl");
		writeFileSync(customPath, JSON.stringify(sample()) + "\n");
		const report = computeLatencyReport(tmp, { log_path: customPath });
		expect(report.total_events).toBe(1);
	});

	it("uses real per-tool timings from tool_breakdown when present (Phase A.7)", () => {
		writeJsonl([
			sample({
				checks_ran: ["typescript", "biome_lint"],
				checks_timing_ms: 1000,
				tool_breakdown: [
					{ tool: "tsc", ms: 800, finding_count: 0 },
					{ tool: "biome", ms: 200, finding_count: 0 },
				],
			}),
			sample({
				checks_ran: ["typescript", "biome_lint"],
				checks_timing_ms: 600,
				tool_breakdown: [
					{ tool: "tsc", ms: 500, finding_count: 1 },
					{ tool: "biome", ms: 100, finding_count: 0 },
				],
			}),
		]);
		const report = computeLatencyReport(tmp, { compute_by_tool: true });
		expect(report.by_tool).toBeDefined();
		const tsc = report.by_tool?.find((t) => t.tool === "tsc");
		const biome = report.by_tool?.find((t) => t.tool === "biome");
		// p50 of [500, 800] is 800 (nearest-rank ceil(0.5*2)=1 → index 1 in
		// sorted ascending [500, 800]). The key assertion is that we're
		// reporting per-tool elapsed (500-800) rather than the per-event
		// total (600-1000).
		expect(tsc?.events).toBe(2);
		expect(tsc?.when_present.max).toBe(800);
		expect(biome?.events).toBe(2);
		expect(biome?.when_present.max).toBe(200);
	});

	it("falls back to the when-present approximation for legacy logs (no tool_breakdown)", () => {
		writeJsonl([
			sample({ checks_ran: ["typescript"], checks_timing_ms: 500 }),
			sample({ checks_ran: ["typescript"], checks_timing_ms: 700 }),
		]);
		const report = computeLatencyReport(tmp, { compute_by_tool: true });
		const tsc = report.by_tool?.find((t) => t.tool === "typescript");
		// Approximation: total event time bucketed under each tool that ran.
		expect(tsc?.events).toBe(2);
		expect(tsc?.when_present.max).toBe(700);
	});
});
