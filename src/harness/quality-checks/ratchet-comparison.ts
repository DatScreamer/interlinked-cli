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
	countUnjustifiedCasts,
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
 *
 * Each dimension is a self-contained "did this one thing regress" decision
 * (see the `check*Ratchet` helpers below) — the orchestrator here is just the
 * declaration-ordered sequence of those decisions, spread into one flat
 * result list. Every helper reads only the baseline fields it decides on, so
 * a mid-sequence throw (a baseline field access failing because the file
 * mutated between edits) still preserves the already-collected findings —
 * that ordering guarantee is pinned by the "gathered before a later-stage
 * throw" test.
 */
export function runRatchetComparison(ctx: RatchetContext): QualityCheckResult[] {
	const results: QualityCheckResult[] = [];
	if (ctx.diffAwareEnabled !== false || !ctx.baseline) return results;

	try {
		const { absPath, postContent, cwd } = ctx;
		const pre = ctx.baseline;
		results.push(...checkSuppressionRatchet(absPath, pre, postContent));
		results.push(...checkAsAnyRatchet(absPath, pre, postContent));
		results.push(...checkNonNullAssertionRatchet(absPath, pre, postContent));
		results.push(...checkUnjustifiedCastRatchet(absPath, pre, postContent));
		results.push(...checkDiscoveredPrimitiveRatchet(cwd, absPath, pre, postContent));
		results.push(...checkTodoMarkerRatchet(absPath, pre, postContent));
		results.push(...checkConsoleStatementRatchet(absPath, pre, postContent));
		results.push(...checkPublicApiSurfaceRatchet(absPath, pre, postContent));
		results.push(...checkTypeDensityRatchet(absPath, pre, postContent));
	} catch {
		/* intentional: non-fatal — file may have been deleted between edits */
	}

	return results;
}

/** Suppression-directive ratchet: more `@ts-ignore` / `eslint-disable` / `biome-ignore` than before. */
function checkSuppressionRatchet(
	absPath: string,
	pre: PreEditBaseline,
	postContent: string,
): QualityCheckResult[] {
	const post = countSuppressionDirectives(postContent);
	if (post > pre.suppressionCount) {
		return [
			{
				name: "suppression_ratchet",
				severity: "warning",
				message: `Suppression directives increased (${pre.suppressionCount} → ${post}). Fix the underlying issue instead of adding @ts-ignore / eslint-disable.`,
				file: absPath,
			},
		];
	}
	return [];
}

/** `as any` cast ratchet: more unsafe casts to `any` than before. */
function checkAsAnyRatchet(absPath: string, pre: PreEditBaseline, postContent: string): QualityCheckResult[] {
	const post = countAsAnyCasts(postContent);
	if (post > pre.asAnyCastCount) {
		return [
			{
				name: "as_any_ratchet",
				severity: "warning",
				message: `'as any' casts increased (${pre.asAnyCastCount} → ${post}). Fix the types instead of casting to any.`,
				file: absPath,
			},
		];
	}
	return [];
}

/** Non-null assertion ratchet: more `foo!.bar` than before. */
function checkNonNullAssertionRatchet(
	absPath: string,
	pre: PreEditBaseline,
	postContent: string,
): QualityCheckResult[] {
	const post = countNonNullAssertions(postContent);
	if (post > pre.nonNullAssertionCount) {
		return [
			{
				name: "non_null_assertion_ratchet",
				severity: "warning",
				message: `Non-null assertions increased (${pre.nonNullAssertionCount} → ${post}). Replace \`foo!.bar\` with an explicit null check, optional chaining (\`foo?.bar\`), or narrow the type so the assertion is unnecessary.`,
				file: absPath,
			},
		];
	}
	return [];
}

/** Unjustified-cast ratchet (optional — older callers/tests may not capture it). */
function checkUnjustifiedCastRatchet(
	absPath: string,
	pre: PreEditBaseline,
	postContent: string,
): QualityCheckResult[] {
	if (pre.unjustifiedCastCount === undefined) return [];
	const post = countUnjustifiedCasts(postContent);
	if (post > pre.unjustifiedCastCount) {
		return [
			{
				name: "unjustified_cast_ratchet",
				severity: "warning",
				message:
					"Unjustified casts increased (" +
					pre.unjustifiedCastCount +
					" -> " +
					post +
					"). Add a // SAFETY: comment explaining why each cast is sound, or remove the cast.",
				file: absPath,
			},
		];
	}
	return [];
}

/**
 * Defensive-primitive coverage ratchet — adapted from curl's
 * curlx_str_number lesson (Mythos blog, 2026-05). Once the project has
 * adopted a wrapper around an unsafe builtin (e.g. safeParseInt wrapping
 * parseInt), each new bare call to the underlying builtin is a missed
 * coverage opportunity. Can emit one finding per regressed wrapper, unlike
 * the other single-finding ratchets.
 */
function checkDiscoveredPrimitiveRatchet(
	cwd: string,
	absPath: string,
	pre: PreEditBaseline,
	postContent: string,
): QualityCheckResult[] {
	const preViolations = pre.discoveredPrimitiveViolations;
	if (!preViolations) return [];
	const postViolations = capturePrimitiveViolations(cwd, postContent);
	if (!postViolations) return [];

	const results: QualityCheckResult[] = [];
	for (const [wrapperName, postCount] of Object.entries(postViolations)) {
		const preCount = preViolations[wrapperName] ?? 0;
		if (postCount > preCount) {
			results.push({
				name: "discovered_primitive_ratchet",
				severity: "warning",
				message: `Bare unsafe-builtin calls increased for \`${wrapperName}\` (${preCount} → ${postCount}). This project has adopted \`${wrapperName}\` as its safe wrapper — use it instead of the raw builtin. Disable via .interlinked/discovered-primitives.json \`disabled\` list.`,
				file: absPath,
			});
		}
	}
	return results;
}

// === Batch 7 ratchets ===

/** TODO/FIXME/HACK/XXX marker ratchet (optional). */
function checkTodoMarkerRatchet(
	absPath: string,
	pre: PreEditBaseline,
	postContent: string,
): QualityCheckResult[] {
	if (pre.todoMarkerCount === undefined) return [];
	const post = countTodoMarkers(postContent);
	if (post > pre.todoMarkerCount) {
		return [
			{
				name: "todo_marker_ratchet",
				severity: "warning",
				message: `TODO/FIXME/HACK/XXX markers increased (${pre.todoMarkerCount} → ${post}). Resolve the marker before committing or replace it with a tracked-issue reference (\`// TODO(TICKET-123): ...\`).`,
				file: absPath,
			},
		];
	}
	return [];
}

/** `console.*` statement ratchet (optional). */
function checkConsoleStatementRatchet(
	absPath: string,
	pre: PreEditBaseline,
	postContent: string,
): QualityCheckResult[] {
	if (pre.consoleStatementCount === undefined) return [];
	const post = countConsoleStatements(postContent);
	if (post > pre.consoleStatementCount) {
		return [
			{
				name: "console_statement_ratchet",
				severity: "warning",
				message: `console.* statements increased (${pre.consoleStatementCount} → ${post}). Use a structured logger or remove the debug print before committing.`,
				file: absPath,
			},
		];
	}
	return [];
}

/** Public API surface ratchet (optional): exported-symbol count grew. */
function checkPublicApiSurfaceRatchet(
	absPath: string,
	pre: PreEditBaseline,
	postContent: string,
): QualityCheckResult[] {
	if (pre.publicApiSurfaceCount === undefined) return [];
	const post = countPublicApiSurface(postContent);
	if (post > pre.publicApiSurfaceCount) {
		return [
			{
				name: "public_api_surface_ratchet",
				severity: "warning",
				message: `Public API surface grew (${pre.publicApiSurfaceCount} → ${post} exported symbols). Every new export expands the contract callers can rely on; confirm the symbol is genuinely meant for external use.`,
				file: absPath,
			},
		];
	}
	return [];
}

/**
 * Composite type-density ratchet (optional): bare `: any` / `: unknown` /
 * `: Function` / `: {}` annotations + untyped exported params + missing
 * exported return types. One ratchet, six counters, single warning that
 * lists every dimension that regressed.
 */
function checkTypeDensityRatchet(
	absPath: string,
	pre: PreEditBaseline,
	postContent: string,
): QualityCheckResult[] {
	const density = pre.typeDensity;
	if (!density) return [];
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
		const before = density[key];
		const after = post[key];
		if (after > before) regressions.push(`${label} (${before}→${after})`);
	}
	if (regressions.length === 0) return [];
	return [
		{
			name: "type_density_ratchet",
			severity: "warning",
			message: `Type density regressed: ${regressions.join(", ")}. Replace bare \`: any\` / \`: unknown\` / \`: Function\` / \`: {}\` with named shapes, and add explicit types to exported function signatures so cold readers know the contract.`,
			file: absPath,
		},
	];
}
