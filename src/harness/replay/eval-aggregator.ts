// ===========================================
// T3 aggregator — pure, deterministic rollup
// ===========================================
// Counting and percentiles over ledger rows — NO model call anywhere in the
// aggregation path (feedback_harness_deterministic_only), sorted keys and
// fixed rounding so repeated aggregation is byte-identical
// (docs/design/reproducibility/tier3-scoring.md).

import type { LedgerRow } from "./eval-ledger.js";

export interface EvalSummary {
	run_id: string;
	candidate_model: string;
	steps: number;
	action_match_rate: number;
	structural: {
		scored: number;
		mean_normalized: number;
		p50_normalized: number;
		p90_normalized: number;
	};
	by_tool: Record<string, { steps: number; action_match_rate: number }>;
}

const ROUND_PLACES = 10_000;

function round4(value: number): number {
	return Math.round(value * ROUND_PLACES) / ROUND_PLACES;
}

/** Nearest-rank percentile over an ascending-sorted array. */
function percentile(sortedAsc: readonly number[], p: number): number {
	if (sortedAsc.length === 0) return 0;
	const rank = Math.ceil((p / 100) * sortedAsc.length);
	return sortedAsc[Math.min(sortedAsc.length, Math.max(1, rank)) - 1] ?? 0;
}

export function aggregateLedger(rows: readonly LedgerRow[]): EvalSummary {
	const matches = rows.filter((r) => r.scores.action_match.match).length;
	const normalized = rows
		.map((r) => r.scores.structural)
		.filter((s): s is NonNullable<LedgerRow["scores"]["structural"]> => s !== null && s.comparable)
		.map((s) => s.normalized)
		.sort((a, b) => a - b);
	const mean =
		normalized.length === 0 ? 0 : normalized.reduce((acc, v) => acc + v, 0) / normalized.length;

	const byTool: EvalSummary["by_tool"] = {};
	const tools = [...new Set(rows.map((r) => r.reference_tool ?? "unknown"))].sort();
	for (const tool of tools) {
		const toolRows = rows.filter((r) => (r.reference_tool ?? "unknown") === tool);
		const toolMatches = toolRows.filter((r) => r.scores.action_match.match).length;
		byTool[tool] = {
			steps: toolRows.length,
			action_match_rate: round4(toolMatches / toolRows.length),
		};
	}

	return {
		run_id: rows[0]?.run_id ?? "",
		candidate_model: rows[0]?.candidate.model ?? "",
		steps: rows.length,
		action_match_rate: rows.length === 0 ? 0 : round4(matches / rows.length),
		structural: {
			scored: normalized.length,
			mean_normalized: round4(mean),
			p50_normalized: round4(percentile(normalized, 50)),
			p90_normalized: round4(percentile(normalized, 90)),
		},
		by_tool: byTool,
	};
}
