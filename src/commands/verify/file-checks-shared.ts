// ===========================================
// Per-file check battery — shared primitives
// ===========================================
// Holds the primitives needed by BOTH the orchestrator (`file-checks.ts`) and
// every per-group helper (`file-checks-<group>.ts`): the `toIssues` value
// converter, the `PiiOpts` alias, and the `FileCheckContext` interface. Kept in
// a sibling module that depends on NOTHING else in this family so the group
// files can import them directly without a runtime require cycle back through
// `file-checks.ts` — mirrors `harness/checks/test-hygiene-shared.ts`.

import type { CodeQualityIssue, CodeQualityResults } from "./tool-results-types.js";

/**
 * Public API — consumed by `file-checks.ts` and the `file-checks-<group>.ts`
 * helpers.
 *
 * Convert `InlineMatch[]` from generic-checks into `CodeQualityIssue[]`.
 */
export function toIssues(
	check: string,
	file: string,
	matches: Array<{ line: number; text: string }>,
): CodeQualityIssue[] {
	return matches.map((m) => ({ check, file, line: m.line, message: m.text }));
}

/** Public API — consumed by `file-checks.ts` and the `file-checks-<group>.ts` helpers. */
export type PiiOpts = Parameters<typeof import("../../harness/generic-checks.js").checkPiiInSource>[2];

/**
 * Public API — shared context threaded through every per-group helper. Bundles
 * the per-file locals the stateless detectors need (resolved path, content,
 * cwd for cross-file checks, the result accumulator, PII options).
 */
export interface FileCheckContext {
	file: string;
	content: string;
	relPath: string;
	cwd: string;
	r: CodeQualityResults;
	piiOpts: PiiOpts;
}
