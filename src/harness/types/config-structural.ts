// interlinked-tdd: exempt — type declarations only, no runtime logic.
// ===========================================
// Interlinked Harness — Structural / Project-Wide / Error-Memory Config Types
// ===========================================
// Split out of ./config.ts to keep that module under the per-file line cap.
// Leaf cluster: these interfaces are referenced by GuardRulesConfig in
// config.ts (config.ts imports them back) and re-exported there so the
// public surface and the ./types.js barrel are unchanged.

import type { ModuleRole } from "./graph.js";

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
	/** Plan 25 lane 5 — delta check: warn only on the specific edit that
	 *  CLOSES a new import cycle through the edited file (vs import_cycles'
	 *  whole-state view of pre-existing cycles too). */
	new_import_cycle?: boolean;
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
	/** Characterize-before-touch (plan 25 lane 1): editing a file on the
	 *  untested list requires a characterization test first. "block" refuses
	 *  the edit, "warn" allows with a warning (default), "off" disables.
	 *  Mode-laddered: strict=block, balanced=warn, lenient=off. */
	characterize_mode?: "block" | "warn" | "off";
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
	affected_files?: string[] | undefined;
	/** The subsequent edit that fixed the issue (populated retroactively) */
	fix_context?: string | undefined;
	/** Line range where the error occurred (for region-level tracking) */
	line_start?: number | undefined;
	line_end?: number | undefined;
	/** Other files edited in the same session when this error occurred */
	co_edited_files?: string[] | undefined;
	/** Tool call sequence leading up to this error (last 15 calls) */
	pre_error_sequence?: string[] | undefined;
}
