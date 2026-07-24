// Metadata fragment: complexity + API-signature-shape + comment-claim checks.
// Composed into GENERIC_CHECK_META in ./generic.ts. Keys must match the
// `name` fields in quality-checks.ts agentSafetyChecks array.

import type { CheckMeta } from "./types.js";

export const GENERIC_API_SHAPE_META: Record<string, CheckMeta> = {
	// Heuristic — regex-based analysis, not tool-backed
	complexity: {
		name: "Function Complexity",
		description: "Flags functions with high branch count, deep nesting, or many parameters",
		tier: 2,
		determinism: "heuristic",
	},
	cognitive_complexity: {
		name: "Cognitive Complexity",
		description:
			"Per-function cognitive complexity (SonarSource model: nesting penalized, flat switch nearly free, boolean-run transitions +1) over the Sonar-default cap of 15; AST-computed, advisory-gated",
		tier: 2,
		determinism: "heuristic",
	},
	boolean_trap: {
		name: "Boolean Trap",
		description:
			"Detects call sites with 2+ boolean literal arguments — intent is opaque to a reader without jumping to the definition",
		tier: 2,
		determinism: "heuristic",
	},
	positional_optional_boolean: {
		name: "Positional Optional Boolean",
		description:
			"Signature-side twin of boolean_trap — flags function declarations with a positional optional boolean (`flag?: boolean`, `flag: boolean = false`, `flag = false`). Every call site is unreadable; move the bool into an options object or a string-literal union.",
		tier: 2,
		determinism: "heuristic",
	},
	many_optional_params: {
		name: "Many Optional Params",
		description:
			"Detects signatures with 3+ optional parameters (`?:` markers + `=` defaults). Each optional doubles call-shape surface and a default change is a silent semantic API break. Move them into an options object.",
		tier: 2,
		determinism: "heuristic",
	},
	same_typed_primitive_params: {
		name: "Same-Typed Primitive Params",
		description:
			"Detects exported / public-method signatures with two consecutive primitive parameters of the same surface type (string, number, boolean) — orderable-by-mistake at the call site",
		tier: 2,
		determinism: "heuristic",
	},
	comment_claims_limit_no_guard: {
		name: "Comment Claims Limit With No Guard",
		description:
			"Detects functions whose comment says `max N` / `at most N` / `limited to N` but whose body has no `< N` / `<= N` guard.",
		tier: 2,
		determinism: "partially_deterministic",
	},
	comment_claims_null_throws_instead: {
		name: "Comment Claims Null But Body Throws",
		description:
			"Detects functions whose comment says `returns null on failure` / `may return undefined` but whose body contains an unhandled `throw`.",
		tier: 2,
		determinism: "partially_deterministic",
	},
	comment_claims_validation_missing: {
		name: "Comment Claims Validation But No Check",
		description:
			"Detects functions whose comment says `validates X` / `sanitizes Y` / `escapes Z` but whose body has no conditional/regex/encode call.",
		tier: 2,
		determinism: "partially_deterministic",
	},
	comment_claims_idempotent_mutates: {
		name: "Comment Claims Idempotent But Mutates",
		description:
			"Detects functions whose comment says `idempotent` but whose body contains an unconditional mutation with no guard.",
		tier: 2,
		determinism: "partially_deterministic",
	},
	comment_claims_throws_doesnt: {
		name: "Declared @throws Never Thrown",
		description:
			"Detects JSDoc `@throws {ErrorX}` declarations where the body never throws that error class.",
		tier: 2,
		determinism: "partially_deterministic",
	},
};
