// ===========================================
// Structural Checks — Dependency-aware edit validation
// ===========================================
// Runs after each file edit (PostToolUse) to detect multi-agent coherence
// issues that single-file lint/typecheck cannot catch. All checks are
// deterministic, sub-100ms, and require no external tools.
//
// Checks are grouped into tiers by cost:
//   Tier 1 (sub-100ms, every edit): export surface, import resolution,
//     duplicate symbols, co-dependency staleness, dead imports
//   Tier 2 (sub-1s, every edit): import cycles, interface change impact,
//     test proximity
//   Tier 3 (1-5s, conditional): smart tsc triggering
//
// Individual check implementations live in ./structural-checks/*.
// This file orchestrates the dispatch for runStructuralChecks and
// getPreToolUseContext. Keep it a thin coordinator — new checks should
// get their own sibling file and be wired in here.

import { extname } from "node:path";
import {
	checkCrossFileSwitchDiscriminant,
	checkSingleImplementationInterface,
} from "./cross-file-checks.js";
import type { ProjectGraph } from "./project-graph.js";
import type { RouteMap } from "./route-map.js";
import type { SessionTracker } from "./session-state.js";
import { checkImportCycles } from "./structural-checks/cycles.js";
import { checkDeadExports } from "./structural-checks/dead-exports.js";
import { checkUndefinedEnvVars } from "./structural-checks/env-vars.js";
import {
	checkExportRippleCompilation,
	checkExportSurface,
	checkRippleTests,
} from "./structural-checks/export-surface.js";
import {
	exportSurfaceChanged,
	extractFilePath,
} from "./structural-checks/helpers.js";
import {
	checkCrossPackageImports,
	checkDeadImports,
	checkDuplicateSymbols,
	checkHallucinatedImports,
	checkImportResolution,
} from "./structural-checks/imports.js";
import {
	checkCoDependencyStaleness,
	checkInterfaceChangeImpact,
	checkJSDocParamMismatch,
	checkTestProximity,
} from "./structural-checks/misc-checks.js";
import {
	type PreToolContext,
	preCheckBlastRadius,
	preCheckChangePropagation,
	preCheckCompletionTracking,
	preCheckFollowUpViolation,
	preCheckRecentlyFailed,
	preCheckRedundantReread,
	preCheckRouteContext,
	preCheckSiblingAwareness,
	preCheckStaleRead,
	preCheckTestFirst,
} from "./structural-checks-pre-context.js";
import type {
	ExportedSymbol,
	HarnessEvent,
	SessionTrajectory,
	StructuralCheckResult,
	StructuralChecksConfig,
} from "./types.js";

// Re-export the formatter and helper functions so existing importers (server,
// evaluator) keep working without touching their import statements.
export { formatStructuralWarnings } from "./structural-checks/formatter.js";

// ===========================================
// PostToolUse Structural Checks
// ===========================================

/**
 * Public API — consumed by server.ts.
 *
 * Run all enabled structural checks for a PostToolUse file edit.
 * The ProjectGraph is updated BEFORE this runs (old exports passed in).
 */
export function runStructuralChecks(
	event: HarnessEvent,
	config: StructuralChecksConfig,
	graph: ProjectGraph,
	sessions: SessionTracker,
	oldExports: ExportedSymbol[],
	oldInterfaceBodies: Map<string, string>,
): StructuralCheckResult[] {
	if (!config.enabled) return [];

	const filePath = extractFilePath(event);
	if (!filePath) return [];

	// Only run on TS/JS files
	const ext = extname(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].includes(ext)) {
		return [];
	}

	const results: StructuralCheckResult[] = [];
	const relPath = graph.toRelative(filePath);

	// Skip files outside the project graph root (e.g., editing a file in another repo)
	if (relPath.startsWith("..")) return [];

	// Tier 1: Export surface change detection
	if (config.export_surface) {
		const exportResults = checkExportSurface(filePath, relPath, oldExports, graph);
		results.push(...exportResults);

		// Tier 3: Ripple compilation check — verify affected importers still compile
		// Only triggered when export surface actually changed and there are affected files.
		const affectedFromExportSurface = exportResults.flatMap((r) => r.affectedFiles || []);
		if (affectedFromExportSurface.length > 0) {
			results.push(
				...checkExportRippleCompilation(
					filePath,
					relPath,
					affectedFromExportSurface,
					graph,
				),
			);

			// Also run tests for the edited file if a test file exists
			results.push(...checkRippleTests(filePath, relPath, graph));
		}
	}

	// Tier 1: Import resolution
	if (config.import_resolution) {
		results.push(...checkImportResolution(filePath, relPath, graph));
	}

	// Tier 1: Duplicate symbol detection (boundary-aware)
	if (config.duplicate_symbols) {
		const boundary = graph.getProjectBoundary(filePath);
		results.push(...checkDuplicateSymbols(filePath, relPath, oldExports, graph, boundary));
	}

	// Tier 1: Co-dependency staleness
	if (config.co_dependency_staleness) {
		results.push(
			...checkCoDependencyStaleness(
				filePath,
				relPath,
				event,
				graph,
				sessions,
				config.staleness_window_s,
			),
		);
	}

	// Tier 1: Dead import detection
	if (config.dead_imports) {
		results.push(...checkDeadImports(filePath, relPath));
	}

	// Tier 2: Import cycle detection
	if (config.import_cycles) {
		results.push(...checkImportCycles(filePath, relPath, graph));
	}

	// Tier 2: Interface change impact
	if (config.interface_change_impact) {
		results.push(...checkInterfaceChangeImpact(filePath, relPath, oldInterfaceBodies, graph));
	}

	// Tier 2: Test proximity
	if (config.test_proximity) {
		results.push(...checkTestProximity(filePath, relPath, event, sessions));
	}

	// Tier 1: Dead exports
	if (config.dead_exports) {
		results.push(...checkDeadExports(filePath, relPath, graph));
	}

	// Tier 1: Hallucinated imports
	if (config.hallucinated_imports) {
		results.push(...checkHallucinatedImports(filePath, relPath, graph));
	}

	// Tier 1: Cross-package imports
	if (config.cross_package_imports) {
		results.push(...checkCrossPackageImports(filePath, relPath, graph));
	}

	// Tier 1: Undefined env vars
	if (config.undefined_env_vars) {
		results.push(...checkUndefinedEnvVars(filePath, relPath, event));
	}

	// D1: JSDoc parameter mismatch
	results.push(...checkJSDocParamMismatch(filePath, relPath));

	// Cross-file taste checks
	if (config.cross_file_switch_discriminant !== false) {
		results.push(...checkCrossFileSwitchDiscriminant(filePath, relPath, graph));
	}
	if (config.single_implementation_interface !== false) {
		results.push(...checkSingleImplementationInterface(filePath, relPath, graph));
	}

	return results;
}

/**
 * Public API — consumed by server.ts.
 *
 * Determine if a full tsc run should be skipped (smart_tsc optimization).
 * Returns true if the edit only changed internal logic (no export surface change),
 * meaning it cannot break any other file in the project.
 */
export function shouldSkipTsc(
	config: StructuralChecksConfig,
	oldExports: ExportedSymbol[],
	newExports: ExportedSymbol[],
): boolean {
	if (!config.smart_tsc) return false;

	// If no exports changed, internal-only edit — skip tsc
	return !exportSurfaceChanged(oldExports, newExports);
}

// ===========================================
// PreToolUse Context Injection
// ===========================================

/**
 * Public API — consumed by server.ts / evaluator.
 *
 * Generate context-injection warnings for PreToolUse events.
 * These provide agents with relevant dependency information BEFORE they act.
 */
export function getPreToolUseContext(
	event: HarnessEvent,
	config: StructuralChecksConfig,
	graph: ProjectGraph,
	sessions: SessionTracker,
	session?: SessionTrajectory,
	routeMap?: RouteMap,
): string[] {
	if (!config.enabled || !graph.isInitialized) return [];

	const toolName = event.tool_name || "";
	const filePath = extractFilePath(event);
	if (!filePath) return [];

	const ext = extname(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].includes(ext)) {
		return [];
	}

	const relPath = graph.toRelative(filePath);

	// Skip files outside the project graph root (e.g., editing a file in another repo)
	if (relPath.startsWith("..")) return [];

	// Shared, pre-resolved inputs every block helper reads. Each helper below is a
	// single-responsibility extraction of one former inline block — same gate,
	// same wording, same order — so the public behavior is byte-identical to the
	// pre-decomposition function while this orchestrator stays a thin sequence.
	const ctx: PreToolContext = { event, config, graph, sessions, toolName, filePath, relPath, ext };

	return [
		...preCheckRecentlyFailed(ctx, session),
		...preCheckTestFirst(ctx, session),
		...preCheckBlastRadius(ctx),
		...preCheckStaleRead(ctx),
		...preCheckRedundantReread(ctx, session),
		...preCheckRouteContext(ctx, routeMap),
		...preCheckSiblingAwareness(ctx),
		...preCheckCompletionTracking(ctx, session),
		...preCheckFollowUpViolation(ctx, session),
		...preCheckChangePropagation(ctx),
	];
}
