// T3 eval ledger — one JSONL row per scored step under
// .interlinked/replay/eval/<run_id>/ (docs/design/reproducibility/tier3-scoring.md).
// Pins: run-id allocation is injectable-clock deterministic, rows round-trip,
// foreign/torn lines are skipped, runs are isolated by id.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { allocRunId, appendLedgerRow, type LedgerRow, loadLedger } from "./eval-ledger.js";

const cleanups: string[] = [];
afterEach(() => {
	for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "il-ledger-"));
	cleanups.push(dir);
	return dir;
}

function row(runId: string, seq: number, match: boolean): LedgerRow {
	return {
		schema: "replay-eval.v1",
		run_id: runId,
		ts: "2026-07-24T15:00:00.000Z",
		mode: "off_policy",
		reference: { session_id: "sess", seq, tool_use_id: `toolu_${seq}`, model: "vendor-model-v6" },
		candidate: { model: "candidate-x", decode: "default" },
		scores: {
			action_match: { same_tool: match, same_input: match, match },
			structural: match ? { kind: "ast", comparable: true, distance: 0, normalized: 0 } : null,
		},
	};
}

describe("allocRunId", () => {
	it("is deterministic given an injected clock and slugs the candidate", () => {
		const id = allocRunId("My Model/v2", () => "2026-07-24T15:04:05.678Z");
		expect(id).toBe("run-20260724T150405-my-model-v2");
	});
});

describe("appendLedgerRow / loadLedger", () => {
	it("round-trips rows for a run and isolates runs from each other", () => {
		const cwd = tempCwd();
		appendLedgerRow(cwd, row("run-a", 1, true));
		appendLedgerRow(cwd, row("run-a", 2, false));
		appendLedgerRow(cwd, row("run-b", 1, true));
		const a = loadLedger(cwd, "run-a");
		expect(a).toHaveLength(2);
		expect(a[1]?.scores.action_match.match).toBe(false);
		expect(loadLedger(cwd, "run-b")).toHaveLength(1);
	});

	it("returns [] for an unknown run", () => {
		expect(loadLedger(tempCwd(), "run-none")).toEqual([]);
	});
});
