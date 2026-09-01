// test-contract: integration — onboarding persists exact bytes before remote
// work and recovers each durable boundary without exposing adoption to submit.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MutationCloudFetch } from "./mutation-cloud-v3-client.js";
import type { CapturedMutationOnboardingSource } from "./mutation-cloud-v3-onboarding-source.js";
import type { MutationCloudSubmissionFetch } from "./mutation-cloud-v3-submission.js";
import {
	MutationCloudV3Runtime,
	type MutationCloudV3RuntimeConfig,
} from "./mutation-cloud-v3-runtime.js";
import { openMutationJournal } from "./mutation-journal-sqlite.js";
import { canonicalJson } from "./protocol-v3/canonical.js";
import { PROTOCOL_V3_CONTRACT_DIGEST as CONTRACT_DIGEST } from "./protocol-v3/contract-identity.js";
import { deriveAdmission, parseMutationJobRequestV3 } from "./protocol-v3/request.js";
import { signReceipt, TEST_NOW, TEST_REGISTRY } from "./protocol-v3/test-authentication.js";

const NOW_MS = Date.parse(TEST_NOW);
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const AUTHORITY = Object.freeze({
	tenant: "tenant-1",
	project: "project-1",
	repository: "github.com/example/repo",
});
const ONBOARDING_BINDING = Object.freeze({
	...AUTHORITY,
	commit: COMMIT,
	targetFile: "src/answer.ts",
});

function digest(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function captured(sourceText = "exact git archive tar bytes"): CapturedMutationOnboardingSource {
	const sourceArtifactBytes = Buffer.from(sourceText, "utf8");
	const targetBytes = Buffer.from("export const answer = 42;\n", "utf8");
	const sourceArtifactSha256 = digest(sourceArtifactBytes);
	return {
		format: "git-archive-tar-v1",
		archivePrefix: "interlinked-source-v1/",
		repository: "github.com/example/repo",
		commit: COMMIT,
		targetFile: "src/answer.ts",
		targetBytes,
		targetSha256: digest(targetBytes),
		sourceArtifactId: `src_git_archive_v1_${sourceArtifactSha256}`,
		sourceArtifactBytes,
		sourceArtifactSha256,
		scopeMode: "import_graph",
		testFiles: ["src/answer.test.ts"],
	};
}

function config(): MutationCloudV3RuntimeConfig {
	const common = {
		baseUrl: "https://mutation.example",
		token: "onboarding-test-credential",
		projectRef: "project-1",
		timeoutMs: 5_000,
	};
	return {
		submission: {
			...common,
			repository: "github.com/example/repo",
			contractDigest: CONTRACT_DIGEST,
			keyRegistry: TEST_REGISTRY,
			serverAuthority: { tenant: "tenant-1", project: "project-1" },
		},
		client: { ...common, claimantId: "onboarding-installation" },
		evaluator: {
			keyRegistry: TEST_REGISTRY,
			serverAuthority: { tenant: "tenant-1", project: "project-1" },
			evaluatorPolicyVersion: "onboarding-policy-v1",
			siteCountThreshold: 50,
		},
		owner: "onboarding-runtime",
		leaseMs: 15_000,
	};
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

interface SubmissionRecorder {
	fetch: MutationCloudSubmissionFetch;
	methods: string[];
	requestBodies: Uint8Array[];
}

function signedAcceptance(request: ReturnType<typeof parseMutationJobRequestV3> & { ok: true }) {
	const admission = deriveAdmission(request.request);
	const payload = {
		receipt_version: "1",
		kind: "acceptance",
		protocol_version: "interlinked-mutation/3.0",
		issued_at: TEST_NOW,
		job: request.request.job,
		approved_policy_ids: [],
		policy_version: "policy-v1",
		request_hash: admission.request_hash,
		test_scope_hash: digest(canonicalJson(request.request.test_files)),
		quota_reservation_id: `quota-${request.request.job.job_key}`,
		changeset_hash: admission.changeset_hash,
		source_artifact: request.request.source_artifact,
		intended_image_digest: `sha256:${"0".repeat(64)}`,
		intended_engine_config_hash: "e".repeat(64),
		intended_scope_mode: request.request.scope_mode,
	};
	const signed: unknown = JSON.parse(signReceipt(payload));
	if (signed === null || typeof signed !== "object" || Array.isArray(signed)) {
		throw new Error("test acceptance receipt must be an object");
	}
	return { admission, signed };
}

function submissionRecorder(): SubmissionRecorder {
	const methods: string[] = [];
	const requestBodies: Uint8Array[] = [];
	const fetch: MutationCloudSubmissionFetch = async (_url, init) => {
		methods.push(init.method);
		if (init.method === "GET") {
			return json({
				protocol_version: "interlinked-mutation/3.0",
				contract_digest: CONTRACT_DIGEST,
				keys: TEST_REGISTRY,
			});
		}
		if (init.method === "PUT") {
			const body = init.body;
			if (!(body instanceof Uint8Array)) throw new Error("artifact upload must carry exact bytes");
			return json({
				format: "git-archive-tar-v1",
				artifact_id: `src_git_archive_v1_${digest(body)}`,
				sha256: digest(body),
				bytes: body.byteLength,
				idempotent_replay: false,
			}, 201);
		}
		const body = typeof init.body === "string" ? Buffer.from(init.body, "utf8") : init.body;
		if (!(body instanceof Uint8Array)) throw new Error("job submission must carry exact request bytes");
		requestBodies.push(Uint8Array.from(body));
		const parsed = parseMutationJobRequestV3(JSON.parse(Buffer.from(body).toString("utf8")));
		if (!parsed.ok) throw new Error(parsed.reason);
		const acceptance = signedAcceptance(parsed);
		return json({
			job_key: parsed.request.job.job_key,
			project_ref: parsed.request.job.project,
			execution_state: "accepted",
			execution_instance_id: "onboarding-workflow-1",
			request_hash: acceptance.admission.request_hash,
			changeset_hash: acceptance.admission.changeset_hash,
			acceptance_receipt: acceptance.signed,
			idempotent_replay: false,
		}, 202);
	};
	return { fetch, methods, requestBodies };
}

const pendingFetch: MutationCloudFetch = async () => json({ error: "not ready" }, 409);

let root = "";

afterEach(() => {
	if (root !== "") rmSync(root, { recursive: true, force: true });
	root = "";
});

function openRuntime(args: {
	recorder: SubmissionRecorder;
	fault?: (point: "after_onboarding_prepare" | "after_onboarding_acceptance" | "after_onboarding_activation") => void;
	captureSource?: () => CapturedMutationOnboardingSource;
	randomBytes?: (size: number) => Uint8Array;
}): MutationCloudV3Runtime {
	return new MutationCloudV3Runtime(root, config(), {
		submissionFetch: args.recorder.fetch,
		clientFetch: pendingFetch,
		clockMs: () => NOW_MS,
		onboarding: {
			captureSource: args.captureSource ?? (() => captured()),
			randomBytes: args.randomBytes ?? (() => Uint8Array.from({ length: 32 }, () => 7)),
			...(args.fault === undefined ? {} : { faultInjector: args.fault }),
		},
	});
}

describe("MutationCloudV3Runtime onboarding", () => {
	it("prepares exact bytes, authenticates, activates adopt_current, and polls with the single runtime", async () => {
		root = mkdtempSync(join(tmpdir(), "interlinked-onboarding-runtime-"));
		const recorder = submissionRecorder();
		const runtime = openRuntime({ recorder });
		const result = await runtime.onboard("src/answer.ts");
		expect(result.onboarding).toMatchObject({
			kind: "activated",
			jobId: `job_onboard_${"07".repeat(32)}`,
			format: "git-archive-tar-v1",
			preparedReplay: false,
			activationReplay: false,
		});
		expect(result.immediate.processor).toMatchObject({ kind: "pending", jobId: result.onboarding.jobId });
		expect(recorder.methods).toEqual(["GET", "PUT", "POST"]);
		const posted = recorder.requestBodies[0];
		expect(posted).toBeDefined();
		const parsedRequest: unknown = JSON.parse(Buffer.from(posted ?? []).toString("utf8"));
		expect(parsedRequest).not.toHaveProperty("baseline_intent");
		expect(parsedRequest).not.toHaveProperty("adoption_intent");
		runtime.close();

		const journal = openMutationJournal(root);
		const intent = journal.getOnboardingIntent(ONBOARDING_BINDING);
		expect(intent?.state).toBe("activated");
		expect(Buffer.from(intent?.requestBytes ?? [])).toEqual(Buffer.from(posted ?? []));
		const claimed = journal.claimJob({
			jobId: result.onboarding.jobId,
			authority: AUTHORITY,
			owner: "assert-adoption",
			nowMs: NOW_MS + 1_000,
			leaseMs: 1_000,
		});
		expect(claimed?.baselineIntent).toBe("adopt_current");
		journal.close();
	});

	it("crash after prepare leaves exact unclaimable bytes and recovery reuses them", async () => {
		root = mkdtempSync(join(tmpdir(), "interlinked-onboarding-prepare-crash-"));
		const first = submissionRecorder();
		const fault = vi.fn((point: string) => {
			if (point === "after_onboarding_prepare") throw new Error("prepare crash");
		});
		const randomBytes = vi.fn(() => Uint8Array.from({ length: 32 }, () => 9));
		const crashed = openRuntime({ recorder: first, fault, randomBytes });
		await expect(crashed.onboard("src/answer.ts")).rejects.toThrow("prepare crash");
		expect(first.methods).toEqual([]);
		crashed.close();
		const journal = openMutationJournal(root);
		const prepared = journal.getOnboardingIntent(ONBOARDING_BINDING);
		expect(prepared?.state).toBe("prepared");
		expect(journal.claimNext({ authority: AUTHORITY, owner: "not-claimable", nowMs: NOW_MS, leaseMs: 1_000 })).toBeNull();
		const exactRequest = Buffer.from(prepared?.requestBytes ?? []);
		journal.close();

		const recoveredRecorder = submissionRecorder();
		const recovered = openRuntime({ recorder: recoveredRecorder, randomBytes });
		await recovered.onboard("src/answer.ts");
		expect(Buffer.from(recoveredRecorder.requestBodies[0] ?? [])).toEqual(exactRequest);
		expect(randomBytes).toHaveBeenCalledOnce();
		recovered.close();
	});

	it("crash after durable authenticated acceptance resumes without a second remote submission", async () => {
		root = mkdtempSync(join(tmpdir(), "interlinked-onboarding-accept-crash-"));
		const first = submissionRecorder();
		const crashed = openRuntime({
			recorder: first,
			fault: (point) => {
				if (point === "after_onboarding_acceptance") throw new Error("acceptance crash");
			},
		});
		await expect(crashed.onboard("src/answer.ts")).rejects.toThrow("acceptance crash");
		expect(first.methods).toEqual(["GET", "PUT", "POST"]);
		crashed.close();
		const before = openMutationJournal(root);
		expect(before.getOnboardingIntent(ONBOARDING_BINDING)?.state).toBe("accepted");
		expect(before.claimNext({ authority: AUTHORITY, owner: "not-claimable", nowMs: NOW_MS, leaseMs: 1_000 })).toBeNull();
		before.close();

		const second = submissionRecorder();
		const recovered = openRuntime({ recorder: second });
		const result = await recovered.onboard("src/answer.ts");
		expect(result.onboarding.authenticatedReplay).toBe(true);
		expect(second.methods).toEqual([]);
		recovered.close();
	});

	it("crash after activation reopens the same pending job without remote resubmission", async () => {
		root = mkdtempSync(join(tmpdir(), "interlinked-onboarding-activate-crash-"));
		const first = submissionRecorder();
		const crashed = openRuntime({
			recorder: first,
			fault: (point) => {
				if (point === "after_onboarding_activation") throw new Error("activation crash");
			},
		});
		await expect(crashed.onboard("src/answer.ts")).rejects.toThrow("activation crash");
		crashed.close();
		const second = submissionRecorder();
		const recovered = openRuntime({ recorder: second });
		const result = await recovered.onboard("src/answer.ts");
		expect(result.onboarding).toMatchObject({ activationReplay: true, preparedReplay: true });
		expect(second.methods).toEqual([]);
		recovered.close();
	});

	it("rejects valid but different replay bytes before any remote call", async () => {
		root = mkdtempSync(join(tmpdir(), "interlinked-onboarding-drift-"));
		const first = submissionRecorder();
		const crashed = openRuntime({
			recorder: first,
			fault: (point) => {
				if (point === "after_onboarding_prepare") throw new Error("prepare crash");
			},
		});
		await expect(crashed.onboard("src/answer.ts")).rejects.toThrow("prepare crash");
		crashed.close();
		const second = submissionRecorder();
		const drifted = openRuntime({ recorder: second, captureSource: () => captured("different tar bytes") });
		await expect(drifted.onboard("src/answer.ts")).rejects.toThrow("exact prepared bytes or metadata");
		expect(second.methods).toEqual([]);
		drifted.close();
	});
});
