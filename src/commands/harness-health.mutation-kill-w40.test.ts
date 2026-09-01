// Mutation-kill suite (wave 40) for harness-health.ts. Targets survivors from
// scratch/fleet-r3/w40-briefs/src_commands_harness-health.ts.json.
// The companion harness-health.test.ts pins the aggregation/output-mode
// contract; these tests pin exact literal text (header, table columns,
// status-cell text, probation-section copy) and the read-stream options
// object that the companion suite's `toContain` assertions leave underspecified.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harnessHealthCommand } from "./harness-health.js";

const { createReadStreamSpy } = vi.hoisted(() => ({ createReadStreamSpy: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		createReadStream: (...args: unknown[]) => {
			createReadStreamSpy(...args);
			// SAFETY: the exact mocked rest arguments are forwarded to the real
			// overloaded function; `any` only bridges its variadic call signature.
			return (actual.createReadStream as any)(...args);
		},
	};
});

let dir: string;

async function capture(fn: () => Promise<void>): Promise<string> {
	const spy = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		await fn();
		return spy.mock.calls.map((c) => c.join(" ")).join("\n");
	} finally {
		spy.mockRestore();
	}
}

/** Strips ANSI color/style escape codes so literal-text assertions aren't
 * broken by terminal formatting inserted between words/lines. */
function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function writeLog(lines: string[]): void {
	mkdirSync(join(dir, ".interlinked"), { recursive: true });
	writeFileSync(join(dir, ".interlinked", "recurrences.jsonl"), `${lines.join("\n")}\n`, "utf-8");
}

function caughtLine(checkId: string, file: string, message: string, session: string): string {
	return JSON.stringify({
		ts: "2026-06-01T00:00:00.000Z",
		kind: "harness_caught",
		check_id: checkId,
		agent_source: "claude",
		session_id: session,
		file,
		message,
	});
}

/** 12 findings x 6 re-fires — clears every probation threshold. */
function noisyFixtureLines(checkId: string): string[] {
	const lines: string[] = [];
	for (let f = 0; f < 12; f++) {
		for (let r = 0; r < 6; r++) {
			lines.push(caughtLine(checkId, `src/f${f}.ts`, `finding ${f}`, `s-${r % 4}`));
		}
	}
	return lines;
}

beforeEach(() => {
	vi.clearAllMocks();
	dir = mkdtempSync(join(tmpdir(), "interlinked-health-w40-"));
	vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

describe("aggregateHealthFromLog — read-stream options", () => {
	// test-contract: invariant — the stream must decode as text, not raw
	// Buffer chunks, or JSONL parsing downstream breaks.
	it("opens the recurrence log with an explicit utf-8 encoding option", async () => {
		writeLog([caughtLine("quiet_check", "src/x.ts", "one-off", "s-1")]);
		await capture(() => harnessHealthCommand({}));
		expect(createReadStreamSpy).toHaveBeenCalledTimes(1);
		const [calledPath, calledOptions] = createReadStreamSpy.mock.calls[0] ?? [];
		expect(calledPath).toBe(join(dir, ".interlinked", "recurrences.jsonl"));
		expect(calledOptions).toEqual({ encoding: "utf-8" });
	});
});

describe("renderHealthReport — literal text", () => {
	// test-contract: public-api — the report header is user-facing copy.
	it("prints the exact report header", async () => {
		writeLog([caughtLine("quiet_check", "src/x.ts", "one-off", "s-1")]);
		const out = await capture(() => harnessHealthCommand({}));
		expect(out).toContain("Check health (repeat-rate = events per unique finding)");
	});

	// test-contract: public-api — every table column label must render, in
	// order, on the same header line.
	it("prints all seven table column labels on one header row", async () => {
		writeLog([caughtLine("quiet_check", "src/x.ts", "one-off", "s-1")]);
		const out = await capture(() => harnessHealthCommand({}));
		expect(out).toMatch(
			/check id\s+status\s+repeat\s+events\s+unique\s+sessions\s+determinism/,
		);
	});

	// test-contract: invariant — the outer line-join must be a real newline;
	// gluing the header block directly onto the table would corrupt the report.
	it("separates the header block from the table with a real newline", async () => {
		writeLog([caughtLine("quiet_check", "src/x.ts", "one-off", "s-1")]);
		const out = await capture(() => harnessHealthCommand({}));
		expect(stripAnsi(out)).toMatch(/\ncheck id\s+status/);
	});

	// test-contract: invariant — a blank separator line sits between the
	// table and the probation section (whether or not any candidates exist).
	it("pushes an actual blank line before the probation section", async () => {
		writeLog(noisyFixtureLines("typescript")); // proven check, zero candidates
		const out = await capture(() => harnessHealthCommand({}));
		const lines = stripAnsi(out).split("\n");
		const probationStart = lines.findIndex((l) => l.startsWith("No probation candidates"));
		expect(probationStart).toBeGreaterThan(0);
		expect(lines[probationStart - 1]).toBe("");
	});

	// test-contract: boundary — the determinism column falls back to the
	// literal string "unknown" for an unclassified check id.
	it("renders literal 'unknown' as the trailing determinism cell", async () => {
		writeLog(noisyFixtureLines("totally_unknown_check_xyz"));
		const out = await capture(() => harnessHealthCommand({}));
		const row = out.split("\n").find((l) => l.includes("totally_unknown_check_xyz"));
		expect(row).toBeDefined();
		expect(row?.trim().endsWith("unknown")).toBe(true);
	});
});

describe("statusCell — exact per-status text", () => {
	// test-contract: public-api — probation-candidate status text.
	it("renders 'PROBATION' next to a noisy heuristic check id", async () => {
		writeLog(noisyFixtureLines("agent_thumbprint_prose"));
		const out = await capture(() => harnessHealthCommand({}));
		expect(stripAnsi(out)).toMatch(/agent_thumbprint_prose\s+PROBATION/);
	});

	// test-contract: public-api — healthy status text (proven check, noisy stats).
	it("renders 'healthy' next to a noisy proven check id", async () => {
		writeLog(noisyFixtureLines("typescript"));
		const out = await capture(() => harnessHealthCommand({}));
		expect(stripAnsi(out)).toMatch(/typescript\s+healthy/);
	});

	// test-contract: public-api — low-data status text (below the event floor).
	it("renders 'low-data' next to a check id with too few events", async () => {
		writeLog([caughtLine("quiet_check", "src/x.ts", "one-off", "s-1")]);
		const out = await capture(() => harnessHealthCommand({}));
		expect(stripAnsi(out)).toMatch(/quiet_check\s+low-data/);
	});
});

describe("renderProbationSection — zero candidates", () => {
	// test-contract: public-api — the exact "all clear" message, and no throw
	// (a BlockStatement mutant here would make the function return undefined
	// and crash the ...spread in renderHealthReport).
	it("prints the exact no-candidates message and does not throw", async () => {
		writeLog(noisyFixtureLines("typescript"));
		const out = await capture(() => harnessHealthCommand({}));
		expect(out).toContain(
			"No probation candidates — every graded check is healthy or low-data.",
		);
	});
});

describe("renderProbationSection — with candidates", () => {
	// test-contract: public-api — the section header names the candidate count.
	it("prints the 'Probation candidates (N)' header with the demote/refine copy", async () => {
		writeLog(noisyFixtureLines("agent_thumbprint_prose"));
		const out = await capture(() => harnessHealthCommand({}));
		expect(out).toMatch(/Probation candidates \(\d+\) — demote to advisory or refine detection:/);
	});

	// test-contract: public-api — each candidate row is bulleted.
	it("bullets each probation candidate row", async () => {
		writeLog(noisyFixtureLines("agent_thumbprint_prose"));
		const out = await capture(() => harnessHealthCommand({}));
		expect(stripAnsi(out)).toMatch(/●\s+agent_thumbprint_prose/);
	});

	// test-contract: public-api — the trailing guidance line, both sentences.
	it("prints both sentences of the trailing guidance line", async () => {
		writeLog(noisyFixtureLines("agent_thumbprint_prose"));
		const out = await capture(() => harnessHealthCommand({}));
		expect(out).toContain("Same finding re-firing unchanged");
		expect(out).toContain("Prefer refining the check over demoting");
	});
});
