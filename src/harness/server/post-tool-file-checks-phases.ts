// ===========================================
// PostToolUse — per-file check phases
// ===========================================
// Cohesive check phases extracted verbatim from `runPerFileChecks` in
// `post-tool-file-checks.ts`. Each helper operates on the shared
// `ServerRuntime` (ctx) and `PerFileCheckCtx` (acc) accumulators and mutates
// `decision`/`session` in place — identical logic to the inline phase blocks.
//
// The orchestrator (`runPerFileChecks`) calls these in the SAME order; the
// only change is bare local references becoming helper parameters. The
// structural-checks phase and the recurrence-consolidation tail stay in the
// main file (the latter is pinned by source-level regression tests).

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { checkAssertionDensity, runBehavioralChecks } from "../behavioral-checks.js";
import { GENERIC_CHECK_META, QUALITY_CHECK_META } from "../check-metadata.js";
import {
	countSuppressionDirectives,
	findProjectRoot,
	formatQualityWarnings,
	type QualityCheckOptions,
	runProjectWideChecksAsync,
	runQualityChecks,
} from "../quality-checks.js";
import type { QualityCheckResult } from "../quality-checks/result-types.js";
import { acknowledgeChecks, isAcknowledged } from "../session-state.js";
import { DEFAULT_TRIGGERS, expandSiblings } from "../sibling-expansion.js";
import { runStructureChecks } from "../structure/structure-checks.js";
import { formatStructureWarnings } from "../structure/structure-formatter.js";
import { loadStructureConfig } from "../structure/structure-loader.js";
import {
	type Finding,
	formatScoredFindings,
	scoreFindings,
	writeTelemetry,
} from "../suggestion-scorer.js";
import { loadFileSuppressions, scanInlineSuppressions } from "../suppressions.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";
import { collectDeletionHygieneDiffFindings } from "./deletion-hygiene-diff.js";
import { deriveEditedLineNumbers } from "./edit-line-derivation.js";
import type { PerFileCheckCtx } from "./post-tool-file-checks.js";
import type { ServerRuntime } from "./runtime-context.js";
import { collectSuggestionFindings } from "./suggestion-checks.js";

/** Structure-check cold-build time budget (ms). When existing checks have
 *  already burned this much of the shared 15s PostToolUse window, the cold
 *  graph build is skipped (a cached graph still runs). */
const STRUCT_TIME_BUDGET_MS = 12000;
/** Session edit count at which the shotgun-surgery taste check first fires. */
const SHOTGUN_THRESHOLD = 40;
/** Higher session edit count that fires the shotgun check a second time. */
const SHOTGUN_THRESHOLD_HIGH = 60;

/**
 * Smart-tsc filtering: when only internal logic changed (no export-surface
 * change) and tsc is enabled, still run tsc but filter output to the edited
 * file only. Returns `{ tscFilterFile }` when the gate applies, else undefined
 * (callers spread the result, so an absent key leaves opts untouched under
 * exactOptionalPropertyTypes).
 */
function buildSmartTscOpts(
	ctx: ServerRuntime,
	structuralConfig: GuardRulesConfig["structural_checks"],
	editedFilePath: string,
	exportSurfaceChanged: boolean,
): QualityCheckOptions | undefined {
	if (
		!structuralConfig?.smart_tsc ||
		exportSurfaceChanged ||
		!editedFilePath ||
		!ctx.rules.quality_checks?.typescript?.enabled
	) {
		return undefined;
	}
	const filterFile = relative(
		findProjectRoot(editedFilePath, ctx.cwd) || ctx.cwd,
		editedFilePath,
	);
	ctx.log(`Smart tsc: filtering to ${filterFile} (internal-only edit)`);
	return { tscFilterFile: filterFile };
}

/**
 * Record the names of enabled quality checks whose `file_types` match the
 * edited file's extension into `checksRan` (which checks actually applied).
 */
function recordChecksRan(
	qualityChecks: NonNullable<GuardRulesConfig["quality_checks"]>,
	editedFilePath: string,
	checksRan: string[],
): void {
	for (const [name, check] of Object.entries(qualityChecks)) {
		if (
			check.enabled &&
			check.file_types.some((t: string) => editedFilePath.endsWith(t))
		) {
			checksRan.push(name);
		}
	}
}

/**
 * Sibling expansion (PostToolUse fan-out): when a finding hits a known
 * type-erasure / boundary trigger, query the trigram index for every other
 * instance and append one quality row per sibling. Mutates `qualityResults`
 * in place. Advisory — never throws (failures are logged only).
 */
function expandQualitySiblings(
	ctx: ServerRuntime,
	editedFilePath: string,
	qualityResults: QualityCheckResult[],
): void {
	const triggerNames = new Set(DEFAULT_TRIGGERS.map((t) => t.triggerName));
	const triggers = qualityResults
		.filter((r) => triggerNames.has(r.name))
		.map((r) => ({ name: r.name, file: r.file ?? editedFilePath }));
	if (!ctx.trigramIndex || triggers.length === 0) return;
	const CWD = ctx.cwd;
	try {
		const siblings = expandSiblings({
			triggers,
			index: ctx.trigramIndex,
			reader: {
				read: (relPath: string): string | undefined => {
					try {
						return readFileSync(`${CWD}/${relPath}`, "utf-8");
					} catch (e) {
						void e;
						return undefined;
					}
				},
			},
			cwd: CWD,
		});
		for (const s of siblings) {
			qualityResults.push({
				name: s.siblingRuleId,
				severity: "warning",
				message: s.message,
				file: s.file,
			});
		}
		if (siblings.length > 0) {
			ctx.log(
				`Sibling expansion: ${siblings.length} row(s) across ${triggers.length} trigger(s)`,
			);
		}
	} catch (e) {
		// Sibling fan-out is advisory — never fail the post-edit pipeline on it.
		ctx.log(`Sibling expansion failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** Append each quality finding into `allCheckResults` with its resolved
 *  determinism (quality meta → generic meta → fully_deterministic default). */
function collectQualityResultEntries(
	qualityResults: QualityCheckResult[],
	allCheckResults: PerFileCheckCtx["allCheckResults"],
): void {
	for (const r of qualityResults) {
		allCheckResults.push({
			source: "quality",
			name: r.name,
			severity: r.severity,
			message: r.message,
			file: r.file,
			detail: r.detail,
			determinism:
				QUALITY_CHECK_META[r.name]?.determinism ??
				GENERIC_CHECK_META[r.name]?.determinism ??
				"fully_deterministic",
		});
	}
}

/**
 * Surface quality findings: append formatted warnings to `decision.warnings`
 * and flip `decision.decision` to "block" for fully-deterministic errors or
 * the software_version_regression post-tool attention channel.
 */
function applyQualityDecision(
	ctx: ServerRuntime,
	qualityResults: QualityCheckResult[],
	decision: HarnessDecision,
): void {
	if (qualityResults.length === 0) return;
	const warnings = formatQualityWarnings(qualityResults);
	decision.warnings = [...(decision.warnings || []), ...warnings];

	// Block only on fully_deterministic quality checks with error severity.
	// Heuristic checks (strong_typing, prompt_injection, freshness-sensitive
	// references) are advisory only, except software_version_regression:
	// PostToolUse returns `decision: "block"` for compatibility even though
	// the mutation already landed. Treat it as an attention-required channel.
	const hasDeterministicErrors = qualityResults.some(
		(r) =>
			r.severity === "error" &&
			QUALITY_CHECK_META[r.name]?.determinism === "fully_deterministic",
	);
	const hasPostToolAttention = qualityResults.some(
		(r) => r.name === "software_version_regression",
	);
	if (hasDeterministicErrors || hasPostToolAttention) {
		decision.decision = "block";
	}

	const outcome = hasDeterministicErrors
		? "blocking"
		: hasPostToolAttention
			? "post-tool attention required"
			: "advisory";
	ctx.log(
		`Quality issues found: ${qualityResults.map((r) => r.name).join(", ")} (${outcome})`,
	);
}

/**
 * Quality-checks phase: tsc/lint/secrets (subprocess-based) + sibling
 * expansion + quality-result collection/blocking. Returns the baseline
 * suppression count captured before the checks consumed it — the behavioral
 * phase needs it for the suppression-delta escalation.
 *
 * Thin orchestrator: the cohesive branch groups (smart-tsc opts, checks-ran
 * tracking, sibling fan-out, result collection, blocking decision) live in the
 * sibling helpers above so each unit stays well under the cyclomatic cap.
 */
export async function runQualityPhase(
	ctx: ServerRuntime,
	checkEvent: HarnessEvent,
	editedFilePath: string,
	editedFileInRepo: boolean,
	exportSurfaceChanged: boolean,
	structuralConfig: GuardRulesConfig["structural_checks"],
	session: SessionTrajectory,
	decision: HarnessDecision,
	acc: PerFileCheckCtx,
): Promise<number> {
	const CWD = ctx.cwd;
	const rules = ctx.rules;
	const { allCheckResults, checksRan, postToolMetrics, markPhase } = acc;

	// --- Quality checks (tsc, lint, secrets — slower, subprocess-based) ---
	// Capture baseline suppression count before quality checks consume it
	let previousSuppressionCount = 0;
	if (!rules.quality_checks) return previousSuppressionCount;

	// Smart tsc: when only internal logic changed (no export surface change),
	// still run tsc but filter output to only the edited file. This catches
	// internal type errors (e.g. TS18046 'unknown' access) without reporting
	// unrelated project-wide errors.
	const qualityOpts = buildSmartTscOpts(
		ctx,
		structuralConfig,
		editedFilePath,
		exportSurfaceChanged,
	);

	const baselineFilePath = isAbsolute(editedFilePath)
		? editedFilePath
		: resolve(CWD, editedFilePath);
	const currentBaseline = ctx.preEditBaselines.get(baselineFilePath);
	previousSuppressionCount = currentBaseline?.suppressionCount ?? 0;
	// Phase mark — everything from the last mark up to here was
	// the structural-checks block (export-surface diff, project
	// graph update, impact analysis, deletion-hygiene).
	markPhase("structural_checks");
	const rawQualityResults = await runQualityChecks(checkEvent, rules.quality_checks, CWD, {
		...qualityOpts,
		...(currentBaseline !== undefined ? { baseline: currentBaseline } : {}),
		...(rules.diff_aware !== undefined ? { diffAware: rules.diff_aware } : {}),
		outToolMetrics: postToolMetrics,
		// Mythos Phase 4: recency-weighted check depth.
		// Cold files skip heuristic detectors at PostToolUse.
		filePriority: ctx.filePriorityMap,
		// Diagnostic: per-check phase boundary. Each iteration
		// of the inline-check loop fires this with its name,
		// so phase_breakdown carries one entry per check
		// (inline_software_version_regression, inline_strong_typing,
		// …). Lets us pin a residual spike to a single check.
		onCheckBoundary: markPhase,
		// Out-of-tree edits skip subprocess/tree-walking
		// `command`-based checks (tsc/biome/semgrep/gitleaks):
		// those are project-rooted and would run THIS repo's
		// tooling for a foreign file. Inline content checks
		// still run. See `editedFileInRepo` above.
		editedFileInRepo,
	});
	// Phase mark — runQualityChecks ran tsc/biome/inline checks.
	// The subprocess time is captured in tool_breakdown; this
	// phase covers their wall time + the inline-check residual.
	markPhase("quality_checks");
	// Clear consumed baseline
	ctx.preEditBaselines.delete(baselineFilePath);
	// Track which quality checks actually applied to this file type
	recordChecksRan(rules.quality_checks, editedFilePath, checksRan);

	// --- Session-ack suppression for quality checks ---
	// Skip re-firing warnings the user already acknowledged for this file+check.
	// Errors always re-fire regardless of acknowledgment.
	const qualityResults = rawQualityResults.filter(
		(r) => r.severity === "error" || !isAcknowledged(session, editedFilePath, r.name),
	);

	// --- Sibling expansion (PostToolUse fan-out) ---
	// When a finding hits a known type-erasure / boundary pattern, query
	// the trigram index for every other instance and emit one row per
	// sibling. Codex finding-discovery convention "do not collapse
	// separate instances under one candidate" — turns a single edit's
	// `as_any_ratchet` into a worklist covering the whole module.
	expandQualitySiblings(ctx, editedFilePath, qualityResults);

	// Collect quality check results for local persistence
	collectQualityResultEntries(qualityResults, allCheckResults);

	applyQualityDecision(ctx, qualityResults, decision);

	return previousSuppressionCount;
}

/**
 * Project-wide sweep phase (cross-file tsc/biome). Fires at most once per
 * event; debounced by edit cadence or export-surface change. Ends with the
 * `project_wide_sweep` phase mark.
 */
export async function runProjectWideSweepPhase(
	ctx: ServerRuntime,
	editedFilePath: string,
	editedFileInRepo: boolean,
	exportSurfaceChanged: boolean,
	decision: HarnessDecision,
	acc: PerFileCheckCtx,
): Promise<void> {
	const CWD = ctx.cwd;
	const log = ctx.log;
	const rules = ctx.rules;
	const { markPhase } = acc;

	// ── Project-wide sweep (cross-file tsc/biome) ──
	// Catches cross-file type errors and lint issues that per-file checks miss.
	// Triggers: every N edits or immediately when export surface changed.
	// Skipped for out-of-tree edits: the sweep runs project-rooted tsc/
	// biome over CWD, so it must not fire for a file outside CWD (it
	// would also wrongly advance the repo's sweep cadence counter).
	const pwConfig = rules.project_wide_checks;
	if (pwConfig?.enabled && editedFilePath && editedFileInRepo) {
		ctx.projectWideSweepState.recordFileChecked(editedFilePath);
		if (!acc.projectWideSweepFired) {
			const intervalReached = ctx.projectWideSweepState.recordEdit(pwConfig);
			const shouldSweep =
				intervalReached || (pwConfig.on_export_change && exportSurfaceChanged);

			if (shouldSweep) {
				acc.projectWideSweepFired = true;
				// Async sweep yields the event loop while tsc/biome subprocesses
				// run, so other PostToolUse connections can be serviced during
				// the up-to-30s sweep window instead of queueing behind it.
				const sweepResult = await runProjectWideChecksAsync(
					pwConfig,
					ctx.projectWideSweepState,
					CWD,
				);

				if (sweepResult.findings.length > 0) {
					const sweepWarnings = formatQualityWarnings(sweepResult.findings);
					decision.warnings = [
						...(decision.warnings || []),
						...sweepWarnings,
					];
					log(
						`Project-wide sweep: ${sweepResult.findings.length} cross-file issue(s) from ${sweepResult.toolsRun.join(", ")} (${sweepResult.elapsedMs}ms)`,
					);
				} else {
					log(
						`Project-wide sweep: clean (${sweepResult.toolsRun.join(", ")}, ${sweepResult.elapsedMs}ms)`,
					);
				}
			}
		}
	}
	// Phase mark — project-wide sweep is debounced (every 5 edits), so
	// for most events this will be ~0ms; only firings show real cost.
	markPhase("project_wide_sweep");
}

/**
 * Scored-suggestions phase: regex heuristics + deletion-hygiene diff
 * detectors, scored/limited, with telemetry. Non-deterministic, top 1-3.
 */
export function runScoredSuggestionsPhase(
	ctx: ServerRuntime,
	checkEvent: HarnessEvent,
	editedFilePath: string,
	session: SessionTrajectory,
	decision: HarnessDecision,
	acc: PerFileCheckCtx,
): void {
	const CWD = ctx.cwd;
	const log = ctx.log;
	const rules = ctx.rules;
	const { allCheckResults } = acc;

	// ── Scored suggestions (non-deterministic heuristics, top 1-3) ──
	if (editedFilePath && existsSync(editedFilePath)) {
		try {
			const suggContent = readFileSync(editedFilePath, "utf-8");
			const inlineSup = scanInlineSuppressions(suggContent);
			const relPath = relative(CWD, editedFilePath);
			const fileSup = loadFileSuppressions(join(CWD, ".interlinked"), relPath);

			// Collect findings from regex heuristics (30+ checks).
			// Registry lives in ./server/suggestion-checks.ts for auditing.
			const allFindings: Finding[] = collectSuggestionFindings(
				suggContent,
				editedFilePath,
			);

			// --- Deletion hygiene (Layer 2): diff-aware zombie detectors ---
			// These compare old_string vs new_string to catch the agent hedging.
			allFindings.push(
				...collectDeletionHygieneDiffFindings({
					oldString: checkEvent.tool_input?.old_string as string | undefined,
					newString: checkEvent.tool_input?.new_string as string | undefined,
					filePath: editedFilePath,
				}),
			);

			if (allFindings.length > 0) {
				// Compute edit region for proximity scoring
				let editStartLine: number | undefined;
				let editEndLine: number | undefined;
				const oldStr = checkEvent.tool_input?.old_string as string | undefined;
				if (oldStr && suggContent) {
					const idx = suggContent.indexOf(oldStr);
					if (idx >= 0) {
						editStartLine = suggContent.slice(0, idx).split("\n").length;
						editEndLine = editStartLine + oldStr.split("\n").length;
					}
				}

				const rawScored = scoreFindings(allFindings, {
					filePath: editedFilePath,
					session,
					...(editStartLine !== undefined ? { editStartLine } : {}),
					...(editEndLine !== undefined ? { editEndLine } : {}),
					inlineSuppressions: inlineSup,
					fileSuppressions: fileSup,
					limit: rules.suggestion_limit ?? 3,
					threshold: rules.suggestion_threshold ?? 0.5,
				});

				// Session-ack suppression for suggestions (always warning severity)
				const scored = rawScored.filter(
					(s) => !isAcknowledged(session, editedFilePath, s.check),
				);

				if (scored.length > 0) {
					for (const s of scored) {
						allCheckResults.push({
							source: "suggestion",
							name: s.check,
							severity: "warning",
							message: s.message,
							file: editedFilePath || undefined,
							score: s.score,
							line: s.line,
							determinism: "heuristic",
						});
					}
					const suggWarnings = formatScoredFindings(scored);
					decision.warnings = [
						...(decision.warnings || []),
						...suggWarnings,
					];
					log(
						`Suggestions: ${scored.map((s) => `${s.check}(${s.score.toFixed(2)})`).join(", ")}`,
					);
				}

				// Telemetry (non-blocking)
				writeTelemetry(allFindings, scored, {
					interlinkedDir: join(CWD, ".interlinked"),
					sessionId: checkEvent.session_id,
					agentName: session?.agent_name || "unknown",
					filePath: relPath,
					threshold: rules.suggestion_threshold ?? 0.5,
				});
			}
		} catch (e) {
			void e;
		}
	}
}

/**
 * Session-level taste check: shotgun surgery. Fires once per session at the
 * 40-file and again at the 60-file threshold.
 */
export function runShotgunSurgeryPhase(
	session: SessionTrajectory,
	decision: HarnessDecision,
	acc: PerFileCheckCtx,
): void {
	const { allCheckResults, checksRan } = acc;

	// --- Session-level taste check: shotgun surgery ---
	// Threshold starts at 40 (not 25): adding a field to a shared interface
	// naturally touches types + implementation + every test mock, easily 10-15 files.
	if (session && session.files_written.size >= SHOTGUN_THRESHOLD) {
		const shotgunKey = `shotgun-surgery-${session.files_written.size >= SHOTGUN_THRESHOLD_HIGH ? "60" : "40"}`;
		if (!isAcknowledged(session, "__session__", shotgunKey)) {
			allCheckResults.push({
				source: "suggestion",
				name: "shotgun-surgery",
				severity: "warning",
				message: `This session has edited ${session.files_written.size} files. Consider whether abstraction boundaries could reduce the blast radius, or if this change should be broken into smaller steps.`,
				determinism: "heuristic",
			});
			if (!decision.warnings) decision.warnings = [];
			decision.warnings.push(
				`[taste:shotgun-surgery] ${session.files_written.size} files edited in this session — consider if the change scope is too broad`,
			);
			checksRan.push("shotgun-surgery");
			// Mark as acknowledged so we don't re-fire on every subsequent edit
			// at the same threshold. The 60-file threshold uses a different key,
			// so it will still fire once when crossed.
			acknowledgeChecks(session, "__session__", [shotgunKey]);
		}
	}
}

/**
 * Structure checks phase (non-blocking guidance) + the `scored_suggestions`
 * phase mark that closes out the scored-suggestions/structure window. Mutates
 * `ctx.structureGraph` / `ctx.structureConfigCache` caches in place.
 */
export function runStructureChecksPhase(
	ctx: ServerRuntime,
	editedFilePath: string,
	editedFileInRepo: boolean,
	session: SessionTrajectory,
	decision: HarnessDecision,
	acc: PerFileCheckCtx,
): void {
	const CWD = ctx.cwd;
	const log = ctx.log;
	const { allCheckResults, checksRan, markPhase } = acc;

	// --- Structure checks phase (non-blocking guidance) ---
	// Skip cold graph build if existing checks already consumed most of the time budget.
	// The 15s PostToolUse timeout is shared with tsc/biome/etc. On large repos, a cold
	// graph build (~5-10s for 20K+ nodes) can push past the limit. The cached graph
	// (from a previous call) makes subsequent edits fast (<100ms).
	// Skipped for out-of-tree edits: runStructureChecks builds/refreshes
	// the artifact graph rooted at the file's project. For a file
	// outside CWD that root falls back to CWD, so this would build
	// THIS repo's graph for a foreign file — wrong, and the tree walk
	// is the 11-19s cost the out-of-tree guard exists to remove.
	const structElapsed = Date.now() - acc.postStartMs;
	const hasCachedGraph = ctx.structureGraph !== null;
	if (
		editedFilePath &&
		editedFileInRepo &&
		(hasCachedGraph || structElapsed < STRUCT_TIME_BUDGET_MS)
	) {
		try {
			const structRepoRoot = findProjectRoot(editedFilePath, CWD) || CWD;
			const structResult = runStructureChecks(
				editedFilePath,
				structRepoRoot,
				ctx.structureGraph,
				ctx.structureConfigCache,
				session?.files_written,
			);
			ctx.structureGraph = structResult.graph;
			if (!ctx.structureConfigCache) {
				ctx.structureConfigCache = loadStructureConfig(structRepoRoot).config;
			}
			for (const r of structResult.results) {
				allCheckResults.push(r);
			}
			if (structResult.findings.length > 0) {
				checksRan.push("structure");
				if (!decision.warnings) decision.warnings = [];
				decision.warnings.push(
					...formatStructureWarnings(structResult.findings),
				);
			}
			// Record structure pending completions into session state
			if (session) {
				for (const pc of structResult.pendingCompletions) {
					session.pending_completions.set(`struct:${pc.source_artifact_ref}`, {
						source_file: pc.source_file,
						affected_files: pc.required_companion_files,
						resolved_files: new Set(pc.resolved_companion_files),
						recorded_at_tool_call: session.tool_call_count,
						description: `[structure] ${pc.finding_class}: ${pc.source_artifact_ref}`,
					});
				}
			}
		} catch (structErr) {
			log(
				`Structure check error: ${structErr instanceof Error ? structErr.message : String(structErr)}`,
			);
		}
	}
	// Phase mark — everything between project_wide_sweep and here was
	// the scored-suggestions pipeline (scanInlineSuppressions,
	// loadFileSuppressions, runStructureChecks). One of these is
	// re-loading state per event and is the load-bearing tax.
	markPhase("scored_suggestions");
}

/**
 * Session-level behavioral checks (persistent-warning escalation,
 * assertion-density). Reads the suppression-count baseline captured by the
 * quality phase.
 */
export function runBehavioralPhase(
	checkEvent: HarnessEvent,
	editedFilePath: string,
	previousSuppressionCount: number,
	session: SessionTrajectory,
	decision: HarnessDecision,
	acc: PerFileCheckCtx,
): void {
	const { allCheckResults } = acc;

	// --- Session-level behavioral checks ---
	if (session && editedFilePath) {
		// Capture fileContent once — both `countSuppressionDirectives`
		// and `checkAssertionDensity` need it. Reading twice would
		// double the I/O on every PostToolUse Edit.
		let fileContent: string | undefined;
		let currentSuppressionCount = 0;
		try {
			if (existsSync(editedFilePath)) {
				fileContent = readFileSync(editedFilePath, "utf-8");
				currentSuppressionCount = countSuppressionDirectives(fileContent);
			}
		} catch (e) {
			void e;
		}
		// Refinement 2026-05: derive the set of lines this edit actually
		// touched from tool_input + post-edit file content. Threaded into
		// `runBehavioralChecks` → `checkPersistentWarningEscalation` so
		// the escalation only fires for persistent findings within ±3
		// lines of an edit, suppressing the FP where stale findings in
		// untouched regions amplified on every unrelated re-edit.
		const editedLines = deriveEditedLineNumbers(
			checkEvent.tool_name,
			checkEvent.tool_input,
			fileContent,
		);
		const behavioralResults = runBehavioralChecks(
			session,
			editedFilePath,
			allCheckResults,
			previousSuppressionCount,
			currentSuppressionCount,
			editedLines,
		);

		// Plan 09 Phase 1: assertion-density runs outside
		// `runBehavioralChecks` because it's session-delta-based and
		// needs the post-edit content (which the orchestrator's
		// signature doesn't carry). The internal `TEST_FILE_RE` short-
		// circuit handles the test-file gate.
		if (fileContent !== undefined) {
			const r = checkAssertionDensity(session, editedFilePath, fileContent);
			if (r) behavioralResults.push(r);
		}

		// Filter-first: only push *shown* results into
		// `allCheckResults` so the recurrence and effectiveness loops
		// downstream don't see acknowledged-skipped findings.
		// Errors bypass the ack check by design — match the
		// suggestion-check pattern at server.ts:1970 and the quality-
		// check pattern at :1661 (`r.severity === "error" ||
		// !isAcknowledged(...)`). Acknowledging an error means "I saw
		// it"; it should still surface until actually fixed.
		if (behavioralResults.length > 0) {
			if (!decision.warnings) decision.warnings = [];
			for (const r of behavioralResults) {
				if (r.severity !== "warning" && r.severity !== "error") {
					// Info-level — record but don't surface, matching
					// the pre-existing `checkTddGreenConfirmation`
					// behavior.
					allCheckResults.push(r);
					continue;
				}
				const shouldShow =
					r.severity === "error" ||
					!isAcknowledged(session, editedFilePath, r.name);
				if (!shouldShow) continue;

				allCheckResults.push(r);
				const tag =
					r.determinism === "fully_deterministic" ? "[proven]" : "[heuristic]";
				decision.warnings.push(`${tag} ${r.name}: ${r.message}`);
			}
		}
	}
}
