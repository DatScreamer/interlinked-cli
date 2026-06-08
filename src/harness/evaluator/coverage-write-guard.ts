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
// Red bar (per-edit TDD), opt-in via `per_edit_coverage.block_on_test_failure`:
// the same overlay run also yields `testsPassed` (from the suite's exit code). A
// FAILING suite is a harder failure than a coverage gap, so when that flag is on
// AND the run came back RED (`testsPassed === false`) the edit is blocked BEFORE
// the coverage decision, naming the failing test(s). `testsPassed === null`
// (runner unavailable / errored) fail-opens, exactly like a failed coverage
// measurement — a red bar can only ever fire from a clean, definitive red run.
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
import { computeCyclomaticAst } from "../checks/cyclomatic-ast.js";
import { computeCyclomaticPython } from "../checks/cyclomatic-python.js";
import { type FunctionCoverage, type PerFileCoverage } from "../coverage-final-reader.js";
import {
	type CoverageObligation,
	readFileCoverageBaseline,
	readRuntimeEstimateMs,
	recordCoverageObligation,
	updateRuntimeEstimateMs,
	writeFileCoverageBaseline,
} from "../coverage-obligation-ledger.js";
import { type CreateCoverageOverlayFn, createCoverageOverlay } from "../coverage-overlay.js";
import {
	type CoverageLanguage,
	type CoverageRunner,
	coverageRunnerFor,
} from "../coverage-runner.js";
import { selectAffectedTests } from "../coverage-test-selector.js";
import type { DependencyView } from "../dependency-view.js";
import { isCappableFile } from "../large-file-policy.js";
import { resolveProposedContent } from "../overlay-content.js";
import { deriveEditedLineNumbers } from "../server/edit-line-derivation.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent } from "../types.js";
import {
	type CrapInput,
	type CyclomaticAnalyzer,
	DEFAULT_CRAP_THRESHOLD,
	decideCrap,
	hasPerLineData,
} from "./coverage-crap-decision.js";
import { isFileWrite } from "./tool-classifiers.js";

// `CyclomaticAnalyzer` (the per-function cyclomatic counter for CRAP) now lives
// with the CRAP decision; re-exported here so this module's public surface is
// unchanged for existing importers.
export type { CyclomaticAnalyzer } from "./coverage-crap-decision.js";

/** Injectable seams so unit tests run with NO real suite / overlay / analyzer. */
export interface CoverageWriteDeps {
	/** Resolve a CoverageRunner for a language (default: the real factory). */
	runnerFor: (language: CoverageLanguage) => CoverageRunner | null;
	/** Build an apply-before-disk overlay (default: the real file-tree mirror). */
	createOverlay: CreateCoverageOverlayFn;
	/** Wall clock — injected for deterministic estimate timestamps in tests. */
	clock: () => number;
	/**
	 * The per-function cyclomatic analyzer for a language, or null to skip CRAP for
	 * it. Default: the in-process TS AST for js/ts, radon for python — the same
	 * analyzers the strict cyclomatic PreToolUse gate uses. Injected so the CRAP
	 * tests supply a deterministic stub instead of spawning radon / loading TS.
	 */
	cyclomaticFor: (language: CoverageLanguage) => CyclomaticAnalyzer | null;
}

/** The real cyclomatic analyzer for a coverage language, or null to skip CRAP. */
function defaultCyclomaticFor(language: CoverageLanguage): CyclomaticAnalyzer | null {
	switch (language) {
		case "js":
		case "ts":
			return computeCyclomaticAst;
		case "python":
			return computeCyclomaticPython;
		default:
			return null;
	}
}

/** Production defaults — the real runner factory, overlay mirror, clock, analyzer. */
const DEFAULT_DEPS: CoverageWriteDeps = {
	runnerFor: (language) => coverageRunnerFor(language),
	createOverlay: createCoverageOverlay,
	clock: Date.now,
	cyclomaticFor: defaultCyclomaticFor,
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

/** Render the failing-test list for the red-bar reason, or a generic phrase. */
function failingTestPhrase(failingTests: string[] | undefined): string {
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
function blockForRedBar(relPath: string, failingTests: string[] | undefined): HarnessDecision {
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
 * The strict-TDD block for a source file that NO test transitively depends on
 * (affected-test selection returned `[]`). Whatever executable lines the edit
 * adds are exercised by nothing, so — without running a suite — the file is
 * uncovered by definition. Tells the agent to ship the test in the SAME edit.
 */
function blockForUntestedSource(relPath: string): HarnessDecision {
	return {
		decision: "block",
		reason:
			`[interlinked:coverage] BLOCKED: no test in the project imports ${relPath} ` +
			"(directly or transitively), so this edit's executable lines are covered by " +
			"nothing. Strict TDD: write the test for " +
			`${relPath} in this edit (use MultiEdit so the overlay sees code + test ` +
			"together → covered → allowed), then retry.",
		rule_id: "per-edit-coverage",
		severity: "medium",
		category: "coverage",
	};
}

// CRAP (Change Risk Anti-Patterns) — the 4th per-edit block — lives in
// `coverage-crap-decision.ts` (`decideCrap`), extracted to keep this module under
// the per-file line cap. It runs AFTER the uncovered-added-line / drop decision: a
// flat coverage gap is the more basic failure; CRAP is the "complex AND
// under-covered" escalation. Computed from the SAME overlay coverage run (no
// second suite spawn). `hasPerLineData` (imported above) is shared between the
// coverage-drop path here and the CRAP path there.

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

/**
 * Build an ALLOW decision that carries a single agent-visible coverage warning,
 * and ALSO mirror that exact line to the daemon's stderr (belt and suspenders:
 * the daemon log keeps a record even where the runner doesn't surface allow-time
 * warnings). The `[interlinked:coverage]` prefix is what the agent sees — the
 * Claude Code adapter routes an allow-decision's `warnings` into
 * `hookSpecificOutput.additionalContext` at PreToolUse, so this text reaches the
 * model on the same turn. Fail-open: the decision is `allow`, never a block.
 */
function allowWithCoverageWarning(warning: string): HarnessDecision {
	process.stderr.write(`${warning}\n`);
	return { decision: "allow", warnings: [warning] };
}

/**
 * Loud-degrade: ALLOW (fail-open) but emit an AGENT-VISIBLE warning so a write
 * that wasn't coverage-checked never passes silently. Returns an allow-decision
 * carrying the `[interlinked:coverage]` warning (not bare null), which the
 * pipeline propagates to the agent. The daemon-stderr line is kept too.
 */
function loudDegrade(relPath: string, why: string): HarnessDecision {
	return allowWithCoverageWarning(
		`[interlinked:coverage] WARNING: per-edit coverage gate degraded for ${relPath} ` +
			`(${why}) — allowing the edit (fail-open). This edit was NOT coverage-checked.`,
	);
}

/**
 * The fail-LOUD path for "the gate is ON for this language but the runner could
 * not establish a result" — no runner, an `ok:false` run, or a `testsPassed`/report
 * the runner could not produce. The single most common real cause is a MISSING
 * COVERAGE PROVIDER (`@vitest/coverage-v8` / `pytest-cov`), so we name it. Allows
 * the edit (fail-open — "can't measure" is not "deny") but NEVER silently: it
 * returns an allow-decision carrying an AGENT-VISIBLE warning (not bare null) so
 * the operator is told to install the provider; the daemon-stderr line is kept too.
 */
function loudRunnerUnavailable(
	relPath: string,
	language: CoverageLanguage,
	why: string,
): HarnessDecision {
	const provider = language === "python" ? "pytest-cov" : "@vitest/coverage-v8";
	return allowWithCoverageWarning(
		`[interlinked:coverage] WARNING: coverage/red-green/CRAP gate is ON for ${language} ` +
			`but could not run for ${relPath} (${why}) — install the coverage provider ` +
			`(${provider} for js/ts, pytest-cov for python) to enforce; this edit was NOT ` +
			"coverage-checked.",
	);
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
	/**
	 * Affected-test subset (repo-relative paths) the overlay run is scoped to.
	 * Non-empty ⇒ the fast per-edit path (only these tests run, no budget defer).
	 * Empty/undefined ⇒ the full suite runs (the budget gate already decided it
	 * fits). Forwarded to the runner as {@link CoverageRunOpts.selectedTests}.
	 */
	selectedTests?: string[];
	/**
	 * When true (`per_edit_coverage.block_on_test_failure`), an overlay run that
	 * leaves the suite RED (`testsPassed === false`) blocks the edit before the
	 * coverage decision. Default-absent ⇒ falsy ⇒ coverage-only behavior.
	 */
	blockOnTestFailure?: boolean;
	/**
	 * When true (`per_edit_coverage.block_on_crap`), a function the edit ADDED or
	 * TOUCHED whose CRAP score reaches {@link crapThreshold} blocks the edit AFTER
	 * the coverage decision. Default-absent ⇒ falsy ⇒ coverage-only behavior.
	 */
	blockOnCrap?: boolean;
	/** CRAP score at/above which a touched function blocks. Absent ⇒ {@link DEFAULT_CRAP_THRESHOLD}. */
	crapThreshold?: number;
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
	// Gate is ON for this language but no runner could be built → fail LOUD
	// (missing provider?), never silent. Allow (can't-measure ≠ deny).
	if (!runner) {
		return loudRunnerUnavailable(ctx.relPath, ctx.language, `no coverage runner for ${ctx.language}`);
	}

	const overlay = deps.createOverlay(ctx.projectRoot, ctx.relPath, ctx.proposed);
	try {
		const runOpts: { projectRoot: string; coverageDir: string; selectedTests?: string[] } = {
			projectRoot: overlay.overlayRoot,
			coverageDir: `${overlay.overlayRoot}/.interlinked/coverage`,
		};
		if (ctx.selectedTests && ctx.selectedTests.length > 0) {
			runOpts.selectedTests = ctx.selectedTests;
		}
		const result = await runner.run(runOpts);
		updateRuntimeEstimateMs(ctx.projectRoot, result.suiteMs, deps.clock);
		// `ok:false` means the runner produced no parseable coverage — the most
		// common real cause is a missing provider. Fail LOUD, not silent.
		if (!result.ok) {
			return loudRunnerUnavailable(ctx.relPath, ctx.language, result.error ?? "coverage run failed");
		}

		// Red bar before coverage: a FAILING suite is a harder failure than a
		// coverage gap. Only when opted in (block_on_test_failure) AND the suite
		// definitively came back red (testsPassed === false). `null` (couldn't
		// determine) falls through to the coverage decision — fail-open on the
		// pass/fail axis, exactly like the coverage block's runner-unavailable path.
		if (ctx.blockOnTestFailure && result.testsPassed === false) {
			return blockForRedBar(ctx.relPath, result.failingTests);
		}

		const cov = result.perFile.get(ctx.relPath);
		if (!cov) {
			return loudDegrade(ctx.relPath, "edited file absent from coverage report");
		}
		// Coverage decision first (uncovered-added-line / drop). A block here is the
		// more basic failure; CRAP is the "complex AND under-covered" escalation.
		const coverageDecision = decideFromCoverage(ctx.projectRoot, ctx.relPath, cov, ctx.editedLines);
		if (coverageDecision) return coverageDecision;

		// Coverage allowed → the 4th per-edit gate. Only when opted in
		// (block_on_crap); uses the SAME overlay coverage just computed.
		if (ctx.blockOnCrap) {
			const crapInput: CrapInput = {
				relPath: ctx.relPath,
				proposed: ctx.proposed,
				cov,
				editedLines: ctx.editedLines,
				threshold: ctx.crapThreshold ?? DEFAULT_CRAP_THRESHOLD,
				analyzer: deps.cyclomaticFor(ctx.language),
			};
			return decideCrap(crapInput, loudDegrade);
		}
		return null;
	} finally {
		overlay.cleanup();
	}
}

/**
 * Outcome of affected-test selection, routing the rest of the gate:
 *   - `block`  — the file is in the graph but NO test depends on it (`[]`): a
 *                strict-TDD block, no suite run needed.
 *   - `scoped` — a non-empty affected-test subset: run ONLY those (fast → fits
 *                the per-edit budget → skip the budget defer).
 *   - `full`   — selection unavailable (no depView, or the file is not in the
 *                graph → `null`): fall back to the full suite + budget gate.
 */
type SelectionRoute =
	| { kind: "block"; decision: HarnessDecision }
	| { kind: "scoped"; tests: string[] }
	| { kind: "full" };

/**
 * Run affected-test selection (when a dependency view is available) and map its
 * tri-state result to a {@link SelectionRoute}. `null` from the selector (file
 * not in the graph) and a missing view both route to `full` — "don't know which
 * tests" must never run a wrong subset. `[]` routes to a strict-TDD `block`. A
 * non-empty subset routes to `scoped`. Kept separate so `checkCoverageWrite`
 * stays low-complexity.
 */
function routeBySelection(
	relPath: string,
	projectRoot: string,
	depView: DependencyView | undefined,
): SelectionRoute {
	if (!depView) return { kind: "full" };
	const selected = selectAffectedTests({ editedRelPath: relPath, projectRoot, depView });
	if (selected === null) return { kind: "full" };
	if (selected.length === 0) return { kind: "block", decision: blockForUntestedSource(relPath) };
	return { kind: "scoped", tests: selected };
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
 * edit (a) leaves the suite RED — only when `block_on_test_failure` is on, the
 * red-bar check, which precedes coverage — (b) adds an uncovered line / drops the
 * file's coverage, or (c) leaves a TOUCHED function with a CRAP score ≥ the
 * threshold — only when `block_on_crap` is on, the CRAP check, which FOLLOWS the
 * coverage decision; otherwise null (allow). All three are computed from ONE
 * overlay suite run. A pure no-op — runner never invoked — when disabled, in warn
 * mode, or for a non-code / unsupported-language / test / non-cappable file. Never
 * throws (fail-open).
 *
 * AFFECTED-TEST SELECTION (the keystone that makes this AFFORDABLE on a slow,
 * multi-language suite): when `depView` is supplied, the gate first walks the
 * reverse import graph to find only the tests transitively affected by the edit:
 *   - a NON-EMPTY subset → the overlay runs ONLY those tests (fast → fits the
 *     per-edit budget → enforced in-band, no defer);
 *   - `[]` (file in the graph, but nothing tests it) → BLOCK (strict TDD — the
 *     edit's executable lines are covered by nothing);
 *   - `null` (file not in the graph) or no `depView` → the FULL suite + budget
 *     gate (unchanged) — never run a wrong subset.
 */
export async function checkCoverageWrite(
	event: HarnessEvent,
	rules: GuardRulesConfig,
	deps: CoverageWriteDeps = DEFAULT_DEPS,
	depView?: DependencyView,
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
		return await selectRunAndDecide(
			{ event, cfg, deps, depView },
			{ projectRoot, relPath, language, input, proposed },
		);
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return loudDegrade(relPath, why);
	}
}

/** Fixed-per-call inputs threaded into {@link selectRunAndDecide} (the parts of
 *  the event/config the routing + run need). Bundled so the helper takes two
 *  params, not seven. */
interface GateCall {
	event: HarnessEvent;
	cfg: NonNullable<GuardRulesConfig["per_edit_coverage"]>;
	deps: CoverageWriteDeps;
	depView: DependencyView | undefined;
}

/** Resolved per-edit facts (path/language/content) shared across the helper. */
interface GateTarget {
	projectRoot: string;
	relPath: string;
	language: CoverageLanguage;
	input: NonNullable<HarnessEvent["tool_input"]>;
	proposed: string;
}

/**
 * Run affected-test selection, apply the budget gate (full-suite route only),
 * build the {@link GateContext}, and run the overlay decision. Extracted from
 * `checkCoverageWrite` so that entry stays under the cyclomatic cap; throwing is
 * contained by the caller's try/catch (loud-degrade).
 */
async function selectRunAndDecide(call: GateCall, target: GateTarget): Promise<HarnessDecision | null> {
	const { cfg, deps, depView, event } = call;
	const { projectRoot, relPath, language, input, proposed } = target;

	// Affected-test selection FIRST: it decides whether we enforce a fast scoped
	// run, must block (nothing tests this source), or fall back to the full suite
	// (and therefore consult the budget gate).
	const route = routeBySelection(relPath, projectRoot, depView);
	if (route.kind === "block") return route.decision;

	if (route.kind === "full") {
		const estimate = readRuntimeEstimateMs(projectRoot);
		if (estimate !== null && estimate >= cfg.budget_ms) {
			return deferForBudget(projectRoot, relPath, event, estimate, cfg.budget_ms);
		}
	}

	const ctx: GateContext = {
		projectRoot,
		relPath,
		proposed,
		language,
		editedLines: deriveEditedLineNumbers(event.tool_name, input, proposed),
		budgetMs: cfg.budget_ms,
		blockOnTestFailure: cfg.block_on_test_failure === true,
		blockOnCrap: cfg.block_on_crap === true,
		crapThreshold: cfg.crap_threshold ?? DEFAULT_CRAP_THRESHOLD,
		...(route.kind === "scoped" ? { selectedTests: route.tests } : {}),
	};
	return runOverlayAndDecide(ctx, event, deps);
}
