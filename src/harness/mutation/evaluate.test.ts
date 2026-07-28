import { describe, expect, it } from "vitest";
import { evaluateMutation } from "./evaluate.js";
import { computeSymbolHashes, type SymbolHashEntry } from "./identity.js";
import { emptyManifest } from "./manifest.js";
import type { AdaptedMutant } from "./stryker-adapter.js";
import type { MutationGateOutcome, MutationManifest, StableId, SymbolRecord, TestRunResult } from "./types.js";

const FILE = "src/x.ts";
const META = {
	engine: "stryker",
	engineVersion: "1",
	dependencyGraphVersion: "g",
	environmentHash: "e",
	authoritativeAt: "t0",
};
const CONTENT = "function bar(x: number): boolean { return x > 0; }\n";

type Measured = Extract<MutationGateOutcome, { kind: "measured" }>;

// Narrowing helpers live outside the it() blocks so the test bodies stay branch-free.
function measured(out: MutationGateOutcome): Measured {
	if (out.kind !== "measured") throw new Error(`expected a measured outcome, got ${out.kind}`);
	return out;
}

function requireHashes(content: string): Map<StableId, SymbolHashEntry> {
	const h = computeSymbolHashes(FILE, content);
	if (!h) throw new Error("typescript unavailable");
	return h;
}

/**
 * A manifest that already has a baseline for FILE, but whose symbol hash differs
 * from CONTENT — so the symbol reads as CHANGED and the ratchet applies.
 *
 * The ratchet tests need this because a manifest with NO entry for the file is a
 * first sighting, where the gate deliberately establishes a baseline instead of
 * verdicting: with no prior, every symbol looks changed and every pre-existing
 * survivor looks new, so judging it rejects on the size of the file rather than
 * the size of the edit.
 */
function priorBaseline(): MutationManifest {
	return manifestFromContent("function bar(x: number): boolean { return x > 1; }\n");
}

function manifestFromContent(content: string): MutationManifest {
	const records: Record<string, SymbolRecord> = {};
	for (const [symbolId, entry] of requireHashes(content)) {
		records[symbolId] = {
			symbolId,
			qualifiedName: entry.qualifiedName,
			symbolHash: entry.symbolHash,
			mutants: {},
			instability: { events: [], consecutiveStableRuns: 0, quarantined: false },
		};
	}
	return { ...emptyManifest(META), files: { [FILE]: records } };
}

function adaptedGt(status: AdaptedMutant["status"]): AdaptedMutant {
	return {
		raw: { file: FILE, mutator: "Eq", originalLexeme: ">", replacement: ">=", startOffset: CONTENT.indexOf("> 0") },
		status,
	};
}

function evalWith(
	base: MutationManifest,
	adapted: AdaptedMutant[],
	siteCountThreshold = 50,
	testRun?: TestRunResult,
): MutationGateOutcome {
	return evaluateMutation({ file: FILE, baseManifest: base, overlayContent: CONTENT, adapted, siteCountThreshold, testRun, at: "t" });
}

describe("evaluateMutation", () => {
	it("blocks a new survivor in a changed symbol and emits a hash-bound receipt", () => {
		const m = measured(evalWith(priorBaseline(), [adaptedGt("survived")]));
		expect(m.decision).toBe("block");
		expect(m.newSurvivors).toHaveLength(1);
		expect(m.receipt.overlayHash).toHaveLength(64);
		expect(m.receipt.sites).toHaveLength(1);
	});

	it("allows when the mutant is killed", () => {
		expect(measured(evalWith(priorBaseline(), [adaptedGt("killed")])).decision).toBe("allow");
	});

	it("blocks on an uncovered changed site", () => {
		const m = measured(evalWith(priorBaseline(), [adaptedGt("uncovered")]));
		expect(m.decision).toBe("block");
		expect(m.uncoveredSites).toHaveLength(1);
	});

	it("allows a survivor in an unchanged symbol (hash matches the manifest)", () => {
		expect(measured(evalWith(manifestFromContent(CONTENT), [adaptedGt("survived")])).decision).toBe("allow");
	});

	it("blocks oversize: changed sites over the threshold, even when the mutant is killed", () => {
		// 1 changed site > a threshold of 0 ⇒ "split this patch" overrides the clean kill.
		const m = measured(evalWith(priorBaseline(), [adaptedGt("killed")], 0));
		expect(m.decision).toBe("block");
		expect(m.changedSiteCount).toBeGreaterThan(m.siteCountThreshold);
	});

	it("returns a refreshed manifest ONLY on a measured-clean allow (generation bumped)", () => {
		const clean = measured(evalWith(priorBaseline(), [adaptedGt("killed")]));
		expect(clean.decision).toBe("allow");
		expect(clean.refreshedManifest?.generation).toBe(1);
		expect(Object.keys(clean.refreshedManifest?.files[FILE] ?? {})).not.toHaveLength(0);
	});

	it("returns NO refreshed manifest on a block (dirty run cannot launder the manifest)", () => {
		const dirty = measured(evalWith(priorBaseline(), [adaptedGt("survived")]));
		expect(dirty.decision).toBe("block");
		expect(dirty.refreshedManifest).toBeUndefined();
	});

	it("closes the loop: a clean pass's manifest makes the next run's same-content survivor pre-existing", () => {
		// Run 1: killed mutant → clean → refreshed manifest persisted (simulated).
		const first = measured(evalWith(priorBaseline(), [adaptedGt("killed")]));
		const persisted = first.refreshedManifest;
		if (!persisted) throw new Error("expected a refreshed manifest");
		// Run 2: SAME content, now the engine reports a survivor. The symbol hash
		// matches the persisted manifest → unchanged region → no block.
		const second = measured(evalWith(persisted, [adaptedGt("survived")]));
		expect(second.decision).toBe("allow");
	});

	// --- First sighting: establish a baseline, do not verdict ---
	// Without this the gate could never bootstrap: no manifest ⇒ every symbol
	// reads as changed ⇒ rejected on the size of the FILE ⇒ no clean pass ⇒ still
	// no manifest. Measured live as a one-line comment edit reporting 116
	// "changed sites".
	it("P: allows a survivor on FIRST sighting and records it as the baseline", () => {
		const m = measured(evalWith(emptyManifest(META), [adaptedGt("survived")]));
		expect(m.decision).toBe("allow");
		expect(m.refreshedManifest).toBeDefined();
	});

	it("P: allows an oversize first sighting — the count reflects the file, not the edit", () => {
		const m = measured(evalWith(emptyManifest(META), [adaptedGt("killed")], 0));
		expect(m.decision).toBe("allow");
	});

	it("P: allows an uncovered site on first sighting", () => {
		expect(measured(evalWith(emptyManifest(META), [adaptedGt("uncovered")])).decision).toBe("allow");
	});

	it("N: STILL blocks a red suite on first sighting — that is the edit, not the baseline", () => {
		const m = measured(
			evalWith(emptyManifest(META), [adaptedGt("killed")], 50, {
				overlayGreen: false,
				redWitnessSatisfied: null,
			}),
		);
		expect(m.decision).toBe("block");
	});

	it("N: the SECOND edit ratchets normally once the baseline exists", () => {
		// Establish on first sighting, then re-judge the same survivor against it.
		const first = measured(evalWith(emptyManifest(META), [adaptedGt("killed")]));
		const persisted = first.refreshedManifest;
		if (!persisted) throw new Error("expected a refreshed manifest");
		const changed = measured(
			evaluateMutation({
				file: FILE,
				baseManifest: { ...persisted, files: { [FILE]: priorBaseline().files[FILE] ?? {} } },
				overlayContent: CONTENT,
				adapted: [adaptedGt("survived")],
				siteCountThreshold: 50,
				at: "t",
			}),
		);
		expect(changed.decision).toBe("block");
	});

	it("blocks a red overlay suite even when the mutant is killed (spec §7 red/green)", () => {
		const m = measured(evalWith(priorBaseline(), [adaptedGt("killed")], 50, { overlayGreen: false, redWitnessSatisfied: null }));
		expect(m.decision).toBe("block");
		expect(m.suiteRed).toBe(true);
	});

	it("warns (allows) on a failed RED-witness with a green suite + killed mutant", () => {
		const m = measured(evalWith(priorBaseline(), [adaptedGt("killed")], 50, { overlayGreen: true, redWitnessSatisfied: false }));
		expect(m.decision).toBe("allow");
		expect(m.redWitnessFailed).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Phase D ratchet: 13 survivors of 90 in the gate's DECISION core — the place
// where an unnoticed wrong answer becomes a forged pass or a false block.
// ---------------------------------------------------------------------------

describe("the site-count ceiling is a strict threshold", () => {
	it("allows a patch sitting exactly ON the threshold", () => {
		// `>` not `>=`: at the limit is still inside it. Off-by-one here turns a
		// legal patch into a "split this up" block.
		const m = measured(evalWith(priorBaseline(), [adaptedGt("killed")], 1));
		expect(m.decision).toBe("allow");
	});

	it("blocks a patch one site over the threshold", () => {
		const m = measured(evalWith(priorBaseline(), [adaptedGt("killed")], 0));
		expect(m.decision).toBe("block");
	});
});

describe("suite verdicts outrank the ratchet", () => {
	it("blocks a red overlay suite even when every mutant was killed", () => {
		const m = measured(
			evalWith(priorBaseline(), [adaptedGt("killed")], 50, { overlayGreen: false, redWitnessSatisfied: null }),
		);
		expect(m.decision).toBe("block");
	});

	it("allows a green overlay suite with killed mutants", () => {
		const m = measured(
			evalWith(priorBaseline(), [adaptedGt("killed")], 50, { overlayGreen: true, redWitnessSatisfied: null }),
		);
		expect(m.decision).toBe("allow");
	});

	it("does NOT block on an unsatisfied red-witness — that is a warning only", () => {
		const m = measured(
			evalWith(priorBaseline(), [adaptedGt("killed")], 50, { overlayGreen: true, redWitnessSatisfied: false }),
		);
		expect(m.decision).toBe("allow");
	});

	it("blocks a red suite on a FIRST sighting too — that is the edit, not the baseline", () => {
		const m = measured(
			evalWith(emptyManifest(META), [adaptedGt("killed")], 50, { overlayGreen: false, redWitnessSatisfied: null }),
		);
		expect(m.decision).toBe("block");
	});
});

describe("zip — pairing identities with measured mutants", () => {
	it("ignores a trailing adapted mutant with no matching identity", () => {
		// The engine can report more mutants than the parser identified; the extra
		// must be dropped, never paired with the wrong identity.
		const m = measured(evalWith(priorBaseline(), [adaptedGt("survived"), adaptedGt("survived")]));
		expect(m.newSurvivors.length).toBeGreaterThanOrEqual(1);
	});

	it("produces no findings for an empty measurement", () => {
		const m = measured(evalWith(priorBaseline(), []));
		expect(m.newSurvivors).toEqual([]);
		expect(m.decision).toBe("allow");
	});
});
