// Tests for the dead-code categorizer (operator decision 2026-08-17):
// candidates sort into mechanically-derived buckets so deletion agents only
// ever touch the provably-safe ones. The classifier is a pure function over
// extracted signals; git probes are injected so tests never spawn git.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildDocsCorpus,
	type CandidateSignals,
	type CandidateVerdict,
	categorizeCandidate,
	categorizeDeadCode,
	type CategorizeReport,
	type DeadCodeBucket,
	type DeadCodeRecommendation,
} from "./deadcode-categorize.js";

function signals(partial: Partial<CandidateSignals>): CandidateSignals {
	return {
		kind: "export",
		everImported: true,
		docReferenced: false,
		seamName: false,
		publishedSurface: false,
		testOnlyImporters: false,
		reExportLine: false,
		typeOnly: false,
		hadImportersRemoved: false,
		...partial,
	};
}

describe("categorizeCandidate — positive (bucket per signal)", () => {
	// test-contract: behavior — never-imported + doc-referenced is planned
	// scaffolding; deleting it undoes design intent (differential-fuzz-types)
	it("P1: never-imported + doc-referenced → future-scaffolding", () => {
		// Typed via the public API shapes so the exported types are themselves
		// under test reference (bucket/recommendation unions included).
		const c: CandidateVerdict = categorizeCandidate(
			signals({ everImported: false, docReferenced: true }),
		);
		const bucket: DeadCodeBucket = c.bucket;
		const rec: DeadCodeRecommendation = c.recommendation;
		expect(bucket).toBe("future-scaffolding");
		expect(rec).toBe("keep");
	});

	// test-contract: behavior — seam names and published surface are
	// deliberate API; the fix is annotation, not deletion
	it("P2: seam name or published surface → deliberate-seam", () => {
		expect(categorizeCandidate(signals({ seamName: true })).bucket).toBe("deliberate-seam");
		expect(categorizeCandidate(signals({ publishedSurface: true })).bucket).toBe(
			"deliberate-seam",
		);
		expect(categorizeCandidate(signals({ testOnlyImporters: true })).bucket).toBe(
			"deliberate-seam",
		);
	});

	// test-contract: behavior — a re-export line whose symbol lives elsewhere
	// deletes zero code; tsc guards the removal
	it("P3: re-export line → reexport-residue, delete-line recommendation", () => {
		const c = categorizeCandidate(signals({ reExportLine: true }));
		expect(c.bucket).toBe("reexport-residue");
		expect(c.recommendation).toBe("delete-line");
	});

	it("P4: type-only export → orphaned-type", () => {
		const c = categorizeCandidate(signals({ typeOnly: true }));
		expect(c.bucket).toBe("orphaned-type");
		expect(c.recommendation).toBe("delete");
	});

	// test-contract: behavior — git shows importers existed and were removed:
	// superseded by a successor; safe with the refactor commit cited
	it("P5: had importers removed → superseded", () => {
		const c = categorizeCandidate(signals({ hadImportersRemoved: true }));
		expect(c.bucket).toBe("superseded");
		expect(c.recommendation).toBe("delete");
	});
});

describe("categorizeCandidate — negative (precedence + fallback)", () => {
	// test-contract: invariant — keep-buckets outrank delete-buckets: a
	// doc-referenced never-imported file stays scaffolding even when type-only
	it("N1: future-scaffolding outranks orphaned-type", () => {
		const c = categorizeCandidate(
			signals({ everImported: false, docReferenced: true, typeOnly: true }),
		);
		expect(c.bucket).toBe("future-scaffolding");
	});

	it("N2: deliberate-seam outranks reexport-residue", () => {
		const c = categorizeCandidate(signals({ seamName: true, reExportLine: true }));
		expect(c.bucket).toBe("deliberate-seam");
	});

	it("N3: no signal → ambiguous, review recommendation", () => {
		const c = categorizeCandidate(signals({}));
		expect(c.bucket).toBe("ambiguous");
		expect(c.recommendation).toBe("review");
	});

	// test-contract: behavior — never-imported WITHOUT a doc reference stays
	// ambiguous (could be scaffolding whose docs use prose, could be
	// stillborn), but the reason must carry the never-imported evidence so
	// the reviewer starts from it (calibration find: differential-fuzz-types'
	// plan docs say "differential fuzzing", never the file base)
	it("N4: never-imported without doc reference → ambiguous, evidence in reason", () => {
		const c = categorizeCandidate(signals({ everImported: false }));
		expect(c.bucket).toBe("ambiguous");
		expect(c.reason).toContain("never imported in git history");
	});
});

describe("signal extraction over a fixture repo", () => {
	let tmp: string;

	function seed(rel: string, content: string): void {
		const abs = join(tmp, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content);
	}

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "interlinked-deadcat-"));
		seed("package.json", JSON.stringify({ name: "fixture", bin: { fixture: "./dist/index.js" } }));
		seed("docs/plans/01-future.md", "The fuzz prover consumes `PlannedThing` from planned-module.\n");
		seed("src/index.ts", 'import { used } from "./lib.js";\nconsole.log(used);\n');
		seed(
			"src/lib.ts",
			'export const used = 1;\nexport type OrphanShape = { a: number };\nexport function _resetForTests(): void {}\n',
		);
		seed("src/barrel.ts", 'export { used } from "./lib.js";\nexport const barrelOnly = 2;\n');
		seed("src/planned-module.ts", "export interface PlannedThing { x: number }\n");
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	// test-contract: behavior — the docs corpus is a word-boundary match, so
	// symbol names hit but substrings of longer identifiers do not
	it("P6: buildDocsCorpus matches whole symbols only", () => {
		const corpus = buildDocsCorpus(tmp);
		expect(corpus.mentions("PlannedThing")).toBe(true);
		expect(corpus.mentions("Planned")).toBe(false);
		expect(corpus.mentions("NeverMentioned")).toBe(false);
	});

	// test-contract: public-api — the end-to-end pass buckets a doc-referenced
	// never-imported file as scaffolding and a seam-named export as deliberate,
	// with git probes injected (no spawns)
	it("P7: categorizeDeadCode buckets fixture candidates end-to-end", () => {
		const report: CategorizeReport = categorizeDeadCode(tmp, {
			unreachableFiles: ["src/planned-module.ts"],
			deadExports: [
				{ file: "src/lib.ts", detail: "unused export '_resetForTests' — remove" },
				{ file: "src/lib.ts", detail: "unused export 'OrphanShape' — remove" },
			],
			gitProbe: () => ({ everImported: false, hadImportersRemoved: false }),
		});
		const byName = new Map(report.items.map((i) => [i.symbol ?? i.file, i.bucket]));
		expect(byName.get("src/planned-module.ts")).toBe("future-scaffolding");
		expect(byName.get("_resetForTests")).toBe("deliberate-seam");
		expect(byName.get("OrphanShape")).toBe("orphaned-type");
	});
});
