import { describe, expect, it } from "vitest";
import { structureFindingToCheckResult } from "./structure-checks.js";
import type { StructureFinding } from "./types.js";

describe("structureFindingToCheckResult", () => {
	const base: StructureFinding = {
		name: "public_symbol_companion_untouched",
		severity: "warning",
		message: "example",
		file: "src/foo.ts",
		determinism: "fully_deterministic",
		provenance: "declared",
		artifact_kind: "public_symbol",
		artifact_id: "public_symbol:foo",
		required_updates: [{ file: "docs/foo.md", kind: "doc", reason: "x" }],
		confidence: 1,
	};

	it("converts a finding into a check result entry", () => {
		const entry = structureFindingToCheckResult(base);
		expect(entry).toHaveProperty("source");
		expect(entry).toHaveProperty("name");
		expect(entry).toHaveProperty("file");
		expect(entry).toHaveProperty("message");
		expect(entry.source).toBe("structure");
		expect(entry.name).toBe("public_symbol_companion_untouched");
		expect(entry.file).toBe("src/foo.ts");
	});

	it("preserves the source file", () => {
		const entry = structureFindingToCheckResult({ ...base, file: "src/other.ts" });
		expect(entry.file).toBe("src/other.ts");
	});

	it("embeds the finding's message in the output", () => {
		const entry = structureFindingToCheckResult({ ...base, message: "specific" });
		expect(entry.message).toContain("specific");
	});
});
