// ===========================================
// Harness Server — Deletion Hygiene (Diff-Aware)
// ===========================================
// Layer-2 deletion hygiene checks that compare `old_string` vs `new_string`
// to catch agents hedging (replacing real implementations with stubs,
// gutting test assertions, hiding behind deprecation comments, etc.).
//
// Extracted from server.ts to keep the PostToolUse pipeline compact.

import {
	checkDeletionCommentAdded,
	checkDeprecationAdded,
	checkReplacedWithStub,
	checkTestGutted,
} from "../deletion-hygiene.js";
import type { Finding } from "../suggestion-scorer.js";

/** Bundle of the three primitive inputs the diff-aware checks need.
 *  Passing as an object avoids argument-order mixups between the two
 *  string fields. */
export interface DeletionHygieneDiffInput {
	oldString: string | undefined;
	newString: string | undefined;
	filePath: string;
}

/**
 * Public API — consumed by the harness PostToolUse pipeline in
 * `server.ts`. Runs the four diff-aware deletion hygiene checks and
 * returns any findings. Caller merges them into `allFindings` for
 * scoring.
 *
 * Returns an empty array if `oldString` or `newString` is missing —
 * the checks only make sense when both sides of an Edit are available.
 */
export function collectDeletionHygieneDiffFindings(input: DeletionHygieneDiffInput): Finding[] {
	const { oldString, newString, filePath } = input;
	if (!oldString || !newString) return [];
	return [
		...checkReplacedWithStub(oldString, newString, filePath),
		...checkTestGutted(oldString, newString, filePath),
		...checkDeprecationAdded(oldString, newString, filePath),
		...checkDeletionCommentAdded(oldString, newString, filePath),
	];
}
