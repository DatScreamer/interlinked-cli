// interlinked-tdd: exempt
// ===========================================
// Check Engine — result deduplication helpers
// ===========================================
// Extracted from check-engine/index.ts (leaf cluster, no module-private
// state). Two results are duplicates if they point to the same file+line
// and say essentially the same thing after normalization.

import type { CheckResult } from "./types.js";

/**
 * Normalize a diagnostic message for dedup comparison.
 * Strips tool-specific prefixes, rule IDs, and whitespace variations
 * so that "unused variable 'x'" from biome and eslint collapse to one.
 */
function normalizeMessage(msg: string): string {
	return msg
		.replace(/^[\w/-]+:\s*/, "") // strip leading rule id like "lint/suspicious/noDoubleEquals: "
		.replace(/\s+/g, " ") // collapse whitespace
		.trim()
		.toLowerCase();
}

/**
 * Build a dedup key from a check result.
 * Two results are duplicates if they point to the same file+line and say
 * essentially the same thing (after normalization).
 */
function dedupKey(r: CheckResult): string {
	return `${r.file}:${r.line}:${normalizeMessage(r.message)}`;
}

/** Result of deduplicating check findings. */
export interface DeduplicationResult {
	deduplicated: CheckResult[];
	removedCount: number;
}

/**
 * Remove duplicate findings across tools.
 * When duplicates exist, keeps the one from the higher-priority tool
 * (first in TOOL_RUNNERS order) and the higher severity.
 */
export function deduplicateResults(results: CheckResult[]): DeduplicationResult {
	const seen = new Map<string, CheckResult>();
	const severityRank: Record<string, number> = { error: 3, warning: 2, info: 1 };

	for (const r of results) {
		const key = dedupKey(r);
		const existing = seen.get(key);
		if (!existing) {
			seen.set(key, r);
		} else {
			// Keep the higher severity; on tie, keep the first (earlier tool = higher priority)
			if ((severityRank[r.severity] ?? 0) > (severityRank[existing.severity] ?? 0)) {
				seen.set(key, r);
			}
		}
	}

	const deduplicated = [...seen.values()];
	return {
		deduplicated,
		removedCount: results.length - deduplicated.length,
	};
}
