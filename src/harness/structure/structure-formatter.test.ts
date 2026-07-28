import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { formatStructureVerifyOutput, formatStructureWarnings } from "./structure-formatter.js";
import type { StructureFinding } from "./types.js";

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

describe("formatStructureWarnings", () => {
	it("emits one multi-line string per finding", () => {
		const lines = formatStructureWarnings([finding()]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("[interlinked:structure]");
		expect(lines[0]).toContain("file: src/foo.ts");
		expect(lines[0]).toContain("artifact: public_symbol foo");
		expect(lines[0]).toContain("determinism: fully_deterministic");
	});

	it("sorts fully_deterministic → partially → heuristic", () => {
		const lines = formatStructureWarnings([
			finding({ determinism: "heuristic", file: "c.ts" }),
			finding({ determinism: "partially_deterministic", file: "b.ts" }),
			finding({ determinism: "fully_deterministic", file: "a.ts" }),
		]);
		expect(lines[0]).toContain("a.ts");
		expect(lines[1]).toContain("b.ts");
		expect(lines[2]).toContain("c.ts");
	});

	it("lists required follow-ups when present", () => {
		const lines = formatStructureWarnings([finding()]);
		expect(lines[0]).toContain("required follow-ups");
		expect(lines[0]).toContain("docs/foo.md (doc)");
	});
});

describe("formatStructureVerifyOutput", () => {
	it("shapes the output with mode + counts + details", () => {
		const out = formatStructureVerifyOutput({
			config: null,
			findings: [finding()],
			invalidFiles: [],
			adoption: { public_api: 1.0 },
			catalogFresh: true,
		});
		expect(out.mode).toBe("minimal");
		expect(out.findings.fully_deterministic).toBe(1);
		expect(nonNull(out.details[0]).name).toBe("public_symbol_companion_untouched");
	});

	it("mode defaults to 'minimal' when no config is provided", () => {
		const out = formatStructureVerifyOutput({
			config: null,
			findings: [],
			invalidFiles: [],
			adoption: {},
			catalogFresh: true,
		});
		expect(out.mode).toBe("minimal");
	});
});
