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
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { STRUCTURAL_CHECK_META } from "../check-metadata.js";
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
	findProjectRoot,
	type ToolBreakdownEntry,
} from "../quality-checks.js";
import { recordHarnessCaught } from "../recurrence.js";
import { recordImplEdit, recordTestWrite, TEST_FILE_RE } from "../server-tdd-cycle.js";
import { acknowledgeChecks, isAcknowledged } from "../session-state.js";
import {
	formatStructuralWarnings,
	runStructuralChecks,
	shouldSkipTsc,
} from "../structural-checks.js";
import { loadFileSuppressions } from "../suppressions.js";
import type {
	CheckResultEntry,
	ExportedSymbol,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import {
	runBehavioralPhase,
	runProjectWideSweepPhase,
	runQualityPhase,
	runScoredSuggestionsPhase,
	runShotgunSurgeryPhase,
	runStructureChecksPhase,
} from "./post-tool-file-checks-phases.js";
import { getGraphForFile, type ServerRuntime } from "./runtime-context.js";

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
	const { allCheckResults, checksRan } = acc;

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
	// Returns the suppression-count baseline (read before the checks consumed
	// it) for the behavioral phase below. The `structural_checks` phase mark
	// fires inside this helper, immediately before runQualityChecks.
	const previousSuppressionCount = await runQualityPhase(
		ctx,
		checkEvent,
		editedFilePath,
		editedFileInRepo,
		exportSurfaceChanged,
		structuralConfig,
		session,
		decision,
		acc,
	);

	// ── Project-wide sweep (cross-file tsc/biome) ── (ends with the
	// `project_wide_sweep` phase mark).
	await runProjectWideSweepPhase(
		ctx,
		editedFilePath,
		editedFileInRepo,
		exportSurfaceChanged,
		decision,
		acc,
	);

	// ── Scored suggestions (non-deterministic heuristics, top 1-3) ──
	runScoredSuggestionsPhase(ctx, checkEvent, editedFilePath, session, decision, acc);

	// --- Session-level taste check: shotgun surgery ---
	runShotgunSurgeryPhase(session, decision, acc);

	// --- Structure checks phase (non-blocking guidance) ── (ends with the
	// `scored_suggestions` phase mark).
	runStructureChecksPhase(ctx, editedFilePath, editedFileInRepo, session, decision, acc);

	// --- Session-level behavioral checks ---
	runBehavioralPhase(
		checkEvent,
		editedFilePath,
		previousSuppressionCount,
		session,
		decision,
		acc,
	);

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
