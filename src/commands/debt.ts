// ===========================================
// interlinked debt — inspect the pair-scoped TDD obligation ledger
// ===========================================
//
// Subcommands (Phase 3 of docs/design/coverage-debt-tdd.md):
//   list             Open debts (kind, file, opened-at, session)
//   show <file>      Full transition history for one file's obligations
//   resolve <file>   Discharge every open debt on a file (human override)
//
// Reads and writes `.interlinked/obligations.jsonl` through the same ledger
// I/O layer the harness gate uses (obligation-ledger-io.ts) — no daemon
// round-trip. `resolve` appends ordinary local-source discharge transitions:
// it clears the per-edit wander block, and the COMMIT GATE remains the
// ground-truth backstop (it re-measures coverage and the suite, so a
// resolved-but-still-uncovered / still-red pair is caught there). Output
// modes follow the CLI convention: --json / --short / --full via the shared
// getOutputMode / output helpers.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	appendDebtTxn,
	readDebtTxnsForFile,
	readOpenDebts,
} from "../harness/obligation-ledger-io.js";
import type { Obligation, ObligationTxn } from "../harness/obligations.js";
import { getOutputMode, output, outputError } from "../lib/output.js";

export interface DebtCommandOpts {
	cwd?: string;
	json?: boolean;
	short?: boolean;
	full?: boolean;
}

function iso(atMs: number): string {
	return new Date(atMs).toISOString();
}

/** Shared `<file>` positional guard. Commander enforces presence at parse
 *  time, but a direct call may pass undefined / whitespace — refuse with
 *  usage and exit 2 (plan.ts's convention). */
function requireFileArg(file: string | undefined, sub: string): string | null {
	const trimmed = file?.trim();
	if (trimmed) return trimmed;
	console.error("error: <file> is required");
	console.error(`Usage: interlinked debt ${sub} <file>`);
	process.exitCode = 2;
	return null;
}

// ===========================================
// debt list
// ===========================================

function debtRow(d: Obligation): string {
	return [d.kind.padEnd(10), d.file.padEnd(48), iso(d.openedAtMs).padEnd(26), d.sessionId].join(
		"  ",
	);
}

/**
 * A debt whose owning session left no snapshot on disk can never discharge
 * automatically: only that session's own green run clears it, and it will not
 * run again.
 *
 * Observed 2026-07-26: two red_suite debts sat open for 28 hours after the
 * failure they described was fixed, because the session that opened them had
 * ended. Nothing distinguished them from live debts, so they read as an
 * outstanding problem indefinitely. Marking them separates the ones a green
 * run can still clear from the ones only `debt resolve` can.
 */
export function isOrphanedDebt(projectRoot: string, debt: Obligation): boolean {
	if (!debt.sessionId) return false;
	return !existsSync(join(projectRoot, ".interlinked", "sessions", `${debt.sessionId}.json`));
}

function renderDebtTable(open: Obligation[], projectRoot: string = process.cwd()): string {
	const orphans = open.filter((d) => isOrphanedDebt(projectRoot, d));
	const note = orphans.length
		? [
				"",
				`${orphans.length} debt(s) marked ORPHANED: the session that opened them has ended,`,
				"so no green run will ever clear them automatically. Verify the file, then",
				"`interlinked debt resolve <file>`.",
			]
		: [];
	return [
		`${"KIND".padEnd(10)}  ${"FILE".padEnd(48)}  ${"OPENED".padEnd(26)}  SESSION`,
		...open.map((d) => `${debtRow(d)}${isOrphanedDebt(projectRoot, d) ? "  ORPHANED" : ""}`),
		"",
		`(${open.length} open debt(s); \`interlinked debt show <file>\` for history, ` +
			"`interlinked debt resolve <file>` to discharge)",
		...note,
	].join("\n");
}

export async function debtListCommand(opts: DebtCommandOpts): Promise<void> {
	const projectRoot = opts.cwd ?? process.cwd();
	const open = readOpenDebts(projectRoot);
	output(getOutputMode(opts), open, {
		json: () => open,
		short: () =>
			open.length === 0
				? "no open debts"
				: `${open.length} open debt(s): ${open.map((d) => d.file).join(", ")}`,
		normal: () =>
			open.length === 0
				? "(no open debts — the pair-scoped TDD ledger is clear)"
				: renderDebtTable(open, projectRoot),
	});
}

// ===========================================
// debt show <file>
// ===========================================

function renderTxn(txn: ObligationTxn): string {
	switch (txn.op) {
		case "open": {
			const region = txn.region ? ` [${txn.region.start}-${txn.region.end}]` : "";
			return `${iso(txn.atMs)}  open       ${txn.kind}${region}  session=${txn.sessionId}`;
		}
		case "discharge":
			return `${iso(txn.atMs)}  discharge  ${txn.id}  source=${txn.source}`;
		case "escalate":
			return `${iso(txn.atMs)}  escalate   ${txn.id}  survivors=${txn.survivors.length}`;
	}
}

export async function debtShowCommand(
	file: string | undefined,
	opts: DebtCommandOpts,
): Promise<void> {
	const target = requireFileArg(file, "show");
	if (!target) return;
	const cwd = opts.cwd ?? process.cwd();
	const mode = getOutputMode(opts);
	const txns = readDebtTxnsForFile(cwd, target);
	if (txns.length === 0) {
		outputError(mode, `no ledger history for ${target} — nothing has opened a debt on it`);
		return;
	}
	const open = readOpenDebts(cwd).filter((d) => d.file === target);
	output(mode, { file: target, open, txns }, {
		json: () => ({ file: target, open, txns }),
		normal: () =>
			[
				`Ledger history for ${target} — ${txns.length} transition(s), ${open.length} still open:`,
				...txns.map(renderTxn),
			].join("\n"),
	});
}

// ===========================================
// debt resolve <file>
// ===========================================

export async function debtResolveCommand(
	file: string | undefined,
	opts: DebtCommandOpts,
): Promise<void> {
	const target = requireFileArg(file, "resolve");
	if (!target) return;
	const cwd = opts.cwd ?? process.cwd();
	const open = readOpenDebts(cwd).filter((d) => d.file === target);
	const atMs = Date.now();
	for (const d of open) {
		appendDebtTxn(cwd, { op: "discharge", id: d.id, source: "local", atMs });
	}
	const resolved = open.map((d) => ({ id: d.id, kind: d.kind }));
	output(getOutputMode(opts), resolved, {
		json: () => ({ file: target, resolved }),
		short: () =>
			resolved.length === 0
				? `no open debts on ${target}`
				: `resolved ${resolved.length} debt(s) on ${target}`,
		normal: () =>
			resolved.length === 0
				? `(no open debts on ${target} — nothing to resolve)`
				: [
						`Resolved ${resolved.length} open debt(s) on ${target}:`,
						...resolved.map((r) => `  ${r.kind}  ${r.id}`),
						"",
						"Recorded as ordinary local-source discharges (a human override). The commit gate",
						"remains the ground-truth backstop — it re-measures coverage and the suite.",
					].join("\n"),
	});
}
