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

	it("rejects absolute paths and URL hosts as file anchors", () => {
		const parsed = parseReviewFindings(
			[
				"1. [high] /tmp/review.ts:7 is not a repository anchor.",
				"2. [high] https:example.com/report.pdf is not a repository anchor.",
				"3. [high] [src/review.ts:7] is a repository anchor.",
			].join("\n"),
		);
		expect(parsed[0]).not.toHaveProperty("file");
		expect(parsed[1]).not.toHaveProperty("file");
		expect(parsed[2]).toEqual(expect.objectContaining({ file: "src/review.ts", line: 7 }));
	});

	it("does not materialize an optional line when an anchor omits it", () => {
		const parsed = parseReviewFindings("1. [low] [src/review.ts] Missing line metadata.");
		expect(parsed[0]).toEqual(expect.objectContaining({ file: "src/review.ts" }));
		expect(Object.hasOwn(parsed[0] ?? {}, "line")).toBe(false);
	});

	it("normalizes severity, inline brackets, anchors, and repeated whitespace", () => {
		const parsed = parseReviewFindings(
			"1. [severity:   high]Defect [x]Defect2 [module.ts:21] left    right   ",
		);
		expect(parsed[0]).toEqual(
			expect.objectContaining({
				severity: "high",
				file: "module.ts",
				line: 21,
				statement: "Defect x Defect2 left right",
			}),
		);
	});

	it("requires TOTAL to be a valid, line-started numeric terminator", () => {
		expect(
			parseReviewFindings("1. [low] first\n   Note TOTAL: 99\n2. [low] second\nTOTAL: 2"),
		).toHaveLength(2);
		expect(parseReviewFindings("1. [low] first\n   TOTAL: 2\n2. [low] second")).toHaveLength(1);
		expect(parseReviewFindings("1. [low] first\nTOTAL:1\n2. [low] second")).toHaveLength(1);
		expect(
			parseReviewFindings("1. [low] first\nTOTAL: nope\n2. [low] second"),
		).toHaveLength(2);
	});

	it("keeps finding-block line breaks and separates body anchors", () => {
		const parsed = parseReviewFindings(
			"1. [high] Defect\nsrc/a.ts:17\n\n2. [low] Next",
		);
		expect(parsed[0]).toEqual(
			expect.objectContaining({
				file: "src/a.ts",
				line: 17,
				raw: "[high] Defect\nsrc/a.ts:17",
			}),
		);
	});

	it("selects non-empty evidence and clips it at 300 characters", () => {
		const quote = "q".repeat(350);
		const parsed = parseReviewFindings(
			`1. [high] Defect\n   Evidence:\n   Evidence: ${quote}`,
		);
		expect(parsed[0]?.quote).toBe(quote.slice(0, 300));

		const noSpace = parseReviewFindings("1. [high] Defect\n   Evidence:quoted");
		expect(noSpace[0]?.quote).toBe("quoted");

		const embedded = parseReviewFindings("1. [high] Defect\n   prefix Evidence: quoted");
		expect(embedded[0]).not.toHaveProperty("quote");
	});

	it("clips oversized statements and raw provenance", () => {
		const statement = "a".repeat(350);
		const parsedStatement = parseReviewFindings(`1. [high] ${statement}`);
		expect(parsedStatement[0]?.statement).toBe(statement.slice(0, 300));

		const parsedRaw = parseReviewFindings(`1. [high] Defect\n${"x".repeat(2100)}`);
		expect(parsedRaw[0]?.raw).toHaveLength(2000);
	});

	it("accepts multi-digit indexes and severity tags without an internal space", () => {
		const parsed = parseReviewFindings(
			"12. [severity:high] [src/review.ts:9] Defect without spacing.",
		);
		expect(parsed[0]).toEqual(
			expect.objectContaining({ index: 12, severity: "high", file: "src/review.ts", line: 9 }),
		);

		const spaced = parseReviewFindings("12.   [severity:high] Defect with outer spacing.");
		expect(spaced[0]?.raw).toBe("[severity:high] Defect with outer spacing.");
	});
});
