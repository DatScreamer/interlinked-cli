// T3 aggregator — pure, deterministic aggregation over ledger rows: rates,
// structural percentiles, per-tool breakdown. No LLM anywhere in the
// aggregation path (repo doctrine), and byte-identical output across runs
// (docs/design/reproducibility/tier3-scoring.md).

import { describe, expect, it } from "vitest";
import { aggregateLedger } from "./eval-aggregator.js";
import type { LedgerRow } from "./eval-ledger.js";

function row(
	seq: number,
	tool: string,
	match: boolean,
	structural: LedgerRow["scores"]["structural"],
): LedgerRow {
	return {
		schema: "replay-eval.v1",
		run_id: "run-x",
		ts: "2026-07-24T15:00:00.000Z",
		mode: "off_policy",
		reference: { session_id: "sess", seq, tool_use_id: `toolu_${seq}`, model: "ref-model" },
		candidate: { model: "cand", decode: "default" },
		scores: {
			action_match: { same_tool: true, same_input: match, match },
			structural,
		},
		reference_tool: tool,
	};
}

describe("aggregateLedger", () => {
	it("computes rates, structural stats, and per-tool breakdown", () => {
		const rows = [
			row(1, "Edit", true, { kind: "ast", comparable: true, distance: 0, normalized: 0 }),
			row(2, "Edit", false, { kind: "ast", comparable: true, distance: 8, normalized: 0.4 }),
			row(3, "Bash", false, { kind: "argv", comparable: true, distance: 1, normalized: 0.25 }),
			row(4, "Read", true, null),
		];
		const summary = aggregateLedger(rows);
		expect(summary).toEqual({
			run_id: "run-x",
			candidate_model: "cand",
			steps: 4,
			action_match_rate: 0.5,
			structural: {
				scored: 3,
				mean_normalized: 0.2167,
				p50_normalized: 0.25,
				p90_normalized: 0.4,
			},
			by_tool: {
				Bash: { steps: 1, action_match_rate: 0 },
				Edit: { steps: 2, action_match_rate: 0.5 },
				Read: { steps: 1, action_match_rate: 1 },
			},
		});
	});

	it("is byte-deterministic across repeated aggregation", () => {
		const rows = [row(1, "Edit", true, null), row(2, "Bash", false, null)];
		expect(JSON.stringify(aggregateLedger(rows))).toBe(JSON.stringify(aggregateLedger(rows)));
	});

	it("handles an empty ledger without dividing by zero", () => {
		const summary = aggregateLedger([]);
		expect(summary.steps).toBe(0);
		expect(summary.action_match_rate).toBe(0);
		expect(summary.structural.scored).toBe(0);
	});
});
