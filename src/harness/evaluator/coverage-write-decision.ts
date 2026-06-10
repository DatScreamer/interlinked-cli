// ===========================================
// Per-edit coverage — pure decision helpers (extracted from coverage-write-guard.ts)
// ===========================================
// The uncovered-added-line / coverage-drop / red-bar decision pieces of the
// per-edit gate, split out to keep the guard module under the per-file line cap.
// Pure functions over the runner's PerFileCoverage — no overlay, no runner, no
// config. Import from coverage-write-guard.ts unless you specifically need the
// decision pieces in isolation (the delete-only path does).

import { type FunctionCoverage, type PerFileCoverage } from "../coverage-final-reader.js";
import { readFileCoverageBaseline } from "../coverage-obligation-ledger.js";
import type { HarnessDecision } from "../types.js";
import { hasPerLineData } from "./coverage-crap-decision.js";

/**
 * The covered-line *fraction* (0..1) for a file, derived from the per-function
 * statement coverage the runner reports. Empty / no-statement files report 1
 * (nothing to cover ⇒ no regression). This is the honest aggregate the drop
 * check compares against the prior baseline.
 */
function coveredFraction(cov: PerFileCoverage): number {
	if (cov.functions.length === 0) return 1;
	let sum = 0;
	for (const fn of cov.functions) sum += fn.statement_pct;
	return sum / cov.functions.length / 100;
}

/**
 * The covered-line fraction from PER-LINE data (coverage.py): covered /
 * (covered + uncovered). A file with no executable lines reports 1 (nothing to
 * cover ⇒ no regression), matching the function-path convention.
 */
function coveredFractionByLine(covered: ReadonlySet<number>, uncovered: ReadonlySet<number>): number {
	const total = covered.size + uncovered.size;
	if (total === 0) return 1;
	return covered.size / total;
}

/**
 * The first executable line the edit ADDED that is uncovered, or null when none.
 * When the edited-line set is known, only an added line counts (the line-precise
 * strict-TDD invariant); when derivation failed (undefined), ANY uncovered line
 * counts — an edit must not leave the file with an uncovered line. Lowest line
 * number first, for a stable, actionable message.
 */
function uncoveredAddedLine(
	uncovered: ReadonlySet<number>,
	editedLines: Set<number> | undefined,
): number | null {
	let lowest: number | null = null;
	for (const ln of uncovered) {
		if (editedLines && !editedLines.has(ln)) continue;
		if (lowest === null || ln < lowest) lowest = ln;
	}
	return lowest;
}

/** True when a function's body range intersects any edited line. */
function fnTouchesEditedLines(fn: FunctionCoverage, editedLines: Set<number>): boolean {
	for (let ln = fn.line; ln <= fn.endLine; ln++) {
		if (editedLines.has(ln)) return true;
	}
	return false;
}

/**
 * The first uncovered function that the edit ADDED/changed, or null when every
 * edited function is covered. A function is "uncovered" when it never executed
 * (hits 0) or none of its statements ran (statement_pct 0). When the edited-line
 * set is unavailable (fail-open on derivation), every uncovered function counts
 * — the strict-TDD invariant: an edit must not leave an uncovered function.
 */
function uncoveredAddedFunction(
	cov: PerFileCoverage,
	editedLines: Set<number> | undefined,
): FunctionCoverage | null {
	for (const fn of cov.functions) {
		const uncovered = fn.hits === 0 || fn.statement_pct === 0;
		if (!uncovered) continue;
		if (!editedLines || fnTouchesEditedLines(fn, editedLines)) return fn;
	}
	return null;
}

/** The actionable strict-TDD block for an uncovered added line. */
function blockForUncovered(relPath: string, fn: FunctionCoverage): HarnessDecision {
	return {
		decision: "block",
		reason:
			`[interlinked:coverage] BLOCKED: ${relPath} line ${fn.line} (function ` +
			`\`${fn.name}\`) is executable but uncovered by the test suite after this edit. ` +
			"Strict TDD: an edit must not add uncovered code. Add the test that exercises " +
			"this code in the SAME edit (use MultiEdit so the overlay sees test + code " +
			"together → covered → allowed), then retry.",
		rule_id: "per-edit-coverage",
		severity: "medium",
		category: "coverage",
	};
}

/**
 * The strict-TDD block for an uncovered added line known only by NUMBER (the
 * per-line path; coverage.py gives no function name). Same actionable shape as
 * {@link blockForUncovered} minus the function attribution.
 */
function blockForUncoveredLine(relPath: string, line: number): HarnessDecision {
	return {
		decision: "block",
		reason:
			`[interlinked:coverage] BLOCKED: ${relPath} line ${line} is executable but ` +
			"uncovered by the test suite after this edit. Strict TDD: an edit must not add " +
			"uncovered code. Add the test that exercises this code in the SAME edit (use " +
			"MultiEdit so the overlay sees test + code together → covered → allowed), then retry.",
		rule_id: "per-edit-coverage",
		severity: "medium",
		category: "coverage",
	};
}

/** Render the failing-test list for the red-bar reason, or a generic phrase. */
export function failingTestPhrase(failingTests: string[] | undefined): string {
	if (!failingTests || failingTests.length === 0) return "one or more tests are failing";
	const shown = failingTests.slice(0, 3);
	const suffix = failingTests.length > shown.length ? ", …" : "";
	return `failing test(s): ${shown.join(", ")}${suffix}`;
}

/**
 * The red-bar (strict per-edit TDD) block: the overlay ran the suite and it came
 * back RED (`testsPassed === false`). A failing suite is a harder failure than a
 * coverage gap, so this fires BEFORE the uncovered-line / drop decision and names
 * the failing test(s) so the fix is actionable.
 */
export function blockForRedBar(relPath: string, failingTests: string[] | undefined): HarnessDecision {
	return {
		decision: "block",
		reason:
			`[interlinked:coverage] BLOCKED: your edit to ${relPath} leaves the test suite RED ` +
			`— ${failingTestPhrase(failingTests)}. Fix it in THIS edit (use MultiEdit so the ` +
			"overlay sees code + test together → suite green → allowed) before proceeding. " +
			"Strict TDD: an edit may not save a transiently-red state.",
		rule_id: "per-edit-coverage",
		severity: "medium",
		category: "coverage",
	};
}

/** The actionable block for a per-file coverage regression vs the baseline. */
function blockForDrop(relPath: string, prior: number, now: number): HarnessDecision {
	const pct = (n: number): string => `${Math.round(n * 100)}%`;
	return {
		decision: "block",
		reason:
			`[interlinked:coverage] BLOCKED: this edit drops ${relPath} coverage from ` +
			`${pct(prior)} to ${pct(now)}. Strict TDD: coverage must not decrease. Restore the ` +
			"test(s) covering the changed code in this edit (MultiEdit), then retry.",
		rule_id: "per-edit-coverage",
		severity: "medium",
		category: "coverage",
	};
}

/**
 * The uncovered-added-line block and the now-fraction from PER-LINE data. Used
 * for engines whose report is natively per-line (coverage.py). Returns the block
 * for an uncovered added line, or the file's covered fraction when none.
 */
function decidePerLine(
	relPath: string,
	cov: PerFileCoverage,
	editedLines: Set<number> | undefined,
): { block: HarnessDecision } | { now: number } {
	const covered = cov.coveredLines ?? new Set<number>();
	const uncovered = cov.uncoveredLines ?? new Set<number>();
	const line = uncoveredAddedLine(uncovered, editedLines);
	if (line !== null) return { block: blockForUncoveredLine(relPath, line) };
	return { now: coveredFractionByLine(covered, uncovered) };
}

/**
 * The uncovered-added-line block and the now-fraction from PER-FUNCTION data
 * (istanbul / JS). Behavior is unchanged from the original single-path gate.
 */
function decidePerFunction(
	relPath: string,
	cov: PerFileCoverage,
	editedLines: Set<number> | undefined,
): { block: HarnessDecision } | { now: number } {
	const uncovered = uncoveredAddedFunction(cov, editedLines);
	if (uncovered) return { block: blockForUncovered(relPath, uncovered) };
	return { now: coveredFraction(cov) };
}

/**
 * Decide block-or-allow from the overlay's coverage of the edited file. Order:
 * uncovered-added-line first (the most actionable, line-specific message), then
 * the per-file drop vs baseline. On allow, the new fraction is handed back via
 * `out` so the CALLER persists it only after every later gate (CRAP) also
 * passes — writing it here would poison the baseline with rejected content if
 * CRAP then blocks (finding 8). Returns the block decision or null.
 *
 * One decision path, two coverage shapes: native per-line data (coverage.py) is
 * preferred when present because the decision is inherently per-line; otherwise
 * the per-function (istanbul / JS) path runs — identical to before this fork.
 */
export function decideFromCoverage(
	projectRoot: string,
	relPath: string,
	cov: PerFileCoverage,
	editedLines: Set<number> | undefined,
	out: { now?: number },
): HarnessDecision | null {
	const verdict = hasPerLineData(cov)
		? decidePerLine(relPath, cov, editedLines)
		: decidePerFunction(relPath, cov, editedLines);
	if ("block" in verdict) return verdict.block;

	const now = verdict.now;
	const prior = readFileCoverageBaseline(projectRoot, relPath);
	if (prior !== null && now < prior) return blockForDrop(relPath, prior, now);

	out.now = now;
	return null;
}
