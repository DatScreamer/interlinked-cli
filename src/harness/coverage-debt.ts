// ===========================================
// Coverage debt — the pair-scoped TDD decision (Phase 2 logic)
// ===========================================
// Encodes the rule: an agent's FIRST edit that leaves source uncovered — or
// leaves the suite RED (the red→green loop's legitimate intermediate) — is
// never blocked: it opens a debt (kind `coverage` / `red_suite`) and is
// allowed. While a debt is open the agent may freely keep editing the same
// source (or its companion test); the ONLY thing blocked is an edit that
// wanders to an unrelated file before the debt is covered / green again.
// "Block, but not too soon, and never for staying in the pair."
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

const TEST_INFIX_RX = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const CODE_EXT_RX = /\.[cm]?[jt]sx?$/i;

/** Split a path into (directory, basename-stem, isTest). A trailing `/__tests__`
 *  segment is stripped from the directory so an umbrella test under `__tests__/`
 *  resolves to the same directory as the sources it covers. */
function pairParts(relPath: string): { dir: string; stem: string; isTest: boolean } {
	const isTest = TEST_INFIX_RX.test(relPath);
	const noInfix = relPath.replace(TEST_INFIX_RX, "").replace(CODE_EXT_RX, "");
	const slash = noInfix.lastIndexOf("/");
	const dir = (slash >= 0 ? noInfix.slice(0, slash) : "").replace(/\/__tests__$/, "");
	const stem = slash >= 0 ? noInfix.slice(slash + 1) : noInfix;
	return { dir, stem, isTest };
}

/**
 * True iff two paths belong to the same coverage pair. Beyond the exact stem
 * match (`src/foo.ts` ↔ `src/foo.test.ts`), this also pairs a DECOMPOSED source
 * with its UMBRELLA test: `foo-bar.ts` is covered by `foo.test.ts` when they
 * share a directory (or the test lives in that directory's `__tests__/`) and the
 * test's stem is a hyphen-delimited prefix of the source's stem. Decomposing
 * `foo.ts` into `foo-*.ts` siblings otherwise stranded each from the umbrella
 * test that exercises it (`__tests__/write-content-guards.test.ts` no longer
 * paired with `write-content-guards-content-quality.ts`). Optimistic by the same
 * contract as the rest of debt mode — the commit gate is the ground-truth backstop.
 */
export function inSamePair(a: string, b: string): boolean {
	if (pairStem(a) === pairStem(b)) return true;
	const pa = pairParts(a);
	const pb = pairParts(b);
	if (pa.dir !== pb.dir) return false;
	// Exactly one side must be a test; its stem prefixes the source side's stem.
	const test = pa.isTest && !pb.isTest ? pa : pb.isTest && !pa.isTest ? pb : null;
	const src = test === pa ? pb : test === pb ? pa : null;
	if (!test || !src) return false;
	return src.stem.startsWith(`${test.stem}-`);
}

/** The conventional co-located test path for a source file (`src/foo.ts` →
 *  `src/foo.test.ts`) — named in the block message so the agent knows where to go. */
export function expectedCompanionTest(source: string): string {
	return source.replace(/\.([cm]?[jt]sx?)$/i, ".test.$1");
}

/** The source counterpart of a TEST path (`src/foo.test.ts` → `src/foo.ts`):
 *  strip the `.test`/`.spec` infix, keep the extension. The inverse of
 *  {@link expectedCompanionTest}, used so a debt opened ON a test file (the
 *  red→green loop's canonical first edit) names its pair correctly instead of
 *  deriving nonsense like `foo.test.test.ts`. */
export function expectedSourceOfTest(testPath: string): string {
	return testPath.replace(/\.(test|spec)(\.[cm]?[jt]sx?)$/i, "$2");
}

/** The exact phrase the per-edit gate's uncovered-added-line producers
 *  (`blockForUncovered` / `blockForUncoveredLine` in
 *  `evaluator/coverage-write-decision.ts`) interpolate into their reasons, and
 *  that {@link isUncoveredBlock} matches on. Shared so the producer↔matcher
 *  coupling is structural — two drifting string literals cannot silently stop
 *  debt-mode from recognizing the verdict. */
export const UNCOVERED_MARKER = "uncovered by the test suite";

/** The exact phrase the red-bar producers (`blockForRedBar` in
 *  `evaluator/coverage-write-decision.ts`, `blockForDeletionRedBar` in
 *  `evaluator/coverage-write-guard-redbar.ts`) interpolate, and that
 *  {@link isRedBarBlock} matches on. `blockForCrossSuiteRedBar` deliberately
 *  does NOT carry this marker — cross-ecosystem breakage is not the pair's
 *  red→green loop, so it stays a hard block instead of folding into debt. */
export const RED_BAR_MARKER = "leaves the test suite RED";

/** True for the per-edit gate's "this added line is uncovered" block — the
 *  first verdict debt-mode downgrades. Coverage-drop / floor / CRAP blocks
 *  carry different reasons and pass through untouched. */
export function isUncoveredBlock(decision: HarnessDecision | null): boolean {
	return (
		decision !== null &&
		decision.decision === "block" &&
		typeof decision.reason === "string" &&
		decision.reason.includes(UNCOVERED_MARKER)
	);
}

/** True for the per-edit gate's red-bar block ("leaves the test suite RED") —
 *  the second verdict debt-mode downgrades, into a `red_suite` debt: the
 *  red→green loop in progress. Landing a failing test first, or a behavior
 *  redesign whose source+tests must change across edits, is PROGRESS — what's
 *  forbidden is wandering off while the pair is red (and the commit gate is
 *  the ground-truth backstop). This is what retires the old "write code + test
 *  together in one `interlinked write --batch`" workaround. */
export function isRedBarBlock(decision: HarnessDecision | null): boolean {
	return (
		decision !== null &&
		decision.decision === "block" &&
		typeof decision.reason === "string" &&
		decision.reason.includes(RED_BAR_MARKER)
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

/** The "other side of the pair" clause for a debt message. Role-correct when
 *  the debted file is itself a TEST (the red→green loop's canonical opener:
 *  land the failing test first) — it names the test's SOURCE instead of
 *  deriving the nonsense `foo.test.test.ts` via {@link expectedCompanionTest}. */
function pairOtherSide(d: Obligation): string {
	if (TEST_INFIX_RX.test(d.file)) {
		const src = expectedSourceOfTest(d.file);
		return d.kind === "coverage" ? `cover its source (${src})` : `its source (${src})`;
	}
	const test = expectedCompanionTest(d.file);
	return d.kind === "coverage" ? `write its test (${test}) and cover it` : `its test (${test})`;
}

function blockForWander(d: Obligation): HarnessDecision {
	const reason =
		d.kind === "red_suite"
			? `[interlinked:coverage] BLOCKED: the test suite is RED from your edits to ${d.file}, ` +
				`and this edit moves to an unrelated file. Drive that pair green first — keep editing ` +
				`${d.file} or ${pairOtherSide(d)} — then continue.`
			: `[interlinked:coverage] BLOCKED: you added code to ${d.file} that no test covers yet, ` +
				`and this edit moves to an unrelated file. Keep editing ${d.file} or ` +
				`${pairOtherSide(d)} — then continue.`;
	return {
		decision: "block",
		reason,
		rule_id: "per-edit-coverage-debt",
		severity: "medium",
		category: "coverage",
	};
}

function allowWithDebt(file: string): HarnessDecision {
	const next = TEST_INFIX_RX.test(file)
		? `cover its source (${expectedSourceOfTest(file)}) next`
		: "write its test next";
	return {
		decision: "allow",
		warnings: [
			`[interlinked:coverage] Opened coverage debt for ${file} — the code you added isn't ` +
				`covered yet. Keep editing ${file} or ${next}; just don't move to an ` +
				`unrelated file until it's covered.`,
		],
	};
}

function allowWithRedDebt(file: string): HarnessDecision {
	const other = TEST_INFIX_RX.test(file)
		? `its source (${expectedSourceOfTest(file)})`
		: "its test";
	return {
		decision: "allow",
		warnings: [
			`[interlinked:coverage] Suite is RED after this edit — red debt opened for ${file}. ` +
				`You're in the red→green loop: keep editing ${file} or ${other} freely; just don't ` +
				`move to an unrelated file until the pair runs green again.`,
		],
	};
}

/**
 * The red-bar fold — the twin of the uncovered fold below. A red verdict opens
 * (or continues) the pair's `red_suite` debt and ALLOWS: landing a failing
 * test first, or a behavior change whose source + tests must move across
 * edits, is the red→green loop, not a violation. Any NON-red verdict on an
 * edit that LANDS discharges same-pair red debts — deliberately optimistic,
 * like the coverage discharge: that includes verdicts produced WITHOUT a suite
 * run (an ungated pure-test edit, a budget defer, a loud degrade), and the
 * commit gate is the ground-truth backstop. A pass-through BLOCK (drop /
 * floor / CRAP) refuses the edit, so it discharges nothing. Returns an
 * outcome to short-circuit with, or null to continue folding.
 */
function foldRedBar(args: {
	baseDecision: HarnessDecision | null;
	editedFile: string;
	stillOpen: Obligation[];
	txns: ObligationTxn[];
	sessionId: string;
	atMs: number;
}): CoverageDebtOutcome | null {
	const { baseDecision, editedFile, stillOpen, txns, sessionId, atMs } = args;
	if (isRedBarBlock(baseDecision)) {
		const already = stillOpen.some((d) => d.kind === "red_suite" && inSamePair(editedFile, d.file));
		if (!already) {
			txns.push({ op: "open", kind: "red_suite", file: editedFile, contentHash: "", sessionId, atMs });
		}
		return { decision: allowWithRedDebt(editedFile), txns };
	}
	// A pass-through BLOCK (coverage-drop / floor / CRAP) REFUSES the edit —
	// nothing lands on disk, so its non-red overlay run is no evidence the
	// pair went green: same-pair red debts must survive. The uncovered block
	// is exempt because it downgrades to allow + coverage debt below (that
	// edit DOES land, and its overlay ran non-red).
	if (baseDecision?.decision === "block" && !isUncoveredBlock(baseDecision)) return null;
	for (const d of stillOpen) {
		if (d.kind === "red_suite" && inSamePair(editedFile, d.file)) {
			txns.push({ op: "discharge", id: d.id, source: "local", atMs });
		}
	}
	return null;
}

/**
 * Apply the pair-scoped debt rule. Order: discharge anything the caller proved
 * covered, then enforce the pair boundary (wander → block), then fold the base
 * gate verdict (red → open red debt + allow; uncovered → open coverage debt +
 * allow; covered-with-open-debt → discharge; everything else → pass through).
 */
export function decideCoverageDebt(input: CoverageDebtInput): CoverageDebtOutcome {
	const { baseDecision, editedFile, openDebts, rechecks, wipLimit = 1, sessionId, atMs } = input;
	const txns: ObligationTxn[] = [];

	// 1. Discharge any COVERAGE debt the caller re-checked and found covered.
	//    (Scoped by kind: a companion-test edit is optimistic proof of coverage,
	//    but proves nothing about the suite being green — red debts discharge
	//    only from a non-red verdict, in foldRedBar.) Keyed by DEBT ID, not
	//    file: a coverage debt and a red debt can be open on the SAME file, and
	//    a file-keyed filter would hide the red debt from `stillOpen` here so
	//    foldRedBar could not discharge it in the same call.
	const discharged = new Set<string>();
	for (const d of openDebts) {
		if (d.kind === "coverage" && rechecks.get(d.file) === true) {
			txns.push({ op: "discharge", id: d.id, source: "local", atMs });
			discharged.add(d.id);
		}
	}
	const stillOpen = openDebts.filter((d) => !discharged.has(d.id));

	// 2. Pair rule (WIP-limited): editing inside any open pair is always free; an
	//    edit outside every open pair is a "wander", blocked once the number of
	//    concurrently-open debts is at the WIP limit (default 1 = strict pair rule).
	const inSomePair = stillOpen.some((d) => inSamePair(editedFile, d.file));
	const oldest = stillOpen[0];
	if (!inSomePair && oldest && stillOpen.length >= wipLimit) {
		return { decision: blockForWander(oldest), txns };
	}

	// 3. In-pair (or nothing open): fold the base gate verdict — red first (its
	//    discharge must run even when the verdict falls through to uncovered).
	const red = foldRedBar({ baseDecision, editedFile, stillOpen, txns, sessionId, atMs });
	if (red) return red;

	if (isUncoveredBlock(baseDecision)) {
		// First (or continued) uncovered edit → open debt and ALLOW. Not blocked.
		txns.push({ op: "open", kind: "coverage", file: editedFile, contentHash: "", sessionId, atMs });
		return { decision: allowWithDebt(editedFile), txns };
	}
	if (baseDecision === null && stillOpen.some((d) => d.kind === "coverage" && d.file === editedFile)) {
		// Edited the debted source and it now reads as covered → discharge.
		txns.push({ op: "discharge", id: obligationId("coverage", editedFile), source: "local", atMs });
		return { decision: null, txns };
	}
	// Drop / floor / CRAP / clean-allow pass through untouched.
	return { decision: baseDecision, txns };
}
