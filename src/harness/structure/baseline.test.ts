import { describe, expect, it } from "vitest";
import { addToBaseline, findingToBaselineEntry, isBaselined } from "./baseline.js";
import type { BaselineFile, StructureFinding } from "./types.js";

function finding(overrides: Partial<StructureFinding> = {}): StructureFinding {
	return {
		name: "public_symbol_companion_untouched",
		severity: "warning",
		message: "example",
		file: "src/foo.ts",
		determinism: "fully_deterministic",
		provenance: "declared",
		artifact_kind: "public_symbol",
		artifact_id: "public_symbol:foo",
		required_updates: [{ file: "docs/foo.md", kind: "doc", reason: "needs update" }],
		confidence: 1,
		...overrides,
	};
}

describe("findingToBaselineEntry", () => {
	it("emits the expected fields", () => {
		const entry = findingToBaselineEntry(finding());
		expect(entry.finding_name).toBe("public_symbol_companion_untouched");
		expect(entry.source_file).toBe("src/foo.ts");
		expect(entry.determinism).toBe("fully_deterministic");
		expect(entry.required_companion_files).toEqual(["docs/foo.md"]);
		expect(typeof entry.context_hash).toBe("string");
		expect(entry.context_hash.length).toBe(64); // sha256 hex
	});

	it("produces a stable hash regardless of required_updates order", () => {
		const f1 = finding({
			required_updates: [
				{ file: "docs/a.md", kind: "doc", reason: "x" },
				{ file: "docs/b.md", kind: "doc", reason: "x" },
			],
		});
		const f2 = finding({
			required_updates: [
				{ file: "docs/b.md", kind: "doc", reason: "x" },
				{ file: "docs/a.md", kind: "doc", reason: "x" },
			],
		});
		expect(findingToBaselineEntry(f1).context_hash).toBe(
			findingToBaselineEntry(f2).context_hash,
		);
	});
});

describe("isBaselined", () => {
	it("matches on finding_name + artifact_ref + source_file + determinism", () => {
		const baseline: BaselineFile = {
			schema_version: 1,
			entries: [findingToBaselineEntry(finding())],
		};
		expect(isBaselined(finding(), baseline)).toBe(true);
	});

	it("returns false when determinism differs", () => {
		const baseline: BaselineFile = {
			schema_version: 1,
			entries: [findingToBaselineEntry(finding())],
		};
		const other = finding({ determinism: "partially_deterministic" });
		expect(isBaselined(other, baseline)).toBe(false);
	});

	it("returns false when source_file differs", () => {
		const baseline: BaselineFile = {
			schema_version: 1,
			entries: [findingToBaselineEntry(finding())],
		};
		expect(isBaselined(finding({ file: "src/bar.ts" }), baseline)).toBe(false);
	});
});

describe("addToBaseline", () => {
	it("deduplicates when re-adding an already-baselined finding", () => {
		const base: BaselineFile = { schema_version: 1, entries: [] };
		const a = addToBaseline(base, [finding()]);
		expect(a.entries).toHaveLength(1);

		// Re-adding the same finding against the now-populated baseline is a no-op.
		const b = addToBaseline(a, [finding()]);
		expect(b.entries).toHaveLength(1);

		const c = addToBaseline(b, [finding({ file: "src/bar.ts" })]);
		expect(c.entries).toHaveLength(2);
	});

	it("preserves existing entries", () => {
		const base: BaselineFile = {
			schema_version: 1,
			entries: [findingToBaselineEntry(finding({ file: "src/pre.ts" }))],
		};
		const added = addToBaseline(base, [finding()]);
		expect(added.entries).toHaveLength(2);
	});
});
