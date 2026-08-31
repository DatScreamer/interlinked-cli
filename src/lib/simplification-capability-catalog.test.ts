import { describe, expect, it } from "vitest";
import {
	findSimplificationCapabilities,
	parseSimplificationCapabilityCatalog,
	simplificationCapabilityCatalogSha256,
	type SimplificationCapabilityCatalog,
} from "./simplification-capability-catalog.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function fixture(): unknown {
	return {
		schema_version: "simplification-capability-catalog/v1",
		catalog_id: "node-22-contracts",
		entries: [{
			id: "node22:path.matchesGlob",
			remedy: "stdlib",
			capability: "path.matchesGlob",
			target: { name: "node", version: "22.14.0" },
			support: "available",
			equivalence: "fixture-validated",
			contract_sha256: SHA_A,
			fixture_sha256: SHA_B,
			provenance: {
				source: "pinned Node API documentation and compatibility fixture",
				source_sha256: SHA_C,
				checked_at: "2026-08-30T12:00:00.000Z",
			},
			limitations: ["glob dialect must match the repository contract"],
		}],
	};
}

function parsedFixture(): Readonly<SimplificationCapabilityCatalog> {
	const parsed = parseSimplificationCapabilityCatalog(fixture());
	if (!parsed.ok) throw new Error(parsed.reason);
	return parsed.catalog;
}

describe("simplification capability catalog", () => {
	it("parses, content-addresses, and selects an exact pinned runtime entry", () => {
		const catalog = parsedFixture();
		expect(simplificationCapabilityCatalogSha256(catalog)).toMatch(/^[a-f0-9]{64}$/);
		expect(findSimplificationCapabilities(
			catalog,
			{ name: "node", version: "22.14.0" },
			"stdlib",
		)).toHaveLength(1);
		expect(findSimplificationCapabilities(
			catalog,
			{ name: "node", version: "22.15.0" },
		)).toEqual([]);
	});

	it("rejects unpinned versions and fixture claims without fixture evidence", () => {
		const unpinned = fixture() as { entries: Array<Record<string, unknown>> };
		unpinned.entries[0]!.target = { name: "node", version: "latest" };
		expect(parseSimplificationCapabilityCatalog(unpinned).ok).toBe(false);
		const ranged = fixture() as { entries: Array<Record<string, unknown>> };
		ranged.entries[0]!.target = { name: "node", version: "^22.14.0" };
		expect(parseSimplificationCapabilityCatalog(ranged).ok).toBe(false);

		const missingFixture = fixture() as { entries: Array<Record<string, unknown>> };
		missingFixture.entries[0]!.fixture_sha256 = null;
		expect(parseSimplificationCapabilityCatalog(missingFixture).ok).toBe(false);
	});

	it("rejects duplicate or non-canonical entry ids", () => {
		const invalid = fixture() as { entries: Array<Record<string, unknown>> };
		invalid.entries.unshift({ ...invalid.entries[0]!, id: "z-last" });
		expect(parseSimplificationCapabilityCatalog(invalid).ok).toBe(false);
	});
});
