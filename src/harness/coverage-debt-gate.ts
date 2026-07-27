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

import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { decideCoverageDebt, inSamePair, isRedBarBlock, isUncoveredBlock } from "./coverage-debt.js";
import { selectAffectedTests } from "./coverage-test-selector.js";
import type { DependencyView } from "./dependency-view.js";
import { isFileWrite } from "./evaluator/tool-classifiers.js";
import { isCappableFile } from "./large-file-policy.js";
import { appendDebtTxn, readOpenDebts } from "./obligation-ledger-io.js";
import type { Obligation } from "./obligations.js";
import type { PerEditCoverageConfig } from "./types/config.js";
import type { HarnessDecision, HarnessEvent } from "./types.js";

const CODE_RX = /\.[cm]?[jt]sx?$/i;
const TEST_RX = /\.(test|spec)\.[cm]?[jt]sx?$/i;

/** Once-per-(session, debt) dedup for the foreign-debt heads-up note: the
 *  heads-up is information, and repeating unactionable information trains
 *  agents to ignore warnings (the index-nudge lesson). Daemon-lifetime;
 *  cleared on restart. */
const foreignDebtNoted = new Set<string>();

/** Test hook: clear the foreign-debt note dedup. */
export function resetForeignDebtNotesForTests(): void {
	foreignDebtNoted.clear();
}

function strField(input: Record<string, unknown>, key: string): string {
	const v = input[key];
	return typeof v === "string" ? v : "";
}

/** Repo-relative path of the edited code file, or null for a non-mutating /
 *  non-file / non-code event. Uses the canonical `isFileWrite` classifier so
 *  EVERY agent's write verb counts — Claude's Write/Edit/MultiEdit AND the
 *  Copilot/Gemini/Codex forms (write_file/edit_file/str_replace/create/…), not
 *  just Claude's (the hand-rolled set silently dropped debt-mode detection for
 *  non-Claude agents; found in the 2026 baseline review). A read-only
 *  `Read`/`Grep`/`Glob` is NOT a write, so it returns null and bypasses the
 *  wander rule entirely (found 2026-06-28: the debt-lock was false-gating
 *  read-only calls). apply_patch carries no `file_path`, so debt mode v1 gates
 *  named single-file edits only. */
function editedCodeFile(event: HarnessEvent, projectRoot: string): string | null {
	if (!isFileWrite(event.tool_name)) return null;
	const input = event.tool_input ?? {};
	const named = strField(input, "file_path") || strField(input, "path");
	if (!named) return null;
	const rel = relative(projectRoot, resolve(projectRoot, named));
	if (!CODE_RX.test(rel)) return null;
	// Debt's domain is product code + its tests, ONE definition shared with the
	// line-cap / cyclomatic / coverage-targeting surfaces (isCappableFile): a
	// path the canonical predicate exempts — root scratch/ probes, .interlinked/
	// tool-state, generated, out-of-root — can neither open debt nor be a
	// "wander". Tests stay IN domain even though the predicate exempts them:
	// a companion-test edit is exactly how debt discharges. Two gates carrying
	// two domain definitions is how the scratchpad guard's sanctioned
	// destination became this gate's "unrelated file" (2026-07-17).
	if (!TEST_RX.test(rel) && !isCappableFile({ filePath: rel, content: "", root: projectRoot })) {
		return null;
	}
	return rel;
}

/**
 * Debt files that sit DIRECTLY next to the edited file in the import graph.
 *
 * Closes an asymmetry: a red_suite debt gets graph-aware relatedness through
 * its recorded failing tests, but a `coverage` debt carries no such evidence,
 * so relatedness fell back to the filename pair alone. A coordinated change
 * that moves a symbol between a module and its immediate importer then reads as
 * a wander — neither file can go green by itself, yet the gate demands one of
 * them be finished before the other is touched. That cost three correct edits
 * on 2026-07-27.
 *
 * DIRECT neighbours only, deliberately. A transitive walk would make almost
 * every file "related" to almost every debt and quietly retire the WIP limit;
 * one hop covers the real case (two files that must land together are adjacent)
 * without dissolving the gate.
 *
 * Returns null for "unknown" — no view, a `seed-only` backend (whose answers
 * describe the seed regardless of the argument), an unindexed file, or any
 * error. Unknown must never WIDEN, matching `affectedTestsForEdit`.
 */
function adjacentDebtFilesForEdit(
	editedFile: string,
	projectRoot: string,
	depView: DependencyView | undefined,
	openDebts: Obligation[],
): ReadonlySet<string> | null {
	if (!depView || depView.answerScope !== "repo") return null;
	try {
		// The view is keyed by ABSOLUTE paths while debts record repo-relative
		// ones; querying with a relative path silently matches nothing.
		const absEdited = resolve(projectRoot, editedFile);
		if (!depView.hasFile(absEdited)) return null;
		// One call each way: `x ∈ getDependents(y)` means x imports y, so testing
		// both directions covers importer AND importee with the only edge API the
		// view exposes.
		const dependentsOfEdited = new Set(depView.getDependents(absEdited));
		const adjacent = new Set<string>();
		for (const d of openDebts) {
			const absDebt = resolve(projectRoot, d.file);
			if (dependentsOfEdited.has(absDebt)) {
				adjacent.add(d.file);
				continue;
			}
			if (depView.hasFile(absDebt) && depView.getDependents(absDebt).includes(absEdited)) {
				adjacent.add(d.file);
			}
		}
		return adjacent;
	} catch {
		return null;
	}
}

/**
 * Affected-test selection for the edited file — the failure-evidence cone's
 * graph half. Computed ONLY when some open red debt actually carries
 * failing-test evidence the cone check could intersect (a pure read over the
 * daemon's existing `ProjectGraph`, the same `selectAffectedTests` walk the
 * gate scopes suite runs with — never a second graph build). Returns null for
 * "unknown" (no view, no evidence, file not in graph, truncated walk, any
 * error): relatedness then falls back to the filename pair + failing-test
 * identity, the strict legacy shape — unknown must never WIDEN.
 */
function affectedTestsForEdit(
	editedFile: string,
	projectRoot: string,
	depView: DependencyView | undefined,
	openDebts: Obligation[],
): ReadonlySet<string> | null {
	if (!depView) return null;
	const hasEvidence = openDebts.some(
		(d) => d.kind === "red_suite" && (d.failingTestFiles?.length ?? 0) > 0,
	);
	if (!hasEvidence) return null;
	try {
		const selected = selectAffectedTests({ editedRelPath: editedFile, projectRoot, depView });
		return selected === null ? null : new Set(selected);
	} catch {
		return null;
	}
}

/**
 * Apply the pair-scoped debt lifecycle to a base coverage verdict. A pure
 * pass-through (returns `baseDecision`) for non-file / non-code events and for a
 * clean edit with no open debt. Otherwise opens / discharges / blocks per
 * `decideCoverageDebt` and persists the transitions to the ledger. `depView`
 * (the daemon's already-built dependency view, when the caller has one) powers
 * failure-evidence relatedness: while the suite is red, any file that can
 * influence a recorded failing test is part of the red→green loop, not a
 * wander — the atomic cross-module change the filename-pair rule alone
 * mis-blocked (mcp-client-bio, 2026-07).
 */
export function applyDebtMode(
	event: HarnessEvent,
	cfg: PerEditCoverageConfig,
	baseDecision: HarnessDecision | null,
	depView?: DependencyView,
): HarnessDecision | null {
	if (cfg.debt_mode !== true) return baseDecision; // off ⇒ pure pass-through
	const projectRoot = event.cwd;
	if (!projectRoot) return baseDecision; // no cwd ⇒ can't resolve the ledger; pass through
	const editedFile = editedCodeFile(event, projectRoot);
	if (!editedFile) return baseDecision; // non-file / non-code → untouched

	const openDebts = readOpenDebts(projectRoot);
	// Nothing to do only when NO debt is open and the verdict is neither of the
	// two debt-shaped blocks (uncovered → coverage debt, red-bar → red debt).
	if (openDebts.length === 0 && !isUncoveredBlock(baseDecision) && !isRedBarBlock(baseDecision)) {
		return baseDecision;
	}

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
		affectedTests: affectedTestsForEdit(editedFile, projectRoot, depView, openDebts),
		adjacentDebtFiles: adjacentDebtFilesForEdit(editedFile, projectRoot, depView, openDebts),
		// Message accuracy: name a conventional companion test only if it exists
		// (the phantom `genomics.test.ts` failure mode).
		fileExists: (rel) => existsSync(resolve(projectRoot, rel)),
		shouldNoteForeignDebt: (d) => {
			const key = `${event.session_id}|${d.id}`;
			if (foreignDebtNoted.has(key)) return false;
			foreignDebtNoted.add(key);
			return true;
		},
	});
	for (const txn of outcome.txns) appendDebtTxn(projectRoot, txn);
	return outcome.decision;
}
