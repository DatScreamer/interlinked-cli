// ===========================================
// Ratchet comparison — warn when countable quality metrics regress
// ===========================================
// Active when diff-aware is OFF (default): the agent is expected to improve
// all issues in files it touches, not just avoid introducing new ones.
// Metrics must not go up (more suppressions, more `as any`, etc.). Extracted
// from runQualityChecks so the orchestrator stays a thin sequencer; the guard
// (`diffAware.enabled === false && baseline`) lives here so the caller can
// invoke it unconditionally.

import { capturePrimitiveViolations } from "../discovered-primitives.js";
import type { PreEditBaseline } from "../types.js";
import {
	countAsAnyCasts,
	countConsoleStatements,
	countNonNullAssertions,
	countPublicApiSurface,
	countSuppressionDirectives,
	countTodoMarkers,
	countTypeDensity,
} from "./ratchet-metrics.js";
import type { QualityCheckResult } from "./result-types.js";

/** Read-only context the ratchet phase needs from the orchestrator. */
export interface RatchetContext {
	/** Absolute path of the edited file (used as the finding's `file`). */
	absPath: string;
	/** Post-edit file content (snapshot). Empty string when unreadable. */
	postContent: string;
	/** Pre-edit baseline counters; the comparison no-ops when absent. */
	baseline: PreEditBaseline | undefined;
	/** Project cwd (for discovered-primitive wrapper resolution). */
	cwd: string;
	/** When false (diff-aware enabled), the ratchet does not run. */
	diffAwareEnabled: boolean | undefined;
}

/**
 * Compare post-edit metric counts against the pre-edit baseline and emit one
 * warning per dimension that regressed. Returns the findings in declaration
 * order; the caller appends them to the result list after the inline-check
 * block so overall ordering is preserved.
 */
export function runRatchetComparison(ctx: RatchetContext): QualityCheckResult[] {
	const results: QualityCheckResult[] = [];
	if (ctx.diffAwareEnabled !== false || !ctx.baseline) return results;

	try {
		const absPath = ctx.absPath;
		const postContent = ctx.postContent;
		const pre = ctx.baseline;
		const postSuppressions = countSuppressionDirectives(postContent);
		const postAsAny = countAsAnyCasts(postContent);
		const postNonNull = countNonNullAssertions(postContent);

		if (postSuppressions > pre.suppressionCount) {
			results.push({
				name: "suppression_ratchet",
				severity: "warning",
				message: `Suppression directives increased (${pre.suppressionCount} → ${postSuppressions}). Fix the underlying issue instead of adding @ts-ignore / eslint-disable.`,
				file: absPath,
			});
		}
		if (postAsAny > pre.asAnyCastCount) {
			results.push({
				name: "as_any_ratchet",
				severity: "warning",
				message: `'as any' casts increased (${pre.asAnyCastCount} → ${postAsAny}). Fix the types instead of casting to any.`,
				file: absPath,
			});
		}
		if (postNonNull > pre.nonNullAssertionCount) {
			results.push({
				name: "non_null_assertion_ratchet",
				severity: "warning",
				message: `Non-null assertions increased (${pre.nonNullAssertionCount} → ${postNonNull}). Replace \`foo!.bar\` with an explicit null check, optional chaining (\`foo?.bar\`), or narrow the type so the assertion is unnecessary.`,
				file: absPath,
			});
		}

		// Defensive-primitive coverage ratchet — adapted from curl's
		// curlx_str_number lesson (Mythos blog, 2026-05). Once the
		// project has adopted a wrapper around an unsafe builtin
		// (e.g. safeParseInt wrapping parseInt), each new bare call
		// to the underlying builtin is a missed coverage opportunity.
		if (pre.discoveredPrimitiveViolations) {
			const postViolations = capturePrimitiveViolations(ctx.cwd, postContent);
			if (postViolations) {
				for (const [wrapperName, postCount] of Object.entries(postViolations)) {
					const preCount = pre.discoveredPrimitiveViolations[wrapperName] ?? 0;
					if (postCount > preCount) {
						results.push({
							name: "discovered_primitive_ratchet",
							severity: "warning",
							message: `Bare unsafe-builtin calls increased for \`${wrapperName}\` (${preCount} → ${postCount}). This project has adopted \`${wrapperName}\` as its safe wrapper — use it instead of the raw builtin. Disable via .interlinked/discovered-primitives.json \`disabled\` list.`,
							file: absPath,
						});
					}
				}
			}
		}

		// === Batch 7 ratchets ===
		if (pre.todoMarkerCount !== undefined) {
			const postTodo = countTodoMarkers(postContent);
			if (postTodo > pre.todoMarkerCount) {
				results.push({
					name: "todo_marker_ratchet",
					severity: "warning",
					message: `TODO/FIXME/HACK/XXX markers increased (${pre.todoMarkerCount} → ${postTodo}). Resolve the marker before committing or replace it with a tracked-issue reference (\`// TODO(TICKET-123): ...\`).`,
					file: absPath,
				});
			}
		}
		if (pre.consoleStatementCount !== undefined) {
			const postConsole = countConsoleStatements(postContent);
			if (postConsole > pre.consoleStatementCount) {
				results.push({
					name: "console_statement_ratchet",
					severity: "warning",
					message: `console.* statements increased (${pre.consoleStatementCount} → ${postConsole}). Use a structured logger or remove the debug print before committing.`,
					file: absPath,
				});
			}
		}
		if (pre.publicApiSurfaceCount !== undefined) {
			const postSurface = countPublicApiSurface(postContent);
			if (postSurface > pre.publicApiSurfaceCount) {
				results.push({
					name: "public_api_surface_ratchet",
					severity: "warning",
					message: `Public API surface grew (${pre.publicApiSurfaceCount} → ${postSurface} exported symbols). Every new export expands the contract callers can rely on; confirm the symbol is genuinely meant for external use.`,
					file: absPath,
				});
			}
		}
		// Composite type-density ratchet: bare `: any` / `: unknown` /
		// `: Function` / `: {}` annotations + untyped exported params +
		// missing exported return types. One ratchet, six counters,
		// single warning that lists every dimension that regressed.
		if (pre.typeDensity) {
			const post = countTypeDensity(postContent);
			const dims: Array<[keyof typeof post, string]> = [
				["anyAnnotations", "`: any`"],
				["unknownAnnotations", "`: unknown`"],
				["functionType", "`: Function`"],
				["emptyObjectType", "`: {}`"],
				["untypedExportedParams", "untyped exported params"],
				["missingExportedReturnType", "missing exported return type"],
			];
			const regressions: string[] = [];
			for (const [key, label] of dims) {
				const before = pre.typeDensity[key];
				const after = post[key];
				if (after > before) regressions.push(`${label} (${before}→${after})`);
			}
			if (regressions.length > 0) {
				results.push({
					name: "type_density_ratchet",
					severity: "warning",
					message: `Type density regressed: ${regressions.join(", ")}. Replace bare \`: any\` / \`: unknown\` / \`: Function\` / \`: {}\` with named shapes, and add explicit types to exported function signatures so cold readers know the contract.`,
					file: absPath,
				});
			}
		}
	} catch {
		/* intentional: non-fatal — file may have been deleted between edits */
	}

	return results;
}
