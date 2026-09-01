// ===========================================
// Protocol v3 — verified evidence → ONE local evaluator
// ===========================================
// This is the only composition seam between authenticated cloud evidence and
// baseline/policy semantics. The cloud reports observations; evaluate.ts owns
// adoption, ratcheting, blocking, and manifest refresh. No verdict is accepted
// from the wire and no parallel evaluator exists here.

import {
	mintAuthenticatedNoTestPolicy,
	mintAuthenticatedZeroMutantCensus,
} from "../authenticated-zero-census.js";
import { evaluateMutation } from "../evaluate.js";
import type { MutationGateOutcome, MutationManifest } from "../types.js";
import { authenticatedEvidenceToMutationRun } from "./evaluator-bridge.js";
import { classifyEvidence, type V3EvidenceClassification } from "./evidence.js";
import { isVerifiedEvidenceBundle, type VerifiedEvidenceBundle } from "./verify.js";

export interface VerifiedEvaluatorInput {
	bundle: VerifiedEvidenceBundle;
	/** Exact local overlay bytes submitted in the authenticated job request. */
	targetContent: string;
	baseManifest: MutationManifest;
	siteCountThreshold: number;
	at: string;
	/** First-sighting adoption is permitted only for an explicit background
	 * onboarding measurement of current code. Per-edit/durable callers omit
	 * this or choose require_established so a proposed edit cannot
	 * grandfather its own survivors. */
	baselineIntent?: "require_established" | "adopt_current";
	cwd?: string;
}

export interface VerifiedMutationEvaluation {
	outcome: MutationGateOutcome;
	evidence: V3EvidenceClassification;
	resultHash: string;
}

function unavailable(reason: string): MutationGateOutcome {
	return { kind: "unavailable", reason, warning: `[mutation:not-measured] ${reason}` };
}

/** Evaluate a fully authenticated protocol-v3 bundle under local policy. */
export function evaluateVerifiedMutationEvidence(
	input: VerifiedEvaluatorInput,
): VerifiedMutationEvaluation {
	if (!isVerifiedEvidenceBundle(input.bundle)) {
		throw new Error("protocol-v3 evidence bundle was not minted by the verifier");
	}
	const evidence = classifyEvidence(input.bundle);
	const resultHash = input.bundle.envelope.result_hash;
	if (evidence.completeness === "none") {
		return {
			outcome: unavailable(evidence.incompleteness_reasons.join("; ") || "mutation evidence is absent"),
			evidence,
			resultHash,
		};
	}
	const bridged = authenticatedEvidenceToMutationRun(input.bundle, input.targetContent);
	if (!bridged.ok) {
		return { outcome: unavailable(bridged.reason), evidence, resultHash };
	}
	const zeroCensus = mintAuthenticatedZeroMutantCensus(input.bundle);
	const noTestPolicy = mintAuthenticatedNoTestPolicy(input.bundle);
	const outcome = evaluateMutation({
		file: input.bundle.envelope.job.target_file,
		baseManifest: input.baseManifest,
		overlayContent: input.targetContent,
		adapted: bridged.run.mutants,
		siteCountThreshold: input.siteCountThreshold,
		at: input.at,
		...(bridged.run.testRun === undefined ? {} : { testRun: bridged.run.testRun }),
		...(bridged.run.engineExitCode === undefined ? {} : { engineExitCode: bridged.run.engineExitCode }),
		...(bridged.run.executedTestCount === undefined ? {} : { executedTestCount: bridged.run.executedTestCount }),
		...(bridged.run.droppedMutants === undefined ? {} : { droppedMutants: bridged.run.droppedMutants }),
		...(bridged.run.evidenceGaps === undefined ? {} : { evidenceGaps: bridged.run.evidenceGaps }),
		...(evidence.incompleteness_reasons.length === 0
			? {}
			: { evidenceGaps: evidence.incompleteness_reasons }),
		...(zeroCensus === null
			? {}
			: {
				authenticatedZeroMutantCensus: zeroCensus,
				authenticatedEvidenceResultHash: resultHash,
			}),
		...(noTestPolicy === null ? {} : { authenticatedNoTestPolicy: noTestPolicy }),
		...(input.cwd === undefined ? {} : { cwd: input.cwd }),
	});
	if (outcome.kind === "baseline_adoption_ready" && input.baselineIntent !== "adopt_current") {
		return {
			outcome: unavailable(
				"no established mutation baseline exists for this target; run an explicit background onboarding measurement of current code before evaluating proposed edits",
			),
			evidence,
			resultHash,
		};
	}
	return { outcome, evidence, resultHash };
}
