import { describe, expect, it } from "vitest";
import type { Finding } from "./corpus.js";
import { parseFinding, parseProvenanceEntry } from "./parse-finding.js";

const prov = {
	provenance_id: "p1",
	provenance_completeness: "anchored_line",
	source_runner: "codex-sol",
};

const row: Finding = {
	id: "f1",
	bug_class: "nan_guard",
	aliases: [],
	check: null,
	file: "src/x.ts",
	line: 12,
	message: "boom",
	severity: "high",
	provenance: [{ ...prov, provenance_completeness: "anchored_line" }],
	provenance_tier: "site",
	dedup_key: "dk1",
	times_observed: 1,
	source_runners: ["codex-sol"],
	status: "candidate",
	first_seen: "2026-08-09T00:00:00Z",
	last_seen: "2026-08-09T00:00:00Z",
};

describe("parseFinding — accepts well-formed rows", () => {
	it("round-trips a minimal complete finding", () => {
		expect(parseFinding(structuredClone(row))).toEqual(row);
	});

	it("accepts a null `check` (a finding with no owning detector)", () => {
		expect(parseFinding({ ...structuredClone(row), check: null })?.check).toBeNull();
	});

	it("carries every optional top-level field through", () => {
		const full = {
			...structuredClone(row),
			category: "security" as const,
			fix_instruction: "do the thing",
			approved_by: "qcody",
			distilled: { detector_id: "d1", kind: "inline_check" as const, cold_path_wired: true },
			anchor_span_sha256: "abc",
			anchor_context: ["a", "b"],
			anchor_tree: "sha+dirty",
		};
		expect(parseFinding(full)).toEqual(full);
	});
});

describe("parseFinding — rejects rows missing a required field", () => {
	// Each of these passed the pre-2026-08-09 `isFinding` predicate, which
	// checked only id / bug_class / provenance / message.
	for (const field of [
		"aliases",
		"check",
		"file",
		"line",
		"severity",
		"provenance_tier",
		"dedup_key",
		"times_observed",
		"source_runners",
		"status",
		"first_seen",
		"last_seen",
	] as const) {
		it(`rejects a row with no \`${field}\``, () => {
			const bad: Record<string, unknown> = { ...structuredClone(row) };
			delete bad[field];
			expect(parseFinding(bad)).toBeNull();
		});
	}

	it("rejects an out-of-union severity / status / tier", () => {
		expect(parseFinding({ ...structuredClone(row), severity: "catastrophic" })).toBeNull();
		expect(parseFinding({ ...structuredClone(row), status: "wip" })).toBeNull();
		expect(parseFinding({ ...structuredClone(row), provenance_tier: "module" })).toBeNull();
	});

	it("rejects a non-object, an array, and a torn shape", () => {
		expect(parseFinding(null)).toBeNull();
		expect(parseFinding([row])).toBeNull();
		expect(parseFinding("{}")).toBeNull();
	});

	it("rejects an aliases array holding a non-string", () => {
		expect(parseFinding({ ...structuredClone(row), aliases: ["a", 3] })).toBeNull();
	});
});

describe("parseProvenanceEntry", () => {
	it("preserves quote and the other free-text members", () => {
		const p = { ...prov, quote: "the offending line", comment_author: "sol", url: "https://x" };
		expect(parseProvenanceEntry(p)).toEqual(p);
	});

	it("rejects an unknown provenance_completeness", () => {
		expect(parseProvenanceEntry({ ...prov, provenance_completeness: "vibes" })).toBeNull();
	});

	it("rejects a malformed lines tuple", () => {
		expect(parseProvenanceEntry({ ...prov, lines: [1] })).toBeNull();
		expect(parseProvenanceEntry({ ...prov, lines: [1, "2"] })).toBeNull();
	});

	// Legacy recovery: an older writer stored the digest as a serialized Buffer.
	// Dropping those findings would be data loss over a cosmetic field.
	it("hex-encodes a legacy Buffer-shaped raw_sha256 instead of rejecting", () => {
		const parsed = parseProvenanceEntry({
			...prov,
			raw_sha256: { type: "Buffer", data: [0, 15, 255, 16] },
		});
		expect(parsed?.raw_sha256).toBe("000fff10");
	});

	it("passes a normal hex raw_sha256 through untouched", () => {
		expect(parseProvenanceEntry({ ...prov, raw_sha256: "deadbeef" })?.raw_sha256).toBe("deadbeef");
	});

	it("rejects a raw_sha256 that is neither a string nor a Buffer shape", () => {
		expect(parseProvenanceEntry({ ...prov, raw_sha256: { nope: 1 } })).toBeNull();
		expect(parseProvenanceEntry({ ...prov, raw_sha256: { type: "Buffer", data: [999] } })).toBeNull();
	});
});
