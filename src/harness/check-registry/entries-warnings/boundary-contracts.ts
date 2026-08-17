// Boundary/contract wave (Plan 25 lanes 7-8,
// docs/plans/25-refactor-readiness-program.md): two post-phase, advisory
// detectors. test_contract_annotation is adoption-triggered (see
// checks/test-contract-annotation.ts); unvalidated_input_boundary extends
// the boundary-parser family alongside the existing `unvalidated_json_boundary`
// (see checks/unvalidated-input-boundary.ts for exactly how the two differ).

import { detectTestContractAnnotation } from "../../checks/test-contract-annotation.js";
import { detectUnvalidatedInputBoundary } from "../../checks/unvalidated-input-boundary.js";
import type { CheckRegistration } from "../types.js";

export const BOUNDARY_CONTRACT_ENTRIES: CheckRegistration[] = [
	{
		id: "test_contract_annotation",
		phase: "post",
		name: "Test Contract Annotation",
		description:
			"Adoption-triggered: once a mutation-directed test file (*.mutation-kill.*/*.mutation-hardening.*/*.survivor(s).*) has systematically adopted the `test-contract:` comment convention, flags an it()/test() block with no such comment in the contiguous comment block directly above it. Silent for files that never adopted the convention, or only used it as a spot annotation.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Add a `// test-contract: <kind> — <what this case pins>` comment directly above the block, matching the convention this file has already adopted elsewhere (e.g. `// test-contract: boundary — parseWindow rejects the documented zero-width interval`).",
		fn: detectTestContractAnnotation,
		resultsPropName: "testContractAnnotation",
		content_keywords: ["test-contract:"],
	},
	{
		id: "unvalidated_input_boundary",
		phase: "post",
		name: "Unvalidated Input Boundary",
		description:
			"Detects an awaited .json() call with no schema-parse call on the same or adjacent 2 lines, and direct process.argv[<n>] indexing outside a bin/cli entry file. Never fires on JSON.parse( — see unvalidated_json_boundary for that shape.",
		tier: 1,
		determinism: "heuristic",
		severity: "warning",
		pipeline: "agent_safety",
		fix_instruction:
			"Pipe the .json() result through a schema parser before using it (`const parsed = MySchema.parse(await res.json());`), and read positional CLI args only in a recognized entry file (index.ts/cli.ts/bin/) — elsewhere, accept them as explicit function parameters instead of indexing process.argv directly.",
		fn: detectUnvalidatedInputBoundary,
		resultsPropName: "unvalidatedInputBoundary",
		content_keywords: [".json", "process.argv"],
	},
];
