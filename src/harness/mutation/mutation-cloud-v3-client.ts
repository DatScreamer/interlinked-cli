// =====================================================
// Durable mutation jobs — authenticated cloud HTTP client
// =====================================================
// The client owns transport only. It never trusts a cloud verdict and never
// supplies verifier authority or keys from the response. A terminal claim is
// normalized into the strict wire wrapper consumed by the protocol-v3 journal
// evaluator; parse/authentication/local policy happen after the local lease is
// renewed and before the SQLite transaction commits.

import { createHash } from "node:crypto";
import { isJsonObject } from "../../lib/json-types.js";
import type {
	RemoteMutationJobClient,
	RemoteMutationJobIdentity,
} from "./mutation-job-processor.js";
import type { MutationJournalAck } from "./mutation-journal-types.js";
import {
	boundedErrorBody,
	type BoundedHttpResponse,
	hasExactJsonKeys,
	readBoundedJson,
	readExactBytes,
} from "./mutation-cloud-v3-http.js";
import { MAX_REPORT_BYTES } from "./protocol-v3/field-checks.js";

const CLAIM_PENDING_STATUS = 409;
const MAX_OPAQUE_ID_TAIL = 511;

interface FetchResponse extends BoundedHttpResponse {
	ok: boolean;
	status: number;
}

export type MutationCloudFetch = (
	url: string,
	init: {
		method: "GET" | "POST";
		headers: Record<string, string>;
		body?: string;
		signal: AbortSignal;
		redirect: "error";
	},
) => Promise<FetchResponse>;

export interface MutationCloudV3ClientConfig {
	baseUrl: string;
	token: string;
	projectRef: string;
	/** Stable installation/workspace identity, not an agent turn id. */
	claimantId: string;
	timeoutMs: number;
}

type CloudClaim =
	| { kind: "pending" }
	| { kind: "acknowledged" }
	| {
			kind: "leased";
			resultHash: string;
			bundle: Record<string, unknown>;
	  };

function defaultMutationCloudFetch(url: string, init: Parameters<MutationCloudFetch>[1]): Promise<FetchResponse> {
	return globalThis.fetch(url, {
		method: init.method,
		headers: init.headers,
		...(init.body === undefined ? {} : { body: init.body }),
		signal: init.signal,
		redirect: init.redirect,
	});
}

function remoteLeaseId(config: MutationCloudV3ClientConfig, job: RemoteMutationJobIdentity): string {
	const identity = `${config.claimantId}\0${job.remoteJobId}\0${job.acceptanceReceiptHash}`;
	return `lease_${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 40)}`;
}

function requireOpaque(value: unknown, field: string): string {
	const pattern = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${MAX_OPAQUE_ID_TAIL}}$`);
	if (typeof value !== "string" || !pattern.test(value)) {
		throw new Error(`mutation cloud ${field} is malformed`);
	}
	return value;
}

function requireHash(value: unknown, field: string): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
		throw new Error(`mutation cloud ${field} is not lowercase sha-256 hex`);
	}
	return value;
}

function reportPointer(envelope: Record<string, unknown>): { hash: string; bytes: number } | null {
	if (!("report" in envelope)) return null;
	if (!isJsonObject(envelope.report)) throw new Error("mutation cloud envelope.report is malformed");
	const hash = requireHash(envelope.report.r2_sha256, "report.r2_sha256");
	const bytes = envelope.report.bytes;
	if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1) {
		throw new Error("mutation cloud report.bytes is not a positive safe integer");
	}
	if (bytes > MAX_REPORT_BYTES) {
		throw new Error(`mutation cloud report exceeds the ${MAX_REPORT_BYTES}-byte response limit`);
	}
	return { hash, bytes };
}

function bundleReceipts(bundle: Record<string, unknown>): {
	acceptance: string;
	execution: string | null;
	terminalization: string | null;
} {
	const allowed = ["envelope", "acceptance_receipt", "execution_receipt", "terminalization_record"];
	if (Object.keys(bundle).some((key) => !allowed.includes(key))) {
		throw new Error("mutation cloud terminal bundle carries unknown fields");
	}
	if (!isJsonObject(bundle.acceptance_receipt)) {
		throw new Error("mutation cloud terminal bundle is missing its acceptance receipt");
	}
	const execution = isJsonObject(bundle.execution_receipt) ? JSON.stringify(bundle.execution_receipt) : null;
	const terminalization = isJsonObject(bundle.terminalization_record)
		? JSON.stringify(bundle.terminalization_record)
		: null;
	if ((execution === null) === (terminalization === null)) {
		throw new Error("mutation cloud terminal bundle must carry exactly one execution or terminalization receipt");
	}
	return {
		acceptance: JSON.stringify(bundle.acceptance_receipt),
		execution,
		terminalization,
	};
}

export class MutationCloudV3Client implements RemoteMutationJobClient {
	readonly #baseUrl: string;

	constructor(
		private readonly config: MutationCloudV3ClientConfig,
		private readonly fetchImpl: MutationCloudFetch = defaultMutationCloudFetch,
	) {
		this.#baseUrl = config.baseUrl.replace(/\/+$/, "");
		if (this.#baseUrl === "") throw new Error("mutation cloud baseUrl is required");
		if (config.token === "") throw new Error("mutation cloud token is required");
		if (config.timeoutMs <= 0 || !Number.isSafeInteger(config.timeoutMs)) {
			throw new Error("mutation cloud timeoutMs must be a positive safe integer");
		}
	}

	async claimResult(job: RemoteMutationJobIdentity): Promise<unknown> {
		const claim = await this.#claim(job);
		if (claim.kind === "pending") return { kind: "pending" };
		if (claim.kind === "acknowledged") {
			throw new Error("remote mutation result was acknowledged before this journal committed it");
		}
		const envelope = claim.bundle.envelope;
		if (!isJsonObject(envelope)) throw new Error("mutation cloud terminal bundle has no envelope");
		if (requireHash(envelope.result_hash, "envelope.result_hash") !== claim.resultHash) {
			throw new Error("mutation cloud claim result_hash disagrees with its envelope");
		}
		if (requireHash(envelope.acceptance_receipt_hash, "envelope.acceptance_receipt_hash") !== job.acceptanceReceiptHash) {
			throw new Error("mutation cloud result is bound to a different acceptance receipt");
		}
		const receipts = bundleReceipts(claim.bundle);
		const pointer = reportPointer(envelope);
		const report = pointer === null ? null : await this.#fetchReport(job, pointer);
		return {
			kind: "terminal",
			evidence: {
				envelope,
				acceptance_receipt: receipts.acceptance,
				execution_receipt: receipts.execution,
				terminalization_record: receipts.terminalization,
				report_bytes: report,
			},
		};
	}

	async acknowledge(job: RemoteMutationJobIdentity, ack: MutationJournalAck): Promise<void> {
		if (ack.acceptanceReceiptHash !== job.acceptanceReceiptHash) {
			throw new Error("journal acknowledgement is bound to a different acceptance receipt");
		}
		// Re-claim with the deterministic remote lease before acking. This makes
		// an evaluated row restart-safe even when the original remote lease expired
		// after the SQLite commit but before the remote acknowledgement.
		const claim = await this.#claim(job);
		if (claim.kind === "acknowledged") return;
		if (claim.kind !== "leased") throw new Error("remote mutation result is no longer ready for acknowledgement");
		if (claim.resultHash !== ack.resultHash) {
			throw new Error("journal acknowledgement result hash disagrees with the remote result");
		}
		const response = await this.#request(
			`/mutation/jobs/${encodeURIComponent(job.remoteJobId)}/ack`,
			"POST",
			{
				project_ref: this.config.projectRef,
				claimant_id: this.config.claimantId,
				lease_id: remoteLeaseId(this.config, job),
				result_hash: ack.resultHash,
			},
		);
		if (!response.ok) {
			throw new Error(`mutation cloud ack failed: HTTP ${response.status} ${await boundedErrorBody(response, [this.config.token])}`);
		}
		const body = await readBoundedJson(response, "mutation cloud acknowledgement response");
		if (!isJsonObject(body) || body.state !== "acknowledged" || body.job_key !== job.remoteJobId) {
			throw new Error("mutation cloud ack response is malformed");
		}
	}

	async #claim(job: RemoteMutationJobIdentity): Promise<CloudClaim> {
		requireOpaque(job.remoteJobId, "job id");
		requireHash(job.acceptanceReceiptHash, "acceptance receipt hash");
		const leaseId = remoteLeaseId(this.config, job);
		const response = await this.#request(
			`/mutation/jobs/${encodeURIComponent(job.remoteJobId)}/claim`,
			"POST",
			{ project_ref: this.config.projectRef, claimant_id: this.config.claimantId, lease_id: leaseId },
		);
		if (response.status === CLAIM_PENDING_STATUS) return { kind: "pending" };
		if (!response.ok) {
			throw new Error(`mutation cloud claim failed: HTTP ${response.status} ${await boundedErrorBody(response, [this.config.token])}`);
		}
		const body = await readBoundedJson(response, "mutation cloud claim response");
		if (!isJsonObject(body)) throw new Error("mutation cloud claim response is not an object");
		if (body.state === "acknowledged" && hasExactJsonKeys(body, ["state", "job_key"])) {
			if (body.job_key !== job.remoteJobId) throw new Error("mutation cloud claim returned a foreign job");
			return { kind: "acknowledged" };
		}
		if (
			body.state !== "leased" ||
			!hasExactJsonKeys(body, ["state", "job_key", "lease_id", "lease_until", "result_hash", "bundle"]) ||
			body.job_key !== job.remoteJobId ||
			body.lease_id !== leaseId ||
			!isJsonObject(body.bundle)
		) {
			throw new Error("mutation cloud leased claim response is malformed or foreign");
		}
		return { kind: "leased", resultHash: requireHash(body.result_hash, "claim result_hash"), bundle: body.bundle };
	}

	async #fetchReport(job: RemoteMutationJobIdentity, pointer: { hash: string; bytes: number }): Promise<Uint8Array> {
		const query = new URLSearchParams({ project_ref: this.config.projectRef });
		const response = await this.#request(
			`/mutation/jobs/${encodeURIComponent(job.remoteJobId)}/report?${query.toString()}`,
			"GET",
		);
		if (!response.ok) {
			throw new Error(`mutation cloud report failed: HTTP ${response.status} ${await boundedErrorBody(response, [this.config.token])}`);
		}
		const bytes = await readExactBytes({
			response,
			expected: pointer.bytes,
			limit: MAX_REPORT_BYTES,
			label: "mutation cloud report",
		});
		const hash = createHash("sha256").update(bytes).digest("hex");
		if (bytes.byteLength !== pointer.bytes || hash !== pointer.hash) {
			throw new Error("mutation cloud report bytes disagree with the authenticated pointer");
		}
		return bytes;
	}

	#request(
		path: string,
		method: "GET" | "POST",
		body?: Record<string, unknown>,
	): Promise<FetchResponse> {
		const headers: Record<string, string> = {
			authorization: `Bearer ${this.config.token}`,
		};
		const init: Parameters<MutationCloudFetch>[1] = {
			method,
			headers,
			signal: AbortSignal.timeout(this.config.timeoutMs),
			redirect: "error",
		};
		if (body !== undefined) {
			headers["content-type"] = "application/json";
			init.body = JSON.stringify(body);
		}
		return this.fetchImpl(`${this.#baseUrl}${path}`, init);
	}
}
