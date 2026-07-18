import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findingsCorpusPath, loadFindings } from "../harness/findings/corpus.js";
import { loadReconciliation, reconciliationStateOf } from "../harness/spec/reconciliation.js";
import { ingestReviewReport, isReviewFinding, verifyFindingAnchors } from "./findings.js";

const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const REPORT = `
1. [severity: high] [src/a.ts:21] Four-digit dashed ids are never extracted.
   Evidence: const DASHED_ID_RE = /x/;
   Why: digit width.

2. [medium] The sequencing conflicts with the architecture overall.
   Why: judgment call, no anchor.

TOTAL: 2
`;

describe("ingestReviewReport", () => {
	it("records parsed findings into the corpus with provenance", () => {
		const cwd = mkdtempSync(join(tmpdir(), "findings-cli-"));
		roots.push(cwd);
		const report = join(cwd, "review.md");
		writeFileSync(report, REPORT);
		const summary = ingestReviewReport(report, "codex-sol", cwd);
		expect(summary).toEqual({ parsed: 2, recorded: 2, anchored: 1 });
		const rows = loadFindings(cwd).filter(isReviewFinding);
		expect(rows).toHaveLength(2);
		const anchored = rows.find((r) => r.file === "src/a.ts");
		expect(anchored).toEqual(
			expect.objectContaining({ line: 21, severity: "high" }),
		);
		expect(anchored?.provenance[0]?.source_runner).toBe("codex-sol");
		expect(anchored?.provenance[0]?.quote).toContain("DASHED_ID_RE");
		// The corpus file is real JSONL on disk.
		expect(readFileSync(findingsCorpusPath(cwd), "utf8").trim().split("\n")).toHaveLength(2);
	});

	it("re-ingesting the same report dedups rather than duplicating", () => {
		const cwd = mkdtempSync(join(tmpdir(), "findings-cli-"));
		roots.push(cwd);
		const report = join(cwd, "review.md");
		writeFileSync(report, REPORT);
		ingestReviewReport(report, "codex-sol", cwd);
		ingestReviewReport(report, "codex-sol", cwd);
		const rows = loadFindings(cwd).filter(isReviewFinding);
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.times_observed >= 1)).toBe(true);
	});

	it("distinct unanchored findings with shared leading words get distinct ids (round-2 #4)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "findings-cli-"));
		roots.push(cwd);
		const report = join(cwd, "review.md");
		writeFileSync(
			report,
			"1. [medium] The API must define retry behavior for writes.\n2. [medium] The API must define retry behavior for reads.\nTOTAL: 2",
		);
		ingestReviewReport(report, "sol", cwd);
		const rows = loadFindings(cwd).filter(isReviewFinding);
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map((r) => r.id)).size).toBe(2);
	});

	it("a second reviewer merges provenance instead of replacing (round-2 #6)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "findings-cli-"));
		roots.push(cwd);
		const report = join(cwd, "review.md");
		writeFileSync(report, "1. [high] [src/a.ts:21] Anchored defect.\nTOTAL: 1");
		ingestReviewReport(report, "reviewer-a", cwd);
		ingestReviewReport(report, "reviewer-b", cwd);
		const rows = loadFindings(cwd).filter(isReviewFinding);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.source_runners.sort()).toEqual(["reviewer-a", "reviewer-b"]);
	});
});

describe("verifyFindingAnchors (LG-6)", () => {
	/** cwd + a real src/a.ts whose line 21 the REPORT's finding anchors. */
	function setup(): { cwd: string; target: string } {
		const cwd = mkdtempSync(join(tmpdir(), "findings-verify-"));
		roots.push(cwd);
		const lines = Array.from({ length: 25 }, (_, i) => `const filler${i + 1} = ${i + 1};`);
		lines[20] = "const DASHED_ID_RE = /^\\d{4}-\\d{4}$/;"; // line 21, the anchor
		const target = join(cwd, "src", "a.ts");
		writeFileSync(join(cwd, "review.md"), REPORT);
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(target, `${lines.join("\n")}\n`);
		ingestReviewReport(join(cwd, "review.md"), "codex-sol", cwd);
		return { cwd, target };
	}

	it("classifies an untouched anchor live and skips unanchored findings", () => {
		const { cwd } = setup();
		const summary = verifyFindingAnchors(cwd, false);
		expect(summary.counts.live).toBe(1);
		expect(summary.rows).toHaveLength(1); // the unanchored finding is skipped
	});

	it("detects a move after insertions above, re-anchors with --write, then reads live", () => {
		const { cwd, target } = setup();
		const original = readFileSync(target, "utf8");
		writeFileSync(target, `// new header\n// more header\n${original}`);

		const dryRun = verifyFindingAnchors(cwd, false);
		expect(dryRun.counts.moved).toBe(1);
		expect(dryRun.rows[0]?.newLine).toBe(23);
		// Dry run wrote nothing.
		expect(loadFindings(cwd).find((f) => f.file === "src/a.ts")?.line).toBe(21);

		const written = verifyFindingAnchors(cwd, true);
		expect(written.reanchored).toBe(1);
		const updated = loadFindings(cwd).find((f) => f.file === "src/a.ts");
		expect(updated?.line).toBe(23);
		// Reanchor is ledger maintenance: the finding stays OPEN, never closed.
		const recon = loadReconciliation(cwd);
		expect(updated && reconciliationStateOf(recon, updated.id)).toBe("open");
		// After re-anchoring, a fresh verify reads live.
		expect(verifyFindingAnchors(cwd, false).counts.live).toBe(1);
	});

	it("classifies changed content drifted and a deleted file gone — never auto-closing", () => {
		const { cwd, target } = setup();
		const original = readFileSync(target, "utf8");
		writeFileSync(target, original.replace("const DASHED_ID_RE", "const DASHED_ID_PATTERN"));
		expect(verifyFindingAnchors(cwd, true).counts.drifted).toBe(1);
		rmSync(target);
		expect(verifyFindingAnchors(cwd, true).counts.gone).toBe(1);
		const f = loadFindings(cwd).find((row) => row.file === "src/a.ts");
		expect(f && reconciliationStateOf(loadReconciliation(cwd), f.id)).toBe("open");
	});
});
