// ===========================================
// Ratchet Metrics — countable quality metrics that must not regress
// ===========================================
// Extracted from quality-checks.ts. Each helper counts occurrences of a
// specific pattern (suppression directives, `as any` casts, non-null
// assertions) in a file's text. The quality-checks runner compares pre-edit
// and post-edit counts and flags any increase as a ratchet violation.

const SUPPRESSION_PATTERN = /@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable|biome-ignore/g;
const AS_ANY_PATTERN = /\bas\s+any\b/g;
// Non-null assertion: identifier followed by `!` then `.`, `[`, `(`, or `)` —
// the positions that distinguish a type assertion from boolean negation /
// `!=` / `!==`. `(` catches `foo!()` (call after assertion); `)` catches
// `bar(foo!)` (assertion on the last argument).
const NON_NULL_ASSERTION_PATTERN = /\w!\s*[.[()]/g;

/**
 * Public API — consumed by quality-checks.runQualityChecks and verify.ts.
 *
 * Count suppression directives in file content (@ts-expect-error, @ts-expect-error,
 * @ts-nocheck, eslint-disable, biome-ignore).
 */
export function countSuppressionDirectives(content: string): number {
	return (content.match(SUPPRESSION_PATTERN) || []).length;
}

/**
 * Public API — consumed by quality-checks.runQualityChecks and verify.ts.
 *
 * Count `as any` casts in file content.
 */
export function countAsAnyCasts(content: string): number {
	return (content.match(AS_ANY_PATTERN) || []).length;
}

/**
 * Public API — consumed by quality-checks.runQualityChecks and verify.ts.
 *
 * Count non-null assertions (`foo!.bar` / `foo![x]` / `foo!()`) in file
 * content. Used by the ratchet to block edits that add more non-null
 * assertions to a file than were present before.
 */
export function countNonNullAssertions(content: string): number {
	return (content.match(NON_NULL_ASSERTION_PATTERN) || []).length;
}
