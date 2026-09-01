// interlinked-tdd: exempt — type definitions only, no executable surface.
// ===========================================
// Mutation protocol v3 — the canonical result envelope (cross-repo contract)
// ===========================================
// Source of truth for docs/plans/27-durable-mutation-job-protocol.md §6.
// A terminal mutation result is a DISCRIMINATED UNION, never an optional
// collection of fields: `mutation_result | suite_red | not_mutatable |
// execution_failed | cancelled | expired`. Both repositories bind to this
// schema through the shared acceptance corpus in protocol/mutation-v3/ —
// change the schema ONLY together with those fixtures.
//
// Review 2026-08-31 second pass — three design rules now encoded here:
// 1. The envelope carries EVIDENCE, never a clean verdict. Verdict-shaped
//    helpers were removed; see evidence.ts for mechanical classification
//    and the ONE local evaluator for policy.
// 2. Census is exactly-once: generated === executable + approved_excluded,
//    and every excluded mutant is a signed full-identity row + policy_id.
// 3. Timing/cost are EXCLUDED from the envelope entirely in 3.0 — the run
//    ledger owns them (resolves plan 27's §6-vs-timing contradiction).

/** The versioned evidence identity. Any other value is a different contract. */
export const PROTOCOL_V3_VERSION = "interlinked-mutation/3.0";

/** Mechanical mutant statuses — v3 wire values (no LLM judgement).
 *  `timeout` / `indeterminate` make the evidence INCOMPLETE (evidence.ts);
 *  `uncovered` is mutation debt, not a survivor. */
export type V3MutantStatus = "killed" | "survived" | "timeout" | "uncovered" | "indeterminate";

export const V3_MUTANT_STATUSES: readonly V3MutantStatus[] = [
	"killed",
	"survived",
	"timeout",
	"uncovered",
	"indeterminate",
];

/** Tenant/project/repository/commit/target binding — who and what this
 *  result is evidence ABOUT. Unbound evidence proves nothing. */
export interface V3JobBinding {
	tenant: string;
	project: string;
	repository: string;
	commit: string;
	/** Normalized repo-relative POSIX path of the measured target file. */
	target_file: string;
	/** sha-256 of the exact target content measured (the overlay hash). */
	target_content_hash: string;
	/** Idempotent job key the result answers. */
	job_key: string;
}

/** The one source bundle encoding protocol v3 runners accept. The format
 *  participates in request/receipt hashes so an executor never guesses how
 *  authenticated bytes should be decoded. */
export const SOURCE_ARTIFACT_FORMAT = "git-archive-tar-v1";

/** Opaque reference to the exact full-repository snapshot + proposed overlay
 * the Sandbox must mount. The bytes travel out of band; request and receipts
 * bind this metadata. `artifact_id` is resolved server-side and is never an
 * R2 key supplied by a client. */
export interface V3SourceArtifactBinding {
	format: typeof SOURCE_ARTIFACT_FORMAT;
	artifact_id: string;
	sha256: string;
	bytes: number;
}

/** Test-selection + mutation-scope echo. v1 retires incremental and range
 *  scope: `incremental` MUST be false and `mutation_scope` MUST be
 *  "whole_file" — present as echoes so a drifting producer is caught. */
export interface V3ScopeEcho {
	mode: "import_graph" | "companion_fallback" | "glob_fallback";
	/** The exact test files loaded, repo-relative, no duplicates. May be
	 *  empty only for a controlled not_mutatable under a recorded policy. */
	test_files: string[];
	incremental: false;
	mutation_scope: "whole_file";
}

export interface V3EngineIdentity {
	name: string;
	version: string;
	/** sha-256 of the EFFECTIVE engine configuration actually used. */
	config_hash: string;
	/** Engine process exit status. Only an explicit 0 can carry complete evidence. */
	exit_code: number;
}

/** Runner build + image identity — which code produced this evidence.
 *  The image digest is REQUIRED on evidence-carrying kinds. */
export interface V3RunnerIdentity {
	build: string;
	image_digest: string;
}

/** Mutant census — exactly-once accounting:
 *  generated === executable + approved_excluded. */
export interface V3MutantCensus {
	generated: number;
	executable: number;
	approved_excluded: number;
}

export interface V3TestRunEvidence {
	/** Count of tests the runner EXECUTED. 0 never carries complete evidence. */
	executed_test_count: number;
	overlay_green: boolean;
	/** null ⇒ the edit added no new test (nothing to witness). */
	red_witness_satisfied: boolean | null;
	/** sha-256 of the exact test command executed. */
	command_hash: string;
	/** Test-runner identity (e.g. vitest), distinct from the execution runner. */
	runner_name: string;
	runner_version: string;
}

/** The identity algorithm evidence kinds echo — tenth pass P0-2: enough
 *  authenticated provenance travels with every mutant row for the LOCAL
 *  evaluator to recompute symbolId/siteId/mutantId from the measured
 *  content (identity.ts) and verify the claimed id. */
/** Full-width wire identity. This is NOT the legacy 16-hex manifest v1:
 * changing the intermediate hash width changes descendant ids, so the wire
 * algorithm has its own version and is never presented as backward compatible. */
export const IDENTITY_ALGORITHM = "interlinked-site-v2";

export interface V3MutantIdentityProvenance {
	/** FULL sha-256 stable identity (plan 27: portable evidence carries
	 *  full fingerprints, never engine ids like "stryker-1"). */
	mutant_id: string;
	/** Full sha-256 of the mutation site and enclosing symbol. These are
	 * independently re-derived from local target bytes before evaluation. */
	site_id: string;
	symbol_id: string;
	/** Human-readable structural context, authenticated for display and checked
	 * against the local AST derivation. */
	qualified_name: string;
	/** Collision-resistant structural anchor. Equals qualified_name for named
	 * symbols and adds a stable local ordinal for anonymous/computed symbols. */
	symbol_context: string;
	/** Engine operator name, e.g. "EqualityOperator". */
	mutator: string;
	/** The original source token (may be empty). */
	original_lexeme: string;
	/** The replacement token (may be empty). */
	replacement: string;
	/** 0-based UTF-16 code-unit offset (JavaScript string index) of the
	 *  mutated token in the hash-bound target content — the portable
	 *  identity-recompute anchor. */
	start_offset: number;
	/** Rank of this distinct offset within its
	 * (symbol, mutator, original_lexeme) group. */
	ordinal_within_symbol: number;
}

export interface V3MutantRow extends V3MutantIdentityProvenance {
	status: V3MutantStatus;
}

/** One approved exclusion: WHICH portable mutant identity, under WHICH
 * recorded policy. Exclusions carry the same provenance because they belong
 * to the generated-mutant universe and therefore affect ordinal ranking. */
export interface V3ExcludedRow extends V3MutantIdentityProvenance {
	policy_id: string;
}

/** Pointer to the full report in object storage, hash-bound. REQUIRED on
 *  mutation_result so the verifier can prove the target appears in the
 *  actual report. */
export interface V3ReportPointer {
	r2_sha256: string;
	bytes: number;
	content_hash: string;
}

/** Authenticated terminal evidence: signature over the result_hash. Shape
 *  here; VERIFICATION lives behind the verify boundary (verify.ts), which
 *  also binds key_id to the verified receipt signer for the selected arm. */
export interface V3Signature {
	key_id: string;
	value: string;
}

/** Fields EVERY terminal envelope carries (plan 27 §6). */
export interface V3TerminalCommon {
	protocol_version: typeof PROTOCOL_V3_VERSION;
	job: V3JobBinding;
	acceptance_receipt_hash: string;
	/** EXACTLY ONE of these two binds the result to its evidence chain.
	 *  Evidence-carrying kinds REQUIRE the execution receipt (an attempt
	 *  ran); the terminalization record is the pre-execution terminal path. */
	execution_receipt_hash?: string;
	terminalization_record_hash?: string;
	/** Attempt identity — required exactly when an execution receipt is. */
	attempt_id?: string;
	result_hash: string;
	signature: V3Signature;
	/** Monotonic event-log sequence — an observability hint, NOT replay
	 *  protection (plan 27 r5.3). */
	seq: number;
	occurred_at: string;
}

export interface V3MutationResult extends V3TerminalCommon {
	kind: "mutation_result";
	scope: V3ScopeEcho;
	engine: V3EngineIdentity;
	runner: V3RunnerIdentity;
	census: V3MutantCensus;
	/** One row per approved exclusion; length === census.approved_excluded. */
	excluded: V3ExcludedRow[];
	/** One row per executable mutant; length === census.executable. */
	mutants: V3MutantRow[];
	/** MUST be "interlinked-site-v2" — the algorithm the mutant_ids were
	 *  computed with, so a local adapter can recompute and verify them. */
	identity_algorithm: typeof IDENTITY_ALGORITHM;
	test_run: V3TestRunEvidence;
	report: V3ReportPointer;
}

export interface V3SuiteRed extends V3TerminalCommon {
	kind: "suite_red";
	scope: V3ScopeEcho;
	engine: V3EngineIdentity;
	runner: V3RunnerIdentity;
	test_run: V3TestRunEvidence;
	/** Partial adverse evidence that DID report before the red stop —
	 *  census, excluded, mutants, and identity_algorithm travel together
	 *  or not at all. */
	census?: V3MutantCensus;
	excluded?: V3ExcludedRow[];
	mutants?: V3MutantRow[];
	identity_algorithm?: typeof IDENTITY_ALGORITHM;
}

export interface V3NotMutatable extends V3TerminalCommon {
	kind: "not_mutatable";
	scope: V3ScopeEcho;
	engine: V3EngineIdentity;
	runner: V3RunnerIdentity;
	/** Proof contract: generated = 0 AND executable = 0 (so excluded rows
	 *  cannot exist on this kind). */
	census: V3MutantCensus;
	test_run: V3TestRunEvidence;
	/** REQUIRED (review 2026-08-31 third pass): without the report, an
	 *  OMITTED target is indistinguishable from a genuinely non-mutatable
	 *  one — the original false-clean class. The verifier proves the target
	 *  appears in the retrieved report before evidence can be complete. */
	report: V3ReportPointer;
	/** Recorded policy id permitting executed_test_count = 0. */
	no_test_policy?: string;
}

export interface V3ExecutionFailed extends V3TerminalCommon {
	kind: "execution_failed";
	failure_classification: string;
	/** EXPLICIT marker (review 2026-08-31): "none" ⇒ no evidence blocks may
	 *  appear; "partial" ⇒ an execution receipt is required and at least one
	 *  evidence block is present. No consumer may infer completeness. */
	evidence_completeness: "none" | "partial";
	scope?: V3ScopeEcho;
	engine?: V3EngineIdentity;
	runner?: V3RunnerIdentity;
	census?: V3MutantCensus;
	excluded?: V3ExcludedRow[];
	mutants?: V3MutantRow[];
	identity_algorithm?: typeof IDENTITY_ALGORITHM;
	test_run?: V3TestRunEvidence;
}

export interface V3Cancelled extends V3TerminalCommon {
	kind: "cancelled";
	cancellation_reason: string;
}

export interface V3Expired extends V3TerminalCommon {
	kind: "expired";
	expiry_reason: string;
}

export type V3Envelope =
	| V3MutationResult
	| V3SuiteRed
	| V3NotMutatable
	| V3ExecutionFailed
	| V3Cancelled
	| V3Expired;

export type V3Kind = V3Envelope["kind"];

export const V3_KINDS: readonly V3Kind[] = [
	"mutation_result",
	"suite_red",
	"not_mutatable",
	"execution_failed",
	"cancelled",
	"expired",
];

/** The kinds whose envelopes carry run evidence and therefore REQUIRE an
 *  execution receipt, an attempt id, and a runner image digest. */
export const V3_EVIDENCE_KINDS: readonly V3Kind[] = [
	"mutation_result",
	"suite_red",
	"not_mutatable",
];
