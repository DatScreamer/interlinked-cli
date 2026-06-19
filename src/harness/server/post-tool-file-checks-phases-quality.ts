// interlinked-tdd: exempt
// ===========================================
// PostToolUse — quality + scored-suggestion phase helpers
// ===========================================
// Leaf helpers extracted verbatim from `post-tool-file-checks-phases.ts` to
// keep the orchestrator file under the per-file line cap. These are the
// quality-phase support functions (smart-tsc opts, checks-ran tracking,
// sibling fan-out, result collection, blocking decision) plus the
// self-contained scored-suggestions phase. Logic is byte-identical to the
// inline versions; only their host file changed.

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { GENERIC_CHECK_META, QUALITY_CHECK_META } from "../check-metadata.js";
import {
	findProjectRoot,
	formatQualityWarnings,
	type QualityCheckOptions,
} from "../quality-checks.js";
import type { QualityCheckResult } from "../quality-checks/result-types.js";
import { isAcknowledged } from "../session-state.js";
import { DEFAULT_TRIGGERS, expandSiblings } from "../sibling-expansion.js";
import {
	type Finding,
	formatScoredFindings,
	scoreFindings,
	writeTelemetry,
} from "../suggestion-scorer.js";
import { loadFileSuppressions, scanInlineSuppressions } from "../suppressions.js";
import type { GuardRulesConfig, HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";
import { collectDeletionHygieneDiffFindings } from "./deletion-hygiene-diff.js";
import type { PerFileCheckCtx } from "./post-tool-file-checks.js";
import type { ServerRuntime } from "./runtime-context.js";
import { collectSuggestionFindings } from "./suggestion-checks.js";

/**
 * Smart-tsc filtering: when only internal logic changed (no export-surface
 * change) and tsc is enabled, still run tsc but filter output to the edited
 * file only. Returns `{ tscFilterFile }` when the gate applies, else undefined
 * (callers spread the result, so an absent key leaves opts untouched under
 * exactOptionalPropertyTypes).
 */
export function buildSmartTscOpts(
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
export function recordChecksRan(
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
export function expandQualitySiblings(
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
export function collectQualityResultEntries(
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
export function applyQualityDecision(
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
