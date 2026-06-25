// ===========================================
// Coverage debt — the pair-scoped TDD decision (Phase 2 logic)
// ===========================================
// Encodes the rule: an agent's FIRST edit that leaves source uncovered is never
// blocked — it opens a coverage debt and is allowed. While that debt is open the
// agent may freely keep editing the same source (or write its companion test);
// the ONLY thing blocked is an edit that wanders to an unrelated file before the
// debt is covered. "Block, but not too soon, and never for staying in the pair."
//
// This module is PURE: it takes the base coverage-gate verdict plus the current
// ledger state and a map of re-checked files, and returns the final decision +
// the obligation transitions to append. The fs ledger and the runner-backed
// re-check live in the call-site glue; this is the part that holds the rule and
// is exhaustively unit-tested (including the canonical edit pairs).

import { type Obligation, type ObligationTxn, obligationId } from "./obligations.js";
import type { HarnessDecision } from "./types.js";

/**
 * The logical-unit key shared by a source file and its co-located test: strip a
 * `.test`/`.spec` infix and the extension. `src/foo.ts` and `src/foo.test.ts`
 * both map to `src/foo`; `src/bar.ts` does not. Two edits are "in the same pair"
 * iff they share a stem.
 */
export function pairStem(relPath: string): string {
	return relPath.replace(/\.(test|spec)\.[cm]?[jt]sx?$/i, "").replace(/\.[cm]?[jt]sx?$/i, "");
}

/** The conventional co-located test path for a source file (`src/foo.ts` →
 *  `src/foo.test.ts`) — named in the block message so the agent knows where to go. */
export function expectedCompanionTest(source: string): string {
	return source.replace(/\.([cm]?[jt]sx?)$/i, ".test.$1");
}

/** True for the per-edit gate's "this added line is uncovered" block — the one
 *  verdict debt-mode downgrades. Red-bar / coverage-drop / floor / CRAP blocks
 *  carry different reasons and pass through untouched. */
export function isUncoveredBlock(decision: HarnessDecision | null): boolean {
	return (
		decision !== null &&
		decision.decision === "block" &&
		typeof decision.reason === "string" &&
		decision.reason.includes("uncovered by the test suite")
	);
}

export interface CoverageDebtInput {
	/** What `checkCoverageWrite` returned for the edited file. */
	baseDecision: HarnessDecision | null;
	/** Repo-relative path of the file this edit touches. */
	editedFile: string;
	/** Currently-open coverage debts (from the ledger). */
	openDebts: Obligation[];
	/** Files the caller re-ran coverage on this edit → covered? (true = covered). */
	rechecks: ReadonlyMap<string, boolean>;
	/** Max concurrently-open debts before an out-of-pair edit blocks. Omitted ⇒ 1
	 *  (strict pair rule); >1 relaxes toward the commit backstop. */
	wipLimit?: number;
	sessionId: string;
	atMs: number;
}

export interface CoverageDebtOutcome {
	/** The final verdict (null = allow). */
	decision: HarnessDecision | null;
	/** Ledger transitions the caller must append. */
	txns: ObligationTxn[];
}

function blockForWander(d: Obligation): HarnessDecision {
	const test = expectedCompanionTest(d.file);
	return {
		decision: "block",
		reason:
			`[interlinked:coverage] BLOCKED: you added code to ${d.file} that no test covers yet, ` +
			`and this edit moves to an unrelated file. Keep editing ${d.file} or write its test ` +
			`(${test}) and cover it — then continue.`,
		rule_id: "per-edit-coverage-debt",
		severity: "medium",
		category: "coverage",
	};
}

function allowWithDebt(file: string): HarnessDecision {
	return {
		decision: "allow",
		warnings: [
			`[interlinked:coverage] Opened coverage debt for ${file} — the code you added isn't ` +
				`covered yet. Keep editing ${file} or write its test next; just don't move to an ` +
				`unrelated file until it's covered.`,
		],
	};
}

/**
 * Apply the pair-scoped debt rule. Order: discharge anything the caller proved
 * covered, then enforce the pair boundary (wander → block), then fold the base
 * gate verdict (uncovered → open debt + allow; covered-with-open-debt →
 * discharge; everything else → pass through).
 */
export function decideCoverageDebt(input: CoverageDebtInput): CoverageDebtOutcome {
	const { baseDecision, editedFile, openDebts, rechecks, wipLimit = 1, sessionId, atMs } = input;
	const txns: ObligationTxn[] = [];

	// 1. Discharge any debt the caller re-checked and found covered.
	const discharged = new Set<string>();
	for (const d of openDebts) {
		if (rechecks.get(d.file) === true) {
			txns.push({ op: "discharge", id: d.id, source: "local", atMs });
			discharged.add(d.file);
		}
	}
	const stillOpen = openDebts.filter((d) => !discharged.has(d.file));

	// 2. Pair rule (WIP-limited): editing inside any open pair is always free; an
	//    edit outside every open pair is a "wander", blocked once the number of
	//    concurrently-open debts is at the WIP limit (default 1 = strict pair rule).
	const inSomePair = stillOpen.some((d) => pairStem(editedFile) === pairStem(d.file));
	const oldest = stillOpen[0];
	if (!inSomePair && oldest && stillOpen.length >= wipLimit) {
		return { decision: blockForWander(oldest), txns };
	}

	// 3. In-pair (or nothing open): fold the base gate verdict.
	if (isUncoveredBlock(baseDecision)) {
		// First (or continued) uncovered edit → open debt and ALLOW. Not blocked.
		txns.push({ op: "open", kind: "coverage", file: editedFile, contentHash: "", sessionId, atMs });
		return { decision: allowWithDebt(editedFile), txns };
	}
	if (baseDecision === null && stillOpen.some((d) => d.file === editedFile)) {
		// Edited the debted source and it now reads as covered → discharge.
		txns.push({ op: "discharge", id: obligationId("coverage", editedFile), source: "local", atMs });
		return { decision: null, txns };
	}
	// Red-bar / drop / floor / CRAP / clean-allow pass through untouched.
	return { decision: baseDecision, txns };
}
