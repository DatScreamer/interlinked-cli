// test-contract: authenticated durable evidence is bound to the locally
// journaled request/admission and can reach only the one mutation evaluator.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { emptyManifest } from "./manifest.js";
import type {
	ClaimedMutationJob,
	JournalManifestHead,
} from "./mutation-journal-types.js";
import {
	ProtocolV3MutationJobEvaluator,
	type ProtocolV3RemoteEvidence,
} from "./protocol-v3-job-evaluator.js";
import { canonicalJson } from "./protocol-v3/canonical.js";
import {
	authenticateFixture,
	TEST_NOW,
	TEST_REGISTRY,
} from "./protocol-v3/test-authentication.js";
import {
	MUTATION_RESULT_TARGET_CONTENT,
	validMutationResult,
} from "./protocol-v3/test-envelopes.js";
import { parseAndVerify } from "./protocol-v3/verify.js";

const META = {
	engine: "stryker",
	engineVersion: "8.2.0",
	dependencyGraphVersion: "fixture",
	environmentHash: "fixture",
	authoritativeAt: "2026-08-31T11:00:00.000Z",
};

function digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function manifestHead(snapshot: unknown, version = 0): JournalManifestHead {
	return { version, snapshot, hash: "a".repeat(64) };
}

function fixtureFor(raw: object, targetContent = MUTATION_RESULT_TARGET_CONTENT) {
	const authenticated = authenticateFixture(raw as Record<string, unknown>);
	const targetBytes = Buffer.from(targetContent, "utf8");
	const job: ClaimedMutationJob = {
		jobId: "local-job-0001",
		remoteJobId: authenticated.inputs.expectedJob.job_key,
		acceptanceReceiptHash: String(authenticated.raw.acceptance_receipt_hash),
		expectedJob: { ...authenticated.inputs.expectedJob },
		expectedAdmission: {
			request_hash: authenticated.inputs.expectedAdmission.request_hash,
			changeset_hash: authenticated.inputs.expectedAdmission.changeset_hash,
			source_artifact: { ...authenticated.inputs.expectedAdmission.source_artifact },
		},
		targetBytes,
		targetSha256: digest(targetBytes),
		baselineIntent: "require_established",
		createdAtMs: 1,
		phase: "poll",
		leaseToken: "lease-0001",
		leaseExpiresAtMs: 10_000,
		claimCount: 1,
	};
	const evidence: ProtocolV3RemoteEvidence = {
		envelope: authenticated.raw,
		acceptance_receipt: authenticated.inputs.receipts.acceptance,
		execution_receipt: authenticated.inputs.receipts.execution ?? null,
		terminalization_record: authenticated.inputs.receipts.terminalization ?? null,
		report_bytes: authenticated.inputs.report ?? null,
	};
	return { authenticated, evidence, job };
}

function fullyExecutableMutationResult() {
	const raw = validMutationResult();
	raw.excluded = [];
	raw.census = { generated: raw.mutants.length, executable: raw.mutants.length, approved_excluded: 0 };
	return raw;
}

function evaluator(authority = { tenant: "t_dev", project: "p_cli" }): ProtocolV3MutationJobEvaluator {
	return new ProtocolV3MutationJobEvaluator({
		keyRegistry: TEST_REGISTRY,
		serverAuthority: authority,
		clock: () => TEST_NOW,
		evaluatorPolicyVersion: "mutation-policy-v3-test",
		siteCountThreshold: 50,
	});
}

describe("ProtocolV3MutationJobEvaluator", () => {
	it("P: refuses self-adoption, then explicit onboarding enables a later measured-clean draft", async () => {
		const fixture = fixtureFor(fullyExecutableMutationResult());
		const adapter = evaluator();
		const refused = await adapter.evaluate({
			job: fixture.job,
			evidence: fixture.evidence,
			manifestHead: manifestHead(emptyManifest(META)),
		});
		expect(refused.decision).toMatchObject({ verdict: "not_measured" });
		expect(refused.receipt).toMatchObject({ verdict: "not_measured", mutation_receipt: null });
		expect(JSON.stringify(refused)).not.toContain("baseline_adopted");

		const onboarding = await evaluator().evaluate({
			job: { ...fixture.job, baselineIntent: "adopt_current" },
			evidence: fixture.evidence,
			manifestHead: manifestHead(emptyManifest(META)),
		});
		expect(onboarding.decision).toMatchObject({ verdict: "baseline_adopted" });
		expect(onboarding.receipt).toMatchObject({
			verdict: "baseline_adopted",
			mutation_receipt: { outcome: "baseline_adopted" },
		});
		expect(onboarding.manifestSnapshot).toMatchObject({ generation: 1 });
		expect(onboarding.findings).toHaveLength(1);
		expect(onboarding.findings[0]?.payload).toMatchObject({
			category: "baseline_adoption",
			severity: "warning",
		});

		const second = await adapter.evaluate({
			job: fixture.job,
			evidence: fixture.evidence,
			manifestHead: manifestHead(onboarding.manifestSnapshot, 1),
		});
		expect(second.decision).toMatchObject({ verdict: "clean" });
		expect(second.receipt).toMatchObject({
			verdict: "clean",
			mutation_receipt: { outcome: "measured_clean" },
		});
		expect(second.manifestSnapshot).toMatchObject({ generation: 2 });
		expect(second.findings).toEqual([]);
		expect(second.authenticatedEvidenceHash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("P: retained canonical evidence supports offline re-authentication with exact report bytes", async () => {
		const fixture = fixtureFor(fullyExecutableMutationResult());
		const parsedAcceptance: unknown = JSON.parse(fixture.evidence.acceptance_receipt);
		fixture.evidence.acceptance_receipt = JSON.stringify(parsedAcceptance, null, 2);
		const draft = await evaluator().evaluate({
			job: fixture.job,
			evidence: fixture.evidence,
			manifestHead: manifestHead(emptyManifest(META)),
		});
		const retained = draft.retainedEvidence;

		expect(retained.formatVersion).toBe(1);
		expect(retained.acceptanceReceipt.canonicalJson).toBe(canonicalJson(parsedAcceptance));
		expect(retained.acceptanceReceipt.canonicalJson).not.toBe(fixture.evidence.acceptance_receipt);
		expect(Buffer.from(retained.report?.bytes ?? [])).toEqual(fixture.authenticated.inputs.report);
		const execution = retained.executionReceipt;
		if (execution === null) throw new Error("executable fixture did not retain its execution receipt");
		const replay = parseAndVerify(JSON.parse(retained.envelope.canonicalJson), {
			expectedJob: fixture.authenticated.inputs.expectedJob,
			serverAuthority: fixture.authenticated.inputs.serverAuthority,
			expectedAdmission: fixture.authenticated.inputs.expectedAdmission,
			keyRegistry: TEST_REGISTRY,
			now: TEST_NOW,
			receipts: {
				acceptance: retained.acceptanceReceipt.canonicalJson,
				execution: execution.canonicalJson,
			},
			...(retained.report === null ? {} : { report: retained.report.bytes }),
		});
		expect(replay.ok).toBe(true);
	});

	it("N: explicit onboarding cannot adopt approved exclusions as executable mutant evidence", async () => {
		const fixture = fixtureFor(validMutationResult());
		const draft = await evaluator().evaluate({
			job: { ...fixture.job, baselineIntent: "adopt_current" },
			evidence: fixture.evidence,
			manifestHead: manifestHead(emptyManifest(META)),
		});

		expect(draft.decision).toMatchObject({ verdict: "not_measured" });
		expect(draft.receipt).toMatchObject({ verdict: "not_measured", mutation_receipt: null });
		expect(draft.manifestSnapshot).toEqual(emptyManifest(META));
		expect(JSON.stringify(draft.decision)).toContain(
			"approved exclusion rows are not executable mutant evidence",
		);
	});

	it("N: authenticated inconclusive evidence commits only explicit not-measured artifacts", async () => {
		const raw = validMutationResult();
		raw.mutants[0] = { ...raw.mutants[0]!, status: "timeout" };
		const fixture = fixtureFor(raw);
		const base = emptyManifest(META);
		const draft = await evaluator().evaluate({
			job: fixture.job,
			evidence: fixture.evidence,
			manifestHead: manifestHead(base),
		});

		expect(draft.decision).toMatchObject({ verdict: "not_measured" });
		expect(draft.receipt).toMatchObject({ verdict: "not_measured", mutation_receipt: null });
		expect(draft.manifestSnapshot).toEqual(base);
		expect(draft.findings).toHaveLength(1);
		expect(draft.findings[0]?.payload).toMatchObject({ category: "not_measured", severity: "warning" });
		expect(JSON.stringify(draft)).not.toContain("measured_clean");
	});

	it("N: rejects evidence bytes changed after the cloud signatures and hashes were created", async () => {
		const fixture = fixtureFor(validMutationResult());
		const runner = fixture.authenticated.raw.runner as Record<string, unknown>;
		runner.build = "tampered-runner-build";
		await expect(evaluator().evaluate({
			job: fixture.job,
			evidence: fixture.evidence,
			manifestHead: manifestHead(emptyManifest(META)),
		})).rejects.toThrow("result_hash mismatch");
	});

	it("N: rejects a valid signed result against a different caller-held source artifact admission", async () => {
		const fixture = fixtureFor(validMutationResult());
		fixture.job.expectedAdmission.source_artifact.sha256 = "0".repeat(64);
		await expect(evaluator().evaluate({
			job: fixture.job,
			evidence: fixture.evidence,
			manifestHead: manifestHead(emptyManifest(META)),
		})).rejects.toThrow("source_artifact binding mismatch");
	});

	it("N: checks the journal acceptance hash before calling the cryptographic verifier", async () => {
		const fixture = fixtureFor(validMutationResult());
		fixture.job.acceptanceReceiptHash = "0".repeat(64);
		await expect(evaluator().evaluate({
			job: fixture.job,
			evidence: fixture.evidence,
			manifestHead: manifestHead(emptyManifest(META)),
		})).rejects.toThrow("does not match the journal claim");
	});

	it("N: the strict remote wrapper rejects injected trust configuration and wrong-length reports", async () => {
		const fixture = fixtureFor(validMutationResult());
		const injected = { ...fixture.evidence, key_registry: TEST_REGISTRY };
		await expect(evaluator().evaluate({
			job: fixture.job,
			evidence: injected,
			manifestHead: manifestHead(emptyManifest(META)),
		})).rejects.toThrow("must contain exactly");

		const wrongLength = { ...fixture.evidence, report_bytes: new Uint8Array(1) };
		await expect(evaluator().evaluate({
			job: fixture.job,
			evidence: wrongLength,
			manifestHead: manifestHead(emptyManifest(META)),
		})).rejects.toThrow("declared report length");
	});

	it("N: server authority remains independently injected rather than copied from the journal or envelope", async () => {
		const fixture = fixtureFor(validMutationResult());
		await expect(evaluator({ tenant: "foreign", project: "p_cli" }).evaluate({
			job: fixture.job,
			evidence: fixture.evidence,
			manifestHead: manifestHead(emptyManifest(META)),
		})).rejects.toThrow("job tenant does not match the authenticated server authority");
	});
});
