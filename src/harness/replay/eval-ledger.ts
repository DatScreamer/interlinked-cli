// ===========================================
// T3 eval ledger — one row per scored step
// ===========================================
// Durable, diffable record of a comparison run: reference step identity,
// candidate identity, and the deterministic scores. Lives under
// .interlinked/replay/eval/<run_id>/ledger.jsonl
// (docs/design/reproducibility/tier3-scoring.md).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ActionMatchScore } from "./scorers/action-match.js";
import type { RoutedStructuralScore } from "./scorers/ast-edit-diff.js";

export interface LedgerRow {
	schema: "replay-eval.v1";
	run_id: string;
	ts: string;
	mode: "off_policy";
	reference: {
		session_id: string;
		seq: number | null;
		tool_use_id: string | null;
		/** The model that produced the recorded action (from the envelope). */
		model: string | null;
	};
	candidate: { model: string; decode: string };
	scores: {
		action_match: ActionMatchScore;
		structural: RoutedStructuralScore | null;
	};
	/** Reference step's tool — denormalized for per-tool aggregation. */
	reference_tool?: string | null;
}

/** Deterministic given an injected clock: run-<compact-utc>-<candidate-slug>. */
export function allocRunId(candidateModel: string, now: () => string): string {
	const compact = now().replace(/[-:]/g, "").slice(0, 15);
	const slug = candidateModel
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `run-${compact}-${slug || "candidate"}`;
}

function safeRunId(runId: string): string {
	return runId.replace(/[^A-Za-z0-9._-]/g, "-");
}

export function ledgerPath(cwd: string, runId: string): string {
	return join(cwd, ".interlinked", "replay", "eval", safeRunId(runId), "ledger.jsonl");
}

export function appendLedgerRow(cwd: string, row: LedgerRow): void {
	const path = ledgerPath(cwd, row.run_id);
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(row)}\n`);
}

/** Tolerant reader — torn/foreign lines are skipped. */
export function loadLedger(cwd: string, runId: string): LedgerRow[] {
	const path = ledgerPath(cwd, runId);
	if (!existsSync(path)) return [];
	const out: LedgerRow[] = [];
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			// SAFETY: schema-checked on the next line before use.
			const parsed = JSON.parse(line) as LedgerRow;
			if (parsed && parsed.schema === "replay-eval.v1") out.push(parsed);
		} catch (err) {
			void err; // torn/foreign line — skipping is this reader's contract
		}
	}
	return out;
}
