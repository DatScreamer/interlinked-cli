// test-contract: durable transport — cloud claims are normalized for the
// authenticated evaluator and remote acknowledgement happens only afterward.

import { describe, expect, it, vi } from "vitest";
import { authenticateFixture } from "./protocol-v3/test-authentication.js";
import { validMutationResult } from "./protocol-v3/test-envelopes.js";
import {
	MutationCloudV3Client,
	type MutationCloudFetch,
} from "./mutation-cloud-v3-client.js";
import type { RemoteMutationJobIdentity } from "./mutation-job-processor.js";
import type { MutationJournalAck } from "./mutation-journal-types.js";
import { MAX_REPORT_BYTES } from "./protocol-v3/field-checks.js";

const JOB: RemoteMutationJobIdentity = {
	remoteJobId: "job_0001",
	acceptanceReceiptHash: "b".repeat(64),
};

const CONFIG = {
	baseUrl: "https://cloud.example/",
	token: "test-token",
	projectRef: "p_cli",
	claimantId: "cli_installation_1",
	timeoutMs: 5_000,
};

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function terminalFixture(): {
	claim: Record<string, unknown>;
	report: Uint8Array;
	resultHash: string;
	acceptanceHash: string;
} {
	// SAFETY: the test fabricator accepts a JSON object and the production
	// parser later reconstructs and validates the complete envelope.
	const fabricated = authenticateFixture(validMutationResult() as unknown as Record<string, unknown>);
	const envelope = fabricated.raw;
	const resultHash = String(envelope.result_hash);
	const acceptanceHash = String(envelope.acceptance_receipt_hash);
	return {
		claim: {
			state: "leased",
			job_key: "job_0001",
			lease_id: "filled-by-test",
			lease_until: "2026-08-31T13:01:00.000Z",
			result_hash: resultHash,
			bundle: {
				envelope,
				acceptance_receipt: JSON.parse(fabricated.inputs.receipts.acceptance),
				execution_receipt: JSON.parse(fabricated.inputs.receipts.execution ?? "null"),
			},
		},
		report: fabricated.inputs.report ?? new Uint8Array(),
		resultHash,
		acceptanceHash,
	};
}

function clientWith(fetchImpl: MutationCloudFetch): MutationCloudV3Client {
	return new MutationCloudV3Client(CONFIG, fetchImpl);
}

function claimWithCapturedLease(fixture: ReturnType<typeof terminalFixture>, initBody: unknown): Record<string, unknown> {
	const parsed = JSON.parse(String(initBody)) as { lease_id: string };
	return { ...fixture.claim, lease_id: parsed.lease_id };
}

describe("MutationCloudV3Client", () => {
	it("P: treats a not-ready claim as pending without inventing evidence", async () => {
		const fetchImpl = vi.fn<MutationCloudFetch>().mockResolvedValue(json({ error: "not ready" }, 409));
		await expect(clientWith(fetchImpl).claimResult(JOB)).resolves.toEqual({ kind: "pending" });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("P: claims a terminal bundle, retrieves the hash-bound report, and emits the strict evaluator wrapper", async () => {
		const fixture = terminalFixture();
		const calls: Array<{
			url: string;
			body: string | undefined;
			authorization: string | undefined;
			redirect: "error";
		}> = [];
		const fetchImpl: MutationCloudFetch = async (url, init) => {
			calls.push({
				url,
				body: init.body,
				authorization: init.headers.authorization,
				redirect: init.redirect,
			});
			if (init.method === "POST") return json(claimWithCapturedLease(fixture, init.body));
			return new Response(Buffer.from(fixture.report).toString("utf8"), {
				status: 200,
				headers: { "x-interlinked-sha256": fixture.resultHash },
			});
		};
		const job = { ...JOB, acceptanceReceiptHash: fixture.acceptanceHash };
		const result = await clientWith(fetchImpl).claimResult(job);
		expect(result).toEqual({
			kind: "terminal",
			evidence: expect.objectContaining({
				envelope: expect.objectContaining({ result_hash: fixture.resultHash }),
				acceptance_receipt: expect.any(String),
				execution_receipt: expect.any(String),
				terminalization_record: null,
				report_bytes: Uint8Array.from(fixture.report),
			}),
		});
		expect(calls).toHaveLength(2);
		expect(calls[1]?.url).toContain("/report?project_ref=p_cli");
		expect(calls.every((call) => call.authorization === "Bearer test-token")).toBe(true);
		expect(calls.every((call) => call.redirect === "error")).toBe(true);
	});

	it("N: rejects a terminal result bound to a foreign acceptance receipt", async () => {
		const fixture = terminalFixture();
		const fetchImpl: MutationCloudFetch = async (_url, init) => json(claimWithCapturedLease(fixture, init.body));
		await expect(clientWith(fetchImpl).claimResult(JOB)).rejects.toThrow("different acceptance receipt");
	});

	it("N: rejects a report whose retrieved bytes disagree with the authenticated pointer", async () => {
		const fixture = terminalFixture();
		let calls = 0;
		const fetchImpl: MutationCloudFetch = async (_url, init) => {
			calls++;
			return calls === 1
				? json(claimWithCapturedLease(fixture, init.body))
				: new Response("tampered report", { status: 200 });
		};
		await expect(
			clientWith(fetchImpl).claimResult({ ...JOB, acceptanceReceiptHash: fixture.acceptanceHash }),
		).rejects.toThrow("report bytes disagree");
	});

	it("N: rejects an oversized authenticated report pointer before requesting the report", async () => {
		const fixture = terminalFixture();
		// SAFETY: terminalFixture constructs the bundle and envelope as plain
		// JSON objects specifically for adversarial transport mutation.
		const bundle = fixture.claim.bundle as Record<string, unknown>;
		// SAFETY: same test-fabricator invariant as the bundle cast above.
		const envelope = bundle.envelope as Record<string, unknown>;
		envelope.report = { r2_sha256: "a".repeat(64), bytes: MAX_REPORT_BYTES + 1 };
		const fetchImpl = vi.fn<MutationCloudFetch>(async (_url, init) =>
			json(claimWithCapturedLease(fixture, init.body)),
		);

		await expect(
			clientWith(fetchImpl).claimResult({ ...JOB, acceptanceReceiptHash: fixture.acceptanceHash }),
		).rejects.toThrow(`${MAX_REPORT_BYTES}-byte`);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("N: requires exactly one execution or terminalization receipt", async () => {
		const fixture = terminalFixture();
		const claim = fixture.claim;
		// SAFETY: terminalFixture constructs this property as a plain object.
		const bundle = (claim.bundle ?? {}) as Record<string, unknown>;
		bundle.terminalization_record = bundle.execution_receipt;
		const fetchImpl: MutationCloudFetch = async (_url, init) => json(claimWithCapturedLease(fixture, init.body));
		await expect(
			clientWith(fetchImpl).claimResult({ ...JOB, acceptanceReceiptHash: fixture.acceptanceHash }),
		).rejects.toThrow("exactly one");
	});

	it("P: reclaims the deterministic remote lease before journal-backed acknowledgement", async () => {
		const fixture = terminalFixture();
		const bodies: Record<string, unknown>[] = [];
		const fetchImpl: MutationCloudFetch = async (url, init) => {
			// SAFETY: the production client generated this JSON request body.
			const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
			bodies.push(body);
			if (url.endsWith("/ack")) {
				return json({ state: "acknowledged", job_key: "job_0001", idempotent_replay: false });
			}
			return json(claimWithCapturedLease(fixture, init.body));
		};
		const ack = {
			jobId: "local_1",
			leaseToken: "local-lease",
			acceptanceReceiptHash: fixture.acceptanceHash,
			resultHash: fixture.resultHash,
			evaluatorPolicyVersion: "policy-v1",
		// SAFETY: production creates this opaque value only from the committed
		// SQLite row; this transport test needs only its public bound fields.
		} as MutationJournalAck;
		await clientWith(fetchImpl).acknowledge(
			{ ...JOB, acceptanceReceiptHash: fixture.acceptanceHash },
			ack,
		);
		expect(bodies).toHaveLength(2);
		expect(bodies[0]?.lease_id).toBe(bodies[1]?.lease_id);
		expect(bodies[1]?.result_hash).toBe(fixture.resultHash);
	});
});
