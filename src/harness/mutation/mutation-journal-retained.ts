// Authenticated evidence retained by the durable mutation journal.
import { createHash } from "node:crypto";
import { canonicalJson } from "./protocol-v3/canonical.js";
import type {
	JournalRetainedCanonicalJson,
	JournalRetainedEvidence,
	JournalRetainedReport,
} from "./mutation-journal-types.js";

const SHA256_RE = /^[0-9a-f]{64}$/;

function requireHash(value: string, label: string): void {
	if (!SHA256_RE.test(value)) throw new Error(`${label} must be a lowercase 64-hex sha-256`);
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function retainedCanonicalJson(value: unknown, label: string): JournalRetainedCanonicalJson {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be a retained canonical JSON record`);
	}
	// SAFETY: the guard above proves a non-null, non-array object; each field is
	// independently narrowed before use.
	const record = value as Record<string, unknown>;
	const encoded = record.canonicalJson;
	const expectedHash = record.sha256;
	if (typeof encoded !== "string" || encoded.length === 0) {
		throw new Error(`${label}.canonicalJson must not be empty`);
	}
	if (typeof expectedHash !== "string") throw new Error(`${label}.sha256 must be a string`);
	requireHash(expectedHash, `${label}.sha256`);
	let parsed: unknown;
	try {
		// SAFETY: JSON.parse returns an untrusted value that canonicalJson validates.
		parsed = JSON.parse(encoded) as unknown;
	} catch (error) {
		throw new Error(`${label}.canonicalJson is not valid JSON`, { cause: error });
	}
	if (canonicalJson(parsed) !== encoded) {
		throw new Error(`${label}.canonicalJson is not in protocol canonical form`);
	}
	if (sha256(encoded) !== expectedHash) {
		throw new Error(`${label}.canonicalJson does not match its sha256`);
	}
	return { canonicalJson: encoded, sha256: expectedHash };
}

function retainedReport(value: unknown): JournalRetainedReport {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("retainedEvidence.report must be a retained report record");
	}
	// SAFETY: the guard above proves a non-null, non-array object; each field is
	// independently narrowed before use.
	const record = value as Record<string, unknown>;
	if (!(record.bytes instanceof Uint8Array)) {
		throw new Error("retainedEvidence.report.bytes must be a byte array");
	}
	if (typeof record.sha256 !== "string") {
		throw new Error("retainedEvidence.report.sha256 must be a string");
	}
	requireHash(record.sha256, "retainedEvidence.report.sha256");
	const bytes = Uint8Array.from(record.bytes);
	if (sha256(bytes) !== record.sha256) {
		throw new Error("retainedEvidence.report.bytes do not match their sha256");
	}
	return { bytes, sha256: record.sha256 };
}

/** Validate hashes and canonical form at both the write and read boundaries.
 * Returning fresh byte storage prevents callers or SQLite buffers from
 * mutating a retained projection after validation. */
export function normalizeRetainedEvidence(value: unknown): JournalRetainedEvidence {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("retainedEvidence must be an object");
	}
	// SAFETY: the guard above proves a non-null, non-array object; each field is
	// independently narrowed before use.
	const record = value as Record<string, unknown>;
	if (record.formatVersion !== 1) throw new Error("retainedEvidence.formatVersion must be 1");
	const execution = record.executionReceipt === null
		? null
		: retainedCanonicalJson(record.executionReceipt, "retainedEvidence.executionReceipt");
	const terminalization = record.terminalizationRecord === null
		? null
		: retainedCanonicalJson(record.terminalizationRecord, "retainedEvidence.terminalizationRecord");
	if ((execution === null) === (terminalization === null)) {
		throw new Error("retainedEvidence must carry exactly one executionReceipt or terminalizationRecord");
	}
	return {
		formatVersion: 1,
		envelope: retainedCanonicalJson(record.envelope, "retainedEvidence.envelope"),
		acceptanceReceipt: retainedCanonicalJson(
			record.acceptanceReceipt,
			"retainedEvidence.acceptanceReceipt",
		),
		executionReceipt: execution,
		terminalizationRecord: terminalization,
		report: record.report === null ? null : retainedReport(record.report),
	};
}
