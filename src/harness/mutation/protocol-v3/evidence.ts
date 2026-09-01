// ===========================================
// Protocol v3 — mechanical evidence classification
// ===========================================
// Review 2026-08-31 fourth pass: classification accepts ONLY the
// `VerifiedEvidenceBundle` the trust boundary mints — a merely parsed
// envelope plus a caller-controlled boolean could reach "complete"
// without signature, receipt, report, or policy verification. The bundle
// guarantees the report behind a pointer was structurally verified, so no
// report flag exists here at all. This module answers two mechanical
// questions:
//   1. How complete is the evidence? complete | partial | none, with reasons.
//   2. What was observed? killed / survived / uncovered / inconclusive
//      counts and whether the affected suite was red.
// Status semantics match the ONE local evaluator: `uncovered` is mutation
// debt (not a survivor); `timeout` / `indeterminate` are inconclusive and
// DEGRADE completeness. No clean verdict exists at this layer — the local
// evaluator combines these observations with the baseline and policy.

import type { V3MutantRow } from "./types.js";
import { isVerifiedEvidenceBundle, type VerifiedEvidenceBundle } from "./verify.js";

export interface V3EvidenceObservations {
	killed: number;
	survived: number;
	uncovered: number;
	inconclusive: number;
	suite_red: boolean;
}

export interface V3EvidenceClassification {
	completeness: "complete" | "partial" | "none";
	incompleteness_reasons: string[];
	observations: V3EvidenceObservations;
}

function countRows(rows: readonly V3MutantRow[], suiteRed: boolean): V3EvidenceObservations {
	const out: V3EvidenceObservations = {
		killed: 0,
		survived: 0,
		uncovered: 0,
		inconclusive: 0,
		suite_red: suiteRed,
	};
	for (const row of rows) {
		if (row.status === "killed") out.killed++;
		else if (row.status === "survived") out.survived++;
		else if (row.status === "uncovered") out.uncovered++;
		else out.inconclusive++; // timeout | indeterminate
	}
	return out;
}

function classification(
	completeness: V3EvidenceClassification["completeness"],
	reasons: string[],
	observations: V3EvidenceObservations,
): V3EvidenceClassification {
	return { completeness, incompleteness_reasons: reasons, observations };
}

const NO_OBSERVATIONS: V3EvidenceObservations = {
	killed: 0,
	survived: 0,
	uncovered: 0,
	inconclusive: 0,
	suite_red: false,
};

function classifyMutationResult(rows: readonly V3MutantRow[]): V3EvidenceClassification {
	const observations = countRows(rows, false);
	if (observations.inconclusive > 0) {
		return classification(
			"partial",
			[`${observations.inconclusive} inconclusive mutant(s) (timeout/indeterminate) — those sites are unmeasured`],
			observations,
		);
	}
	return classification("complete", [], observations);
}

/** Mechanically classify one VERIFIED evidence bundle. Pure; no policy,
 *  no verdict. */
export function classifyEvidence(bundle: VerifiedEvidenceBundle): V3EvidenceClassification {
	if (!isVerifiedEvidenceBundle(bundle)) {
		throw new Error("protocol-v3 evidence bundle was not minted by the verifier");
	}
	const envelope = bundle.envelope;
	switch (envelope.kind) {
		case "mutation_result":
			return classifyMutationResult(envelope.mutants);
		case "not_mutatable":
			return classification("complete", [], { ...NO_OBSERVATIONS });
		case "suite_red":
			return classification(
				"partial",
				["affected suite red — the mutant work-list is not authoritative"],
				countRows(envelope.mutants ?? [], true),
			);
		case "execution_failed": {
			const observations = countRows(envelope.mutants ?? [], envelope.test_run?.overlay_green === false);
			const reasons = [`execution failed: ${envelope.failure_classification}`];
			return classification(envelope.evidence_completeness, reasons, observations);
		}
		case "cancelled":
			return classification("none", [`cancelled: ${envelope.cancellation_reason}`], { ...NO_OBSERVATIONS });
		case "expired":
			return classification("none", [`expired: ${envelope.expiry_reason}`], { ...NO_OBSERVATIONS });
	}
}
