// ===========================================
// Path-glob skip helper
// ===========================================
// Wraps `matchesAnyGlob` with a `GuardRulesConfig`-shaped lookup so the
// PostToolUse pipeline can short-circuit on excluded paths (build artifacts,
// vendored deps, generated code). Phase B.2 of the Free CLI Phase-2 roadmap.

import { matchesAnyGlob } from "../lib/path-glob.js";
import type { CheckReport } from "./check-engine/types.js";
import type { GuardRulesConfig } from "./types.js";

/**
 * Return true when `filePath` matches any glob in `config.skip_paths`. An
 * undefined / empty list always returns false so callers don't accidentally
 * skip everything when configuration is missing.
 */
export function shouldSkipPath(filePath: string, config: GuardRulesConfig): boolean {
	if (!filePath) return false;
	const skipPaths = config.skip_paths;
	if (!skipPaths || skipPaths.length === 0) return false;
	return matchesAnyGlob(filePath, skipPaths);
}

/**
 * Build the empty CheckReport that runChecksAsync returns when a path is
 * excluded by `skip_paths`. Single skip entry with category `config_disabled`
 * so latency telemetry and `verify --json` consumers can see why nothing ran.
 */
export function buildSkipReport(): CheckReport {
	return {
		results: [],
		toolsRun: [],
		toolsSkipped: [],
		skipped: [
			{
				check: "*",
				reason: "skip_paths matched",
				category: "config_disabled",
			},
		],
		elapsedMs: 0,
		metrics: [],
		deduplicatedCount: 0,
	};
}
