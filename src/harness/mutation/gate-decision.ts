// ===========================================
// Per-edit mutation — gate decision helpers (extracted from gate.ts)
// ===========================================
// The wire-shape half of the gate: turn outcomes into HarnessDecisions, apply
// warn-mode downgrades, and — the review 2026-08-24 item-4 fix — route EVERY
// "could not measure" exit through one function that obeys
// `unavailable_behavior`. gate.ts keeps the orchestration; this module keeps
// the policy of what a decision looks like.

import type { HarnessDecision } from "../types/decisions.js";
import type { MutationGateOutcome, MutationManifest, MutationReceipt } from "./types.js";
import { mutationOutcomeToDecision, redWitnessWarning } from "./verdict.js";

export const RULE_ID = "per-edit-mutation";
export const CATEGORY = "mutation";

/** Structural view of the two config fields decisions depend on — kept
 *  structural (not imported from gate.ts) so this module never cycles back
 *  into its orchestrator. */
export interface GateDecisionConfig {
	mode: "block" | "warn" | "off";
	unavailable_behavior: "allow_unmeasured" | "block";
}

export function notMeasured(reason: string): MutationGateOutcome {
	return { kind: "unavailable", reason, warning: `[mutation:not-measured] ${reason}` };
}

export function failClosed(reason: string): HarnessDecision {
	return {
		decision: "block",
		reason: `[interlinked:mutation] BLOCKED: ${reason} (unavailable_behavior=block).`,
		rule_id: RULE_ID,
		severity: "medium",
		category: CATEGORY,
	};
}

export function applyMode(decision: HarnessDecision, mode: GateDecisionConfig["mode"]): HarnessDecision {
	if (mode === "warn" && decision.decision === "block") {
		return {
			decision: "allow",
			warnings: [decision.reason ?? "[interlinked:mutation] finding"],
			rule_id: decision.rule_id,
			category: decision.category,
		};
	}
	return decision;
}

/**
 * Review 2026-08-24, item 4: the ONE choke point for "could not measure".
 * Every unavailable outcome — no runner, a runner exception, missing shards,
 * an evaluator that could not conclude, a partial run with no finding — obeys
 * `unavailable_behavior` here. Warn mode downgrades the fail-closed block the
 * same way it downgrades any other block.
 */
export function unavailableDecision(config: GateDecisionConfig, reason: string): HarnessDecision {
	if (config.unavailable_behavior === "block") {
		return applyMode(failClosed(`mutation could not be measured — ${reason}`), config.mode);
	}
	return mutationOutcomeToDecision(notMeasured(reason));
}

/**
 * Persist the refreshed manifest + receipt iff the OUTCOME earned it: a
 * measured-clean allow (spec §4/§12) or a first-sighting baseline adoption
 * (review 2026-08-28 item 1 — adoption RECORDS the floor, so it must persist,
 * while remaining a distinct kind so it can never be reported as clean).
 * Keyed off the outcome — not the wire decision — so warn-mode (which
 * downgrades blocks) can never launder a dirty run into a manifest refresh.
 * Returns a warning when persistence failed (the allow stands; the next run
 * simply re-measures), else null.
 */
export function persistIfCleanMeasured(
	outcome: MutationGateOutcome,
	persist: ((manifest: MutationManifest, receipt: MutationReceipt) => void) | undefined,
): string | null {
	// Adoption persists through `adoptionDecision` below, never here — its
	// message depends on whether persistence SUCCEEDED, which this function's
	// string-or-null contract cannot express.
	if (outcome.kind !== "measured" || outcome.decision !== "allow") return null;
	if (!outcome.refreshedManifest || !persist) return null;
	try {
		persist(outcome.refreshedManifest, outcome.receipt);
		return null;
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		// Same honest wording as the adoption path (Grok 2026-08-28 issue 3):
		// `makeManifestPersister` writes the manifest THEN the receipt, so a
		// mid-sequence throw can leave a valid manifest the next run trusts —
		// "next run re-measures" alone understated that split-brain.
		return `[interlinked:mutation] manifest persistence failed partway (${detail}) — the on-disk mutation state may be PARTIAL (a manifest can exist without its receipt or index). The allow stands; the next run re-measures against whatever survived.`;
	}
}

/** The one exit for a measured/adoption outcome: route adoption through the
 *  persist-then-declare path, everything else through the ordinary mapping with
 *  the measured-clean persist. Keeps the branch out of the (at-cap) gate
 *  orchestrator and gives the two persistence policies a single seam. */
export function decideAndPersist(
	outcome: MutationGateOutcome,
	persist: ((manifest: MutationManifest, receipt: MutationReceipt) => void) | undefined,
	mode: GateDecisionConfig["mode"],
): HarnessDecision {
	if (outcome.kind === "baseline_adoption_ready") {
		return applyMode(adoptionDecision(outcome, persist), mode);
	}
	const persistWarning = persistIfCleanMeasured(outcome, persist);
	const decision = applyMode(mutationOutcomeToDecision(outcome), mode);
	if (persistWarning) decision.warnings = [...(decision.warnings ?? []), persistWarning];
	return decision;
}

type AdoptionReady = Extract<MutationGateOutcome, { kind: "baseline_adoption_ready" }>;

/**
 * Review 2026-08-28 item 1: "adopted" is declared only after the persistence
 * callback completes — NOT an atomic or crash-durable commit (the file-based
 * sequence can still be partial after a crash until the SQLite journal), so it is
 * declared only after persistence succeeds. The evaluator returns
 * `baseline_adoption_ready` with the success message pre-built; this function
 * performs the persist and picks the honest message:
 *  - persist succeeded  → the adoption warning ("baseline adopted … NOT
 *    certified clean").
 *  - persist threw      → "measured but NOT fully adopted — persistence failed
 *    partway": the on-disk state may be PARTIAL (the sequence has no
 *    transaction, so a valid manifest can survive without its receipt), and
 *    the next run re-measures against whatever survived.
 *  - no persist callback → same NOT-adopted downgrade: a gate constructed
 *    without persistence cannot create a floor, only observe.
 * The RED-witness warning (item 3) rides along in every branch — a new test
 * that never failed on base matters MORE when the adopted floor rests on it.
 */
export function adoptionDecision(
	outcome: AdoptionReady,
	persist: ((manifest: MutationManifest, receipt: MutationReceipt) => void) | undefined,
): HarnessDecision {
	let failure: string | null = null;
	if (persist === undefined) {
		failure = "no persistence configured";
	} else {
		try {
			persist(outcome.refreshedManifest, outcome.receipt);
		} catch (err) {
			failure = err instanceof Error ? err.message : String(err);
		}
	}
	// The failure wording must not overclaim (review 2026-08-28 second pass,
	// finding 2): persistence is manifest → receipt → survivor index → ledger
	// row with no transaction, so a mid-sequence throw can leave a VALID
	// manifest on disk that the next run will trust. "No durable floor exists"
	// was reproduced as false; say what is actually known — the sequence did
	// not complete — until the SQLite journal makes adoption atomic.
	const headline =
		failure === null
			? outcome.warning
			: `[interlinked:mutation] baseline measured but NOT fully adopted — persistence failed partway (${failure}). The on-disk mutation state may be PARTIAL (a manifest can exist without its receipt or index); the next run re-measures against whatever survived. Not certified clean.`;
	const warnings = outcome.redWitnessFailed ? [headline, redWitnessWarning()] : [headline];
	return { decision: "allow", warnings, rule_id: RULE_ID, category: CATEGORY };
}
