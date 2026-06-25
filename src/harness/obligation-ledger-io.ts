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
	type Obligation,
	type ObligationTxn,
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

/** The currently-open COVERAGE debts, netted over the append-only log. Total —
 *  a missing / unreadable / torn ledger reads as no debts (fail-open). */
export function readOpenDebts(projectRoot: string): Obligation[] {
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
		return openObligations(replayObligations(txns), "coverage");
	} catch {
		return []; // unreadable (e.g. the path is a directory) → fail-open
	}
}

function safeJsonParse(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return null; // torn line → null, which parseObligationTxn rejects
	}
}
