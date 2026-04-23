// ===========================================
// Project-Wide Checks — cross-file sweep
// ===========================================
// Runs tsc/biome in project mode to catch cross-file issues that
// per-file PostToolUse checks miss: type errors in callers after
// signature changes, biome cross-file lint rules, etc.

import { getOrCreateEngine } from "../check-engine/index.js";
import type { CheckResult, ToolId } from "../check-engine/types.js";
import type { ProjectWideCheckConfig } from "../types.js";

interface QualityCheckResult {
	name: string;
	severity: "error" | "warning";
	message: string;
	file?: string;
	detail?: string;
}

/**
 * Public API — consumed by quality-checks.runProjectWideChecks and server.ts.
 *
 * Tracks per-session state for debounced project-wide sweeps.
 */
export class ProjectWideSweepState {
	/** Number of file edits since last project-wide sweep. */
	editsSinceLastSweep = 0;
	/** Files already checked per-file in PostToolUse (dedup against project-wide). */
	readonly checkedFiles = new Set<string>();
	/** Dedup key set: "tool:file:line:msg" strings already reported this session. */
	readonly reportedFindings = new Set<string>();

	/** Record a file edit, returns true if a sweep should fire based on interval. */
	recordEdit(config: ProjectWideCheckConfig): boolean {
		this.editsSinceLastSweep++;
		return this.editsSinceLastSweep >= config.edit_interval;
	}

	/** Mark a file as already checked by per-file PostToolUse. */
	recordFileChecked(filePath: string): void {
		this.checkedFiles.add(filePath);
	}

	/** Reset counter after a sweep completes. */
	resetCounter(): void {
		this.editsSinceLastSweep = 0;
	}

	/** Build a dedup key for a finding. */
	static findingKey(tool: ToolId, r: CheckResult): string {
		return `${tool}:${r.file}:${r.line}:${r.message.slice(0, 80)}`;
	}
}

/** Public API — consumed by server.ts. Result from a project-wide sweep. */
export interface ProjectWideSweepResult {
	findings: QualityCheckResult[];
	toolsRun: ToolId[];
	elapsedMs: number;
}

/**
 * Public API — consumed by server.ts.
 *
 * Run project-wide checks (tsc, biome, etc.) in project mode.
 * Deduplicates against findings already reported by per-file checks.
 */
export function runProjectWideChecks(
	config: ProjectWideCheckConfig,
	sweepState: ProjectWideSweepState,
	cwd: string,
): ProjectWideSweepResult {
	const start = Date.now();
	const engine = getOrCreateEngine(cwd);
	const toolsRun: ToolId[] = [];
	const findings: QualityCheckResult[] = [];

	const report = engine.runChecks(
		{ projectRoot: cwd, mode: "project" },
		{ tools: config.tools, timeoutMs: config.timeout_ms },
	);

	for (const tool of report.toolsRun) {
		toolsRun.push(tool.id);
	}

	// Convert engine results to QualityCheckResult, deduplicating against
	// findings already reported by per-file PostToolUse checks.
	for (const r of report.results) {
		const key = ProjectWideSweepState.findingKey(r.tool, r);
		if (sweepState.reportedFindings.has(key)) continue;
		sweepState.reportedFindings.add(key);

		findings.push({
			name: `${r.tool}_project_wide`,
			severity: config.severity,
			message: `[cross-file] ${r.file}(${r.line}): ${r.message}`,
			file: r.file,
		});

		if (findings.length >= config.max_findings) break;
	}

	sweepState.resetCounter();

	return {
		findings,
		toolsRun,
		elapsedMs: Date.now() - start,
	};
}
