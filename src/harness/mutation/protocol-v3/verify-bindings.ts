// Caller-held admission, authority, and job-binding comparisons.
import type { DeepReadonly } from "./canonical.js";
import type { AcceptanceReceiptPayload } from "./receipts.js";
import type { V3JobBinding, V3SourceArtifactBinding } from "./types.js";

export interface ExpectedAdmission {
	readonly request_hash: string;
	readonly changeset_hash: string;
	readonly source_artifact: DeepReadonly<V3SourceArtifactBinding>;
}

export interface V3ServerAuthority {
	readonly tenant: string;
	readonly project: string;
}

export function sourceArtifactMismatch(
	actual: V3SourceArtifactBinding,
	expected: DeepReadonly<V3SourceArtifactBinding>,
): string | null {
	return actual.artifact_id === expected.artifact_id &&
		actual.format === expected.format &&
		actual.sha256 === expected.sha256 &&
		actual.bytes === expected.bytes
		? null
		: "source_artifact binding mismatch";
}

export function admissionAnchorFailure(
	acceptance: AcceptanceReceiptPayload,
	expected: ExpectedAdmission,
): string | null {
	if (acceptance.request_hash !== expected.request_hash) {
		return "acceptance request_hash does not match the request the CLI submitted";
	}
	if (acceptance.changeset_hash !== expected.changeset_hash) {
		return "acceptance changeset_hash does not match the change set the CLI submitted";
	}
	return sourceArtifactMismatch(acceptance.source_artifact, expected.source_artifact);
}

export function authorityFailure(job: V3JobBinding, authority: V3ServerAuthority): string | null {
	if (job.tenant !== authority.tenant) {
		return "job tenant does not match the authenticated server authority";
	}
	return job.project === authority.project
		? null
		: "job project does not match the authenticated server authority";
}

export function jobEchoMismatch(actual: V3JobBinding, expected: V3JobBinding): string | null {
	// SAFETY: Object.keys is narrowed to the statically complete job-binding
	// shape, and each key indexes both values of that same type.
	for (const key of Object.keys(expected) as Array<keyof V3JobBinding>) {
		if (actual[key] !== expected[key]) {
			return `job binding mismatch: ${key} is "${actual[key]}", expected "${expected[key]}"`;
		}
	}
	return null;
}
