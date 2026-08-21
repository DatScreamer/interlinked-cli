// ===========================================
// `harness-latency.ts` — targeted mutation-kill supplement (wave: pass1_w25)
// ===========================================
// The existing companion suites (harness-latency.test.ts,
// harness-latency.mutation-kill-luna.test.ts) already exercise nearly every
// branch. Two manifest survivors slipped past them for narrow, provable
// reasons — this file adds exactly the assertions that close those gaps.
// See scratch/fleet-r3/receipts/harness-latency.jsonl for the full
// mutant-by-mutant disposition (most of this file's 52 survived mutants are
// suspected_equivalent — dead optional fields, `?? null` fallbacks masking
// out-of-range indices, and idempotent equal-value reassignments).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CWD = "/mutation-kill-latency";
const LOG = `${CWD}/.interlinked/logs/latency.jsonl`;

const readFileSyncMock = vi.fn<(path: string, encoding?: string) => string>();

vi.mock("node:fs", () => ({
	existsSync: (path: string): boolean => path === LOG,
	readFileSync: (path: string, encoding?: string): string => readFileSyncMock(path, encoding),
}));

import { computeLatencyReport, harnessLatencyCommand } from "./harness-latency.js";

const record = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	hook_event: "PostToolUse",
	session_id: "s1",
	checks_timing_ms: 5,
	...overrides,
});

async function captureStdout(fn: () => Promise<void>): Promise<string> {
	const chunks: string[] = [];
	const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	});
	try {
		await fn();
	} finally {
		write.mockRestore();
	}
	return chunks.join("");
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(process, "cwd").mockReturnValue(CWD);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("computeLatencyReport — read encoding", () => {
	// test-contract: public-api — the log is decoded as utf-8 text, so a report built
	// from the mock's returned string must reflect that exact record (mutantId 1e269d413e6e385b)
	it("reads the latency log with the utf-8 encoding argument and parses its content", () => {
		readFileSyncMock.mockReturnValueOnce(`${JSON.stringify(record({ checks_timing_ms: 42 }))}\n`);
		const report = computeLatencyReport(CWD);
		expect(readFileSyncMock).toHaveBeenCalledWith(LOG, "utf-8");
		expect(report.total_events).toBe(1);
		expect(report.post_tool_use.max).toBe(42);
	});
});

describe("harnessLatencyCommand — per-tool section blank-line separator", () => {
	// test-contract: public-api — the documented blank-line separator before "Per-tool
	// stats:" must render as a true empty line, not the mutation marker (mutantId c6c1289549d839de)
	it("keeps a true blank line before 'Per-tool stats:' with no mutation marker", async () => {
		readFileSyncMock.mockReturnValueOnce(
			`${JSON.stringify(record({ tool_breakdown: [{ tool: "tsc", ms: 5, finding_count: 0 }] }))}\n`,
		);
		const out = await captureStdout(() => harnessLatencyCommand({ byTool: true }));
		expect(out).toContain("\n\n  Per-tool stats:\n");
		expect(out).not.toContain("Stryker was here");
	});
});
