// interlinked-tdd: exempt — type definitions only, no executable surface.
// ===========================================
// Per-edit mutation — identity, manifest & output contracts (build step 2)
// ===========================================
// The foundational data model for
// docs/design/per-edit-cloud-mutation-testing.md and its step-2 spec
// docs/design/per-edit-mutation-identity-and-manifest.md. Modeled as a sibling
// of coverage-index/types.ts: same content-hash validity inputs, the same
// immutable-snapshot-with-`generation`, and the same instability/quarantine
// model. No executable surface — see identity.ts for the derivation.

/** A 16-hex-char sha-256 prefix used as a stable, content-addressed id. */
export type StableId = string;

/**
 * The mechanical mutant statuses — no LLM judgement, the verdict is exactly this
 * set. `uncovered` mirrors the engine's "no covering test"; `equivalent` is a
 * reviewed annotation that a mutant cannot change behaviour; `indeterminate`
 * marks a run that could not conclude (distinct from a definite `survived`).
 */
export type MutantStatus =
	| "killed"
	| "survived"
	| "timeout"
	| "uncovered"
	| "equivalent"
	| "indeterminate";

/**
 * One mutation reported by the engine, BEFORE identity re-anchoring. The raw
 * character offset is used only to find the enclosing symbol + ordinal; it is
 * never stored as identity (it shifts under unrelated edits — the whole reason
 * identity exists).
 */
export interface RawMutant {
	/** Repo-relative POSIX path of the mutated file. */
	file: string;
	/** Engine operator name, e.g. "EqualityOperator" / "relational_operator". */
	mutator: string;
	/** The original source token being mutated, e.g. ">". */
	originalLexeme: string;
	/** The replacement token, e.g. ">=". */
	replacement: string;
	/** 0-based character offset of the mutated token's start (engine-provided). */
	startOffset: number;
}

/** A mutation re-anchored to stable, line-shift-invariant identities (spec §1–§2). */
export interface MutantIdentity {
	mutantId: StableId;
	siteId: StableId;
	symbolId: StableId;
	/** Human-readable provenance, e.g. "PaymentService.charge". */
	qualifiedName: string;
	mutator: string;
	originalLexeme: string;
	replacement: string;
	ordinalWithinSymbol: number;
}

export interface MutantRecord {
	mutantId: StableId;
	siteId: StableId;
	mutator: string;
	originalLexeme: string;
	replacement: string;
	ordinalWithinSymbol: number;
	status: MutantStatus;
	/** ISO timestamp — when this identity first appeared. */
	firstSeen: string;
	/** For status "equivalent": the human judgment of WHY no test can kill this
	 *  mutant, recorded in-band so the accepted floor stays auditable. Set by
	 *  `acceptMutant` (interlinked mutation accept); absent otherwise. */
	accepted_reason?: string;
}

/** Mirror of coverage-index `ShardInstability`: quarantine on identity churn. */
export interface IdentityInstability {
	events: Array<{ at: string; kind: "id_churn" | "status_flip" }>;
	consecutiveStableRuns: number;
	/** A quarantined symbol's survivors downgrade BLOCK → WARN until it restabilises. */
	quarantined: boolean;
}

export interface SymbolRecord {
	symbolId: StableId;
	qualifiedName: string;
	/** Normalized-source content hash — the differential-skip / changed-region key. */
	symbolHash: string;
	/** Keyed by mutantId. */
	mutants: Record<StableId, MutantRecord>;
	instability: IdentityInstability;
}

/** The persistent per-edit mutation manifest — sibling of CoverageIndexManifest. */
export interface MutationManifest {
	version: 1;
	/** Immutable snapshot id; promotion is compare-and-swap on this generation. */
	generation: number;
	/** ISO timestamp of the run that established this snapshot. */
	authoritativeAt: string;
	engine: string;
	engineVersion: string;
	/** Invalidation input — identities re-measure on a graph-version bump. */
	dependencyGraphVersion: string;
	/** Toolchain/runtime fingerprint. */
	environmentHash: string;
	sourceRevision?: string;
	/** file → symbolId → record. */
	files: Record<string, Record<StableId, SymbolRecord>>;
}

/**
 * The overlay test-run signal accompanying a mutation measurement (spec §7).
 * Produced by the runner alongside the mutants; absent when the runner reports
 * mutants only (older Worker, or a runner that does not run the suite).
 */
export interface TestRunResult {
	/** Affected tests GREEN on the proposed overlay. false ⇒ the edit breaks the
	 *  suite — a hard red/green block that supersedes the mutant work-list. */
	overlayGreen: boolean;
	/** A newly-added test was RED on the pre-edit BASE (the RED-witness). null ⇒
	 *  the edit added no new test, so there is nothing to witness. false ⇒ the new
	 *  test passes on base too (weak/tautological) — a WARN, not a block. */
	redWitnessSatisfied: boolean | null;
}

/** A receipt is valid ONLY against the exact measured overlay content (spec §8). */
export interface MutationReceipt {
	/** Hash of the proposed overlay content actually run. */
	overlayHash: string;
	/** Manifest snapshot the run was diffed against. */
	generation: number;
	sites: Array<{ mutantId: StableId; symbolId: StableId; status: MutantStatus }>;
	engine: string;
	engineVersion: string;
	measuredAt: string;
}

/** Recorded when a measurement could not complete (parent doc §12, case 3). */
export interface MutationObligation {
	reason: "cloud_unreachable" | "over_budget" | "partial";
	overlayHash: string;
	/** Changed symbols still needing measurement at commit time. */
	changedSymbols: StableId[];
}

/**
 * The gate outcome. Only `kind: "measured"` may block, refresh the manifest, or
 * mark the edit mutation-clean; `unavailable` is an honest not-measured allow.
 */
export type MutationGateOutcome =
	| {
			kind: "measured";
			decision: "allow" | "block";
			receipt: MutationReceipt;
			newSurvivors: MutantRecord[];
			uncoveredSites: StableId[];
			/** Distinct mutation sites in the changed region (spec §6 precheck). */
			changedSiteCount: number;
			/** The configured small-scope ceiling; over it ⇒ "split this patch" block. */
			siteCountThreshold: number;
			/** Red/green gate (spec §7): the overlay's affected tests fail. A hard block
			 *  that supersedes the mutant work-list. Absent test-run data ⇒ undefined ⇒
			 *  not gated (older Worker / mutants-only runner). */
			suiteRed?: boolean;
			/** RED-witness (spec §7): a newly-added test did NOT fail on the base — a
			 *  weak/tautological test. WARN, never a block. */
			redWitnessFailed?: boolean;
			/** Present ONLY on a measured-clean allow: the refreshed manifest snapshot
			 *  for the caller to persist. Never present on a block or an unavailable
			 *  outcome — a dirty or unmeasured run must not launder the manifest
			 *  (spec §4/§12). */
			refreshedManifest?: MutationManifest | undefined;
	  }
	| {
			kind: "unavailable";
			reason: string;
			warning: string;
			obligation?: MutationObligation;
	  };
