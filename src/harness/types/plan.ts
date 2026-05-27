// interlinked-tdd: exempt
// ===========================================
// Captured Plan — shared types
// ===========================================
//
// An agent-emitted plan captured at PreToolUse (TaskCreate, ExitPlanMode) or
// UserPromptSubmit (structured `## Plan` markdown, behind a config flag).
//
// Persisted append-only to `.interlinked/plans/<session_id>.jsonl` (each line
// is one CapturedPlan; replanning produces a new line with the same
// session_id, never edits the prior line). Mirrored in
// `SessionTrajectory.declared_plan` as the most recent capture.
//
// Used by:
//   - plan-capture.ts (PB&J Free-CLI item #2) — writes
//   - plan-drift.ts (PB&J Free-CLI item #6) — reads, compares against
//     session.tool_sequence at Stop
//   - Future Tier 2 cloud Plan/Policy Approver (Xiang et al. §II-B) — reads

/** Where the captured plan came from. Source affects parser logic and
 *  confidence; it does NOT affect storage shape. */
export type PlanSource = "TaskCreate" | "ExitPlanMode" | "structured_userprompt";

/** Execution status of a plan step. `pending` at capture; advanced to
 *  `executed` when the drift detector fuzzy-matches a step against a
 *  tool_sequence entry. `skipped` is reserved for steps whose preconditions
 *  were not met (e.g., a step was conditional on an earlier outcome). */
export type PlanStepStatus = "pending" | "executed" | "skipped";

export interface PlanStep {
	/** What the agent said it would do, in its own words (the source of
	 *  truth for human-readable diff at Stop). */
	intent: string;
	/** Tool the agent likely intends to use (e.g., "Write", "Bash",
	 *  "WebFetch"). Best-effort extraction by the parser; absent for
	 *  free-form natural-language steps. */
	tool_hint?: string;
	/** File path / URL / DB / channel / etc. the step targets.
	 *  Best-effort extraction. */
	target_hint?: string;
	/** Updated as the trajectory progresses; starts as "pending". */
	status: PlanStepStatus;
}

export interface CapturedPlan {
	session_id: string;
	agent_name: string;
	/** ISO 8601 timestamp at capture. */
	created_at_iso: string;
	/** session.tool_call_count at capture; lets the drift detector
	 *  scope comparison to "since the plan was declared." */
	created_at_step: number;
	source: PlanSource;
	steps: PlanStep[];
}
