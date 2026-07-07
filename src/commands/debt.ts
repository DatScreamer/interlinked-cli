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

function renderDebtTable(open: Obligation[]): string {
	return [
		`${"KIND".padEnd(10)}  ${"FILE".padEnd(48)}  ${"OPENED".padEnd(26)}  SESSION`,
		...open.map(debtRow),
		"",
		`(${open.length} open debt(s); \`interlinked debt show <file>\` for history, ` +
			"`interlinked debt resolve <file>` to discharge)",
	].join("\n");
}

export async function debtListCommand(opts: DebtCommandOpts): Promise<void> {
	const open = readOpenDebts(opts.cwd ?? process.cwd());
	output(getOutputMode(opts), open, {
		json: () => open,
		short: () =>
			open.length === 0
				? "no open debts"
				: `${open.length} open debt(s): ${open.map((d) => d.file).join(", ")}`,
		normal: () =>
			open.length === 0
				? "(no open debts — the pair-scoped TDD ledger is clear)"
				: renderDebtTable(open),
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
