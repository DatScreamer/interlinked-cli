// ===========================================
// PreToolUse gate — per-edit coverage block (apply-before-disk overlay)
// ===========================================
// Component 3 of docs/design/per-edit-coverage-enforcement.md. On a code-file
// Write/Edit/MultiEdit, this applies the PROPOSED content to an apply-before-disk
// overlay (rooted UNDER projectRoot — see coverage-overlay.ts for why never
// os.tmpdir), runs the project's FULL suite under coverage there via a
// CoverageRunner, and BLOCKS the edit (strict TDD) if it adds an uncovered
// executable line or drops the file's coverage below its prior baseline.
//
// Three safety properties make this safe to ship:
//   1. CONFIG-GATED, DEFAULT OFF. Runs only when `rules.per_edit_coverage.enabled`
//      AND `mode === "block"`. A repo that does not opt in returns at the first
//      gate before any suite run — zero cost, zero behavior change. THIS repo
//      (interlinked-cli, ~16k tests) deliberately does NOT enable it.
//   2. BUDGET-GATED. If the rolling suite-runtime estimate is at/above
//      `budget_ms`, the suite is NOT run per-edit; a deferred obligation is
//      recorded (commit-time enforcement is a later step) and the edit allowed.
//   3. FAIL-OPEN. Any runner/overlay error loud-degrades (stderr warn, allow) —
//      coverage enforcement must never crash the harness or false-block on its
//      own failure. A no-override block has no relief valve, so it fires only
//      from a clean, successful coverage measurement.
//
// Every dependency (CoverageRunner factory, overlay factory, clock) is injected
// via `CoverageWriteDeps` so the unit tests stub them and NO real suite runs.

import { extname } from "node:path";
import {
	type CoverageObligation,
	readFileCoverageBaseline,
	readRuntimeEstimateMs,
	recordCoverageObligation,
	updateRuntimeEstimateMs,
	writeFileCoverageBaseline,
} from "../coverage-obligation-ledger.js";
import { type FunctionCoverage, type PerFileCoverage } from "../coverage-final-reader.js";
import { type CreateCoverageOverlayFn, createCoverageOverlay } from "../coverage-overlay.js";
import {
	type CoverageLanguage,
	type CoverageRunner,
	coverageRunnerFor,
} from "../coverage-runner.js";
import { isCappableFile } from "../large-file-policy.js";
import { deriveEditedLineNumbers } from "../server/edit-line-derivation.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent } from "../types.js";
import { resolveProposedContent } from "../overlay-content.js";
import { isFileWrite } from "./tool-classifiers.js";

/** Injectable seams so unit tests run with NO real suite / overlay. */
export interface CoverageWriteDeps {
	/** Resolve a CoverageRunner for a language (default: the real factory). */
	runnerFor: (language: CoverageLanguage) => CoverageRunner | null;
	/** Build an apply-before-disk overlay (default: the real file-tree mirror). */
	createOverlay: CreateCoverageOverlayFn;
	/** Wall clock — injected for deterministic estimate timestamps in tests. */
	clock: () => number;
}

/** Production defaults — the real runner factory, overlay mirror, and clock. */
const DEFAULT_DEPS: CoverageWriteDeps = {
	runnerFor: (language) => coverageRunnerFor(language),
	createOverlay: createCoverageOverlay,
	clock: Date.now,
};

/** Map a file extension to the coverage language, or null when unsupported. */
function languageForExt(ext: string): CoverageLanguage | null {
	switch (ext.toLowerCase()) {
		case ".ts":
		case ".tsx":
		case ".mts":
		case ".cts":
			return "ts";
		case ".js":
		case ".jsx":
		case ".mjs":
		case ".cjs":
			return "js";
		case ".py":
		case ".pyi":
			return "python";
		default:
			return null;
	}
}

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

/** True when the runner reported native per-line coverage (coverage.py path). */
function hasPerLineData(cov: PerFileCoverage): boolean {
	return cov.uncoveredLines !== undefined || cov.coveredLines !== undefined;
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
 * the per-file drop vs baseline. On allow, refresh the baseline so it reflects
 * the last state the gate let through. Returns the block decision or null.
 *
 * One decision path, two coverage shapes: native per-line data (coverage.py) is
 * preferred when present because the decision is inherently per-line; otherwise
 * the per-function (istanbul / JS) path runs — identical to before this fork.
 */
function decideFromCoverage(
	projectRoot: string,
	relPath: string,
	cov: PerFileCoverage,
	editedLines: Set<number> | undefined,
): HarnessDecision | null {
	const verdict = hasPerLineData(cov)
		? decidePerLine(relPath, cov, editedLines)
		: decidePerFunction(relPath, cov, editedLines);
	if ("block" in verdict) return verdict.block;

	const now = verdict.now;
	const prior = readFileCoverageBaseline(projectRoot, relPath);
	if (prior !== null && now < prior) return blockForDrop(relPath, prior, now);

	// Allowed → record the new baseline.
	writeFileCoverageBaseline(projectRoot, relPath, now);
	return null;
}

/** Loud-degrade: warn on stderr, then allow (return null). Fail-open. */
function loudDegrade(relPath: string, why: string): null {
	process.stderr.write(
		`[interlinked:coverage] WARNING: per-edit coverage gate degraded for ${relPath} ` +
			`(${why}) — allowing the edit (fail-open). Coverage is NOT enforced for this write.\n`,
	);
	return null;
}

/** Record a deferred coverage obligation and allow (budget exceeded). */
function deferForBudget(
	projectRoot: string,
	relPath: string,
	event: HarnessEvent,
	estimateMs: number,
	budgetMs: number,
): null {
	const obligation: CoverageObligation = {
		kind: "coverage",
		file: relPath,
		reason: "budget_exceeded",
		estimated_suite_ms: estimateMs,
		budget_ms: budgetMs,
		session_id: event.session_id,
		timestamp: new Date(Date.now()).toISOString(),
	};
	recordCoverageObligation(projectRoot, obligation);
	return null;
}

interface GateContext {
	projectRoot: string;
	relPath: string;
	proposed: string;
	language: CoverageLanguage;
	editedLines: Set<number> | undefined;
	budgetMs: number;
}

/**
 * Build the overlay, run the suite under coverage, update the estimate, and
 * decide. Split out of `checkCoverageWrite` so the entry stays low-complexity.
 * Throwing is contained by the entry's try/catch (loud-degrade).
 */
async function runOverlayAndDecide(
	ctx: GateContext,
	event: HarnessEvent,
	deps: CoverageWriteDeps,
): Promise<HarnessDecision | null> {
	const runner = deps.runnerFor(ctx.language);
	if (!runner) return loudDegrade(ctx.relPath, `no coverage runner for ${ctx.language}`);

	const overlay = deps.createOverlay(ctx.projectRoot, ctx.relPath, ctx.proposed);
	try {
		const result = await runner.run({
			projectRoot: overlay.overlayRoot,
			coverageDir: `${overlay.overlayRoot}/.interlinked/coverage`,
		});
		updateRuntimeEstimateMs(ctx.projectRoot, result.suiteMs, deps.clock);
		if (!result.ok) return loudDegrade(ctx.relPath, result.error ?? "coverage run failed");

		const cov = result.perFile.get(ctx.relPath);
		if (!cov) {
			return loudDegrade(ctx.relPath, "edited file absent from coverage report");
		}
		return decideFromCoverage(ctx.projectRoot, ctx.relPath, cov, ctx.editedLines);
	} finally {
		overlay.cleanup();
	}
}

/** Resolve the edited file path from the tool input (absolute or cwd-relative). */
function editedRelPath(event: HarnessEvent, projectRoot: string): string | null {
	const input = event.tool_input ?? {};
	const raw = (input.file_path as string) || (input.path as string) || "";
	if (!raw) return null;
	const abs = raw.startsWith("/") ? raw : `${projectRoot}/${raw}`;
	// Keep inside the project; an out-of-tree edit isn't this repo's coverage unit.
	if (!abs.startsWith(`${projectRoot}/`)) return null;
	return abs.slice(projectRoot.length + 1).replace(/\\/g, "/");
}

/**
 * PreToolUse coverage gate. Returns a `block` HarnessDecision when the proposed
 * edit adds an uncovered line or drops the file's coverage; otherwise null
 * (allow). A pure no-op — runner never invoked — when disabled, in warn mode,
 * or for a non-code / unsupported-language / test / non-cappable file. Never
 * throws (fail-open).
 */
export async function checkCoverageWrite(
	event: HarnessEvent,
	rules: GuardRulesConfig,
	deps: CoverageWriteDeps = DEFAULT_DEPS,
): Promise<HarnessDecision | null> {
	const cfg = rules.per_edit_coverage;
	if (!cfg?.enabled || cfg.mode !== "block") return null;
	if (!isFileWrite(event.tool_name)) return null;

	const projectRoot = event.cwd || process.cwd();
	const relPath = editedRelPath(event, projectRoot);
	if (!relPath) return null;

	const language = languageForExt(extname(relPath));
	if (!language || !cfg.languages.includes(language)) return null;

	const input = event.tool_input ?? {};
	const proposed = resolveProposedContent(`${projectRoot}/${relPath}`, input);
	// Skip test files / generated / non-code (same predicate as the line cap):
	// the coverage unit is production code, not the tests themselves.
	if (!isCappableFile({ filePath: relPath, content: proposed })) return null;

	try {
		const estimate = readRuntimeEstimateMs(projectRoot);
		if (estimate !== null && estimate >= cfg.budget_ms) {
			return deferForBudget(projectRoot, relPath, event, estimate, cfg.budget_ms);
		}
		const editedLines = deriveEditedLineNumbers(event.tool_name, input, proposed);
		const ctx: GateContext = {
			projectRoot,
			relPath,
			proposed,
			language,
			editedLines,
			budgetMs: cfg.budget_ms,
		};
		return await runOverlayAndDecide(ctx, event, deps);
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return loudDegrade(relPath, why);
	}
}
