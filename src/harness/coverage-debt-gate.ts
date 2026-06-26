// ===========================================
// Coverage debt — PreToolUse gate wrapper (Phase 2 glue)
// ===========================================
// Wraps the base per-edit coverage verdict with the pair-scoped debt lifecycle
// when `per_edit_coverage.debt_mode` is on. Reads the ledger, optimistically
// discharges a debt when its companion test is edited (the commit gate is the
// ground-truth backstop — an introverted test is caught there), runs
// `decideCoverageDebt`, persists the resulting transitions, and returns the
// final verdict. Self-contained + unit-tested so the live pipeline file gains
// only a two-line call. See `docs/design/coverage-debt-tdd.md`.

import { relative, resolve } from "node:path";
import { decideCoverageDebt, inSamePair, isUncoveredBlock } from "./coverage-debt.js";
import { appendDebtTxn, readOpenDebts } from "./obligation-ledger-io.js";
import type { PerEditCoverageConfig } from "./types/config.js";
import type { HarnessDecision, HarnessEvent } from "./types.js";

const CODE_RX = /\.[cm]?[jt]sx?$/i;
const TEST_RX = /\.(test|spec)\.[cm]?[jt]sx?$/i;

function strField(input: Record<string, unknown>, key: string): string {
	const v = input[key];
	return typeof v === "string" ? v : "";
}

/** Repo-relative path of the edited code file, or null for a non-file / non-code
 *  event (apply_patch is deferred — debt mode v1 gates named single-file edits). */
function editedCodeFile(event: HarnessEvent, projectRoot: string): string | null {
	const input = event.tool_input ?? {};
	const named = strField(input, "file_path") || strField(input, "path");
	if (!named) return null;
	const rel = relative(projectRoot, resolve(projectRoot, named));
	return CODE_RX.test(rel) ? rel : null;
}

/**
 * Apply the pair-scoped debt lifecycle to a base coverage verdict. A pure
 * pass-through (returns `baseDecision`) for non-file / non-code events and for a
 * clean edit with no open debt. Otherwise opens / discharges / blocks per
 * `decideCoverageDebt` and persists the transitions to the ledger.
 */
export function applyDebtMode(
	event: HarnessEvent,
	cfg: PerEditCoverageConfig,
	baseDecision: HarnessDecision | null,
): HarnessDecision | null {
	if (cfg.debt_mode !== true) return baseDecision; // off ⇒ pure pass-through
	const projectRoot = event.cwd;
	if (!projectRoot) return baseDecision; // no cwd ⇒ can't resolve the ledger; pass through
	const editedFile = editedCodeFile(event, projectRoot);
	if (!editedFile) return baseDecision; // non-file / non-code → untouched

	const openDebts = readOpenDebts(projectRoot);
	if (openDebts.length === 0 && !isUncoveredBlock(baseDecision)) return baseDecision; // nothing to do

	// Optimistic discharge: editing a debt's companion test is taken to cover it.
	// `inSamePair` accepts both the co-located sibling AND an umbrella test (e.g.
	// `__tests__/foo.test.ts` for a decomposed `foo-bar.ts`).
	const rechecks = new Map<string, boolean>();
	if (TEST_RX.test(editedFile)) {
		for (const d of openDebts) {
			if (inSamePair(editedFile, d.file)) rechecks.set(d.file, true);
		}
	}

	const outcome = decideCoverageDebt({
		baseDecision,
		editedFile,
		openDebts,
		rechecks,
		wipLimit: cfg.debt_wip_limit ?? 1,
		sessionId: event.session_id,
		atMs: Date.now(),
	});
	for (const txn of outcome.txns) appendDebtTxn(projectRoot, txn);
	return outcome.decision;
}
