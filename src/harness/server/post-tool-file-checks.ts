// ===========================================
// PostToolUse — per-file check body
// ===========================================
// The body of the `for (const currentEditedPath of pathsToCheck)` loop,
// extracted verbatim from `post-tool-pipeline.ts`. Codex `apply_patch`
// payloads carry multiple file sections, so the orchestrator fans this
// function out once per edited file.
//
// All cross-iteration / cross-phase mutable state travels through one
// `PerFileCheckCtx` accumulator: the structural / quality / suggestion /
// structure / behavioral findings append into `accumulator.allCheckResults`,
// the human-facing strings into `decision.warnings`, and the once-per-event
// guards (`projectWideSweepFired`, `recurrenceCursor`) stay on the
// accumulator so they survive across files.
//
// Behavior-preserving move: identical logic to the inline loop body; the
// only change is bare module-level state becoming `ctx.*`.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { checkAssertionDensity, runBehavioralChecks } from "../behavioral-checks.js";
import { deriveEditedLineNumbers } from "./edit-line-derivation.js";
import { GENERIC_CHECK_META, QUALITY_CHECK_META, STRUCTURAL_CHECK_META } from "../check-metadata.js";
import { checkOrphanedTests } from "../deletion-hygiene.js";
import { resolveDependencyView } from "../dependency-view.js";
import { ErrorHistory } from "../error-history.js";
import { recordWarningResolutions, recordWarningsIssued } from "../feedback-effectiveness.js";
import {
	formatImpactWarning,
	recordImpactFollowUps,
	runImpactAnalysis,
} from "../impact-analysis.js";
import {
	countSuppressionDirectives,
	findProjectRoot,
	formatQualityWarnings,
	type QualityCheckOptions,
	runProjectWideChecksAsync,
	runQualityChecks,
	type ToolBreakdownEntry,
} from "../quality-checks.js";
import { recordHarnessCaught } from "../recurrence.js";
import { recordImplEdit, recordTestWrite, TEST_FILE_RE } from "../server-tdd-cycle.js";
import { acknowledgeChecks, isAcknowledged } from "../session-state.js";
import { DEFAULT_TRIGGERS, expandSiblings } from "../sibling-expansion.js";
import {
	formatStructuralWarnings,
	runStructuralChecks,
	shouldSkipTsc,
} from "../structural-checks.js";
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
import type {
	CheckResultEntry,
	ExportedSymbol,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import { collectDeletionHygieneDiffFindings } from "./deletion-hygiene-diff.js";
import { getGraphForFile, type ServerRuntime } from "./runtime-context.js";
import { collectSuggestionFindings } from "./suggestion-checks.js";

/** Cross-iteration / cross-phase accumulator for the PostToolUse per-file
 *  fan-out. The orchestrator creates one of these per event and passes it
 *  to {@link runPerFileChecks} for every edited file. */
export interface PerFileCheckCtx {
	/** Wall-clock when the PostToolUse handler started — feeds the structure
	 *  check time-budget gate. */
	readonly postStartMs: number;
	/** Every structured finding from every file (quality / structural /
	 *  suggestion / structure / behavioral). */
	readonly allCheckResults: CheckResultEntry[];
	/** Names of the check families that actually ran. */
	readonly checksRan: string[];
	/** Per-subprocess-tool latency breakdown. */
	readonly postToolMetrics: ToolBreakdownEntry[];
	/** Records the wall-clock delta since the previous mark under `name`. */
	readonly markPhase: (name: string) => void;
	/** Once-per-event guard: the project-wide sweep fires at most once
	 *  even when a patch touches many files. */
	projectWideSweepFired: boolean;
	/** Suffix of `allCheckResults` not yet mirrored into the recurrence log;
	 *  advances across files so prior files' findings are not re-recorded. */
	recurrenceCursor: number;
}

/** Structure-check cold-build time budget (ms). When existing checks have
 *  already burned this much of the shared 15s PostToolUse window, the cold
 *  graph build is skipped (a cached graph still runs). */
const STRUCT_TIME_BUDGET_MS = 12000;
/** Session edit count at which the shotgun-surgery taste check first fires. */
const SHOTGUN_THRESHOLD = 40;
/** Higher session edit count that fires the shotgun check a second time. */
const SHOTGUN_THRESHOLD_HIGH = 60;

/**
 * Run the structural / quality / project-wide-sweep / scored-suggestion /
 * structure / behavioral / feedback-effectiveness / recurrence pipeline for
 * ONE edited file. Mutates `decision` and `acc` in place.
 */
export async function runPerFileChecks(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	currentEditedPath: string,
	decision: HarnessDecision,
	acc: PerFileCheckCtx,
): Promise<void> {
	const CWD = ctx.cwd;
	const log = ctx.log;
	const rules = ctx.rules;
	const { allCheckResults, checksRan, postToolMetrics, markPhase } = acc;

	let editedFilePath = currentEditedPath;
	// For Bash edits, inject the detected file path into a synthetic event
	const checkEvent = editedFilePath
		? { ...event, tool_input: { ...event.tool_input, file_path: editedFilePath } }
		: event;

	// --- Structural checks (fast, sub-100ms, dependency-aware) ---
	let oldExports: ExportedSymbol[] = [];
	let oldInterfaceBodies = new Map<string, string>();
	let exportSurfaceChanged = false;
	const structuralConfig = rules.structural_checks;
	editedFilePath = (checkEvent.tool_input?.file_path as string) || "";

	// Is the edited file inside this harness's own project (CWD)?
	// Project-rooted analysis — the cross-file project-wide sweep and
	// the artifact-graph build in runStructureChecks — walks the tree
	// from the file's project root. For an out-of-tree edit (e.g. a
	// file under ~/.claude/...), `findProjectRoot` returns null and
	// `repoRoot` falls back to CWD, which would build/refresh THIS
	// repo's graph for a file that isn't in it: wrong result, and an
	// 11-19s tree walk. Gate those phases on in-repo membership; the
	// inline content checks below still run for out-of-tree files.
	const editedFileInRepo =
		editedFilePath.length > 0 &&
		(() => {
			const resolved = resolve(CWD, editedFilePath);
			return resolved === CWD || resolved.startsWith(CWD + sep);
		})();

	// --- TDD cycle tracking: record impl edits and test writes ---
	if (session && editedFilePath) {
		if (TEST_FILE_RE.test(editedFilePath)) {
			recordTestWrite(session, editedFilePath);
		} else {
			recordImplEdit(session, editedFilePath);
		}
	}

	// Resolve graph for the edited file's project (supports cross-repo edits)
	const fileGraph = getGraphForFile(ctx, editedFilePath || CWD);

	if (structuralConfig?.enabled && fileGraph.isInitialized && editedFilePath) {
		// Capture old state, then update graph with new file content
		oldExports = fileGraph.getExports(editedFilePath);
		oldInterfaceBodies = fileGraph.getInterfaceBodies(editedFilePath);
		fileGraph.updateFile(editedFilePath);

		const rawStructuralResults = runStructuralChecks(
			checkEvent,
			structuralConfig,
			fileGraph,
			ctx.sessions,
			oldExports,
			oldInterfaceBodies,
		);
		checksRan.push("structural");

		// --- File-level suppression for structural checks ---
		// Only JSON suppressions apply (inline comments don't make sense
		// for cross-file structural checks).
		const structRelPath = relative(CWD, editedFilePath);
		const structFileSup = loadFileSuppressions(
			join(CWD, ".interlinked"),
			structRelPath,
		);
		const afterSuppression = rawStructuralResults.filter(
			(r) => !structFileSup.has(r.check),
		);

		// --- Session-ack suppression for structural checks ---
		// If the user already saw a warning for this file+check and let
		// the agent continue, skip re-firing warnings (errors always re-fire).
		const structuralResults = afterSuppression.filter(
			(r) =>
				r.severity === "error" || !isAcknowledged(session, editedFilePath, r.check),
		);

		// Collect structured results for local persistence
		for (const r of structuralResults) {
			allCheckResults.push({
				source: "structural",
				name: r.check,
				severity: r.severity,
				message: r.message,
				file: r.file,
				detail: r.detail,
				affected_files: r.affectedFiles,
				determinism: STRUCTURAL_CHECK_META[r.check]?.determinism ?? "heuristic",
			});
		}

		if (structuralResults.length > 0) {
			const structWarnings = formatStructuralWarnings(structuralResults);
			decision.warnings = [...(decision.warnings || []), ...structWarnings];

			// Block only on fully_deterministic findings with error/warning severity.
			// Heuristic/partial findings (blast_radius, test_proximity, etc.) are advisory only.
			const hasDeterministicActionable = structuralResults.some(
				(r) =>
					(r.severity === "error" || r.severity === "warning") &&
					STRUCTURAL_CHECK_META[r.check]?.determinism === "fully_deterministic",
			);
			if (hasDeterministicActionable) {
				decision.decision = "block";
			}

			log(`Structural issues: ${structuralResults.map((r) => r.check).join(", ")}`);

			// Record failed files for recently-failed-here tracking
			const failedChecks = structuralResults
				.filter((r) => r.severity === "error" || r.severity === "warning")
				.map((r) => r.check);
			if (failedChecks.length > 0) {
				session.failed_files.set(editedFilePath, {
					failure_count: failedChecks.length,
					checks: [...new Set(failedChecks)],
					recorded_at: event.timestamp,
					tool_call_count: session.tool_call_count,
				});
			}

			// --- Impact analysis (fast, graph-only, no subprocesses) ---
			if (structuralConfig?.impact_analysis && editedFilePath) {
				const newExportsForImpact = fileGraph.getExports(editedFilePath);
				// Dependency facts come through the seam: a fresh Supermodel
				// `.graph` shard when present, the internal graph otherwise.
				const depView = resolveDependencyView(editedFilePath, CWD, fileGraph);
				const impactResult = runImpactAnalysis(
					editedFilePath,
					depView,
					fileGraph,
					oldExports,
					newExportsForImpact,
					structuralResults,
					{ highThreshold: structuralConfig.impact_high_threshold ?? 4 },
				);

				// Record follow-ups in session state (replaces inline pending_completions)
				recordImpactFollowUps(impactResult, session);

				// Format warnings
				const impactWarnings = formatImpactWarning(impactResult, fileGraph);
				if (impactWarnings.length > 0) {
					decision.warnings = [
						...(decision.warnings || []),
						...impactWarnings,
					];
				}

				// Critical impact blocks so the agent reads the warning
				if (impactResult.severity === "critical") {
					decision.decision = "block";
				}

				log(
					`Impact analysis: ${impactResult.severity} (${impactResult.dependentCount} dependents, ${impactResult.breakingFiles.length} breaking)`,
				);
			} else {
				// Fallback: record pending completions without full impact analysis
				const exportResults = structuralResults.filter(
					(r) =>
						r.check === "export_surface" &&
						r.affectedFiles &&
						r.affectedFiles.length > 0,
				);
				for (const result of exportResults) {
					session.pending_completions.set(editedFilePath, {
						source_file: editedFilePath,
						affected_files: result.affectedFiles!,
						resolved_files: new Set(),
						recorded_at_tool_call: session.tool_call_count,
						description: result.message,
					});
				}
			}
			// Record errors in cross-session error history
			if (rules.error_memory?.enabled) {
				const relPath = fileGraph.toRelative(editedFilePath);
				const fileRole = fileGraph.classifyModule(editedFilePath);
				const currentExports = fileGraph
					.getExports(editedFilePath)
					.map((e) => e.name);
				const dependentCount = fileGraph.getDependents(editedFilePath).length;
				const dependencyCount = fileGraph.getDependencies(editedFilePath).length;

				for (const result of structuralResults) {
					if (result.severity === "error" || result.severity === "warning") {
						const editOldString = checkEvent.tool_input?.old_string as
							| string
							| undefined;
						const editNewString = checkEvent.tool_input?.new_string as
							| string
							| undefined;
						const editContent = checkEvent.tool_input?.content as
							| string
							| undefined;
						const diffContext = ErrorHistory.buildErrorContext({
							file: relPath,
							fileRole,
							dependentCount,
							dependencyCount,
							exports: currentExports,
							result,
							...(editOldString !== undefined ? { oldString: editOldString } : {}),
							...(editNewString !== undefined ? { newString: editNewString } : {}),
							...(editContent !== undefined ? { content: editContent } : {}),
						});
						// Estimate line number from old_string position
						let lineStart: number | undefined;
						const oldStr = checkEvent.tool_input?.old_string as
							| string
							| undefined;
						if (oldStr) {
							try {
								const content = readFileSync(editedFilePath, "utf-8");
								const idx = content.indexOf(oldStr);
								if (idx >= 0)
									lineStart = content.slice(0, idx).split("\n").length;
							} catch (e) {
								void e;
							}
						}

						await ctx.errorHistory.recordError(
							event.session_id,
							session.agent_name,
							relPath,
							fileRole,
							result,
							diffContext,
							{
								...(lineStart !== undefined ? { line_start: lineStart } : {}),
								co_edited_files: [...session.files_written]
									.map((f) => fileGraph.toRelative(f))
									.filter((f) => f !== relPath),
								pre_error_sequence: [...session.tool_sequence],
							},
						);
					}
				}
			}
		} else {
			// No failures — clear any previous failed_files entry for this file
			session.failed_files.delete(editedFilePath);

			// Record fix in error history
			if (rules.error_memory?.enabled) {
				const relPath = fileGraph.toRelative(editedFilePath);
				const queryOldString = checkEvent.tool_input?.old_string as string | undefined;
				const queryNewString = checkEvent.tool_input?.new_string as string | undefined;
				const queryContent = checkEvent.tool_input?.content as string | undefined;
				const fixContext = ErrorHistory.buildQueryContext({
					file: relPath,
					fileRole: fileGraph.classifyModule(editedFilePath),
					dependentCount: fileGraph.getDependents(editedFilePath).length,
					dependencyCount: fileGraph.getDependencies(editedFilePath).length,
					exports: fileGraph.getExports(editedFilePath).map((e) => e.name),
					...(queryOldString !== undefined ? { oldString: queryOldString } : {}),
					...(queryNewString !== undefined ? { newString: queryNewString } : {}),
					...(queryContent !== undefined ? { content: queryContent } : {}),
				});
				ctx.errorHistory.recordFix(relPath, fixContext);
			}
		}

		// Check if export surface changed (for smart tsc)
		const newExports = fileGraph.getExports(editedFilePath);
		exportSurfaceChanged = !shouldSkipTsc(structuralConfig, oldExports, newExports);

		// --- Deletion hygiene (Layer 3): orphaned test references ---
		// When exports are removed, check if co-located test files still reference them
		if (session && oldExports.length > 0) {
			const newExportNames = new Set(newExports.map((e) => e.name));
			const removedSymbols = oldExports
				.filter((e) => !newExportNames.has(e.name))
				.map((e) => e.name);

			if (removedSymbols.length > 0) {
				// Resolve co-located test files (same pattern as checkTestFileExists)
				const extMatch = editedFilePath.match(/\.(ts|tsx|js|jsx|mjs|cjs)$/);
				if (extMatch) {
					const base = editedFilePath.slice(0, -extMatch[0].length);
					const testCandidates = [
						`${base}.test${extMatch[0]}`,
						`${base}.spec${extMatch[0]}`,
						join(
							dirname(editedFilePath),
							"__tests__",
							`${basename(base)}.test${extMatch[0]}`,
						),
						join(
							dirname(editedFilePath),
							"__tests__",
							`${basename(base)}.spec${extMatch[0]}`,
						),
					];
					for (const testFile of testCandidates) {
						if (!existsSync(testFile)) continue;
						try {
							const testContent = readFileSync(testFile, "utf-8");
							const wasEdited = session.files_written.has(testFile);
							const orphanFindings = checkOrphanedTests(
								removedSymbols,
								relative(CWD, testFile),
								testContent,
								wasEdited,
							);
							for (const f of orphanFindings) {
								allCheckResults.push({
									source: "suggestion",
									name: f.check,
									severity: "warning",
									message: f.message,
									file: testFile,
									determinism: "heuristic",
								});
							}
							if (orphanFindings.length > 0) {
								decision.warnings = [
									...(decision.warnings || []),
									...orphanFindings.map(
										(f) => `[deletion-hygiene:${f.check}] ${f.message}`,
									),
								];
							}
						} catch (e) {
							void e;
						}
					}
				}
			}
		}
	} else if (fileGraph.isInitialized && editedFilePath) {
		// Even if structural checks are disabled, keep graph up to date
		fileGraph.updateFile(editedFilePath);
	}

	// Update route map when a file is edited
	if (editedFilePath) {
		ctx.routeMap.updateFile(editedFilePath);
	}

	// --- Quality checks (tsc, lint, secrets — slower, subprocess-based) ---
	// Capture baseline suppression count before quality checks consume it
	let previousSuppressionCount = 0;
	if (rules.quality_checks) {
		// Smart tsc: when only internal logic changed (no export surface change),
		// still run tsc but filter output to only the edited file. This catches
		// internal type errors (e.g. TS18046 'unknown' access) without reporting
		// unrelated project-wide errors.
		let qualityOpts: QualityCheckOptions | undefined;
		if (
			structuralConfig?.smart_tsc &&
			!exportSurfaceChanged &&
			editedFilePath &&
			rules.quality_checks.typescript?.enabled
		) {
			const filterFile = relative(
				findProjectRoot(editedFilePath, CWD) || CWD,
				editedFilePath,
			);
			qualityOpts = { tscFilterFile: filterFile };
			log(`Smart tsc: filtering to ${filterFile} (internal-only edit)`);
		}

		const baselineFilePath = isAbsolute(editedFilePath)
			? editedFilePath
			: resolve(CWD, editedFilePath);
		const currentBaseline = ctx.preEditBaselines.get(baselineFilePath);
		previousSuppressionCount = currentBaseline?.suppressionCount ?? 0;
		// Phase mark — everything from the last mark up to here was
		// the structural-checks block (export-surface diff, project
		// graph update, impact analysis, deletion-hygiene).
		markPhase("structural_checks");
		const rawQualityResults = await runQualityChecks(
			checkEvent,
			rules.quality_checks,
			CWD,
			{
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
			},
		);
		// Phase mark — runQualityChecks ran tsc/biome/inline checks.
		// The subprocess time is captured in tool_breakdown; this
		// phase covers their wall time + the inline-check residual.
		markPhase("quality_checks");
		// Clear consumed baseline
		ctx.preEditBaselines.delete(baselineFilePath);
		// Track which quality checks actually applied to this file type
		for (const [name, check] of Object.entries(rules.quality_checks)) {
			if (
				check.enabled &&
				check.file_types.some((t: string) => editedFilePath.endsWith(t))
			) {
				checksRan.push(name);
			}
		}

		// --- Session-ack suppression for quality checks ---
		// Skip re-firing warnings the user already acknowledged for this file+check.
		// Errors always re-fire regardless of acknowledgment.
		const qualityResults = rawQualityResults.filter(
			(r) =>
				r.severity === "error" || !isAcknowledged(session, editedFilePath, r.name),
		);

		// --- Sibling expansion (PostToolUse fan-out) ---
		// When a finding hits a known type-erasure / boundary pattern, query
		// the trigram index for every other instance and emit one row per
		// sibling. Codex finding-discovery convention "do not collapse
		// separate instances under one candidate" — turns a single edit's
		// `as_any_ratchet` into a worklist covering the whole module.
		const triggerNames = new Set(DEFAULT_TRIGGERS.map((t) => t.triggerName));
		const triggers = qualityResults
			.filter((r) => triggerNames.has(r.name))
			.map((r) => ({ name: r.name, file: r.file ?? editedFilePath }));
		if (ctx.trigramIndex && triggers.length > 0) {
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
					log(
						`Sibling expansion: ${siblings.length} row(s) across ${triggers.length} trigger(s)`,
					);
				}
			} catch (e) {
				// Sibling fan-out is advisory — never fail the post-edit pipeline on it.
				log(`Sibling expansion failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		// Collect quality check results for local persistence
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

		if (qualityResults.length > 0) {
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
			log(
				`Quality issues found: ${qualityResults.map((r) => r.name).join(", ")} (${outcome})`,
			);
		}
	}

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
				editedFilePath!,
			);

			// --- Deletion hygiene (Layer 2): diff-aware zombie detectors ---
			// These compare old_string vs new_string to catch the agent hedging.
			allFindings.push(
				...collectDeletionHygieneDiffFindings({
					oldString: checkEvent.tool_input?.old_string as string | undefined,
					newString: checkEvent.tool_input?.new_string as string | undefined,
					filePath: editedFilePath!,
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
					filePath: editedFilePath!,
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
					(s) => !isAcknowledged(session, editedFilePath!, s.check),
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

	// --- Feedback effectiveness tracking ---
	// Pass full evidence (name + line) so the escalation check on the NEXT
	// edit can read each persistent finding's line for the diff-aware
	// proximity gate (refinement 2026-05).
	if (session && editedFilePath && allCheckResults.length > 0) {
		const warningEvidence = allCheckResults
			.filter((r) => r.severity === "warning" || r.severity === "error")
			.map((r) => ({ name: r.name, ...(r.line !== undefined ? { line: r.line } : {}) }));
		if (warningEvidence.length > 0) {
			recordWarningsIssued(session, editedFilePath, warningEvidence);
		}
		recordWarningResolutions(
			session,
			editedFilePath,
			new Set(allCheckResults.map((r) => r.name)),
		);
	}

	// --- Session-ack: record shown warnings so they don't re-fire ---
	// Only acknowledge warning-level findings (errors must always re-fire).
	if (editedFilePath && allCheckResults.length > 0) {
		const warningCheckNames = allCheckResults
			.filter((r) => r.severity === "warning")
			.map((r) => r.name);
		if (warningCheckNames.length > 0) {
			acknowledgeChecks(session, editedFilePath, warningCheckNames);
		}
	}

	// Mirror EVERY actionable check failure (quality / structural /
	// suggestion / impact / structure / behavioral) into the
	// recurrence log so `interlinked recurrence` can aggregate
	// repeated harness_caught hits across sessions and propose
	// ratchets. Independent of error_memory.enabled — that gate
	// is for embedding-augmented error history; recurrence is its
	// own JSONL. Fire-and-forget; recordHarnessCaught swallows
	// storage failures so live PostToolUse never trips.
	if (editedFilePath && allCheckResults.length > acc.recurrenceCursor) {
		const recurrenceRelPath = relative(CWD, editedFilePath);
		for (let i = acc.recurrenceCursor; i < allCheckResults.length; i++) {
			const r = allCheckResults[i];
			if (r.severity !== "error" && r.severity !== "warning") continue;
			recordHarnessCaught({
				check_id: r.name,
				agent_source: event.agent_source,
				session_id: event.session_id,
				file: r.file ? relative(CWD, r.file) : recurrenceRelPath,
				message: r.message,
				cwd: CWD,
				phase: r.phase,
				severity: r.severity,
			});
		}
		acc.recurrenceCursor = allCheckResults.length;
	}
}
