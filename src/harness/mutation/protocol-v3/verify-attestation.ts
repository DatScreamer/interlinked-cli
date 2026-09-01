// Protocol-v3 result identity, clock, and Ed25519 attestation checks.
import { createHash, verify as edVerify } from "node:crypto";
import { canonicalJson, keyPurposeFailure, keyWindowFailure, type V3KeyRegistry } from "./canonical.js";
import type { V3Envelope } from "./types.js";

const UNHASHED_KEYS = new Set(["seq", "occurred_at", "result_hash", "signature"]);
const FUTURE_SKEW_MS = 5 * 60 * 1000;

export function resultHashPayload(envelope: V3Envelope): Record<string, unknown> {
	const payload: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(envelope)) {
		if (!UNHASHED_KEYS.has(key)) payload[key] = value;
	}
	return payload;
}

export function computeResultHash(envelope: V3Envelope): string {
	return createHash("sha256").update(canonicalJson(resultHashPayload(envelope)), "utf8").digest("hex");
}

export function attestationPayload(envelope: V3Envelope): string {
	return canonicalJson({
		key_id: envelope.signature.key_id,
		occurred_at: envelope.occurred_at,
		result_hash: envelope.result_hash,
	});
}

export function timeFailure(envelope: V3Envelope, now: string): string | null {
	const nowMs = Date.parse(now);
	if (!Number.isFinite(nowMs)) return "verification clock (now) is malformed — failing closed";
	const occurredMs = Date.parse(envelope.occurred_at);
	if (!Number.isFinite(occurredMs)) return "result occurred_at is malformed — failing closed";
	if (occurredMs > nowMs + FUTURE_SKEW_MS) {
		return `occurred_at ${envelope.occurred_at} is unreasonably in the future of the verification clock`;
	}
	return null;
}

export function signatureFailure(envelope: V3Envelope, registry: V3KeyRegistry): string | null {
	const keyId = envelope.signature.key_id;
	const record = registry[keyId];
	if (record === undefined) return `unknown signing key "${keyId}"`;
	const gate = keyPurposeFailure(keyId, record, "result") ??
		keyWindowFailure(keyId, record, Date.parse(envelope.occurred_at));
	if (gate !== null) return gate;
	let valid = false;
	try {
		valid = edVerify(
			null,
			Buffer.from(attestationPayload(envelope), "utf8"),
			record.public_key_pem,
			Buffer.from(envelope.signature.value, "base64"),
		);
	} catch {
		return "signature verification errored — malformed key or signature encoding";
	}
	return valid ? null : "signature verification failed";
}
