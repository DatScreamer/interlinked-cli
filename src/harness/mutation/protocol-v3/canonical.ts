// ===========================================
// Protocol v3 — canonical serialization + key registry (leaf module)
// ===========================================
// Shared by the envelope (verify.ts) and the receipts (receipts.ts) —
// lives in its own leaf so those two never import each other.

import { createHash, createPublicKey } from "node:crypto";

/** Compile-time counterpart to {@link deepFreeze}.  Trust-boundary
 *  results expose this shape so callers cannot accidentally write through
 *  an authenticated snapshot even though the wire interfaces themselves
 *  remain convenient mutable construction types. */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
	? T
	: T extends readonly (infer Item)[]
		? readonly DeepReadonly<Item>[]
		: T extends object
			? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
			: T;

/** Code-unit test for well-formed Unicode: every high surrogate must be
 *  followed by a low surrogate, and no lone low surrogates. (String
 *  isWellFormed() needs lib es2024; this is the same predicate.) */
export function isWellFormedString(value: string): boolean {
	return /^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/.test(value);
}

/** The INTERLINKED CANONICAL JSON profile: recursive lexicographic key
 *  sort, JSON.stringify serialization, no whitespace, and REJECTION of
 *  strings that are not well-formed Unicode (lone surrogates). Within the
 *  protocol's validated domain (safe integers only, ASCII field names,
 *  well-formed strings) it produces RFC 8785 (JCS)-identical bytes; the
 *  profile name is the honest claim, since full JCS number serialization
 *  is not implemented (the schemas admit no non-integer numbers).
 *  Throws on invalid Unicode — callers at trust boundaries catch. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) => {
		if (typeof v === "string" && !isWellFormedString(v)) {
			throw new Error("canonicalJson: string is not well-formed Unicode (lone surrogate)");
		}
		if (typeof v !== "object" || v === null || Array.isArray(v)) return v;
		const record = v as Record<string, unknown>; // SAFETY: guarded object, non-array.
		const sorted: Record<string, unknown> = {};
		for (const k of Object.keys(record).sort()) sorted[k] = record[k];
		return sorted;
	});
}

/** What a registered key is ALLOWED to sign. `result` is arm-neutral: the
 *  verifier additionally requires an envelope's signer id to equal the
 *  verified execution- or terminalization-receipt signer id. That coupling
 *  keeps either authority from signing the other arm's result. */
export type V3KeyPurpose = "acceptance" | "execution" | "terminalization" | "result";

export interface V3KeyRecord {
	/** SPKI PEM of the Ed25519 verification key. */
	public_key_pem: string;
	/** The signing purposes this key is trusted for. REQUIRED — a key with
	 *  no declared purposes signs nothing. */
	purposes: V3KeyPurpose[];
	/** RFC3339: signed objects occurring BEFORE this instant fail. */
	not_before?: string;
	/** RFC3339 revocation instant; signed objects at/after it fail. */
	revoked_at?: string;
}

export type V3KeyRegistry = Record<string, V3KeyRecord>;

/** Key validity window vs one signed object's SIGNED timestamp. Applied
 *  independently to every signed object (envelope AND each receipt). */
export function keyWindowFailure(keyId: string, record: V3KeyRecord, signedAtMs: number): string | null {
	for (const [field, boundary] of [["not_before", record.not_before], ["revoked_at", record.revoked_at]] as const) {
		if (boundary === undefined) continue;
		const boundaryMs = Date.parse(boundary);
		// FAIL CLOSED on a malformed registry timestamp: NaN comparisons are
		// always false, which would read a bad window as unbounded validity.
		if (!Number.isFinite(boundaryMs)) return `signing key "${keyId}" has a malformed ${field} — failing closed`;
		if (field === "not_before" && signedAtMs < boundaryMs) {
			return `signing key "${keyId}" is not valid before ${boundary}`;
		}
		if (field === "revoked_at" && signedAtMs >= boundaryMs) {
			return `signing key "${keyId}" was revoked at ${boundary} — signed after revocation`;
		}
	}
	return null;
}

/** Own-data snapshot of a wire value: getters are read EXACTLY ONCE at
 *  clone time, so validation and later reads cannot see different values
 *  (tenth pass P0-3). Returns null for non-plain-JSON values. */
export function safeStructuredClone<T>(value: T): T | null {
	try {
		return structuredClone(value);
	} catch {
		// interlinked-ignore: empty_catch — non-cloneable wire input maps to
		// the null rejection path; the reason is the return value itself.
		return null;
	}
}

/** Recursively freeze a plain-JSON value in place and return it. */
export function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

/** Purpose gate: the key must be registered FOR this purpose. */
export function keyPurposeFailure(keyId: string, record: V3KeyRecord, purpose: V3KeyPurpose): string | null {
	return record.purposes.includes(purpose)
		? null
		: `signing key "${keyId}" is not trusted for purpose "${purpose}"`;
}

const CONTROL_PURPOSES: readonly V3KeyPurpose[] = ["acceptance", "terminalization"];
const RUNNER_PURPOSES: readonly V3KeyPurpose[] = ["execution"];
const ALL_PURPOSES: readonly V3KeyPurpose[] = [...CONTROL_PURPOSES, ...RUNNER_PURPOSES, "result"];

/** Normalized key fingerprint: sha-256 over the SPKI DER bytes — raw PEM
 *  text comparison misses trivially re-encoded keys (CRLF vs LF, seventh
 *  pass P1-4). Returns null for an unparseable key. */
function spkiFingerprint(pem: string): string | null {
	try {
		const der = createPublicKey(pem).export({ format: "der", type: "spki" });
		return createHash("sha256").update(der).digest("hex");
	} catch {
		return null;
	}
}

/** MUST stay small: a verification registry is hand-curated trust. */
const MAX_REGISTRY_KEYS = 64;
const MAX_KEY_ID_LENGTH = 128;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Shape + bounds of the registry container and its key ids. */
function registryShapeFailure(registry: unknown): string | null {
	if (typeof registry !== "object" || registry === null || Array.isArray(registry)) {
		return "key registry must be an object of key records";
	}
	const keyIds = Object.keys(registry);
	if (keyIds.length === 0 || keyIds.length > MAX_REGISTRY_KEYS) {
		return `key registry must carry 1..${MAX_REGISTRY_KEYS} keys — failing closed`;
	}
	for (const keyId of keyIds) {
		if (keyId.length === 0 || keyId.length > MAX_KEY_ID_LENGTH) {
			return `key ids must be 1..${MAX_KEY_ID_LENGTH} characters — failing closed`;
		}
	}
	return null;
}

/** Strict CONSTRUCTING registry validation (seventh pass P1-5, hardened
 *  eighth pass P1-4): external configuration must FAIL CLOSED with a
 *  reason, never throw. Exact keys, bounded ids/counts, unique known
 *  purposes, valid RFC3339 windows, and keys that parse as Ed25519 SPKI. */
export function keyRegistryFailure(registry: unknown): string | null {
	const shape = registryShapeFailure(registry);
	if (shape !== null) return shape;
	// SAFETY: registryShapeFailure proved the container is a plain object.
	for (const [keyId, record] of Object.entries(registry as Record<string, unknown>)) {
		const bad = keyRecordFailure(keyId, record);
		if (bad !== null) return bad;
	}
	return null;
}

function keyRecordFailure(keyId: string, record: unknown): string | null {
	if (typeof record !== "object" || record === null || Array.isArray(record)) {
		return `key "${keyId}" must be a record`;
	}
	// SAFETY: guarded above — non-null object, non-array.
	const r = record as Record<string, unknown>;
	for (const key of Object.keys(r)) {
		if (!["public_key_pem", "purposes", "not_before", "revoked_at"].includes(key)) {
			return `key "${keyId}" carries unknown property "${key}" — failing closed`;
		}
	}
	const keyType = typeof r.public_key_pem === "string" ? asymmetricKeyTypeOf(r.public_key_pem) : null;
	if (keyType === null) return `key "${keyId}" has no parseable SPKI public key — failing closed`;
	if (keyType !== "ed25519") {
		return `key "${keyId}" is "${keyType}" but the contract requires ed25519 — failing closed`;
	}
	return keyPurposesAndWindowsFailure(keyId, r);
}

function keyPurposesAndWindowsFailure(keyId: string, r: Record<string, unknown>): string | null {
	const purposes = r.purposes;
	const purposesOk =
		Array.isArray(purposes) &&
		purposes.length > 0 &&
		new Set(purposes).size === purposes.length &&
		// SAFETY: includes() narrows by membership — a non-purpose value simply fails the test.
		purposes.every((p) => ALL_PURPOSES.includes(p as V3KeyPurpose));
	if (!purposesOk) {
		return `key "${keyId}" must declare unique purposes from ${ALL_PURPOSES.join("|")} — failing closed`;
	}
	for (const field of ["not_before", "revoked_at"] as const) {
		const value = r[field];
		if (value === undefined) continue;
		if (typeof value !== "string" || !RFC3339_RE.test(value) || !Number.isFinite(Date.parse(value))) {
			return `key "${keyId}" ${field} must be a valid RFC3339 timestamp — failing closed`;
		}
	}
	return null;
}

/** The parsed key's algorithm, or null when unparseable. */
function asymmetricKeyTypeOf(pem: string): string | null {
	try {
		return createPublicKey(pem).asymmetricKeyType ?? null;
	} catch {
		return null;
	}
}

/** Reject a registry where ONE public-key fingerprint spans both control
 *  (acceptance/terminalization) and runner (execution) roles. `result` is
 *  deliberately arm-neutral: verify.ts binds each result signer to the
 *  corresponding verified receipt signer. Fingerprints are SPKI-DER
 *  digests, never raw PEM text. */
export function registryRoleConflictFailure(registry: V3KeyRegistry): string | null {
	const rolesByFingerprint = new Map<string, { control: boolean; runner: boolean }>();
	for (const [keyId, record] of Object.entries(registry)) {
		const fingerprint = spkiFingerprint(record.public_key_pem);
		if (fingerprint === null) return `key "${keyId}" has no parseable SPKI public key — failing closed`;
		const roles = rolesByFingerprint.get(fingerprint) ?? { control: false, runner: false };
		roles.control = roles.control || record.purposes.some((p) => CONTROL_PURPOSES.includes(p));
		roles.runner = roles.runner || record.purposes.some((p) => RUNNER_PURPOSES.includes(p));
		rolesByFingerprint.set(fingerprint, roles);
	}
	for (const roles of rolesByFingerprint.values()) {
		if (roles.control && roles.runner) {
			return "key registry is invalid: one public key spans control (acceptance/terminalization) and runner (execution) roles";
		}
	}
	return null;
}
