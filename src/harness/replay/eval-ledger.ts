// ===========================================
// T3 eval ledger — one row per scored step
// ===========================================
// Durable, diffable record of a comparison run: reference step identity,
// candidate identity, and the deterministic scores. Lives under
// .interlinked/replay/eval/<run_id>/ledger.jsonl
// (docs/design/reproducibility/tier3-scoring.md).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject } from "../../lib/json-types.js";
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

function parseReference(value: unknown): LedgerRow["reference"] | null {
	if (!isJsonObject(value)) return null;
	if (typeof value.session_id !== "string") return null;
	const seq = value.seq ?? null;
	if (seq !== null && typeof seq !== "number") return null;
	const toolUseId = value.tool_use_id ?? null;
	if (toolUseId !== null && typeof toolUseId !== "string") return null;
	const model = value.model ?? null;
	if (model !== null && typeof model !== "string") return null;
	return { session_id: value.session_id, seq, tool_use_id: toolUseId, model };
}

function parseCandidate(value: unknown): LedgerRow["candidate"] | null {
	if (!isJsonObject(value)) return null;
	const { model, decode } = value;
	if (typeof model !== "string" || typeof decode !== "string") return null;
	return { model, decode };
}

function parseActionMatchScore(value: unknown): ActionMatchScore | null {
	if (!isJsonObject(value)) return null;
	const { same_tool, same_input, match } = value;
	if (typeof same_tool !== "boolean" || typeof same_input !== "boolean") return null;
	if (typeof match !== "boolean") return null;
	return { same_tool, same_input, match };
}

/** `null` is a legitimate score (nothing comparable); `undefined` is the
 *  invalid-shape sentinel — matches the convention in trace-assembler.ts. */
function parseStructuralScore(value: unknown): RoutedStructuralScore | null | undefined {
	if (value === null) return null;
	if (!isJsonObject(value)) return undefined;
	const { kind, comparable, distance, normalized } = value;
	if (kind !== "ast" && kind !== "argv") return undefined;
	if (typeof comparable !== "boolean") return undefined;
	if (typeof distance !== "number" || typeof normalized !== "number") return undefined;
	return { kind, comparable, distance, normalized };
}

function parseScores(value: unknown): LedgerRow["scores"] | null {
	if (!isJsonObject(value)) return null;
	const actionMatch = parseActionMatchScore(value.action_match);
	if (!actionMatch) return null;
	const structural = parseStructuralScore(value.structural ?? null);
	if (structural === undefined) return null;
	return { action_match: actionMatch, structural };
}

/** Validate one ledger line. Exported for direct testing. */
export function parseLedgerRow(value: unknown): LedgerRow | null {
	if (!isJsonObject(value)) return null;
	if (value.schema !== "replay-eval.v1") return null;
	if (value.mode !== "off_policy") return null;
	if (typeof value.run_id !== "string" || typeof value.ts !== "string") return null;
	const reference = parseReference(value.reference);
	if (!reference) return null;
	const candidate = parseCandidate(value.candidate);
	if (!candidate) return null;
	const scores = parseScores(value.scores);
	if (!scores) return null;
	const referenceTool = value.reference_tool ?? null;
	if (referenceTool !== null && typeof referenceTool !== "string") return null;

	return {
		schema: "replay-eval.v1",
		run_id: value.run_id,
		ts: value.ts,
		mode: "off_policy",
		reference,
		candidate,
		scores,
		reference_tool: referenceTool,
	};
}

/** Tolerant reader — torn/foreign lines are skipped. */
export function loadLedger(cwd: string, runId: string): LedgerRow[] {
	const path = ledgerPath(cwd, runId);
	if (!existsSync(path)) return [];
	const out: LedgerRow[] = [];
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = parseLedgerRow(JSON.parse(line));
			if (parsed) out.push(parsed);
		} catch (err) {
			void err; // torn/foreign line — skipping is this reader's contract
		}
	}
	return out;
}
