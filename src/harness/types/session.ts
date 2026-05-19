// interlinked-tdd: exempt — type declarations only, no runtime logic.
// ===========================================
// Interlinked Harness — Session Trajectory & TDD-Cycle Types
// ===========================================

import type { ActiveSkillRecord } from "./rules.js";
import type { SensitivityLevel, TaintSource } from "./taint.js";

// ===========================================
// Session Trajectory
// ===========================================

/**
 * Per-test-file counts of `it()`/`test()` blocks and `expect()`/`assert*()`
 * calls. Captured on every PostToolUse Write/Edit of a test file; the
 * delta between successive captures is what the assertion-density
 * behavioral check fires on. Declared here (not in `behavioral-checks.ts`)
 * because `SessionTrajectory` lives in this module — moving the definition
 * out would create an import cycle.
 */
export interface AssertionCounts {
	blocks: number;
	assertions: number;
}

export interface SessionTrajectory {
	session_id: string;
	agent_name: string;
	started_at: string;
	tool_call_count: number;
	error_count: number;
	files_read: Set<string>;
	files_written: Set<string>;
	commands_run: string[];
	/** Track curl-to-localhost frequency per port */
	curl_localhost_count: Record<number, number>;
	last_checkpoint_at?: string;
	/** Count of MCP tool calls (agent is using MCP correctly) */
	mcp_tools_used: number;
	/** Count of non-MCP tool calls */
	local_tools_used: number;
	/** Timestamp of last write per file (for cross-agent staleness detection) */
	file_write_times: Map<string, string>;
	/** Files that had check failures this session (file → entry) */
	failed_files: Map<string, FailedFileEntry>;
	/** Pending follow-through after export changes (source_file → completion) */
	pending_completions: Map<string, PendingCompletion>;
	/** Tool call count when each file was last read (for redundant re-read detection) */
	file_read_at: Map<string, number>;
	/** Recent tool call sequence for pattern detection (last 20: "Edit:src/foo.ts") */
	tool_sequence: string[];
	/** Current sensitivity taint level (ratchets up, never down) */
	sensitivity_level: SensitivityLevel;
	/** Files that caused sensitivity escalation (audit trail) */
	taint_sources: TaintSource[];
	/** Maximum allowed tool calls at current sensitivity level */
	step_limit: number;
	/** Consecutive similar tool patterns for permission suggestion (pattern → count) */
	consecutive_pattern: { pattern: string; count: number } | null;
	/** Permission patterns already suggested this session (avoid duplicates) */
	suggested_permissions: Set<string>;
	/**
	 * Acknowledged check warnings this session (file::checkName pairs).
	 * When a PostToolUse warning is shown and the user allows the agent to
	 * continue, the pair is recorded here. Subsequent PostToolUse events for
	 * the same file+check skip re-firing the warning (warnings only, not errors).
	 * Cleared per-file when a new edit touches that file.
	 */
	acknowledged_checks: Set<string>;
	/** File reminder IDs that have already fired this session (dedup for once_per_session) */
	fired_reminders: Set<string>;
	/** Soft-blocked command hashes — blocked first attempt, allowed on retry */
	soft_blocks: Set<string>;
	/** Tool call counts where prompt injection was detected in PostToolUse file reads */
	injection_detected_steps: number[];
	/** Tool call counts where the ML content-scanner flagged PII/secrets in PostToolUse Read/Grep results */
	pii_detected_steps: number[];
	/** tool_call_count at last auto-coordination check-in (init: 0) */
	last_coordination_at: number;
	/** Date.now() at last auto-coordination check-in (init: Date.now()) */
	last_coordination_ts: number;
	/** Test files executed this session with their last pass/fail status */
	test_runs: Map<string, { status: "pass" | "fail"; at_step: number }>;
	/** Per-file edit count this session (for repeated-edit-without-test detection) */
	file_edit_counts: Map<string, number>;
	/** Warnings issued per file::check (for escalation + effectiveness tracking) */
	warnings_issued: Map<string, WarningRecord>;
	/** TDD red/green cycle tracking per source file */
	tdd_cycles: Map<string, TddCycle>;
	/** Consecutive PostToolUseFailure count per tool_name (reset on any success for the same tool). */
	consecutive_tool_failures: Map<string, number>;
	/**
	 * Skills currently active for this session, keyed by skill name. Populated
	 * by `skill_enter` events; cleared by `skill_leave` or TTL expiry. Read by
	 * the active-when predicate evaluator. Optional so test fixtures and older
	 * call sites that don't care about scope can omit it; the evaluator treats
	 * undefined identically to an empty map. See harness-active-when-scoping.md.
	 */
	active_skills?: Map<string, ActiveSkillRecord>;
	/** Tool names that have already received a silent-failure warning this session (dedup). */
	silent_failure_warned: Set<string>;
	/** Tool names that have already received a context-bloat warning this session (dedup). */
	bloat_warned: Set<string>;
	/**
	 * Phase D.2 trajectory state machine. Lazy-instantiated on first
	 * PreToolUse event for the session when any `harness.trajectory.*`
	 * feature flag is enabled. Detects tool_loop / destructive_sequence /
	 * unbackedoff_retry / silent_stall anti-patterns. Findings surface as
	 * PreToolUse warnings, never as block decisions. Optional so tests
	 * with bare-bones session fixtures don't have to wire it in.
	 */
	trajectoryDetector?: import("../trajectory.js").TrajectoryDetector;
	/**
	 * Commit-cadence tracking — set of distinct non-doc files edited
	 * since the last `git commit`. Cleared on every `git commit` Bash
	 * invocation. Used by the Stop nudge and the mid-session backstop
	 * to count "uncommitted code-file work" without inflating on
	 * re-edits to the same file. Optional so tests that hand-build a
	 * session fixture don't have to wire it in — readers default to
	 * an empty set when absent.
	 */
	non_doc_files_edited_since_commit?: Set<string>;
	/**
	 * Number of doc/plan files (markdown, /docs, /plans, /notes,
	 * CLAUDE.md, AGENTS.md, PLAN*.md) edited since the last commit —
	 * surfaced in the nudge wording so the agent knows we're aware
	 * of the doc churn but excluded it on purpose.
	 */
	doc_files_edited_since_commit?: number;
	/** One-shot guard for the mid-session backstop nudge — set when it fires. */
	mid_session_nudge_emitted?: boolean;
	/** One-shot guard for the Stop-hook nudge — set when it fires. */
	stop_nudge_emitted?: boolean;
	/**
	 * Per-test-file `(blocks, assertions)` counts captured on the previous
	 * PostToolUse for each test file the agent has touched this session.
	 * The assertion-density behavioral check compares the post-edit count
	 * against this prior value to fire on `dBlocks > 0 && dAssertions <= 0`.
	 * First-sight of any test file silently establishes baseline.
	 */
	assertion_counts: Map<string, AssertionCounts>;
	/**
	 * Verification-before-stop tracking. Set of `VerificationSignal` kinds
	 * observed during the session — populated by `session-state.ts` from
	 * Bash commands (typecheck/test/lint/build/dev-server) and MCP browser
	 * tool names. Read at Stop by the three verify-before-stop nudges in
	 * `verification-stop-checks.ts`. Optional so hand-built test fixtures
	 * don't need to wire it.
	 */
	verification_observed?: Set<string>;
	/**
	 * Verification-before-stop tracking. Stubs / TODOs / disabled tests /
	 * not-implemented throws introduced via Write/Edit `content` /
	 * `new_string` this session. Populated by the post-tool evaluator's
	 * stub scanner (`scanForStubs`); read at Stop by
	 * `formatStubsIntroducedWarning`. Capped at `STUB_INTRODUCED_CAP`
	 * entries to keep long-session memory bounded.
	 */
	stubs_introduced?: Array<{ file: string; kind: string; snippet: string }>;
}

// ===========================================
// TDD Cycle Tracking
// ===========================================

/** State of the TDD red/green cycle for a single source file */
export type TddCycleState = "no_test" | "red" | "green" | "regression";

/** Tracks the red/green TDD cycle for a source file and its corresponding test */
export interface TddCycle {
	/** Absolute path to the source file being tested */
	source_file: string;
	/** Absolute path to the corresponding test file (null if none found) */
	test_file: string | null;
	/** Current state of the TDD cycle */
	state: TddCycleState;
	/** tool_call_count when the test file was first written/edited this session */
	test_written_at?: number;
	/** tool_call_count when tests first failed (entered RED) */
	red_at?: number;
	/** tool_call_count when tests first passed after being red (entered GREEN) */
	green_at?: number;
	/** Number of impl edits before any test interaction (writing test or running test) */
	impl_edits_before_test: number;
	/** Previous state — used to detect transitions (e.g., green→red = regression) */
	previous_state?: TddCycleState;
}

/** Record of a warning issued to the agent for a specific file + check */
export interface WarningRecord {
	/** Check name that produced the warning */
	check_name: string;
	/** How many times this warning has been issued for this file */
	issue_count: number;
	/** tool_call_count when first issued */
	first_issued_at: number;
	/** tool_call_count when last issued */
	last_issued_at: number;
	/** Whether the warning was resolved (next edit passed the check) */
	resolved: boolean;
}

/** Aggregate effectiveness stats for a single check across the session */
export interface CheckEffectivenessStats {
	check_name: string;
	times_issued: number;
	times_resolved: number;
	resolution_rate: number;
}

/** Per-session feedback effectiveness summary */
export interface FeedbackEffectivenessSummary {
	per_check: CheckEffectivenessStats[];
	overall_resolution_rate: number;
	total_issued: number;
	total_resolved: number;
}

// ===========================================
// Session-level Tracking Types
// ===========================================

/** Tracks files that had check failures (Feature: recently-failed-here) */
export interface FailedFileEntry {
	/** Number of failures on last check */
	failure_count: number;
	/** Check names that failed */
	checks: string[];
	/** When the failures were recorded */
	recorded_at: string;
	/** Tool call count when recorded */
	tool_call_count: number;
}

/** Tracks pending follow-through after export changes (Feature: completion tracking) */
export interface PendingCompletion {
	/** The file whose export surface changed */
	source_file: string;
	/** Files that import from source and need updating */
	affected_files: string[];
	/** Files the agent has already visited (read/edited) since the change */
	resolved_files: Set<string>;
	/** Tool call count when the completion was recorded */
	recorded_at_tool_call: number;
	/** What changed */
	description: string;
}

/** Route information detected from source code (Feature: route mapping) */
export interface RouteInfo {
	/** HTTP method or "TOOL" for MCP tools */
	method: string;
	/** URL path pattern or tool name */
	path: string;
	/** File that handles this route */
	handler_file: string;
	/** Line number of the route definition */
	line?: number;
}

// ===========================================
// Session Turn End Summary
// ===========================================

/** Summary produced at end of an agent turn (SessionTurnEnd event) */
export interface TurnEndSummary {
	session_id: string;
	agent_name: string;
	/** Total tool calls in this turn */
	tool_call_count: number;
	/** Files written during this turn */
	files_written: string[];
	/** Files read during this turn */
	files_read: string[];
	/** Commands run during this turn */
	commands_run: string[];
	/** Warnings emitted during this turn */
	warning_count: number;
	/** Blocks emitted during this turn */
	block_count: number;
	/** Patterns detected across the turn (e.g., "edit-without-test", "repeated-failure") */
	turn_patterns: string[];
	/** Current sensitivity level at turn end */
	sensitivity_level: SensitivityLevel;
	/** Elapsed time since session start (ms) */
	turn_duration_ms: number;
}

// ===========================================
// Cross-Session Learned Rules
// ===========================================

/** A rule learned from repeated agent behavior, persisted across sessions */
export interface LearnedRule {
	/** The permission pattern (e.g., "Bash(npm test *)") */
	pattern: string;
	/** How many times this pattern was observed before learning */
	observation_count: number;
	/** "allow" — only safe patterns are learned */
	decision: "allow";
	/** When this rule was first observed */
	first_seen: string;
	/** When the threshold was crossed and the rule was persisted */
	learned_at: string;
	/** Session ID where the rule was learned */
	learned_in_session: string;
}
