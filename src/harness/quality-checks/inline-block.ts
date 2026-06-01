// ===========================================
// Inline Checks — generic + language-specific (no subprocess, <10ms total)
// ===========================================
// Runs AFTER the subprocess checks (tsc, lint, etc.) for additional signal.
// Operates on the file content already snapshotted by the orchestrator, so
// there is no extra disk read here. Extracted from runQualityChecks to keep
// the orchestrator a thin sequencer; ordering of the pushed findings is
// identical to the original inline section.

import { buildAgentSafetyChecks } from "../check-registry/index.js";
import { filterToRisers as filterDryToRisers } from "../checks/dry-baseline.js";
import { checkCodeCloneFindings, formatCodeCloneFinding } from "../checks/dry-check.js";
import { type FilePriority, shouldRunAdvisoryChecks } from "../file-priority.js";
import {
	checkBinaryContent,
	checkEmptyFile,
	checkFunctionComplexity,
	checkMissingReturnTypes,
	checkTestFileExists,
} from "../generic-checks.js";
import { loadDisabledLibraries, runFootgunChecks } from "../library-footguns/registry.js";
import type { DiffAwareConfig, HarnessEvent, PreEditBaseline } from "../types.js";
import type { QualityCheckResult } from "./result-types.js";

/** Read-only context the inline-check block needs from the orchestrator. */
export interface InlineBlockContext {
	event: HarnessEvent;
	/** Display path used in finding messages. */
	filePath: string;
	/** Absolute path (passed to per-file check helpers). */
	absFilePath: string;
	/** Post-edit file content (non-null — caller guards on readability). */
	fileContent: string;
	cwd: string;
	diffAware: DiffAwareConfig | undefined;
	baseline: PreEditBaseline | undefined;
	filePriority: Map<string, FilePriority> | undefined;
}

/**
 * Run the generic + agent-safety + library-footgun inline checks against the
 * snapshotted file content. Returns findings in push order; the caller appends
 * them after the subprocess-check results.
 */
export function runInlineCheckBlock(ctx: InlineBlockContext): QualityCheckResult[] {
	const results: QualityCheckResult[] = [];
	const { event, filePath, absFilePath, fileContent, cwd } = ctx;

	try {
		// 1. Binary content — error, skip all other inline checks
		if (checkBinaryContent(fileContent)) {
			results.push({
				name: "binary_content",
				severity: "error",
				message: `Binary content detected in ${filePath} — text editing tools should not write binary files`,
				file: filePath,
			});
		} else {
			// 2. Empty file — warning
			if (checkEmptyFile(fileContent)) {
				results.push({
					name: "empty_file",
					severity: "warning",
					message: `File is empty: ${filePath} — was content intended?`,
					file: filePath,
				});
			}

			// 4. Missing return type annotations (TS/TSX only)
			// Diff-aware: only report findings not in the pre-edit baseline
			let missingReturnTypes = checkMissingReturnTypes(fileContent, absFilePath);
			if (
				ctx.diffAware?.enabled !== false &&
				ctx.diffAware?.missing_return_types !== "off" &&
				ctx.baseline?.missingReturnTypes
			) {
				const baseline = ctx.baseline?.missingReturnTypes;
				if (baseline) {
					missingReturnTypes = missingReturnTypes.filter(
						(m) => !baseline.has(m.text),
					);
				}
			}
			if (missingReturnTypes.length > 0) {
				const shown = missingReturnTypes.slice(0, 5);
				const detail = shown.map((m) => `  L${m.line}: ${m.text}`).join("\n");
				const overflow =
					missingReturnTypes.length > 5
						? `\n  ... and ${missingReturnTypes.length - 5} more`
						: "";
				results.push({
					name: "missing_return_types",
					severity: "warning",
					message: `${missingReturnTypes.length} exported function(s) without return type annotations in ${filePath}`,
					file: filePath,
					detail: detail + overflow,
				});
			}

			// 5. Test file existence
			// Diff-aware: only fire on new file creation (Write tool), not edits to existing files
			const isNewFile =
				ctx.diffAware?.enabled !== false &&
				ctx.diffAware?.no_test_file !== "off" &&
				event.tool_name != null &&
				!["Write", "WriteFile", "write_file"].includes(event.tool_name);
			if (!isNewFile) {
				// Pass file content so the check can short-circuit on
				// generator-emitted files (OpenAPI, protoc, @generated)
				// that never have test siblings by design.
				const noTestFile = checkTestFileExists(absFilePath, fileContent);
				if (noTestFile.length > 0) {
					results.push({
						name: "no_test_file",
						severity: "warning",
						message: `No test file found for ${filePath}`,
						file: filePath,
						detail: noTestFile[0].text,
					});
				}
			}

			// 6. Function complexity
			// Diff-aware: only report complex functions introduced by this edit
			let complexFns = checkFunctionComplexity(fileContent, absFilePath);
			if (ctx.diffAware?.enabled !== false && ctx.diffAware?.complexity !== "off") {
				let filtered = false;

				// Strategy 1: Edit-region intersection (Edit tool with old_string/new_string)
				if (event.tool_input?.old_string) {
					const newStr = (event.tool_input.new_string as string) || "";
					const oldStr = event.tool_input.old_string as string;
					// Post-edit file has new_string, not old_string — use new_string for lookup
					const lookupStr = newStr || oldStr;
					const idx = fileContent.indexOf(lookupStr);
					if (idx >= 0) {
						const editStartLine = fileContent.slice(0, idx).split("\n").length;
						const oldLines = oldStr.split("\n").length;
						const newLines = newStr.split("\n").length;
						const editEndLine = editStartLine + Math.max(oldLines, newLines);
						complexFns = complexFns.filter(
							(m) => m.line >= editStartLine - 5 && m.line <= editEndLine + 50,
						);
						filtered = true;
					}
				}

				// Strategy 2: Baseline subtraction (fallback, or Bash edits without old_string)
				const complexBaseline = ctx.baseline?.complexFunctions;
				if (!filtered && complexBaseline) {
					complexFns = complexFns.filter((m) => !complexBaseline.has(m.text));
				}
			}
			if (complexFns.length > 0) {
				const shown = complexFns.slice(0, 5);
				const detail = shown.map((m) => `  L${m.line}: ${m.text}`).join("\n");
				const overflow =
					complexFns.length > 5 ? `\n  ... and ${complexFns.length - 5} more` : "";
				results.push({
					name: "complexity",
					severity: "warning",
					message: `${complexFns.length} complex function(s) in ${filePath}`,
					file: filePath,
					detail: detail + overflow,
				});
			}

			// 7. Export ripple — now handled by impact-analysis.ts PostToolUse hook.

			// 8. Agent safety checks (async, imports, types, security, correctness)
			// Derived from the declarative CHECK_REGISTRY — see check-registry/.
			// Only run phase="post" here; pre_block/pre_warn entries fire in
			// evaluator.ts at PreToolUse and are authoritative for their phase.
			//
			// Mythos Phase 4 recency gate: when filePriority is provided AND
			// this file is "cold" (>180 days unchanged in git), drop the
			// heuristic detectors and keep only fully-deterministic ones.
			// New/untracked files always pass the gate (fail-OPEN).
			const coldFileMode =
				ctx.filePriority !== undefined &&
				!shouldRunAdvisoryChecks(filePath, ctx.filePriority);
			const agentSafetyChecks = buildAgentSafetyChecks(
				fileContent,
				absFilePath,
				"post",
				undefined,
				coldFileMode,
			);

			for (const check of agentSafetyChecks) {
				const matches =
					check.name === "code_clones" &&
					ctx.diffAware?.enabled !== false &&
					ctx.baseline?.dryCloneBaseline
						? filterDryToRisers(
								checkCodeCloneFindings(fileContent, absFilePath),
								ctx.baseline.dryCloneBaseline,
							).map(formatCodeCloneFinding(absFilePath))
						: check.fn();
				if (matches.length > 0) {
					const shown = matches.slice(0, 5);
					const detail = shown.map((m) => `  L${m.line}: ${m.text}`).join("\n");
					const overflow =
						matches.length > 5 ? `\n  ... and ${matches.length - 5} more` : "";
					results.push({
						name: check.name,
						severity: check.severity,
						message: `${matches.length} ${check.name.replace(/_/g, " ")} issue(s) in ${filePath}`,
						file: filePath,
						detail: detail + overflow,
					});
				}
			}

			// 8b. Library-footgun registry (Mythos Phase 5). Deterministic
			// per-library checks that detect known API anti-patterns
			// (e.g. fetch() without timeout). Findings group by check id
			// — the fix instruction comes from the registry entry so
			// the agent sees both WHAT fired and HOW to fix it. Per-
			// library opt-out via `.interlinked/disabled-libraries.json`.
			const disabledLibs = loadDisabledLibraries(cwd);
			const footgunFindings = runFootgunChecks(fileContent, filePath, disabledLibs);
			if (footgunFindings.length > 0) {
				const byId = new Map<string, typeof footgunFindings>();
				for (const f of footgunFindings) {
					const bucket = byId.get(f.id) || [];
					bucket.push(f);
					byId.set(f.id, bucket);
				}
				for (const [id, bucket] of byId) {
					const first = bucket[0];
					const shown = bucket.slice(0, 5);
					const detail = `${shown
						.map((f) => `  L${f.match.line}: ${f.match.text}`)
						.join("\n")}\n→ ${first.fixInstruction}`;
					const overflow =
						bucket.length > 5 ? `\n  ... and ${bucket.length - 5} more` : "";
					results.push({
						name: id,
						severity: "warning",
						message: `${bucket.length} ${first.name} issue(s) in ${filePath} [${first.library}]`,
						file: filePath,
						detail: detail + overflow,
					});
				}
			}

			// Non-deterministic regex heuristics (generic_inline, silent_catch, sync_io_in_async,
			// perf_*, language-specific) have been moved to the scored suggestion pipeline
			// in server.ts. They're now scored, ranked, and only the top 1-3 above a
			// threshold are shown. See suggestion-scorer.ts.
		}
	} catch {
		/* intentional: file unreadable — skip inline checks silently */
	}

	return results;
}
