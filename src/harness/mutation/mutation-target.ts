// ==========================================================
// Mutation target eligibility — one local/cloud truth boundary
// ==========================================================

import { isTestPath } from "../coverage-test-selector.js";
import { isRepoScratchPath } from "../large-file-policy.js";

export const MUTATION_CODE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

/** Product code whose behavior mutation tests may measure. */
export function isMutationTarget(path: string): boolean {
	if (!MUTATION_CODE_EXT.test(path)) return false;
	if (isTestPath(path)) return false;
	return !isRepoScratchPath(path.replace(/\\/g, "/"), undefined);
}

/** Until protocol-v3 gains an authenticated required-target aggregate, one
 * request may certify at most one eligible source file. */
export function multiSourceNotMeasuredReason(paths: readonly string[]): string | null {
	const eligible = paths.filter((path) => isMutationTarget(path));
	if (eligible.length <= 1) return null;
	return (
		`this change set touches ${eligible.length} eligible source files — ` +
		"measuring one while skipping the rest would imply the whole set passed; " +
		"split the edit or wait for per-file aggregation (MUT-AC-26)"
	);
}
