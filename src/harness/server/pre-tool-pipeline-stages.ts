// ===========================================
// PreToolUse pipeline — extracted stages
// ===========================================
// Self-contained pipeline phases lifted verbatim out of `runPreToolPipeline`
// in `pre-tool-pipeline.ts` so the orchestrator stays under the per-file line
// cap. Each helper mutates the in-flight `preDecision` (and/or `ctx` state) in
// place — none short-circuits the pipeline with an early `return` — so the
// orchestrator calls them at the exact same points, in the same order, with
// identical side effects. Behavior-preserving move only; no logic changes.

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
	checkProdDeltaWithoutTestDelta,
	checkProdTestLocRatio,
	checkTddCommitGate,
	checkTppLeapfrog,
} from "../behavioral-checks.js";
import {
	checkAssertionCountRegression,
	checkAssertionStrengthWeakening,
	checkAssertionValueSwap,
	checkClockMockAdded,
	checkConventionalCommitCoherence,
	checkDisabledTestDelta,
	checkDoneWithoutVerify,
	checkReintroducesRemovedCode,
	checkTestBlockCountRegression,
	checkTestTimeoutInflation,
	parseCommitMessageFromBash,
} from "../behavioral-diff-checks.js";
import { snapshotCrap } from "../checks/crap-baseline.js";
import { snapshotDryShingles } from "../checks/dry-baseline.js";
import { collectSiblingFunctions } from "../checks/dry-check.js";
import { coverageForFile, loadCoverageFinal } from "../coverage-final-reader.js";
import { capturePrimitiveViolations as captureDiscoveredPrimitiveViolations } from "../discovered-primitives.js";
import { listWithOverflow } from "../finding-overflow.js";
import { checkFunctionComplexity, checkMissingReturnTypes } from "../generic-checks.js";
import { checkProjectTestsClean, checkProjectTypecheckClean } from "../project-typecheck-gate.js";
import {
	collectSoftwareVersionReferences,
	countAsAnyCasts,
	countConsoleStatements,
	countNonNullAssertions,
	countPublicApiSurface,
	countSuppressionDirectives,
	countTodoMarkers,
	countTypeDensity,
	countUnjustifiedCasts,
	findProjectRoot,
} from "../quality-checks.js";
import { extractAllEditedFilePaths } from "../server-tool-helpers.js";
import { loadStructureConfig } from "../structure/structure-loader.js";
import type { HarnessDecision, HarnessEvent, PreEditBaseline, SessionTrajectory } from "../types.js";
import { type ServerRuntime, summarizeToolInput } from "./runtime-context.js";

/**
 * TDD commit gate: check for unresolved test failures before git commit.
 * Mutates `preDecision` in place (warnings + possible block). Verbatim move.
 */
export function runTddCommitGate(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	preDecision: HarnessDecision,
): void {
	const { rules } = ctx;
	if (
		preDecision.decision === "allow" &&
		session &&
		event.tool_name === "Bash" &&
		/\bgit\s+commit\b/.test((event.tool_input?.command as string) || "")
	) {
		const testFirstMode = rules.structural_checks?.test_first_mode || "warn";
		const commitMessage = parseCommitMessageFromBash(
			(event.tool_input?.command as string) || "",
		);
		const gateResults = [
			...(session.tdd_cycles.size > 0 ? checkTddCommitGate(session, testFirstMode) : []),
			...checkProdDeltaWithoutTestDelta(session),
			...checkProdTestLocRatio(session),
			...checkTppLeapfrog(session),
			// Batch 3: diff-aware commit gates.
			...checkDisabledTestDelta(session),
			...checkTestBlockCountRegression(session, undefined, commitMessage?.type ?? null),
			...checkAssertionStrengthWeakening(session),
			// Test-oracle integrity (docs/design/test-oracle-integrity.md §4.3).
			...checkAssertionCountRegression(session),
			...checkAssertionValueSwap(session),
			...checkTestTimeoutInflation(session),
			...checkClockMockAdded(session),
			...checkConventionalCommitCoherence(session, commitMessage),
			// Batch 4: trajectory commit gates.
			...checkReintroducesRemovedCode(session),
			...checkDoneWithoutVerify(session),
		];
		if (gateResults.length > 0) {
			const warnings = preDecision.warnings || [];
			for (const r of gateResults) {
				warnings.push(`[interlinked:${r.name}] ${r.message}`);
			}
			preDecision.warnings = warnings;

			if (
				testFirstMode === "enforce" &&
				gateResults.some((r) => r.severity === "error")
			) {
				preDecision.decision = "block";
				preDecision.rule_id ??= "commit-test-first-gate";
				preDecision.reason =
					"BLOCKED: Tests must pass before committing. " +
					gateResults
						.filter((r) => r.severity === "error")
						.map((r) => r.message)
						.join(" ");
			}
		}
	}
}

/**
 * Emit a `guard_block` report to the server bridge for a project-wide git-gate
 * block, when a bridge is configured. Agent-name fallback chain matches the
 * inlined call sites verbatim (event → session → ""). No-op without a bridge.
 */
function reportGitGateGuardBlock(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	reason: string,
): void {
	if (!ctx.serverBridge) return;
	ctx.serverBridge.reportGuardEvent({
		agent_name: event.agent_name || session?.agent_name || "",
		event_type: "guard_block",
		tool_name: event.tool_name,
		tool_input_summary: summarizeToolInput(event),
		decision: "block",
		reason,
		occurred_at: event.timestamp,
	});
}

/**
 * Project-wide typecheck tier of {@link runProjectWideGitGate}. Diff-UNaware —
 * asserts the WHOLE project typechecks before allowing the git command. Appends
 * warnings and, on errors, flips `preDecision` to block + reports a guard event.
 * Verbatim extraction; mutates `preDecision` in place. `isCommit` selects the
 * commit-vs-push wording.
 */
function applyProjectTypecheckGate(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	preDecision: HarnessDecision,
	isCommit: boolean,
): void {
	const tcResults = checkProjectTypecheckClean(ctx.cwd);
	const tcWarnings = tcResults.filter((r) => r.severity === "warning");
	const tcErrors = tcResults.filter((r) => r.severity === "error");
	if (tcWarnings.length > 0) {
		const warnings = preDecision.warnings || [];
		for (const w of tcWarnings) {
			warnings.push(`[interlinked:${w.name}] ${w.message}`);
		}
		preDecision.warnings = warnings;
	}
	if (tcErrors.length > 0) {
		preDecision.decision = "block";
		// Stable id so repeat commit-gate blocks aggregate instead of landing in
		// the null-rule_id bucket (216/735 recent guard_block rows, 2026-07).
		preDecision.rule_id ??= "commit-typecheck-gate";
		const action = isCommit ? "commit" : "push";
		// Cap 10, above the default: a blocked commit needs enough of the error
		// list to act on without re-running the compiler.
		const errLines = listWithOverflow(tcErrors, (e) => `  - ${e.message}`, 10);
		preDecision.reason =
			`BLOCKED: Project typecheck failed (${tcErrors.length} error${tcErrors.length === 1 ? "" : "s"}) — CI will fail on this ${action}. ` +
			"Pre-existing errors in untouched files DO count: every commit must build clean. Fix these first:\n" +
			errLines +
			"\n\nTo bypass (NOT RECOMMENDED — CI will still fail on the PR): " +
			"INTERLINKED_SKIP_PROJECT_TYPECHECK=1 git ...";
		reportGitGateGuardBlock(
			ctx,
			event,
			session,
			`project_typecheck_clean: ${tcErrors.length} error${tcErrors.length === 1 ? "" : "s"}`,
		);
	}
}

/**
 * Push-only second tier of {@link runProjectWideGitGate}: the full project test
 * suite. Typecheck-clean is necessary but not sufficient (tsc-clean commits have
 * shipped stale test assertions that turned CI red); tests are slow so this runs
 * on PUSH only. Appends warnings and, on failures, blocks + reports a guard
 * event. Verbatim extraction; mutates `preDecision` in place.
 */
function applyProjectTestGate(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	preDecision: HarnessDecision,
): void {
	const testResults = checkProjectTestsClean(ctx.cwd);
	const testWarnings = testResults.filter((r) => r.severity === "warning");
	const testErrors = testResults.filter((r) => r.severity === "error");
	if (testWarnings.length > 0) {
		const warnings = preDecision.warnings || [];
		for (const w of testWarnings) {
			warnings.push(`[interlinked:${w.name}] ${w.message}`);
		}
		preDecision.warnings = warnings;
	}
	if (testErrors.length > 0) {
		preDecision.decision = "block";
		preDecision.rule_id ??= "push-test-gate";
		// Cap 10, above the default: a blocked push needs enough of the failure
		// list to act on without re-running the suite.
		const failLines = listWithOverflow(testErrors, (e) => `  - ${e.message}`, 10);
		preDecision.reason =
			`BLOCKED: Project tests failed (${testErrors.length} failure${testErrors.length === 1 ? "" : "s"}) — CI will fail on this push. ` +
			"Pre-existing test failures DO count: every push must build clean. Failing tests:\n" +
			failLines +
			"\n\nTo bypass (NOT RECOMMENDED — CI will still fail on the PR): " +
			"INTERLINKED_SKIP_PROJECT_TESTS=1 git push ...";
		reportGitGateGuardBlock(
			ctx,
			event,
			session,
			`project_tests_clean: ${testErrors.length} failure${testErrors.length === 1 ? "" : "s"}`,
		);
	}
}

/**
 * Project-wide typecheck gate (commit + push) plus the push-only test tier.
 * Diff-UNaware — asserts the whole project typechecks / tests clean before
 * allowing `git commit` / `git push`. Mutates `preDecision` in place and may
 * report a guard block to the server bridge. Thin orchestrator over
 * {@link applyProjectTypecheckGate} and {@link applyProjectTestGate}.
 */
export function runProjectWideGitGate(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	preDecision: HarnessDecision,
): void {
	// --- Project-wide typecheck gate (commit + push) ---
	// Diff-UNaware. Asserts the WHOLE project typechecks before
	// allowing `git commit` or `git push`. Catches the failure
	// mode where an agent edits file A, doesn't touch file B, and
	// CI fails because B was already broken. Per-edit checks are
	// diff-aware and won't surface that. This gate must.
	// Bypass via INTERLINKED_SKIP_PROJECT_TYPECHECK=1 (audited).
	if (preDecision.decision === "allow" && event.tool_name === "Bash") {
		const cmdStr = (event.tool_input?.command as string) || "";
		const isCommit = /\bgit\s+commit\b/.test(cmdStr);
		const isPush = /\bgit\s+push\b/.test(cmdStr);
		if (isCommit || isPush) {
			applyProjectTypecheckGate(ctx, event, session, preDecision, isCommit);

			// Push-only second tier: full test suite. Typecheck-clean
			// is necessary but not sufficient — the codex-flag commit
			// + 139-repo audit wave were both tsc-clean but had stale
			// test assertions that turned CI red. Tests are slow
			// (~40s on this repo), so we only run them on PUSH, not
			// on every commit. Bypass: INTERLINKED_SKIP_PROJECT_TESTS=1.
			if (preDecision.decision === "allow" && isPush) {
				applyProjectTestGate(ctx, event, session, preDecision);
			}
		}
	}
}

/**
 * Diff-aware pre-edit baseline capture for file write tools. Snapshots
 * pre-edit metrics into `ctx.preEditBaselines` so PostToolUse checks can
 * diff against them. Verbatim move; pure side effect on `ctx`.
 */
export function captureDiffAwareBaseline(
	ctx: ServerRuntime,
	event: HarnessEvent,
	filePath: string,
): void {
	const { rules } = ctx;
	const CWD = ctx.cwd;
	if (rules.diff_aware?.enabled === false) return;
	const toolName = event.tool_name || "";
	const isFileWrite = [
		"Write",
		"Edit",
		"Update",
		"WriteFile",
		"EditFile",
		"write_file",
		"edit_file",
		"apply_patch",
	].includes(toolName);
	if (!isFileWrite) return;

	// apply_patch carries no top-level file_path — resolve every target file
	// from the patch body so each gets a pre-edit baseline. Codex multi-file
	// edits were previously skipped entirely (no CRAP/complexity baseline).
	const targetPaths = filePath ? [filePath] : extractAllEditedFilePaths(event);
	for (const target of targetPaths) {
		const baselineFilePath = isAbsolute(target) ? target : resolve(CWD, target);
		if (existsSync(baselineFilePath)) {
			try {
				const preContent = readFileSync(baselineFilePath, "utf-8");
				const missingRT = checkMissingReturnTypes(preContent, baselineFilePath);
				const complexFns = checkFunctionComplexity(preContent, baselineFilePath);
				// CRAP baseline — fail-open when coverage data is absent.
				let crapScores: Map<string, Map<string, number>> | undefined;
				try {
					const coveragePath = resolve(CWD, "coverage", "coverage-final.json");
					const covCache = loadCoverageFinal(coveragePath, CWD);
					if (covCache) {
						const relPath = relative(CWD, baselineFilePath).replace(/\\/g, "/");
						const perFile = coverageForFile(covCache, relPath);
						const mtimeMs = statSync(baselineFilePath).mtimeMs;
						crapScores = snapshotCrap({
							preContent,
							filePath: relPath,
							coverage: perFile,
							fileMtime: mtimeMs,
							threshold: 30,
						});
					}
				} catch (crapErr) {
					void crapErr; /* CRAP snapshot must never break the baseline capture */
				}
				let dryCloneBaseline: PreEditBaseline["dryCloneBaseline"] | undefined;
				try {
					dryCloneBaseline = snapshotDryShingles({
						preContent,
						filePath: baselineFilePath,
						candidates: collectSiblingFunctions(baselineFilePath),
					});
				} catch (dryErr) {
					void dryErr; /* clone snapshot must never break the baseline capture */
				}
				ctx.preEditBaselines.set(baselineFilePath, {
					missingReturnTypes: new Set(missingRT.map((m) => m.text)),
					complexFunctions: new Set(complexFns.map((m) => m.text)),
					crapScores,
					dryCloneBaseline,
					capturedAt: Date.now(),
					suppressionCount: countSuppressionDirectives(preContent),
					asAnyCastCount: countAsAnyCasts(preContent),
					nonNullAssertionCount: countNonNullAssertions(preContent),
					unjustifiedCastCount: countUnjustifiedCasts(preContent),
					todoMarkerCount: countTodoMarkers(preContent),
					consoleStatementCount: countConsoleStatements(preContent),
					publicApiSurfaceCount: countPublicApiSurface(preContent),
					typeDensity: countTypeDensity(preContent),
					softwareVersions: collectSoftwareVersionReferences(
						preContent,
						baselineFilePath,
					),
					discoveredPrimitiveViolations: captureDiscoveredPrimitiveViolations(
						CWD,
						preContent,
					),
				});
			} catch (e) {
				void e;
			}
		}
	}
}

/**
 * Structure context injection (non-blocking). Surfaces unresolved companion
 * follow-ups from previous edits as a warning. Verbatim move.
 */
export function injectStructureContext(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	preDecision: HarnessDecision,
	filePath: string,
): void {
	const CWD = ctx.cwd;
	if (
		filePath &&
		[
			"Write",
			"Edit",
			"Update",
			"WriteFile",
			"EditFile",
			"write_file",
			"edit_file",
		].includes(event.tool_name || "")
	) {
		try {
			const structRepoRoot = findProjectRoot(filePath, CWD) || CWD;
			const { config } = loadStructureConfig(structRepoRoot);
			if (config && session) {
				// Check for unresolved structure follow-ups in session
				const unresolvedStructure: string[] = [];
				for (const [key, completion] of session.pending_completions) {
					if (!key.startsWith("struct:")) continue;
					const remaining = completion.affected_files.filter(
						(f) => !completion.resolved_files.has(f),
					);
					if (remaining.length > 0) {
						unresolvedStructure.push(
							`${completion.description}: ${remaining.join(", ")}`,
						);
					}
				}
				if (unresolvedStructure.length > 0) {
					const warnings = preDecision.warnings || [];
					warnings.push(
						`[interlinked:structure] Unresolved companion follow-ups from previous edits:\n${unresolvedStructure.map((u) => `  - ${u}`).join("\n")}`,
					);
					preDecision.warnings = warnings;
				}
			}
		} catch (e) {
			void e;
		}
	}
}
