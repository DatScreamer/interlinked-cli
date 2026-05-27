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

import { existsSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import { findPropagationTargets, formatPropagationWarnings } from "./change-propagation.js";
import {
	checkCrossFileSwitchDiscriminant,
	checkSingleImplementationInterface,
} from "./cross-file-checks.js";
import { resolveDependencyView } from "./dependency-view.js";
import { checkFollowUpViolation } from "./impact-analysis.js";
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
	findTestFileForSource,
} from "./structural-checks/export-surface.js";
import {
	exportSurfaceChanged,
	extractFilePath,
	isReadOperation,
	isWriteOperation,
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

	const warnings: string[] = [];
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

	// Recently-failed-here: warn when touching a file with unresolved failures
	if (
		config.recently_failed &&
		session &&
		(isWriteOperation(toolName) || isReadOperation(toolName))
	) {
		const failedEntry = session.failed_files.get(filePath);
		if (failedEntry) {
			const ago = session.tool_call_count - failedEntry.tool_call_count;
			warnings.push(
				`[interlinked:recently-failed] ${relPath} had ${failedEntry.failure_count} check failure(s) (${failedEntry.checks.join(", ")}) ${ago} tool call(s) ago. They may still be unresolved.`,
			);
		}
	}

	// Test-first nudge: before editing a source file, check test status
	if (config.test_first && isWriteOperation(toolName) && session) {
		const isSourceExt = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].includes(
			ext,
		);
		const isTest = /\.(test|spec)\.[^.]+$/.test(filePath) || filePath.includes("__tests__");

		if (isSourceExt && !isTest) {
			const testFile = findTestFileForSource(filePath);
			if (!testFile) {
				warnings.push(
					`[interlinked:test-first] No test file found for ${relPath}. Write tests before modifying the implementation.`,
				);
			} else if (!session.test_runs.has(testFile)) {
				warnings.push(
					`[interlinked:test-first] Tests at ${graph.toRelative(testFile)} haven't been run this session. Run them first to establish a green baseline before editing.`,
				);
			}
		}
	}

	// Blast radius: warn when editing a high-connectivity file (with module role).
	// Dependency facts come through the DependencyView seam: a fresh Supermodel
	// `.graph` shard when present, the internal import graph otherwise. The
	// view is resolved per-file here so getPreToolUseContext's signature is
	// untouched. When `view.source === "internal"` the wording is byte-identical
	// to the pre-seam code; the Supermodel path adds a provenance clause.
	if (config.blast_radius && isWriteOperation(toolName)) {
		const view = resolveDependencyView(filePath, event.cwd ?? process.cwd(), graph);
		const dependents = view.getDependents(filePath);
		if (dependents.length >= config.blast_radius_threshold) {
			const role = view.classifyModule(filePath);
			const roleLabel = role === "hub" ? " (hub module)" : "";
			const depList = dependents
				.slice(0, 5)
				.map((d) => graph.toRelative(d))
				.join(", ");
			const more = dependents.length > 5 ? ` and ${dependents.length - 5} more` : "";
			const provenance =
				view.source === "supermodel"
					? " Changes to exports will have wide impact (per Supermodel `.graph` shard)."
					: " Changes to exports will have wide impact.";
			warnings.push(
				`[interlinked:blast-radius] ${relPath}${roleLabel} is imported by ${dependents.length} files (${depList}${more}).${provenance}`,
			);
		}
	}

	// Stale read warning: warn when reading a file recently modified by another agent
	if (config.stale_read_warning && isReadOperation(toolName)) {
		const agentName = event.agent_name || "";
		const stalenessMs = config.staleness_window_s * 1000;
		const now = Date.now();

		for (const sess of sessions.getAll()) {
			if (sess.agent_name === agentName) continue;
			const writeTime = sess.file_write_times.get(filePath);
			if (writeTime && now - new Date(writeTime).getTime() < stalenessMs) {
				const ago = Math.round((now - new Date(writeTime).getTime()) / 1000);
				warnings.push(
					`[interlinked:stale-read] ${relPath} was modified by ${sess.agent_name} ${ago}s ago. Contents may differ from what you previously read.`,
				);
				break; // One warning is enough
			}
		}
	}

	// Redundant re-read: warn when reading a file already read and not modified since
	if (config.redundant_reread && isReadOperation(toolName) && session) {
		const lastReadAt = session.file_read_at.get(filePath);
		if (lastReadAt !== undefined) {
			const toolCallsAgo = session.tool_call_count - lastReadAt;
			// Check if any session has written this file since the last read
			let modifiedSince = false;
			if (session.files_written.has(filePath)) {
				modifiedSince = true;
			}
			if (!modifiedSince) {
				for (const sess of sessions.getAll()) {
					if (sess === session) continue;
					if (sess.file_write_times.has(filePath)) {
						modifiedSince = true;
						break;
					}
				}
			}
			if (!modifiedSince && toolCallsAgo > 0) {
				warnings.push(
					`[interlinked:redundant-reread] You read ${relPath} ${toolCallsAgo} tool call(s) ago and it hasn't changed. Consider using the content from your earlier read.`,
				);
			}
		}
	}

	// Route context: inject handler/route info when editing API files.
	// Migrated to the Phase A3 Endpoint shape: we read the richer record
	// (auth_chain, declared_params, handler_symbol) and project to the
	// same human-readable string the V0 getRouteContext returned. The
	// return type stays `string | null` for back-compat with the
	// structural-checks formatter.
	if (
		config.route_context &&
		routeMap &&
		(isWriteOperation(toolName) || isReadOperation(toolName))
	) {
		const endpoints = routeMap.extractEndpointsForFile(filePath);
		if (endpoints.length > 0) {
			const MCP_TOOL_METHOD = "TOOL";
			const ANY_METHOD = "ALL";
			const descriptions = endpoints.map((e) => {
				if (e.method === MCP_TOOL_METHOD) return `${MCP_TOOL_METHOD} ${e.path}`;
				if (e.method === ANY_METHOD) return e.path;
				return `${e.method} ${e.path}`;
			});
			const unique = [...new Set(descriptions)];
			const summary = `This file handles: ${unique.join(", ")}. Changes may affect API consumers.`;
			warnings.push(`[interlinked:route-context] ${summary}`);
		}
	}

	// Sibling awareness: list existing files when creating a new file
	if (config.sibling_awareness && isWriteOperation(toolName) && !existsSync(filePath)) {
		const siblings = graph.getSiblingFiles(filePath);
		if (siblings.length > 0) {
			const dir = graph.toRelative(dirname(filePath));
			const names = siblings
				.slice(0, 8)
				.map((s) => basename(s))
				.join(", ");
			const more = siblings.length > 8 ? ` and ${siblings.length - 8} more` : "";
			warnings.push(
				`[interlinked:sibling-awareness] Directory ${dir}/ already contains: ${names}${more}. Consider whether this new file duplicates existing functionality.`,
			);
		}
	}

	// Completion tracking: remind about pending follow-through
	if (config.completion_tracking && session) {
		for (const [_sourceFile, completion] of session.pending_completions) {
			const remaining = completion.affected_files.filter(
				(f) => !completion.resolved_files.has(f),
			);
			if (remaining.length === 0) continue;
			const toolCallsSince = session.tool_call_count - completion.recorded_at_tool_call;
			if (toolCallsSince >= config.completion_reminder_threshold) {
				const fileList = remaining
					.slice(0, 4)
					.map((f) => graph.toRelative(f))
					.join(", ");
				const more = remaining.length > 4 ? ` and ${remaining.length - 4} more` : "";
				warnings.push(
					`[interlinked:completion-tracking] ${completion.description} (${toolCallsSince} tool calls ago). Still needs updating: ${fileList}${more}`,
				);
			}
		}
	}

	// Follow-up violation: warn if editing an unrelated file while export follow-ups remain
	if (config.impact_analysis && isWriteOperation(toolName) && filePath && session) {
		const violation = checkFollowUpViolation(filePath, session);
		if (violation) {
			warnings.push(`[interlinked:follow-up-required] ${violation}`);
		}
	}

	// Change propagation: when editing a file, remind about docs/schemas/tests/configs
	if (isWriteOperation(toolName) && filePath) {
		const cwd = event.cwd || process.cwd();
		const propagationTargets = findPropagationTargets(filePath, cwd);
		const propagationWarnings = formatPropagationWarnings(propagationTargets, cwd);
		warnings.push(...propagationWarnings);
	}

	return warnings;
}
