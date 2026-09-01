// ===========================================
// Protocol v3 — structural report verification (unit pins)
// ===========================================
// Review 2026-08-31 fourth pass: report "verification" was a substring
// check — {"note":"src/lib/example.ts 1111… 2222… 9999…"} authenticated.
// Reports are now a versioned structural schema, and the rows must
// correspond EXACTLY to the envelope's evidence.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseUntrustedEnvelope, type ParsedEnvelope } from "./parse.js";
import { buildStructuralReport, verifyReportAgainstEnvelope } from "./report.js";
import { validMutationResult, validNotMutatable } from "./test-envelopes.js";
import type { V3MutationResult, V3NotMutatable } from "./types.js";

function parsed(raw: unknown): ParsedEnvelope {
	const outcome = parseUntrustedEnvelope(raw);
	if (!outcome.ok) throw new Error(`fixture must parse: ${outcome.reason}`);
	return outcome.envelope;
}

function sha(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A parsed envelope whose report pointer matches `text`. */
function withReport(base: V3MutationResult | V3NotMutatable, text: string): ParsedEnvelope {
	return parsed({
		...base,
		report: { r2_sha256: sha(text), bytes: Buffer.byteLength(text, "utf8"), content_hash: sha(text) },
	});
}

describe("verifyReportAgainstEnvelope — positive (must verify)", () => {
	// test-contract: public-api — a structurally exact report (built by the
	// shared builder) verifies for mutation_result and not_mutatable.
	it("P1: exact structural reports verify for both report-requiring kinds", () => {
		const mr = validMutationResult();
		const mrText = buildStructuralReport(mr);
		expect(verifyReportAgainstEnvelope(withReport(mr, mrText), Buffer.from(mrText, "utf8"))).toBeNull();
		const nm = validNotMutatable();
		const nmText = buildStructuralReport(nm);
		expect(verifyReportAgainstEnvelope(withReport(nm, nmText), Buffer.from(nmText, "utf8"))).toBeNull();
	});
});

describe("verifyReportAgainstEnvelope — negative (must reject)", () => {
	// test-contract: security — the reviewer's repro: a prose mention of
	// the target and mutant ids is NOT a structural file entry.
	it("N1: the prose-mention smuggle rejects", () => {
		const prose = '{"note":"src/lib/example.ts 1111111111111111 2222222222222222 9999999999999999"}';
		const reason = verifyReportAgainstEnvelope(withReport(validMutationResult(), prose), Buffer.from(prose, "utf8"));
		expect(reason).toContain("report_version");
	});

	// test-contract: security — a structurally valid report whose rows do
	// not correspond to the envelope (missing target, wrong status, missing
	// exclusion) rejects with the exact discrepancy.
	it("N2: row/target correspondence failures reject", () => {
		const mr = validMutationResult();
		const noTarget = '{"report_version":"1","files":{"src/other.ts":{"mutants":[]}}}';
		expect(
			verifyReportAgainstEnvelope(withReport(mr, noTarget), Buffer.from(noTarget, "utf8")),
		).toContain("target");
		const wrongStatus = buildStructuralReport({
			...mr,
			mutants: [
				{ ...mr.mutants[0]!, status: "survived" },
				{ ...mr.mutants[1]!, status: "killed" },
			] as typeof mr.mutants,
		});
		expect(
			verifyReportAgainstEnvelope(withReport(mr, wrongStatus), Buffer.from(wrongStatus, "utf8")),
		).toContain("status");
		const wrongIdentityContext = buildStructuralReport({
			...mr,
			mutants: [{ ...mr.mutants[0]!, qualified_name: "Foreign.example" }, mr.mutants[1]!],
		});
		expect(
			verifyReportAgainstEnvelope(
				withReport(mr, wrongIdentityContext),
				Buffer.from(wrongIdentityContext, "utf8"),
			),
		).toContain("qualified_name");
		const missingExclusion = buildStructuralReport({ ...mr, excluded: [] });
		expect(
			verifyReportAgainstEnvelope(withReport(mr, missingExclusion), Buffer.from(missingExclusion, "utf8")),
		).toContain("exclu");
		const wrongExclusionPolicy = buildStructuralReport({
			...mr,
			excluded: [{ ...mr.excluded[0]!, policy_id: "policy-different-approved-rule" }],
		});
		expect(
			verifyReportAgainstEnvelope(
				withReport(mr, wrongExclusionPolicy),
				Buffer.from(wrongExclusionPolicy, "utf8"),
			),
		).toContain("policy_id");
	});

	// test-contract: security — not_mutatable requires a structurally
	// present target with an EXACT zero-mutant result; any row rejects.
	it("N3: not_mutatable with any report row rejects", () => {
		const nm = validNotMutatable();
		const withRow = JSON.stringify({
			report_version: "1",
			files: {
				"src/lib/constants.ts": {
					mutants: [{ ...validMutationResult().excluded[0]!, status: "excluded" }],
				},
			},
		});
		expect(
			verifyReportAgainstEnvelope(withReport(nm, withRow), Buffer.from(withRow, "utf8")),
		).toContain("zero-mutant");
	});

	// test-contract: security — r2_sha256 and content_hash BOTH bind the
	// same retrieved bytes; a wrong r2 hash rejects (it was ignored before).
	it("N4: a wrong r2_sha256 rejects", () => {
		const mr = validMutationResult();
		const text = buildStructuralReport(mr);
		const env = parsed({
			...mr,
			report: { r2_sha256: "0".repeat(64), bytes: Buffer.byteLength(text, "utf8"), content_hash: sha(text) },
		});
		expect(verifyReportAgainstEnvelope(env, Buffer.from(text, "utf8"))).toContain("r2_sha256");
	});
});
