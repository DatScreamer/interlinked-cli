// ===========================================
// Protocol v3 — the CROSS-REPOSITORY acceptance matrix
// ===========================================
// Fixture-driven: every case in protocol/mutation-v3/fixtures/corpus.json
// runs through the CLI trust chain. Rejected cases are parser rejections.
// Accepted cases run the FULL path (review 2026-08-31 fourth pass): the
// harness fabricates the signed receipts and the structural report the
// kind requires, re-binds the hashes, seals, then parse+verify+classify —
// so classification is only ever computed on a VerifiedEvidenceBundle.
// The interlinked-cloud producer must pass the SAME corpus (see
// protocol/mutation-v3/README.md). Expectations carry completeness and
// observations ONLY: no case may expect a clean verdict from this layer.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyEvidence } from "./evidence.js";
import { parseUntrustedEnvelope } from "./parse.js";
import { authenticateFixture } from "./test-authentication.js";
import { parseAndVerify } from "./verify.js";

interface CorpusCase {
	name: string;
	expected: {
		parse: "accepted" | "rejected";
		reason_includes?: string;
		completeness?: "complete" | "partial" | "none";
		observations?: {
			killed: number;
			survived: number;
			uncovered: number;
			inconclusive: number;
			suite_red: boolean;
		};
	};
	envelope?: unknown;
	base?: string;
	patch?: Record<string, unknown>;
	delete?: string[];
}

const CORPUS_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../protocol/mutation-v3/fixtures/corpus.json",
);
// SAFETY: the corpus is a repo-committed fixture this suite exists to
// validate; a shape drift fails the derivation/assertions below loudly.
const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf-8")) as { cases: CorpusCase[] };

/** The corpus derivation contract (README §Derivation): a case either
 *  carries a full `envelope`, or derives one from a named case by
 *  shallow-merging `patch` (top-level keys replace wholesale) and removing
 *  `delete` keys. Bases resolve recursively so derived accepted cases can
 *  seed rejected ones. */
function materialize(c: CorpusCase): unknown {
	if (c.base === undefined) return c.envelope;
	const base = corpus.cases.find((candidate) => candidate.name === c.base);
	if (base === undefined) throw new Error(`case "${c.name}" derives from unknown base "${c.base}"`);
	const parent = materialize(base);
	if (parent === null || typeof parent !== "object") {
		throw new Error(`case "${c.name}" derives from non-object base "${c.base}"`);
	}
	// SAFETY: the guard above proved parent is a non-null object.
	const derived: Record<string, unknown> = { ...(parent as Record<string, unknown>), ...(c.patch ?? {}) };
	for (const key of c.delete ?? []) delete derived[key];
	return derived;
}

describe("protocol v3 acceptance corpus", () => {
	// test-contract: invariant — the corpus is non-trivial in both
	// directions; an accidentally emptied corpus must not pass silently.
	it("carries accepted and rejected cases", () => {
		const parses = corpus.cases.map((c) => c.expected.parse);
		expect(parses.filter((p) => p === "accepted").length).toBeGreaterThanOrEqual(10);
		expect(parses.filter((p) => p === "rejected").length).toBeGreaterThanOrEqual(20);
	});

	// test-contract: security — the review's P0: NO corpus expectation may
	// encode a clean verdict; the envelope layer carries evidence only.
	it("no case expects a clean verdict from the protocol layer", () => {
		const raw = readFileSync(CORPUS_PATH, "utf-8");
		expect(raw).not.toContain("can_certify_clean");
		expect(raw).not.toContain("certifies_clean");
	});

	for (const c of corpus.cases.filter((candidate) => candidate.expected.parse === "rejected")) {
		// test-contract: public-api — one matrix row per rejected case; the
		// parser must refuse with the fixture's reason.
		it(`rejected: ${c.name}`, () => {
			const outcome = parseUntrustedEnvelope(materialize(c));
			expect(outcome.ok).toBe(false);
			if (!outcome.ok) expect(outcome.reason).toContain(c.expected.reason_includes ?? "");
		});
	}

	for (const c of corpus.cases.filter((candidate) => candidate.expected.parse === "accepted")) {
		// test-contract: public-api — one matrix row per accepted case, run
		// through the FULL trust chain before classification.
		it(`accepted: ${c.name}`, () => {
			// SAFETY: accepted cases materialize to structurally valid objects.
			const { raw, inputs } = authenticateFixture(materialize(c) as Record<string, unknown>);
			const outcome = parseAndVerify(raw, inputs);
			expect(outcome.ok).toBe(true);
			if (!outcome.ok) return;
			const evidence = classifyEvidence(outcome.bundle);
			expect(evidence.completeness).toBe(c.expected.completeness);
			expect(evidence.observations).toEqual(c.expected.observations);
			if (c.expected.reason_includes !== undefined) {
				expect(evidence.incompleteness_reasons.join(" ")).toContain(c.expected.reason_includes);
			}
		});
	}
});
