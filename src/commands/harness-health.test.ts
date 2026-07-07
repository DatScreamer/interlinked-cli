// `interlinked harness health` — command-level tests over a small synthetic
// recurrences.jsonl fixture. The aggregation math is pinned in
// src/harness/check-health.test.ts; these verify the streaming read, the
// rendering, and the output-mode contract.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckHealthRow } from "../harness/check-health.js";
import { harnessHealthCommand } from "./harness-health.js";

let dir: string;

/** Run `fn` and return everything it wrote to console.log, joined by newlines. */
async function capture(fn: () => Promise<void>): Promise<string> {
	const spy = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		await fn();
		return spy.mock.calls.map((c) => c.join(" ")).join("\n");
	} finally {
		spy.mockRestore();
	}
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

/** 12 findings × 6 re-fires each — clears every probation threshold for a
 *  heuristic check id. `agent_thumbprint_prose` is registry-heuristic today. */
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
	dir = mkdtempSync(join(tmpdir(), "interlinked-health-"));
	vi.spyOn(process, "cwd").mockReturnValue(dir);
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

describe("harnessHealthCommand", () => {
	it("reports gracefully when no recurrence log exists yet", async () => {
		const out = await capture(() => harnessHealthCommand({}));
		expect(out).toContain("No recurrence log");
	});

	it("streams the log, skips torn lines, and flags heuristic probation candidates with WHY", async () => {
		writeLog([
			...noisyFixtureLines("agent_thumbprint_prose"),
			'{"ts":"2026-06-01T00:00:00Z","kind":"harness_ca', // torn tail — must not abort
			"",
		]);
		const out = await capture(() => harnessHealthCommand({}));
		expect(out).toContain("agent_thumbprint_prose");
		expect(out).toContain("PROBATION");
		expect(out).toContain("72 events / 12 unique / 4 sessions");
	});

	it("does not flag a proven check id with the same noisy stats", async () => {
		// `typescript` is on the PROVEN_TOOL_CHECKS allow-list.
		writeLog(noisyFixtureLines("typescript"));
		const out = await capture(() => harnessHealthCommand({}));
		expect(out).toContain("typescript");
		expect(out).not.toContain("PROBATION");
	});

	it("--json emits rows sorted by repeat-rate with status + why per check", async () => {
		writeLog([
			...noisyFixtureLines("agent_thumbprint_prose"),
			caughtLine("quiet_check", "src/x.ts", "one-off", "s-1"),
		]);
		const out = await capture(() => harnessHealthCommand({ json: true }));
		const parsed = JSON.parse(out) as { checks: CheckHealthRow[]; probation_candidates: number };
		expect(parsed.checks.map((c) => c.check_id)).toEqual([
			"agent_thumbprint_prose",
			"quiet_check",
		]);
		expect(parsed.checks[0]?.status).toBe("probation-candidate");
		expect(parsed.checks[0]?.why).toContain("72 events / 12 unique / 4 sessions");
		expect(parsed.checks[1]?.status).toBe("low-data");
		expect(parsed.probation_candidates).toBe(1);
	});

	it("--short is a single summary line", async () => {
		writeLog(noisyFixtureLines("agent_thumbprint_prose"));
		const out = await capture(() => harnessHealthCommand({ short: true }));
		expect(out.trim()).not.toContain("\n");
		expect(out).toContain("1 probation candidate");
	});
});
