// ===========================================
// Ratchet Metrics — countable quality metrics that must not regress
// ===========================================
// Extracted from quality-checks.ts. Each helper counts occurrences of a
// specific pattern (suppression directives, `as any` casts, non-null
// assertions) in a file's text. The quality-checks runner compares pre-edit
// and post-edit counts and flags any increase as a ratchet violation.

import { stripAllLiterals } from "../strip-helpers.js";

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

// ===========================================
// Type-density ratchet — composite metric over six type-erasure shapes.
// ===========================================
// One ratchet, six counters. The post-edit ratchet check fires once if any
// counter increases; the message lists which dimension regressed and by how
// much. Mirrors the existing as-any / non-null / suppression pattern but
// rolls up six related metrics so the agent gets a single actionable line
// instead of six warnings ("noise floor" matters more than "granularity").
//
// All counters strip strings/comments via stripAllLiterals before matching
// so prose like `// this uses : any` doesn't show up as a regression.

const ANY_ANNOTATION_PATTERN = /:\s*any\b/g;
const UNKNOWN_ANNOTATION_PATTERN = /:\s*unknown\b/g;
const FUNCTION_TYPE_PATTERN = /:\s*Function\b/g;
const EMPTY_OBJECT_TYPE_PATTERN = /:\s*\{\s*\}/g;

/** Match an exported function declaration: `export function name(params): returnType`.
 *  Captures the parameter list and the optional return-type annotation. We
 *  intentionally don't try to handle every TS syntax (arrow exports, class
 *  methods, overloads) — the metric is a ratchet, not a lint. The cases we
 *  miss are uniformly missed on both sides of the diff, so the delta is
 *  still correct. */
const EXPORTED_FUNCTION_PATTERN =
	/\bexport\s+(?:async\s+)?function\s+\w+\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(:\s*[^{;]+)?/g;

export interface TypeDensityCounts {
	anyAnnotations: number;
	unknownAnnotations: number;
	functionType: number;
	emptyObjectType: number;
	untypedExportedParams: number;
	missingExportedReturnType: number;
}

/** Public API — ratchet baseline for the composite type-density metric.
 *  Consumed by `server.ts` (baseline capture) and `quality-checks.ts`
 *  (post-edit comparison).
 *
 *  Strings and comments are stripped before counting so embedded mentions
 *  in messages / docs don't poison the metric. */
export function countTypeDensity(content: string): TypeDensityCounts {
	const stripped = stripAllLiterals(content);
	return {
		anyAnnotations: countMatches(stripped, ANY_ANNOTATION_PATTERN),
		unknownAnnotations: countMatches(stripped, UNKNOWN_ANNOTATION_PATTERN),
		functionType: countMatches(stripped, FUNCTION_TYPE_PATTERN),
		emptyObjectType: countMatches(stripped, EMPTY_OBJECT_TYPE_PATTERN),
		...countExportShape(stripped),
	};
}

function countMatches(content: string, pattern: RegExp): number {
	pattern.lastIndex = 0;
	return (content.match(pattern) || []).length;
}

function countExportShape(stripped: string): {
	untypedExportedParams: number;
	missingExportedReturnType: number;
} {
	let untyped = 0;
	let missingReturn = 0;
	EXPORTED_FUNCTION_PATTERN.lastIndex = 0;
	let m: RegExpExecArray | null = EXPORTED_FUNCTION_PATTERN.exec(stripped);
	while (m !== null) {
		const paramList = m[1] ?? "";
		const returnAnnotation = m[2];
		untyped += countUntypedParams(paramList);
		if (!returnAnnotation || returnAnnotation.trim() === "") missingReturn++;
		m = EXPORTED_FUNCTION_PATTERN.exec(stripped);
	}
	return { untypedExportedParams: untyped, missingExportedReturnType: missingReturn };
}

/** Count parameters in a comma-separated TS parameter list that lack a
 *  type annotation. Handles default values (`x = 1`), rest params (`...rest`),
 *  destructuring patterns (`{ a, b }: Foo` is typed; bare `{ a, b }` is not). */
function countUntypedParams(paramList: string): number {
	const trimmed = paramList.trim();
	if (trimmed === "") return 0;
	let depth = 0;
	let untyped = 0;
	let buf = "";
	for (let i = 0; i <= trimmed.length; i++) {
		const ch = trimmed[i];
		const isEnd = i === trimmed.length;
		if (!isEnd && (ch === "<" || ch === "(" || ch === "{" || ch === "[")) depth++;
		else if (!isEnd && (ch === ">" || ch === ")" || ch === "}" || ch === "]")) depth--;
		if ((ch === "," && depth === 0) || isEnd) {
			const param = buf.trim();
			buf = "";
			if (param === "") continue;
			if (!param.includes(":")) untyped++;
		} else {
			buf += ch;
		}
	}
	return untyped;
}
