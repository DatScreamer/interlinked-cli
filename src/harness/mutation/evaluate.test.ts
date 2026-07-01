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
		const m = measured(evalWith(emptyManifest(META), [adaptedGt("survived")]));
		expect(m.decision).toBe("block");
		expect(m.newSurvivors).toHaveLength(1);
		expect(m.receipt.overlayHash).toHaveLength(64);
		expect(m.receipt.sites).toHaveLength(1);
	});

	it("allows when the mutant is killed", () => {
		expect(measured(evalWith(emptyManifest(META), [adaptedGt("killed")])).decision).toBe("allow");
	});

	it("blocks on an uncovered changed site", () => {
		const m = measured(evalWith(emptyManifest(META), [adaptedGt("uncovered")]));
		expect(m.decision).toBe("block");
		expect(m.uncoveredSites).toHaveLength(1);
	});

	it("allows a survivor in an unchanged symbol (hash matches the manifest)", () => {
		expect(measured(evalWith(manifestFromContent(CONTENT), [adaptedGt("survived")])).decision).toBe("allow");
	});

	it("blocks oversize: changed sites over the threshold, even when the mutant is killed", () => {
		// 1 changed site > a threshold of 0 ⇒ "split this patch" overrides the clean kill.
		const m = measured(evalWith(emptyManifest(META), [adaptedGt("killed")], 0));
		expect(m.decision).toBe("block");
		expect(m.changedSiteCount).toBeGreaterThan(m.siteCountThreshold);
	});

	it("blocks a red overlay suite even when the mutant is killed (spec §7 red/green)", () => {
		const m = measured(evalWith(emptyManifest(META), [adaptedGt("killed")], 50, { overlayGreen: false, redWitnessSatisfied: null }));
		expect(m.decision).toBe("block");
		expect(m.suiteRed).toBe(true);
	});

	it("warns (allows) on a failed RED-witness with a green suite + killed mutant", () => {
		const m = measured(evalWith(emptyManifest(META), [adaptedGt("killed")], 50, { overlayGreen: true, redWitnessSatisfied: false }));
		expect(m.decision).toBe("allow");
		expect(m.redWitnessFailed).toBe(true);
	});
});
