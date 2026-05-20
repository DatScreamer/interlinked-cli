// interlinked-tdd: exempt — type declarations only, no runtime logic.
// ===========================================
// Interlinked Harness — Guard Rules Configuration Types
// ===========================================

import type { GuardRule } from "./rules.js";
import type { ModuleRole } from "./graph.js";
import type { ClassifierConfig } from "./policy.js";
import type { TaintTrackingConfig, OutputScanningConfig } from "./taint.js";

// ===========================================
// Guard Rules Configuration
// ===========================================

export interface ProtectedFileRule {
	/** Glob pattern for file paths */
	glob: string;
	/** Which operations to guard: "Write", "Edit", "Delete", "Read" */
	operations: string[];
	/** Optional: run secrets detection on content before allowing */
	check?: "secrets";
	/** Reason shown to agent if blocked */
	reason: string;
}

export interface FileReminder {
	/** Glob pattern for file paths (supports dir/**, exact path, extension globs) */
	glob: string;
	/** Which operations trigger the reminder (omit = any file operation) */
	operations?: string[];
	/** Message shown to agent + user as a warning */
	message: string;
	/** Only fire once per session (default: true) */
	once_per_session?: boolean;
	/** Optional stable ID for dedup (auto-derived from glob if omitted) */
	id?: string;
	/** ISO timestamp when the reminder was created */
	created_at?: string;
	/** Who created this reminder (agent name or "cli") */
	created_by?: string;
}

export interface CurlMcpConfig {
	enabled: boolean;
	/** Localhost ports that should be MCP servers */
	localhost_ports: number[];
	/** Block after this many curl calls to same port (default: 5) */
	escalate_after: number;
	/** Warning message */
	message: string;
}

export interface QualityCheckConfig {
	enabled: boolean;
	/** Shell command to run (file path appended) */
	command?: string;
	/** File extensions to check (e.g., [".ts", ".tsx"]) */
	file_types: string[];
	/** Maximum execution time in milliseconds */
	timeout_ms: number;
	/** Whether failures are errors or warnings */
	severity: "error" | "warning";
	/** Human-readable description */
	description?: string;
	/** Skip this check for test files (e.g., semgrep/gitleaks on test fixtures) */
	skip_test_files?: boolean;
	/**
	 * `dependency_audit` only: prefer osv-scanner over per-ecosystem tools
	 * (npm audit / pip-audit / cargo audit / govulncheck) when it's on PATH.
	 * Default: true. Set false to force the legacy per-ecosystem commands.
	 */
	use_osv_scanner?: boolean;
	/**
	 * `dependency_audit` only: when osv-scanner is used, pass `--offline`
	 * (requires `osv-scanner scan --download-offline-databases` to have run
	 * at least once). Avoids osv.dev network round-trips on every edit.
	 */
	offline?: boolean;
}

// ===========================================
// Diff-Aware Filtering
// ===========================================

/** Controls which checks use diff-aware filtering to suppress pre-existing issues */
export interface DiffAwareConfig {
	/** Master switch (default: true) */
	enabled: boolean;
	/** "baseline" = only report new findings; "off" = report all (default: "baseline") */
	missing_return_types?: "baseline" | "off";
	/** "edit_region" = only in edited area; "off" = report all (default: "edit_region") */
	complexity?: "edit_region" | "off";
	/** "new_files_only" = only on Write (new files); "off" = always (default: "new_files_only") */
	no_test_file?: "new_files_only" | "off";
	/** "edit_content" = only for newly-added refs; "off" = report all (default: "edit_content") */
	undefined_env_vars?: "edit_content" | "off";
}

/** Cached check results from before an edit, used for baseline subtraction and ratchet comparison */
export interface PreEditBaseline {
	/** Function signatures with missing return types (Set of trimmed signature text) */
	missingReturnTypes: Set<string>;
	/** Complex function signatures (Set of trimmed signature text) */
	complexFunctions: Set<string>;
	/**
	 * Per-file, per-function CRAP scores captured before the edit.
	 * Keyed by repo-relative file path, inner map keyed by "name@line".
	 * Consumed by filterToRisers() in the PostToolUse CRAP block.
	 * Optional — absent when coverage data is unavailable (fail-open).
	 */
	crapScores?: Map<string, Map<string, number>>;
	/**
	 * Code-clone similarity pairs captured before the edit.
	 * Consumed by the PostToolUse code_clones block so old duplication in a
	 * touched file is not reported as a new agent warning.
	 */
	dryCloneBaseline?: import("../checks/dry-baseline.js").DryBaseline;
	/** When this baseline was captured */
	capturedAt: number;
	/** Count of suppression directives (@ts-expect-error, @ts-expect-error, eslint-disable, biome-ignore) */
	suppressionCount: number;
	/** Count of `as any` casts */
	asAnyCastCount: number;
	/** Count of non-null assertions (`foo!.bar`) */
	nonNullAssertionCount: number;
	/** Count of TODO / FIXME / HACK / XXX markers (Batch 7 ratchet). */
	todoMarkerCount?: number;
	/** Count of console.* statements (Batch 7 ratchet). */
	consoleStatementCount?: number;
	/** Count of exported symbols — public API surface (Batch 7 ratchet). */
	publicApiSurfaceCount?: number;
	/** Composite type-density counters: bare `: any` / `: unknown` / `: Function` / `: {}`
	 *  annotations plus untyped exported params and missing exported return types.
	 *  Optional — older callers/tests may not capture it; the ratchet check
	 *  fails open in that case. */
	typeDensity?: import("../quality-checks/ratchet-metrics.js").TypeDensityCounts;
	/** Software/model/dependency version references captured before the edit.
	 *  Used by the PostToolUse software_version_regression check to detect
	 *  accidental downgrades caused by stale model memory. Optional so older
	 *  direct test callers continue to fail open. */
	softwareVersions?: import("../quality-checks/software-version-regression.js").SoftwareVersionReference[];
	/** Per-primitive bare-unsafe-builtin counts captured before the edit.
	 *  Keyed by wrapper name (e.g. "safeParseInt" → 3 bare parseInt
	 *  calls in this file). The discovered_primitive_ratchet check
	 *  compares the post-edit counts and warns on any increase. Optional
	 *  — older direct test callers continue to fail open. */
	discoveredPrimitiveViolations?: Record<string, number>;
}

export interface GuardRulesConfig {
	version: 1;
	enabled: boolean;

	/** Custom guard rules (merged with built-in) */
	rules: GuardRule[];
	/** File path protection rules */
	protected_files: ProtectedFileRule[];
	/** File-scoped reminders (non-blocking warnings when files are touched) */
	file_reminders: FileReminder[];
	/** Detect curl to localhost when MCP tools should be used */
	curl_mcp_detection: CurlMcpConfig;
	/** PostToolUse quality checks (tsc, lint, secrets, etc.) */
	quality_checks: Record<string, QualityCheckConfig>;
	/** PostToolUse structural integrity checks (export surface, imports, cycles, etc.) */
	structural_checks: StructuralChecksConfig;
	/** Cross-session error memory */
	error_memory: ErrorMemoryConfig;
	/** Trajectory-level taint tracking (IFC) */
	taint_tracking: TaintTrackingConfig;
	/** Post-execution output scanning */
	output_scanning: OutputScanningConfig;
	/** Project-specific protected paths */
	project_specific?: {
		protected_paths: string[];
		protected_reason: string;
	};
	/**
	 * Path globs to skip the entire PostToolUse check pipeline (mirrors
	 * `SharedConfig.skip_paths`). When the touched file matches any entry,
	 * `runChecksAsync` returns an empty report with `skipped: [{check: "*",
	 * reason: "skip_paths matched", category: "config_disabled"}]`. Matched
	 * via `matchesAnyGlob` from `src/lib/path-glob.ts`.
	 */
	skip_paths?: string[];

	// Personal overrides (from guard-rules.local.json)
	/** Rule IDs to disable */
	disabled_rules?: string[];
	/** Additional exception patterns per rule ID */
	extra_exceptions?: Record<string, string[]>;
	/** Maximum suggestions to show per PostToolUse event (default: 3) */
	suggestion_limit?: number;
	/** Minimum score to show a suggestion (default: 0.5) */
	suggestion_threshold?: number;
	/** Paths outside repo root that agents are allowed to write to (e.g., ~/.claude/) */
	repo_confinement_allowlist?: string[];
	/** Tools that must be available. Missing required tools cause warnings instead of silent skips. */
	required_tools?: import("../check-engine/types.js").ToolId[];
	/** When true, unknown skip reasons (not in skip_allowlist) cause exit code 1 in verify */
	strict_skips?: boolean;
	/** Skip reason categories that are acceptable in strict mode */
	skip_allowlist?: string[];
	/** Diff-aware filtering: only report newly-introduced issues (default: enabled) */
	diff_aware?: DiffAwareConfig;
	/** LLM policy classifier for ambiguous PreToolUse cases */
	policy_classifier?: ClassifierConfig;
	/** ML content scanner (OpenAI privacy-filter etc.) for PreToolUse diff/command/egress content + PostToolUse Read/Grep taint */
	content_scanner?: import("../content-scanner/types.js").ContentScannerConfig;
	/** Auto-coordination: periodic read-only check-in with MCP server */
	auto_coordination?: import("../auto-coordinate.js").AutoCoordinationConfig;
	/** Project-wide checks: periodic cross-file tsc/biome sweep */
	project_wide_checks?: ProjectWideCheckConfig;
	/** Commit-cadence nudges (Stop-hook + mid-session backstop). See CommitCadenceConfig. */
	commit_cadence?: CommitCadenceConfig;
	/** Verification-before-stop nudges (unverified-code, ui-not-interacted, stubs-introduced). See VerificationStopChecksConfig. */
	verification_stop_checks?: VerificationStopChecksConfig;
	/**
	 * Grep accelerator substitution (block-and-answer for rg/grep/Grep).
	 * Disabled by default — the substitution bypasses content scanners,
	 * can serve stale results from a SessionStart-only refreshed index,
	 * and the partially-formed hookSpecificOutput envelopes have hit
	 * Claude Code's hook validator. The trigram index itself stays
	 * loaded and is still used by other consumers (impact analysis,
	 * project graph, structural checks). Re-enable via this flag or
	 * `INTERLINKED_GREP_ACCELERATOR=1`.
	 */
	grep_acceleration?: {
		/** Default: false. Set to true to restore the block-and-answer path. */
		substitution_enabled?: boolean;
	};
}

/** Verification-before-stop nudge configuration. Five independent
 *  Stop / SessionEnd warnings, all stderr-only, all opt-out per-kind:
 *    - warn_unverified_code:   code-file edits with no tsc/test/lint/build
 *    - warn_verify_not_run:    code edits with partial verification —
 *                              tsc/test/etc. ran but `interlinked verify`
 *                              (the canonical local CI mirror) did not.
 *                              Fires only when individual tools ran but
 *                              the suite didn't (no double-nudge with
 *                              warn_unverified_code).
 *    - warn_ui_not_interacted: UI-file edits with no dev-server / browser MCP
 *    - warn_stubs_introduced:  TODO/FIXME/disabled-test/not-impl-throw
 *                              surfaced via Write/Edit content during the session
 *    - warn_fixture_leaks:     untracked src/**\/_*.ts-shaped files whose
 *                              basename appears in a writeFixture()-shaped
 *                              call in a test — afterAll cleanup didn't run
 *  Master `enabled` switch gates all five together. */
export interface VerificationStopChecksConfig {
	enabled: boolean;
	warn_unverified_code: boolean;
	warn_verify_not_run: boolean;
	warn_ui_not_interacted: boolean;
	warn_stubs_introduced: boolean;
	warn_fixture_leaks: boolean;
}

/** Commit-cadence nudge configuration. Two triggers: (a) at Stop /
 *  SessionEnd when the count of distinct non-doc files edited since the
 *  last commit exceeds `stop_threshold`, and (b) a mid-session backstop
 *  one-shot when the same count crosses `mid_session_threshold`. */
export interface CommitCadenceConfig {
	enabled: boolean;
	/** File-count threshold above which the Stop-hook nudge fires. */
	stop_threshold: number;
	/** File-count threshold for the one-shot mid-session backstop. */
	mid_session_threshold: number;
	/** Cumulative session token count (input+output) above which the Stop nudge wording escalates to "long session". */
	token_band_low: number;
	/** Cumulative session token count above which the Stop nudge wording escalates further to "very long session" / "context window degrading". */
	token_band_high: number;
	/** Glob list whose matches are excluded from the count (markdown,
	 *  /docs, /plans, /notes, CLAUDE.md, AGENTS.md, PLAN*.md). Override
	 *  to add project-specific scratch areas (e.g., RFC drafts). */
	doc_globs: string[];
}

// ===========================================
// Project-Wide Checks (cross-file sweep)
// ===========================================

export interface ProjectWideCheckConfig {
	/** Enable project-wide check sweeps (default: true) */
	enabled: boolean;
	/** Run project-wide checks every N file edits (default: 5) */
	edit_interval: number;
	/** Always run project-wide checks when export surface changes (default: true) */
	on_export_change: boolean;
	/** Which tools to run in project mode (default: ["tsc", "biome"]) */
	tools: import("../check-engine/types.js").ToolId[];
	/** Timeout per tool in ms (default: 30000) */
	timeout_ms: number;
	/** Severity for cross-file findings (default: "warning") */
	severity: "error" | "warning";
	/** Maximum findings to report per sweep (default: 20) */
	max_findings: number;
}

// ===========================================
// Structural Checks Configuration
// ===========================================

export interface StructuralChecksConfig {
	enabled: boolean;
	/** Detect removed/renamed exports and warn about affected importers */
	export_surface: boolean;
	/** Verify all imports in edited files resolve to existing files/exports */
	import_resolution: boolean;
	/** Warn when a new export collides with an existing symbol name */
	duplicate_symbols: boolean;
	/** Warn when editing a file whose dependents were recently read by another agent */
	co_dependency_staleness: boolean;
	/** Detect circular dependency introduction */
	import_cycles: boolean;
	/** Warn when interface/type shape changes affect other files */
	interface_change_impact: boolean;
	/** Warn when edited source file has no corresponding test file */
	test_proximity: boolean;
	/** Only run full tsc when export surface changes (skip for internal-only edits) */
	smart_tsc: boolean;
	/** PreToolUse: show import count when editing high-connectivity files */
	blast_radius: boolean;
	/** PreToolUse: warn when reading a file recently modified by another agent */
	stale_read_warning: boolean;
	/** PreToolUse: list sibling files when creating a new file */
	sibling_awareness: boolean;
	/** Staleness window in seconds (default: 300 = 5 minutes) */
	staleness_window_s: number;
	/** Blast radius threshold — warn when file has >= this many dependents */
	blast_radius_threshold: number;
	/** PreToolUse: warn when reading/editing a file that had recent check failures */
	recently_failed: boolean;
	/** PreToolUse: remind agent about pending follow-through after export changes */
	completion_tracking: boolean;
	/** PreToolUse: inject route/handler context when editing API files */
	route_context: boolean;
	/** PreToolUse: warn when re-reading a file that hasn't changed */
	redundant_reread: boolean;
	/** PostToolUse: detect unused imports after editing */
	dead_imports: boolean;
	/** Completion tracking reminder threshold (tool calls since export change, default: 10) */
	completion_reminder_threshold: number;
	/** Detect exports with zero importers in the project graph */
	dead_exports: boolean;
	/** Detect bare-specifier imports not in package.json dependencies */
	hallucinated_imports: boolean;
	/** Detect relative imports that cross a package.json boundary */
	cross_package_imports: boolean;
	/** Detect process.env.FOO where FOO isn't in .env.example */
	undefined_env_vars: boolean;
	/** Detect imports that violate configured layer rules */
	layer_violations: boolean;
	/** Layer rules: "files matching from_glob cannot import from cannot_import_glob" */
	layer_rules?: Array<{ from_glob: string; cannot_import_glob: string; reason: string }>;
	/** PostToolUse: run impact analysis on file edits */
	impact_analysis: boolean;
	/** Impact analysis: dependent count threshold for "high" severity (default: 4) */
	impact_high_threshold: number;
	/** PreToolUse: nudge agent to write/run tests before editing source files */
	test_first: boolean;
	/** TDD enforcement mode: "nudge" (info), "warn" (warning), "enforce" (blocks commit) */
	test_first_mode: "nudge" | "warn" | "enforce";
	/** Detect duplicate switch discriminant (x.kind) across files */
	cross_file_switch_discriminant?: boolean;
	/** Detect interfaces with exactly one implementor (premature abstraction) */
	single_implementation_interface?: boolean;
}

// ===========================================
// Error Memory — Cross-session error tracking
// ===========================================

/** Error memory configuration */
export interface ErrorMemoryConfig {
	enabled: boolean;
	/** Maximum age of error records to consider in seconds (default: 7 days) */
	max_age_s: number;
	/** Maximum number of records to keep in history (default: 5000) */
	max_records: number;
}

/** A single error record persisted in .interlinked/error-history.jsonl */
export interface ErrorRecord {
	/** When the error was detected */
	timestamp: string;
	session_id: string;
	agent_name: string;
	/** Relative file path */
	file: string;
	/** Module role at time of error */
	file_role: ModuleRole;
	/** Which check caught it */
	check_name: string;
	severity: "error" | "warning";
	/** Human-readable error message */
	message: string;
	/** Context: diff, surrounding code, file role */
	diff_context: string;
	/** Files affected by the error */
	affected_files?: string[];
	/** The subsequent edit that fixed the issue (populated retroactively) */
	fix_context?: string;
	/** Line range where the error occurred (for region-level tracking) */
	line_start?: number;
	line_end?: number;
	/** Other files edited in the same session when this error occurred */
	co_edited_files?: string[];
	/** Tool call sequence leading up to this error (last 15 calls) */
	pre_error_sequence?: string[];
}
