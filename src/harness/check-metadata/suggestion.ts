// Metadata for scored suggestion checks (PostToolUse, regex heuristics in server.ts).
// All suggestions are heuristic — they're scored and ranked, never blocking.

import type { CheckMeta } from "./types.js";

/** Public API — consumed by doc generation and re-exported from check-metadata.ts. */
export const SUGGESTION_CHECK_META: Record<string, CheckMeta> = {
	"sql-injection": {
		name: "SQL Injection",
		description: "Detects potential SQL injection via string interpolation",
		tier: 2,
		determinism: "heuristic",
	},
	"perf-query-in-loop": {
		name: "Query in Loop",
		description: "Detects database queries inside loops",
		tier: 2,
		determinism: "heuristic",
	},
	"perf-await-in-loop": {
		name: "Await in Loop",
		description: "Detects sequential await calls inside loops",
		tier: 2,
		determinism: "heuristic",
	},
	"silent-catch": {
		name: "Silent Catch",
		description: "Detects empty catch blocks",
		tier: 2,
		determinism: "heuristic",
	},
	"unreachable-code": {
		name: "Unreachable Code",
		description: "Detects code after return/throw/break statements",
		tier: 2,
		determinism: "heuristic",
	},
	"boolean-trap": {
		name: "Boolean Trap",
		description: "Detects boolean parameters that reduce readability",
		tier: 3,
		determinism: "heuristic",
	},
	"function-arity": {
		name: "Function Arity",
		description: "Detects functions with too many parameters",
		tier: 3,
		determinism: "heuristic",
	},
	"narrative-naming": {
		name: "Narrative Naming",
		description: "Detects non-descriptive variable/function names",
		tier: 3,
		determinism: "heuristic",
	},
	"test-description-quality": {
		name: "Test Description Quality",
		description: "Detects low-quality test descriptions",
		tier: 3,
		determinism: "heuristic",
	},
	"catch-and-ignore": {
		name: "Catch and Ignore",
		description: "Detects catch blocks that swallow errors silently",
		tier: 2,
		determinism: "heuristic",
	},
	"god-file": {
		name: "God File",
		description: "Detects files that are too large or have too many responsibilities",
		tier: 3,
		determinism: "heuristic",
	},
	"magic-numbers": {
		name: "Magic Numbers",
		description: "Detects unexplained numeric literals",
		tier: 3,
		determinism: "heuristic",
	},
	"negated-condition-with-else": {
		name: "Negated Condition with Else",
		description: "Detects if(!x) {...} else {...} that should be inverted",
		tier: 3,
		determinism: "heuristic",
	},
	"nested-ternary": {
		name: "Nested Ternary",
		description: "Detects nested ternary expressions in suggestions",
		tier: 3,
		determinism: "heuristic",
	},
	"flag-arguments": {
		name: "Flag Arguments",
		description: "Detects boolean flag parameters that split function behavior",
		tier: 3,
		determinism: "heuristic",
	},
	"commented-out-code": {
		name: "Commented Out Code",
		description: "Detects commented-out code blocks",
		tier: 3,
		determinism: "heuristic",
	},
	"not-implemented-stub": {
		name: "Not Implemented Stub",
		description: "Detects TODO/FIXME stubs and throw new Error('not implemented')",
		tier: 2,
		determinism: "heuristic",
	},
	"empty-function-body": {
		name: "Empty Function Body",
		description: "Detects functions with empty bodies",
		tier: 2,
		determinism: "heuristic",
	},
	"deprecation-notice": {
		name: "Deprecation Notice",
		description: "Detects @deprecated JSDoc tags",
		tier: 2,
		determinism: "heuristic",
	},
	"orphaned-test-stub": {
		name: "Orphaned Test Stub",
		description: "Detects test stubs without assertions",
		tier: 2,
		determinism: "heuristic",
	},
	"deletion-comment": {
		name: "Deletion Comment",
		description: "Detects comments marking code for removal",
		tier: 2,
		determinism: "heuristic",
	},
	"mixed-error-strategy": {
		name: "Mixed Error Strategy",
		description: "Detects mixed error handling patterns in one file",
		tier: 3,
		determinism: "heuristic",
	},
	"bare-catch-block": {
		name: "Bare Catch Block",
		description: "Detects catch blocks with no error handling",
		tier: 2,
		determinism: "heuristic",
	},
	"catch-return-null": {
		name: "Catch Return Null",
		description: "Detects catch blocks that return null/undefined",
		tier: 2,
		determinism: "heuristic",
	},
	"throw-as-control-flow": {
		name: "Throw as Control Flow",
		description: "Detects throwing exceptions for control flow",
		tier: 3,
		determinism: "heuristic",
	},
	"untyped-catch": {
		name: "Untyped Catch",
		description: "Detects catch blocks with untyped error parameter",
		tier: 3,
		determinism: "heuristic",
	},
	"error-string-comparison": {
		name: "Error String Comparison",
		description: "Detects comparing error messages via string matching",
		tier: 3,
		determinism: "heuristic",
	},
	"inconsistent-error-strategy": {
		name: "Inconsistent Error Strategy",
		description: "Detects mixed throw/return-error patterns in one module",
		tier: 3,
		determinism: "heuristic",
	},
	"shotgun-surgery": {
		name: "Shotgun Surgery",
		description: "Detects sessions editing too many files",
		tier: 3,
		determinism: "heuristic",
	},
};
