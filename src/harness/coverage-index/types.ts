// interlinked-tdd: exempt — type definitions only, no executable surface.
// ===========================================
// Coverage index — type definitions
// ===========================================
// The persistent, replaceable coverage-contribution index from
// docs/design/incremental-per-edit-coverage-crap-ratchet.md (sections 8.1–8.2).
// Aggregate coverage = union(contribution per valid test shard); rerunning a
// shard replaces exactly its contribution, so per-edit coverage can be updated
// without a full-suite run while preserving one consistent test universe.
//
// In-memory shapes only. JSON serialization (the `.interlinked/coverage-index/`
// store, one subtree per runner) lands with store.ts in a later phase; these
// types deliberately use Map for the hot union math.

/**
 * Element-level coverage for one source file from one measurement: every key
 * is an executable element (the denominator), every value a hit count where
 * `> 0` means covered. Line keys are 1-based line numbers; branch / function /
 * statement keys are engine-stable identities (e.g. LCOV `line:block:branch`,
 * Istanbul location + index) that are comparable only within the same
 * source/config version — cross-shard unions always mix same-version
 * contributions because editing a source invalidates every shard that covers
 * it (design doc section 11).
 */
export interface CanonicalCoverageElementSet {
	lines: Map<number, number>;
	branches: Map<string, number>;
	functions: Map<string, number>;
	/** Statement-level data when the engine provides it (Istanbul does, LCOV does not). */
	statements?: Map<string, number>;
}

/**
 * One shard's coverage contribution: per-file element sets for every source
 * file this shard's tests executed. A file absent from `files` was not
 * touched by this shard — it contributes nothing to that file's aggregate
 * (which is NOT the same as covering it with zero hits).
 */
export interface ShardCoverageContribution {
	shardId: string;
	files: Map<string, CanonicalCoverageElementSet>;
}

/** Covered/total/percentage for one coverage dimension of one file. */
export interface DimensionCounts {
	covered: number;
	total: number;
	/** covered / total × 100; a file with nothing to cover reports 100 (no regression possible). */
	pct: number;
}

/**
 * Per-file metrics derived from an aggregated element set. `statements` is
 * null when no contributing engine reported statement-level data.
 */
export interface FileCoverageMetrics {
	lines: DimensionCounts;
	branches: DimensionCounts;
	functions: DimensionCounts;
	statements: DimensionCounts | null;
}

/** One recorded shard-instability observation (design doc section 7.1). */
export interface InstabilityEvent {
	/** ISO timestamp of the rerun that diverged. */
	at: string;
	/** What diverged while every validity hash was identical. */
	kind: "contribution_churn" | "pass_fail_flip";
}

/**
 * Stability bookkeeping for one shard. A quarantined shard's contribution
 * still participates in aggregates, but a regression attributable to it
 * downgrades from block to warning until it proves stable again.
 */
export interface ShardInstability {
	/** Recent instability events, bounded by the store's retention policy. */
	events: InstabilityEvent[];
	/** Consecutive reruns whose contribution + pass/fail matched the stored state. */
	consecutiveStableRuns: number;
	quarantined: boolean;
}

/** Manifest record for one shard (design doc section 8.2). */
export interface ShardManifestEntry {
	shardId: string;
	/** Repo-relative POSIX paths of the test files this shard runs. */
	testPaths: string[];
	/** Content hash per test path — validity input. */
	testContentHashes: Record<string, string>;
	/** Content hash per relevant transitive source/dependency path — validity input. */
	dependencyHashes: Record<string, string>;
	/** Wall-clock of the last execution; feeds selection-cost budget prediction (section 10.2). */
	lastDurationMs: number;
	/** Store-relative path of the serialized contribution blob. */
	contributionPath: string;
	/** Checksum of the contribution blob (torn-write detection). */
	contributionChecksum: string;
	/** Last run's suite verdict; null = never established (runner indeterminate). */
	passed: boolean | null;
	instability: ShardInstability;
}

/**
 * The per-runner index manifest (design doc section 8.2). Accepted manifests
 * are immutable snapshots identified by `generation`; staging/promotion uses
 * compare-and-swap on that generation (section 12).
 */
export interface CoverageIndexManifest {
	version: 1;
	generation: number;
	/** ISO timestamp of the authoritative run that established this index. */
	authoritativeAt: string;
	runnerId: string;
	runnerVersion: string;
	coverageEngine: string;
	coverageConfigHash: string;
	testDiscoveryHash: string;
	dependencyGraphVersion: string;
	environmentHash: string;
	/** Isolation boundary shards derive from (design doc section 5.3). */
	shardBoundary: "file" | "group" | "run";
	sourceRevision?: string;
	shards: Record<string, ShardManifestEntry>;
}
