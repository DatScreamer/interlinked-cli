// ===========================================
// Agent-safety + taste/structural sections
// ===========================================
// Fragment of the declarative section table in `./section-table.ts`.
// Covers the agent-safety checks (mix of red + yellow), the Mythos Phase 2
// comment-vs-behavior drift detectors, and the taste / structural checks.
// Composed — in order — by `./section-table.ts`.

import { tasteStructuralSections } from "./section-table-agent-safety-taste.js";
import type { SectionSpec } from "./section-table-types.js";

/** Agent-safety, drift, and taste/structural sections. */
export const agentSafetySections: readonly SectionSpec[] = [
	// --- Agent safety checks ---
	{
		label: "misused promises",
		key: "misusedPromises",
		noun: "async callbacks in sync APIs",
		passLabel: "no misused promises",
		color: "31",
	},
	{
		label: "floating promises",
		key: "floatingPromises",
		noun: "unhandled async calls at statement position",
		passLabel: "no floating promises",
		color: "31",
	},
	{
		label: "broad object types",
		key: "broadObjectTypes",
		noun: "Record<K, any> / index-to-any / bare Function / bare object annotations",
		passLabel: "no broad object types",
		color: "31",
	},
	{
		label: "boolean trap",
		key: "booleanTrap",
		noun: "call sites with 2+ boolean literal arguments",
		passLabel: "no boolean traps",
		color: "31",
	},
	{
		label: "positional optional boolean",
		key: "positionalOptionalBoolean",
		noun: "function signatures with a positional optional boolean param",
		passLabel: "no positional optional booleans",
		color: "33",
	},
	{
		label: "many optional params",
		key: "manyOptionalParams",
		noun: "function signatures with 3+ optional params",
		passLabel: "no signatures with 3+ optional params",
		color: "33",
	},
	{
		label: "same-typed primitive params",
		key: "sameTypedPrimitiveParams",
		noun: "public signatures with adjacent same-typed primitive params",
		passLabel: "no orderable-by-mistake param pairs",
		color: "33",
	},
	// Mythos Phase 2 — comment-vs-behavior drift detectors.
	{
		label: "comment claims limit",
		key: "commentClaimsLimitNoGuard",
		noun: 'functions whose comment says "max N" / "limited to N" without a guard',
		passLabel: "no comment-claims-limit drift",
		color: "33",
	},
	{
		label: "comment claims null",
		key: "commentClaimsNullThrowsInstead",
		noun: 'functions whose comment says "returns null" but body throws',
		passLabel: "no comment-claims-null drift",
		color: "33",
	},
	{
		label: "comment claims validation",
		key: "commentClaimsValidationMissing",
		noun: 'functions whose comment says "validates/sanitizes/escapes" without any check',
		passLabel: "no comment-claims-validation drift",
		color: "33",
	},
	{
		label: "comment claims idempotent",
		key: "commentClaimsIdempotentMutates",
		noun: 'functions whose comment says "idempotent" but body mutates unconditionally',
		passLabel: "no comment-claims-idempotent drift",
		color: "33",
	},
	{
		label: "comment claims throws",
		key: "commentClaimsThrowsDoesnt",
		noun: "functions whose @throws {ErrorX} declaration isn't actually thrown",
		passLabel: "no comment-claims-throws drift",
		color: "33",
	},
	...tasteStructuralSections,
];
