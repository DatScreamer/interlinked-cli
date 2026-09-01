// ===========================================
// Direct P/N surface for the canonical leaf module — the serialization,
// snapshot, freeze, and key-window primitives every other protocol-v3
// module trusts. (The chain suites exercise them indirectly; this file
// pins each primitive's own contract.)
// ===========================================
import { describe, expect, it } from "vitest";
import {
	canonicalJson,
	deepFreeze,
	isWellFormedString,
	keyPurposeFailure,
	keyWindowFailure,
	safeStructuredClone,
	type V3KeyRecord,
} from "./canonical.js";

const RECORD: V3KeyRecord = { public_key_pem: "unused", purposes: ["result"] };

describe("isWellFormedString — positive (must accept)", () => {
	// test-contract: public-api — ASCII, BMP, and a full surrogate pair.
	it("P1: accepts ASCII, BMP, and paired-surrogate strings", () => {
		expect(isWellFormedString("t_dev")).toBe(true);
		expect(isWellFormedString("café")).toBe(true);
		expect(isWellFormedString("\u{1F600}")).toBe(true);
	});
});

describe("isWellFormedString — negative (must reject)", () => {
	// test-contract: security — lone surrogates are the canonicalJson
	// injection surface (JSON.stringify escapes them undetectably).
	it("N1: rejects a lone high surrogate", () => {
		expect(isWellFormedString("t_dev\uD800")).toBe(false);
	});

	it("N2: rejects a lone low surrogate", () => {
		expect(isWellFormedString("\uDC00t_dev")).toBe(false);
	});
});

describe("canonicalJson — positive (must serialize)", () => {
	// test-contract: invariant — recursive lexicographic key sort, no
	// whitespace: two key orders, one byte sequence.
	it("P1: sorts keys recursively and emits identical bytes for reordered input", () => {
		const a = { b: { z: 1, a: 2 }, a: [1, 2] };
		const b = { a: [1, 2], b: { a: 2, z: 1 } };
		expect(canonicalJson(a)).toBe(canonicalJson(b));
		expect(canonicalJson(a)).toBe('{"a":[1,2],"b":{"a":2,"z":1}}');
	});
});

describe("canonicalJson — negative (must throw)", () => {
	it("N1: throws on a lone surrogate anywhere in the tree", () => {
		expect(() => canonicalJson({ deep: ["ok", "bad\uD800"] })).toThrow("lone surrogate");
	});
});

describe("safeStructuredClone — positive (must snapshot)", () => {
	// test-contract: security — tenth-pass P0-3: a getter is read EXACTLY
	// once at clone time; later reads of the clone cannot change.
	it("P1: reads an accessor exactly once and detaches from the source", () => {
		let reads = 0;
		const trap = {
			get value(): string {
				reads += 1;
				return reads === 1 ? "honest" : "swapped";
			},
		};
		const clone = safeStructuredClone(trap);
		expect(clone?.value).toBe("honest");
		expect(clone?.value).toBe("honest");
		expect(reads).toBe(1);
	});

	it("P2: the clone shares no references with the source", () => {
		const source = { rows: [{ status: "killed" }] };
		const clone = safeStructuredClone(source);
		expect(clone?.rows[0]).not.toBe(source.rows[0]);
		expect(clone).toEqual(source);
	});
});

describe("safeStructuredClone — negative (must reject)", () => {
	it("N1: returns null for a non-cloneable value", () => {
		expect(safeStructuredClone({ fn: () => 1 })).toBe(null);
	});
});

describe("deepFreeze — positive (must freeze recursively)", () => {
	it("P1: freezes the root, nested objects, and arrays in place", () => {
		const value = { rows: [{ status: "killed" }] };
		expect(deepFreeze(value)).toBe(value);
		expect(Object.isFrozen(value)).toBe(true);
		expect(Object.isFrozen(value.rows)).toBe(true);
		expect(Object.isFrozen(value.rows[0])).toBe(true);
	});
});

describe("keyWindowFailure — positive (inside the window)", () => {
	it("P1: passes with no bounds and inside both bounds", () => {
		const at = Date.parse("2026-08-15T00:00:00Z");
		expect(keyWindowFailure("k", RECORD, at)).toBe(null);
		const bounded = { ...RECORD, not_before: "2026-08-01T00:00:00Z", revoked_at: "2026-09-01T00:00:00Z" };
		expect(keyWindowFailure("k", bounded, at)).toBe(null);
	});
});

describe("keyWindowFailure — negative (must fail)", () => {
	it("N1: fails before not_before", () => {
		const record = { ...RECORD, not_before: "2026-08-01T00:00:00Z" };
		expect(keyWindowFailure("k", record, Date.parse("2026-07-31T23:59:59Z"))).toContain("not valid before");
	});

	it("N2: fails at/after revoked_at", () => {
		const record = { ...RECORD, revoked_at: "2026-09-01T00:00:00Z" };
		expect(keyWindowFailure("k", record, Date.parse("2026-09-01T00:00:00Z"))).toContain("revoked");
	});

	// test-contract: security — NaN comparisons are always false; a
	// malformed registry timestamp must fail CLOSED, not read as unbounded.
	it("N3: fails closed on a malformed window timestamp", () => {
		const record = { ...RECORD, revoked_at: "not-a-date" };
		expect(keyWindowFailure("k", record, Date.parse("2026-08-15T00:00:00Z"))).toContain("malformed");
	});
});

describe("keyPurposeFailure — positive/negative", () => {
	it("P1: a declared purpose passes", () => {
		expect(keyPurposeFailure("k", RECORD, "result")).toBe(null);
	});

	it("N1: an undeclared purpose names the key and purpose", () => {
		expect(keyPurposeFailure("k", RECORD, "acceptance")).toContain('not trusted for purpose "acceptance"');
	});
});
