// Check-registry types: shared by entry files and builders.

import type { Determinism } from "../types.js";

/** A single match found by an inline check */
export interface InlineMatch {
	/** 1-based line number */
	line: number;
	/** Trimmed text of the matching line (truncated to 150 chars) */
	text: string;
}

/**
 * Phase at which a check runs.
 *
 * - `pre_block`: runs in PreToolUse, fires `decision: "ask"` (user-confirmed
 *   bypass). Reserved for fully-deterministic, zero-FP errors where blocking
 *   at edit time trains the agent that the rule is a hard rail.
 * - `pre_warn`: runs in PreToolUse, emits a warning before the write lands so
 *   the agent sees the rule at edit time (behavioral priming) without
 *   blocking. Reserved for fully-deterministic or low-FP partial-deterministic
 *   checks.
 * - `post`: runs in PostToolUse only. Default for heuristic warnings where
 *   pre-block would train the model to distrust all rails.
 *
 * Each check has exactly one phase. A `pre_block` check that lands anyway
 * (user approved the bypass) is not re-surfaced in Post — the user's
 * decision is authoritative.
 */
export type CheckPhase = "pre_block" | "pre_warn" | "post";

/** Complete definition of an inline check */
export interface CheckRegistration {
	/** Unique snake_case identifier (e.g., "misused_promises") */
	id: string;
	/** Display name (e.g., "Misused Promises") */
	name: string;
	/** Description */
	description: string;
	/** Performance tier: 1=sub-100ms, 2=sub-1s, 3=conditional */
	tier: 1 | 2 | 3;
	/** Determinism classification */
	determinism: Determinism;
	/** Severity when check fires */
	severity: "error" | "warning";
	/** Which pipeline runs this check */
	pipeline: "agent_safety" | "suggestion";
	/** When this check fires — see CheckPhase for semantics */
	phase: CheckPhase;
	/** Fix instruction shown to agent */
	fix_instruction: string;
	/** Check function — takes (content, filePath), returns InlineMatch[] */
	fn: (content: string, filePath: string) => InlineMatch[];
	/** camelCase property name for CodeQualityResults (e.g., "misusedPromises") */
	resultsPropName: string;
}
