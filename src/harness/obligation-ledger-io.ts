// ===========================================
// Obligation ledger — file I/O (.interlinked/obligations.jsonl)
// ===========================================
// The thin fs adapter over the pure engine in `obligations.ts`: append a
// transition, or read the append-only log and net it to the currently-open
// coverage debts. Total / fail-open — a missing, torn, or unusable ledger reads
// as "no debts" and a failed append is swallowed; bookkeeping must never crash
// the harness (same contract as `coverage-obligation-ledger.ts`).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	METRIC_DESCRIPTORS,
	type Obligation,
	type ObligationKind,
	type ObligationTxn,
	obligationId,
	openObligations,
	parseObligationTxn,
	replayObligations,
} from "./obligations.js";

const LEDGER = join(".interlinked", "obligations.jsonl");

function ledgerPath(projectRoot: string): string {
	return join(projectRoot, LEDGER);
}

/** Append one transition to the ledger. Best-effort; a failed write is swallowed. */
export function appendDebtTxn(projectRoot: string, txn: ObligationTxn): void {
	const path = ledgerPath(projectRoot);
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(txn)}\n`, "utf-8");
	} catch {
		// intentional: a failed ledger write must not crash the harness.
	}
}

/** Every parsed transition in the ledger, in append order — the raw history
 *  the `interlinked debt show` inspection renders. Total — a missing /
 *  unreadable ledger reads as no transitions, and a torn / foreign line is
 *  skipped (fail-open, same contract as `readOpenDebts`). */
export function readDebtTxns(projectRoot: string): ObligationTxn[] {
	const path = ledgerPath(projectRoot);
	if (!existsSync(path)) return [];
	try {
		const raw = readFileSync(path, "utf-8");
		const txns: ObligationTxn[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			const parsed = parseObligationTxn(safeJsonParse(line));
			if (parsed) txns.push(parsed);
		}
		return txns;
	} catch {
		return []; // unreadable (e.g. the path is a directory) → fail-open
	}
}

/** True when a transition belongs to `file`'s obligations: an `open` names the
 *  file directly; a `discharge`/`escalate` carries only the obligation id, so
 *  it matches when the id is `kind:file` (file-level) or `kind:file:start-end`
 *  (region-level) for any registered kind — derived via `obligationId`, never
 *  re-parsed by hand. */
function txnTouchesFile(txn: ObligationTxn, file: string): boolean {
	if (txn.op === "open") return txn.file === file;
	for (const kind of Object.keys(METRIC_DESCRIPTORS) as ObligationKind[]) {
		const base = obligationId(kind, file);
		if (txn.id === base || txn.id.startsWith(`${base}:`)) return true;
	}
	return false;
}

/** The full transition history for ONE file's obligations, in append order —
 *  what `interlinked debt show <file>` prints. */
export function readDebtTxnsForFile(projectRoot: string, file: string): ObligationTxn[] {
	return readDebtTxns(projectRoot).filter((txn) => txnTouchesFile(txn, file));
}

/** The currently-open pair-scoped debts (coverage + red_suite — the two kinds
 *  the per-edit wander rule enforces), netted over the append-only log. Total —
 *  a missing / unreadable / torn ledger reads as no debts (fail-open). */
export function readOpenDebts(projectRoot: string): Obligation[] {
	const state = replayObligations(readDebtTxns(projectRoot));
	return [...openObligations(state, "coverage"), ...openObligations(state, "red_suite")];
}

function safeJsonParse(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return null; // torn line → null, which parseObligationTxn rejects
	}
}
