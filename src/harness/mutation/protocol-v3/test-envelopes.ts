// interlinked-tdd: exempt — deterministic test-support builders with no
// branching; exercised directly by parse.test.ts / evidence.test.ts /
// acceptance.test.ts / verify.test.ts, which pin every behavior reachable
// through them.
// ===========================================
// Protocol v3 — canonical valid envelopes (test/fixture builders)
// ===========================================
// One valid baseline per certifying kind; negative cases perturb exactly
// one field so each rejection reason is attributable.

import { createHash } from "node:crypto";
import { derivePortableIdentities } from "../identity.js";
import type { RawMutant } from "../types.js";
import type { V3ExcludedRow, V3MutantRow, V3MutationResult, V3NotMutatable } from "./types.js";
import { IDENTITY_ALGORITHM, PROTOCOL_V3_VERSION } from "./types.js";

export const MUTATION_RESULT_TARGET_CONTENT = [
	"export function example(x: number): string {",
	'\tconst adjusted = x + 1;',
	'\treturn adjusted > 0 ? "x" : "";',
	"}",
	"",
].join("\n");

export const NOT_MUTATABLE_TARGET_CONTENT = [
	'export const VERSION = "1.0.0";',
	"",
].join("\n");

function targetHash(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function identityRows(): { mutants: V3MutantRow[]; excluded: V3ExcludedRow[] } {
	const file = "src/lib/example.ts";
	const raws: RawMutant[] = [
		{
			file,
			mutator: "EqualityOperator",
			originalLexeme: ">",
			replacement: ">=",
			startOffset: MUTATION_RESULT_TARGET_CONTENT.indexOf("> 0"),
		},
		{
			file,
			mutator: "ArithmeticOperator",
			originalLexeme: "+",
			replacement: "-",
			startOffset: MUTATION_RESULT_TARGET_CONTENT.indexOf("+ 1"),
		},
		{
			file,
			mutator: "StringLiteral",
			originalLexeme: '"x"',
			replacement: '""',
			startOffset: MUTATION_RESULT_TARGET_CONTENT.indexOf('"x"'),
		},
	];
	const identities = derivePortableIdentities(file, MUTATION_RESULT_TARGET_CONTENT, raws);
	if (identities === null) throw new Error("typescript unavailable in protocol fixture builder");
	const provenance = identities.map((identity, index) => {
		const raw = raws[index];
		if (raw === undefined) throw new Error("fixture raw mutant missing");
		return {
			mutant_id: identity.mutantId,
			site_id: identity.siteId,
			symbol_id: identity.symbolId,
			qualified_name: identity.qualifiedName,
			symbol_context: identity.symbolContext,
			mutator: raw.mutator,
			original_lexeme: raw.originalLexeme,
			replacement: raw.replacement,
			start_offset: raw.startOffset,
			ordinal_within_symbol: identity.ordinalWithinSymbol,
		};
	});
	const first = provenance[0];
	const second = provenance[1];
	const excluded = provenance[2];
	if (first === undefined || second === undefined || excluded === undefined) {
		throw new Error("fixture portable identity missing");
	}
	return {
		mutants: [
			{ ...first, status: "killed" },
			{ ...second, status: "killed" },
		],
		excluded: [{ ...excluded, policy_id: "policy-string-literal-noise" }],
	};
}

export function validMutationResult(): V3MutationResult {
	const identities = identityRows();
	return {
		protocol_version: PROTOCOL_V3_VERSION,
		kind: "mutation_result",
		job: {
			tenant: "t_dev",
			project: "p_cli",
			repository: "github.com/QuentinCody/interlinked-cli",
			commit: "0123456789abcdef0123456789abcdef01234567",
			target_file: "src/lib/example.ts",
			target_content_hash: targetHash(MUTATION_RESULT_TARGET_CONTENT),
			job_key: "job_0001",
		},
		acceptance_receipt_hash: "b".repeat(64),
		execution_receipt_hash: "c".repeat(64),
		attempt_id: "attempt_0001",
		result_hash: "d".repeat(64),
		signature: { key_id: "k1", value: "e".repeat(96) },
		seq: 7,
		occurred_at: "2026-08-31T12:00:00.000Z",
		scope: {
			mode: "import_graph",
			test_files: ["src/lib/example.test.ts"],
			incremental: false,
			mutation_scope: "whole_file",
		},
		engine: { name: "stryker", version: "8.2.0", config_hash: "f".repeat(64), exit_code: 0 },
		runner: { build: "runner-build-2026-08-31", image_digest: `sha256:${"0".repeat(64)}` },
		census: { generated: 3, executable: 2, approved_excluded: 1 },
		excluded: identities.excluded,
		mutants: identities.mutants,
		identity_algorithm: IDENTITY_ALGORITHM,
		test_run: {
			executed_test_count: 12,
			overlay_green: true,
			red_witness_satisfied: null,
			command_hash: "5".repeat(64),
			runner_name: "vitest",
			runner_version: "3.2.0",
		},
		report: { r2_sha256: "7".repeat(64), bytes: 20480, content_hash: "8".repeat(64) },
	};
}

export function validNotMutatable(): V3NotMutatable {
	return {
		protocol_version: PROTOCOL_V3_VERSION,
		kind: "not_mutatable",
		job: {
			tenant: "t_dev",
			project: "p_cli",
			repository: "github.com/QuentinCody/interlinked-cli",
			commit: "0123456789abcdef0123456789abcdef01234567",
			target_file: "src/lib/constants.ts",
			target_content_hash: targetHash(NOT_MUTATABLE_TARGET_CONTENT),
			job_key: "job_0002",
		},
		acceptance_receipt_hash: "2".repeat(64),
		execution_receipt_hash: "3".repeat(64),
		attempt_id: "attempt_0002",
		result_hash: "4".repeat(64),
		signature: { key_id: "k1", value: "5".repeat(96) },
		seq: 3,
		occurred_at: "2026-08-31T12:05:00.000Z",
		scope: {
			mode: "companion_fallback",
			test_files: ["src/lib/constants.test.ts"],
			incremental: false,
			mutation_scope: "whole_file",
		},
		engine: { name: "stryker", version: "8.2.0", config_hash: "6".repeat(64), exit_code: 0 },
		runner: { build: "runner-build-2026-08-31", image_digest: `sha256:${"0".repeat(64)}` },
		census: { generated: 0, executable: 0, approved_excluded: 0 },
		test_run: {
			executed_test_count: 5,
			overlay_green: true,
			red_witness_satisfied: null,
			command_hash: "5".repeat(64),
			runner_name: "vitest",
			runner_version: "3.2.0",
		},
		report: { r2_sha256: "7".repeat(64), bytes: 512, content_hash: "8".repeat(64) },
	};
}
