import { describe, expect, it } from "vitest";
import { parseReviewFindings } from "./review-ingest.js";

// The strict format our review prompts demand (and Codex emits).
const STRICT_REPORT = `
1. [severity: high] [src/harness/spec/extract-ids.ts:21] Dashed IDs with four-digit numeric components are never extracted.
   Evidence: const DASHED_ID_RE = /\\b([A-Z][A-Z0-9-]{0,30})-(\\d{1,3})\\b/g;
   Why: \\d{1,3} cannot match four digits.

2. [medium] [src/harness/spec/ledger.ts:325] A markdown target omitted for size is reported as nonexistent.
   Evidence: const exists = mdTarget ? false : this.fileExists(...);
   Why: Size skips increment skipped without setting truncated.

TOTAL: 2
`;

// Sol's plan-audit prose style: numbered items, file:line inline, no brackets.
const SOL_AUDIT_STYLE = `
## Concrete document and repository errors

1. The plan has seven bets, including Sextant/B7 (COMPREHENSIVE_PLAN.md:18); AGENTS.md and README still say six.

2. The plan says the full invariants.toml exists in-repo (COMPREHENSIVE_PLAN.md:839). It does not currently exist.
`;

describe("parseReviewFindings", () => {
	it("parses the strict format: index, severity, anchor, statement, quote", () => {
		const parsed = parseReviewFindings(STRICT_REPORT);
		expect(parsed).toHaveLength(2);
		expect(parsed[0]).toEqual(
			expect.objectContaining({
				index: 1,
				severity: "high",
				file: "src/harness/spec/extract-ids.ts",
				line: 21,
				quote: expect.stringContaining("DASHED_ID_RE"),
			}),
		);
		expect(parsed[0]?.statement).toContain("four-digit numeric components");
		expect(parsed[0]?.statement).not.toContain("[severity");
		expect(parsed[1]?.severity).toBe("medium");
	});

	it("parses Sol's prose audit style with inline file:line anchors", () => {
		const parsed = parseReviewFindings(SOL_AUDIT_STYLE);
		expect(parsed).toHaveLength(2);
		expect(parsed[0]).toEqual(
			expect.objectContaining({ file: "COMPREHENSIVE_PLAN.md", line: 18 }),
		);
		expect(parsed[1]?.statement).toContain("invariants.toml");
	});

	it("stops at TOTAL, tolerates unanchored findings, ignores URLs", () => {
		const parsed = parseReviewFindings(
			"1. [low] The overall sequencing conflicts with the architecture (see https://raft.github.io/raft.pdf).\nTOTAL: 1\n9. never parsed",
		);
		expect(parsed).toHaveLength(1);
		// The URL must not become a file anchor.
		expect(parsed[0]?.file).toBeUndefined();
		expect(parsed[0]?.line).toBeUndefined();
		expect(parsed[0]?.severity).toBe("low");
	});

	it("returns empty for reports with no numbered findings", () => {
		expect(parseReviewFindings("All clean.\nTOTAL: 0")).toEqual([]);
		expect(parseReviewFindings("")).toEqual([]);
	});

	it("does not split on indented numbered sub-lists in a body (round-2 #8)", () => {
		const parsed = parseReviewFindings(
			"1. [high] [a.ts:1] Defect.\n   Evidence:\n   1. first case\n   2. second case\nTOTAL: 1",
		);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.statement).toContain("Defect");
	});

	it("strips the [file:line] anchor from the statement, not just unwraps it (round-2 #7)", () => {
		const parsed = parseReviewFindings("1. [high] [src/a.ts:21] Four-digit IDs fail.");
		expect(parsed[0]?.statement).toBe("Four-digit IDs fail.");
		expect(parsed[0]?.statement).not.toContain("src/a.ts");
		// The anchor is still captured structurally.
		expect(parsed[0]?.file).toBe("src/a.ts");
	});
});
