// interlinked-tdd: exempt — type declarations only, no runtime logic.
// ===========================================
// Sequence detectors — types
// ===========================================
// A SequenceDetector is a pure function over (SessionTrajectory, candidate
// event). Sibling family to the per-file content checks in `check-registry/`,
// but the contract is different — sequence detectors fire on trajectory
// shape, not file content. See `docs/design/trajectory-detectors-implementation-plan.md`.

import type { HarnessEvent, SessionTrajectory } from "../types.js";

/**
 * Family classification. Reading aid; the dispatcher does not branch on family.
 * - `security-shape`: supply-chain, env injection, repetition shapes
 * - `cross-agent`: multi-player staleness / coordination
 * - `injection`: lethal-trifecta / prompt-injection / exfiltration
 * - `quality`: coverage, doc drift, refactor hygiene, plan adherence
 */
export type SequenceDetectorFamily =
	| "security-shape"
	| "cross-agent"
	| "injection"
	| "quality";

/**
 * Phase at which a sequence detector runs.
 * - `pre_block`: PreToolUse, fully-deterministic, low-FP, blocks by default.
 * - `pre_warn`: PreToolUse, deterministic, warn-only.
 * - `stop`: Stop-event scan, runs after-the-fact alongside `stop-rescan.ts`.
 *
 * Sequence detectors are always `fully_deterministic` — they match on event
 * shape, never on inferred intent. The framework asserts this in the registry
 * by accepting only that determinism value on each entry.
 */
export type SequenceDetectorPhase = "pre_block" | "pre_warn" | "stop";

/**
 * One match emitted by a sequence detector. The required field is `message`
 * (the text the agent sees); everything else is optional so that wrappers
 * around existing string-returning consumers (turn-end / pattern-detector)
 * can be added during the PR6 migration without back-filling structured
 * fields they never tracked. See implementation plan §3.3.
 */
export interface SequenceMatch {
	/** Optional — for detectors that operate on multiple prior events. */
	prior_event_count?: number;
	/** Optional — human-readable summary of the anchor events. */
	prior_summary?: string;
	/** Required — the message shown to the agent. */
	message: string;
	/** Optional — up to ~3 short quoted snippets that are the basis for the finding. */
	evidence?: string[];
}

/**
 * Detector function. Pure: must not mutate the trajectory and must not throw.
 * The dispatcher wraps each call in try/catch and swallows exceptions so a
 * bug in one detector cannot break the harness (parity with `quality-checks.ts`).
 */
export type SequenceDetectorFn = (
	trajectory: Readonly<SessionTrajectory>,
	candidate: Readonly<HarnessEvent>,
) => SequenceMatch[];

/** Registry entry for a sequence detector. */
export interface SequenceDetector {
	/** Unique snake_case identifier (used for config + suppression markers). */
	id: string;
	/** Display name; used in formatted warnings. */
	description: string;
	family: SequenceDetectorFamily;
	phase: SequenceDetectorPhase;
	fn: SequenceDetectorFn;
	/** Default enabled state; user can override via `.interlinked` config. */
	default_enabled: boolean;
	/**
	 * Determinism tag — always `fully_deterministic`. Hard-coded into the type
	 * because sequence detectors that aren't deterministic should not exist
	 * at this tier. The cloud classifier (Tier 2) is the LLM tier.
	 */
	determinism: "fully_deterministic";
}

/** A finding emitted by the dispatcher: which detector fired, with the match. */
export interface SequenceFinding {
	detector_id: string;
	family: SequenceDetectorFamily;
	phase: SequenceDetectorPhase;
	match: SequenceMatch;
}
