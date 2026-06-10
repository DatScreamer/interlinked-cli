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
//   1. CONFIG-GATED (DEFAULT ON — see `rules/default-config.ts`). Runs only when
//      `rules.per_edit_coverage.enabled` AND `mode === "block"`. A repo that opts
//      OUT returns at the first gate before any suite run — zero cost. On a big
//      suite (THIS repo, ~16k tests) the budget gate (property 2) routes
//      enforcement to commit time, so the per-edit overlay rarely runs HERE — but
//      it is live by default on fast-suite repos.
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

import { computeCyclomaticAst } from "../checks/cyclomatic-ast.js";
import { computeCyclomaticPython } from "../checks/cyclomatic-python.js";
import {
	type CoverageObligation,
	readRuntimeEstimateMs,
	recordCoverageObligation,
	updateRuntimeEstimateMs,
	writeFileCoverageBaseline,
} from "../coverage-obligation-ledger.js";
import {
	type CreateCoverageOverlayFn,
	createCoverageOverlay,
	type OverlayFile,
} from "../coverage-overlay.js";
import {
	type CoverageLanguage,
	type CoverageRunner,
	coverageLanguageForPath,
	coverageRunnerFor,
} from "../coverage-runner.js";
import { selectAffectedTests } from "../coverage-test-selector.js";
import type { DependencyView } from "../dependency-view.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent } from "../types.js";
import {
	type CrapInput,
	type CyclomaticAnalyzer,
	DEFAULT_CRAP_THRESHOLD,
	decideCrap,
} from "./coverage-crap-decision.js";
import { type CoverageEditPlan, type CoverageTarget, coverageEditPlan } from "./coverage-edit-targets.js";
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

// The uncovered-added-line / coverage-drop / red-bar DECISION helpers live in
// ./coverage-write-decision.ts — extracted verbatim to keep this module under
// the per-file line cap when the delete-only path landed (finding 2026-06).
// The import sits at the extraction site (top-level imports hoist) so the move
// is one contiguous replacement; nothing about the decision flow changed.
import {
	blockForRedBar,
	decideFromCoverage,
	failingTestPhrase,
} from "./coverage-write-decision.js";

// EVIDENCE-AUTHORITY CONTRACT (finding 2): there is deliberately NO
// `blockForUntestedSource`. An empty affected-test selection (`[]`) means only
// that no test STATICALLY imports the file — not that it is uncovered. The static
// reverse-import graph may SELECT which tests to run, but its silence may never
// PROVE absence of coverage: an integration test routinely exercises a CLI entry
// point, an HTTP route, a plugin, or a dynamically-imported module without
// importing its source. So `[]` routes to a MEASURED full-suite run
// (`routeBySelection`), and a block can only come from the real coverage decision
// over the lines the suite actually executed — never from the graph alone.

// CRAP (Change Risk Anti-Patterns) — the 4th per-edit block — lives in
// `coverage-crap-decision.ts` (`decideCrap`), extracted to keep this module under
// the per-file line cap. It runs AFTER the uncovered-added-line / drop decision: a
// flat coverage gap is the more basic failure; CRAP is the "complex AND
// under-covered" escalation. Computed from the SAME overlay coverage run (no
// second suite spawn). The uncovered-line / drop / red-bar decision itself lives
// in `coverage-write-decision.ts` (same extraction, finding 2026-06).

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

// ===========================================
// Red-bar-only enforcement for NON-TARGET gated sections (findings 2026-06)
// ===========================================
// Coverage targets cover only files the gate can SCAN. A patch can also carry
// gated-language sections with no target: deletions / move sources (nothing to
// scan) and — in a DIFFERENT ecosystem than every target — test or non-cappable
// sections. Those sections still land in the overlay and can break THEIR
// language's suite while every target language stays green (finding 2026-06: a
// TS update + Python deletion ran only vitest, and the pytest breakage shipped
// undetected). The red bar is the one decidable axis for them, so:
//   - a delete-only plan (no targets at all) runs EVERY gated overlay language;
//   - a target-bearing plan additionally runs every gated overlay language whose
//     RUNNER no target already runs (the Vitest runner serves js+ts, so a ts
//     target's run covers a js section).
// Both paths are opt-in via `block_on_test_failure`, budget-gated (the deferred
// obligation lands on the language-aware commit gate), and fail-open.

/** The plan's overlay DELETIONS whose language the gate covers. */
function gatedDeletions(
	plan: CoverageEditPlan,
	cfg: NonNullable<GuardRulesConfig["per_edit_coverage"]>,
): OverlayFile[] {
	return plan.overlayFiles.filter((f) => {
		if (!f.delete) return false;
		const language = coverageLanguageForPath(f.relPath);
		return language !== null && cfg.languages.includes(language);
	});
}

/** Every gated-language overlay section grouped by language — targets, tests,
 *  deletions, move sources: the full set the patch materializes. */
function gatedSectionsByLanguage(
	plan: CoverageEditPlan,
	cfg: NonNullable<GuardRulesConfig["per_edit_coverage"]>,
): Map<CoverageLanguage, OverlayFile[]> {
	const byLanguage = new Map<CoverageLanguage, OverlayFile[]>();
	for (const f of plan.overlayFiles) {
		const language = coverageLanguageForPath(f.relPath);
		if (language === null || !cfg.languages.includes(language)) continue;
		const list = byLanguage.get(language) ?? [];
		list.push(f);
		byLanguage.set(language, list);
	}
	return byLanguage;
}

/** The red-bar block for a deletion that breaks the suite. */
function blockForDeletionRedBar(
	relPaths: string[],
	failingTests: string[] | undefined,
): HarnessDecision {
	const shown = relPaths.slice(0, 3).join(", ") + (relPaths.length > 3 ? ", …" : "");
	return {
		decision: "block",
		reason:
			`[interlinked:coverage] BLOCKED: deleting ${shown} leaves the test suite RED — ` +
			`${failingTestPhrase(failingTests)}. Other code still depends on what this patch ` +
			"removes; update or remove the dependents in the SAME patch (the overlay sees the " +
			"whole patch together), then retry.",
		rule_id: "per-edit-coverage",
		severity: "medium",
		category: "coverage",
	};
}

/** The red-bar block for a cross-ecosystem section (a language no target's
 *  runner serves) that breaks ITS suite. */
function blockForCrossSuiteRedBar(
	language: CoverageLanguage,
	relPaths: string[],
	failingTests: string[] | undefined,
): HarnessDecision {
	const shown = relPaths.slice(0, 3).join(", ") + (relPaths.length > 3 ? ", …" : "");
	return {
		decision: "block",
		reason:
			`[interlinked:coverage] BLOCKED: this patch's ${language} sections (${shown}) leave the ` +
			`${language} test suite RED — ${failingTestPhrase(failingTests)}. The patch's coverage ` +
			`targets are in a different ecosystem, so that suite would not otherwise run; fix the ` +
			`${language} breakage in the SAME patch, then retry.`,
		rule_id: "per-edit-coverage",
		severity: "medium",
		category: "coverage",
	};
}

/** Materialize ONE overlay carrying the whole patch and run each language's
 *  suite red-bar-only, once per distinct runner (the Vitest runner serves both
 *  js and ts — dedup by execution key like the commit gate). Returns the
 *  `block(...)` decision for the first red language, a loud degrade, or null
 *  (all green). */
async function runRedBarSuites(
	byLanguage: Map<CoverageLanguage, OverlayFile[]>,
	plan: CoverageEditPlan,
	projectRoot: string,
	deps: CoverageWriteDeps,
	block: (
		language: CoverageLanguage,
		relPaths: string[],
		failingTests: string[] | undefined,
	) => HarnessDecision,
): Promise<HarnessDecision | null> {
	const entries = [...byLanguage.entries()];
	const anchor = entries[0]?.[1]?.[0];
	if (!anchor) return null;
	// The anchor's own content rides the `proposed` slot (the overlay skips its
	// duplicate non-delete entry); a deleted anchor materializes as "" and its
	// delete marker then removes it (finding 2026-06).
	const overlay = deps.createOverlay(
		projectRoot,
		anchor.relPath,
		anchor.delete ? "" : anchor.content,
		plan.overlayFiles,
	);
	try {
		const ranKeys = new Set<string>();
		for (const [language, sections] of entries) {
			const runner = deps.runnerFor(language);
			if (!runner) {
				return loudRunnerUnavailable(anchor.relPath, language, `no coverage runner for ${language}`);
			}
			const key = runner.id ?? language;
			if (ranKeys.has(key)) continue;
			ranKeys.add(key);
			const result = await runner.run({
				projectRoot: overlay.overlayRoot,
				coverageDir: `${overlay.overlayRoot}/.interlinked/coverage`,
			});
			updateRuntimeEstimateMs(projectRoot, result.suiteMs, deps.clock);
			if (!result.ok) {
				return loudRunnerUnavailable(anchor.relPath, language, result.error ?? "coverage run failed");
			}
			if (result.testsPassed === false) {
				return block(
					language,
					sections.map((s) => s.relPath),
					result.failingTests,
				);
			}
		}
		return null;
	} finally {
		overlay.cleanup();
	}
}

/**
 * Enforcement for a plan with NO coverage targets: a DELETE-ONLY source patch.
 * The deletion has nothing to scan, but it can break the suite — every importer
 * of the removed module fails to resolve — and the old `targets.length === 0 →
 * null` skipped enforcement entirely (finding 2026-06). This path materializes
 * the whole-patch overlay (the suite sees the files ABSENT) and runs
 * RED-BAR-ONLY across EVERY gated overlay language — the deletions' own
 * languages plus any sibling section's (a deletion paired with a test file in
 * another ecosystem must run both suites, finding 2026-06):
 *   - only when `block_on_test_failure` is on — with it off the gate has no
 *     decision it could make for a deletion (no coverage target), so no suite
 *     is spent. A patch with NO gated deletion (pure test/non-code) stays
 *     ungated: a failing NEW test is legal TDD, not a regression;
 *   - budget-gated like every full-suite route (the deferred obligation lands
 *     on the commit gate, which runs delete-only suites too);
 *   - fail-open on any error (loud-degrade), like every other gate path.
 */
async function decideForDeletionOnly(
	event: HarnessEvent,
	cfg: NonNullable<GuardRulesConfig["per_edit_coverage"]>,
	deps: CoverageWriteDeps,
	plan: CoverageEditPlan,
	projectRoot: string,
): Promise<HarnessDecision | null> {
	const deletions = gatedDeletions(plan, cfg);
	const first = deletions[0];
	if (!first) return null; // nothing gated deleted (non-code / pure-test / not a patch)
	if (cfg.block_on_test_failure !== true) return null; // no decidable axis
	try {
		const estimate = readRuntimeEstimateMs(projectRoot);
		if (estimate !== null && estimate >= cfg.budget_ms) {
			return deferForBudget(projectRoot, first.relPath, event, estimate, cfg.budget_ms);
		}
		// A red language with a deletion blocks AS a deletion (the trigger); a red
		// sibling language with none blocks as the cross-ecosystem section it is.
		const block = (
			language: CoverageLanguage,
			relPaths: string[],
			failingTests: string[] | undefined,
		): HarnessDecision => {
			const dels = deletions
				.filter((d) => coverageLanguageForPath(d.relPath) === language)
				.map((d) => d.relPath);
			return dels.length > 0
				? blockForDeletionRedBar(dels, failingTests)
				: blockForCrossSuiteRedBar(language, relPaths, failingTests);
		};
		return await runRedBarSuites(gatedSectionsByLanguage(plan, cfg), plan, projectRoot, deps, block);
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return loudDegrade(first.relPath, why);
	}
}

/**
 * Enforcement for the gated overlay languages a TARGET-BEARING plan does NOT
 * already run: a patch updating TypeScript while deleting (or moving, or adding
 * a test in) Python ran only the targets' runner — vitest green shipped a
 * pytest breakage undetected (finding 2026-06). Languages whose runner some
 * target already runs are excluded by EXECUTION KEY (a ts target's Vitest run
 * covers js sections). Red-bar-only, opt-in via `block_on_test_failure`,
 * budget-gated, fail-open — the same contract as the delete-only path.
 */
async function decideForResidualLanguages(
	event: HarnessEvent,
	cfg: NonNullable<GuardRulesConfig["per_edit_coverage"]>,
	deps: CoverageWriteDeps,
	plan: CoverageEditPlan,
	projectRoot: string,
): Promise<HarnessDecision | null> {
	if (cfg.block_on_test_failure !== true) return null; // red bar is the only axis here
	const targetKeys = new Set<string>();
	for (const t of plan.targets) targetKeys.add(deps.runnerFor(t.language)?.id ?? t.language);
	const residual = new Map<CoverageLanguage, OverlayFile[]>();
	for (const [language, sections] of gatedSectionsByLanguage(plan, cfg)) {
		const key = deps.runnerFor(language)?.id ?? language;
		if (!targetKeys.has(key)) residual.set(language, sections);
	}
	const anchor = [...residual.values()][0]?.[0];
	if (!anchor) return null; // every gated section's runner already ran
	try {
		const estimate = readRuntimeEstimateMs(projectRoot);
		if (estimate !== null && estimate >= cfg.budget_ms) {
			return deferForBudget(projectRoot, anchor.relPath, event, estimate, cfg.budget_ms);
		}
		return await runRedBarSuites(residual, plan, projectRoot, deps, blockForCrossSuiteRedBar);
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return loudDegrade(anchor.relPath, why);
	}
}

interface GateContext {
	projectRoot: string;
	relPath: string;
	proposed: string;
	language: CoverageLanguage;
	editedLines: Set<number> | undefined;
	/** Sibling apply_patch sections (the patch's test + other touched files) written
	 *  into the SAME overlay alongside `proposed`, so a code+test patch's suite runs
	 *  against the whole atomic patch (finding 2026-06). Empty for a single-file edit. */
	overlayFiles?: OverlayFile[];
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
	/**
	 * STAGE a passing target's new coverage baseline instead of persisting it
	 * in-loop. The entry flushes staged baselines only after the ENTIRE event
	 * resolves to allow — a mid-loop persist let an early target's baseline land
	 * while a later target blocked the whole atomic patch, leaving the baseline
	 * describing content that never existed (finding 2026-06). Absent ⇒ the
	 * baseline for this run is simply not recorded.
	 */
	recordBaseline?: (relPath: string, fraction: number) => void;
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

	const overlay = deps.createOverlay(ctx.projectRoot, ctx.relPath, ctx.proposed, ctx.overlayFiles);
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
		const covOut: { now?: number } = {};
		const coverageDecision = decideFromCoverage(ctx.projectRoot, ctx.relPath, cov, ctx.editedLines, covOut);
		if (coverageDecision) return coverageDecision;

		// Coverage allowed → the 4th per-edit gate. Only when opted in (block_on_crap);
		// uses the SAME overlay coverage just computed. It runs BEFORE the baseline is
		// persisted, so a CRAP block never poisons it with rejected content (finding 8).
		if (ctx.blockOnCrap) {
			const crapInput: CrapInput = {
				relPath: ctx.relPath,
				proposed: ctx.proposed,
				cov,
				editedLines: ctx.editedLines,
				threshold: ctx.crapThreshold ?? DEFAULT_CRAP_THRESHOLD,
				analyzer: deps.cyclomaticFor(ctx.language),
			};
			const crapDecision = decideCrap(crapInput, loudDegrade);
			if (crapDecision) return crapDecision;
		}

		// EVERY per-target gate passed → STAGE the new baseline (never persist
		// in-loop: a later target or residual-language run can still block the whole
		// atomic patch — finding 2026-06; see GateContext.recordBaseline).
		if (covOut.now !== undefined) {
			ctx.recordBaseline?.(ctx.relPath, covOut.now);
		}
		return null;
	} finally {
		overlay.cleanup();
	}
}

/**
 * Outcome of affected-test selection, routing the rest of the gate:
 *   - `scoped` — a non-empty affected-test subset: run ONLY those (fast → fits
 *                the per-edit budget → skip the budget defer).
 *   - `full`   — selection unavailable (no depView / `null` / `[]`): run the full
 *                suite + budget gate. An empty selection is MEASURED, never
 *                blocked (evidence-authority contract — see routeBySelection).
 */
type SelectionRoute = { kind: "scoped"; tests: string[] } | { kind: "full" };

/**
 * Run affected-test selection (when a dependency view is available) and map its
 * result to a {@link SelectionRoute}. A non-empty subset routes to `scoped` (run
 * only those tests). Everything else routes to `full`:
 *   - no `depView` / `null` from the selector (file not in the graph) — "don't
 *     know which tests", so run them all rather than a wrong subset;
 *   - `[]` (file in the graph, but no test STATICALLY imports it) — the
 *     evidence-authority contract: the graph's silence is not proof of no
 *     coverage (an integration test exercises code it never imports), so MEASURE
 *     with the full suite; the coverage decision blocks only on what actually
 *     ran uncovered.
 * Kept separate so `checkCoverageWrite` stays low-complexity.
 */
function routeBySelection(
	relPath: string,
	projectRoot: string,
	depView: DependencyView | undefined,
): SelectionRoute {
	if (!depView) return { kind: "full" };
	const selected = selectAffectedTests({ editedRelPath: relPath, projectRoot, depView });
	if (selected === null || selected.length === 0) return { kind: "full" };
	return { kind: "scoped", tests: selected };
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
 *   - `[]` (file in the graph, but no test statically imports it), `null` (file
 *     not in the graph), or no `depView` → the FULL suite + budget gate. A static
 *     graph may select tests but may never prove absence of coverage (integration
 *     tests exercise code they don't import), so an empty selection is MEASURED,
 *     never blocked.
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
	// Plan = the production files to GATE (targets) + ALL files to MATERIALIZE in the
	// overlay (the patch's tests/siblings). For an apply_patch the whole ATOMIC patch
	// is overlaid, so a code+test patch is not falsely reported uncovered (finding
	// 2026-06); the full suite is forced only when `fullSuiteReason` says the
	// sections demand it. Non-code / test / non-cappable files are not targets.
	const plan = coverageEditPlan(event, projectRoot, cfg);
	// NO coverage targets ≠ nothing to enforce: a DELETE-ONLY source patch still
	// carries deletion overlays that can break the suite — handled by its own
	// red-bar path instead of a silent skip (finding 2026-06).
	if (plan.targets.length === 0) {
		return await decideForDeletionOnly(event, cfg, deps, plan, projectRoot);
	}

	// One decision per event: the FIRST blocking file wins (short-circuit). A
	// multi-file apply_patch otherwise accumulates any allow-time warnings (e.g. a
	// per-file loud-degrade) into a single allow decision so none is lost.
	// Full-suite forcing is REASONED, not blanket-per-patch (finding 2026-06): only
	// a patch whose sections make scoping unsound (new/changed tests, deletes,
	// moves) forces the full suite; a routine source-only patch keeps the scoped
	// route instead of deferring to the commit gate whenever the full-suite
	// estimate exceeds the budget.
	const warnings: string[] = [];
	// Baselines are STAGED during the loop and persisted only after the ENTIRE
	// event resolves to allow — a mid-loop persist let an early target's baseline
	// land while a later target blocked the whole atomic patch, leaving the
	// baseline describing content that never existed and corrupting future drop
	// decisions (finding 2026-06).
	const stagedBaselines: Array<{ relPath: string; fraction: number }> = [];
	const recordBaseline = (relPath: string, fraction: number): void => {
		stagedBaselines.push({ relPath, fraction });
	};
	for (const target of plan.targets) {
		const decision = await decideForTarget(
			{ event, cfg, deps, depView, recordBaseline },
			projectRoot,
			target,
			plan.overlayFiles,
			plan.fullSuiteReason !== null,
		);
		if (decision?.decision === "block") return decision;
		if (decision?.warnings) warnings.push(...decision.warnings);
	}
	// Gated sections in a language NO target's runner serves (a deletion, move, or
	// test file in another ecosystem) get their own red-bar run — vitest passing
	// must not ship an unrun pytest breakage (finding 2026-06).
	const residual = await decideForResidualLanguages(event, cfg, deps, plan, projectRoot);
	if (residual?.decision === "block") return residual;
	if (residual?.warnings) warnings.push(...residual.warnings);
	// EVERYTHING allowed → only now do the staged baselines become durable state.
	for (const b of stagedBaselines) {
		writeFileCoverageBaseline(projectRoot, b.relPath, b.fraction);
	}
	return warnings.length > 0 ? { decision: "allow", warnings } : null;
}

/** Evaluate ONE coverage target, containing its own failure as a loud-degrade so
 *  a single unmeasurable file in a multi-file patch never aborts the others. */
async function decideForTarget(
	call: GateCall,
	projectRoot: string,
	target: CoverageTarget,
	overlayFiles: OverlayFile[],
	forceFullSuite: boolean,
): Promise<HarnessDecision | null> {
	try {
		return await selectRunAndDecide(call, { projectRoot, ...target, overlayFiles, forceFullSuite });
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return loudDegrade(target.relPath, why);
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
	/** The entry's baseline STAGING sink (see GateContext.recordBaseline). */
	recordBaseline: (relPath: string, fraction: number) => void;
}

/** One resolved coverage target plus the project root — the per-call facts the
 *  routing + run need. `CoverageTarget` (path/language/content/editedLines) is
 *  produced by `coverageTargetsFor`. */
type GateTarget = CoverageTarget & {
	projectRoot: string;
	/** All files to materialize in the overlay (this write's full section set). */
	overlayFiles?: OverlayFile[];
	/** Run the FULL suite — set when the plan's `fullSuiteReason` is non-null (the
	 *  patch touches tests / deletes / moves, so a scoped subset would be unsound). */
	forceFullSuite?: boolean;
};

/**
 * Run affected-test selection, apply the budget gate (full-suite route only),
 * build the {@link GateContext}, and run the overlay decision. Extracted from
 * `checkCoverageWrite` so that entry stays under the cyclomatic cap; throwing is
 * contained by the caller's try/catch (loud-degrade).
 */
async function selectRunAndDecide(call: GateCall, target: GateTarget): Promise<HarnessDecision | null> {
	const { cfg, deps, depView, event } = call;
	const { projectRoot, relPath, language, proposed, editedLines } = target;

	// Affected-test selection FIRST: a non-empty subset runs scoped (fast); an
	// empty/unknown selection falls back to the full suite (and the budget gate).
	// There is no "block from selection" — a block must come from a measured run,
	// never the graph's silence (see routeBySelection's evidence-authority note).
	// An apply_patch forces the FULL suite only when its SECTIONS require it (test
	// sections live only in the overlay, never the on-disk graph a scoped subset is
	// drawn from; deletes/moves have dependents no per-target selection covers) —
	// see `patchFullSuiteReason`. A source-only patch routes scoped like any edit
	// (finding 2026-06: blanket forcing deferred every patch on big-suite repos).
	const route: SelectionRoute = target.forceFullSuite
		? { kind: "full" }
		: routeBySelection(relPath, projectRoot, depView);

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
		editedLines,
		budgetMs: cfg.budget_ms,
		blockOnTestFailure: cfg.block_on_test_failure === true,
		blockOnCrap: cfg.block_on_crap === true,
		crapThreshold: cfg.crap_threshold ?? DEFAULT_CRAP_THRESHOLD,
		recordBaseline: call.recordBaseline,
		...(target.overlayFiles ? { overlayFiles: target.overlayFiles } : {}),
		...(route.kind === "scoped" ? { selectedTests: route.tests } : {}),
	};
	return runOverlayAndDecide(ctx, event, deps);
}
