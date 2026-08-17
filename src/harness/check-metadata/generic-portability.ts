// interlinked-tdd: exempt
// Metadata fragment: portability lint wave (Plan 25 lane 6,
// docs/plans/25-refactor-readiness-program.md). Composed into
// GENERIC_CHECK_META in ./generic.ts. Shape/key coverage lives in the shared
// generic-fragments.test.ts (matches the established convention for this
// directory — no per-fragment metadata test file exists elsewhere either).

import type { CheckMeta } from "./types.js";

export const GENERIC_PORTABILITY_META: Record<string, CheckMeta> = {
	dynamic_code_execution: {
		name: "Dynamic Code Execution",
		description:
			"Detects eval(, new Function(, require(<non-literal>), and import(<non-literal>) — constructs where the executed code is not visible in the source text",
		tier: 1,
		determinism: "heuristic",
	},
	builtin_prototype_mutation: {
		name: "Builtin Prototype Mutation",
		description:
			"Detects monkey-patching of a built-in's prototype or reassignment of a global builtin (Array =, JSON =, ...)",
		tier: 1,
		determinism: "heuristic",
	},
	float_equality_comparison: {
		name: "Float Equality Comparison",
		description:
			"Detects === / !== where one operand is a float literal (contains a dot)",
		tier: 1,
		determinism: "heuristic",
	},
};
