// interlinked-tdd: exempt
// Metadata fragment: boundary/contract wave (Plan 25 lanes 7-8,
// docs/plans/25-refactor-readiness-program.md). Composed into
// GENERIC_CHECK_META in ./generic.ts. Shape/key coverage lives in the shared
// generic-fragments.test.ts (matches the established convention for this
// directory — no per-fragment metadata test file exists elsewhere either).

import type { CheckMeta } from "./types.js";

export const GENERIC_BOUNDARY_CONTRACTS_META: Record<string, CheckMeta> = {
	test_contract_annotation: {
		name: "Test Contract Annotation",
		description:
			"Adoption-triggered: flags an it()/test() block with no test-contract: comment directly above it, once a mutation-directed test file has systematically adopted the convention",
		tier: 1,
		determinism: "heuristic",
	},
	unvalidated_input_boundary: {
		name: "Unvalidated Input Boundary",
		description:
			"Detects an awaited .json() call with no schema-parse call nearby, and direct process.argv[<n>] indexing outside a bin/cli entry file",
		tier: 1,
		determinism: "heuristic",
	},
};
