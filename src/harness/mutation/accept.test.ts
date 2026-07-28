import { describe, expect, it } from "vitest";
import { acceptMutant } from "./accept.js";
import { acceptedSurvivors, emptyManifest } from "./manifest.js";
import type { MutantRecord, MutationManifest, SymbolRecord } from "./types.js";

/**
 * The last gate before `mode: block`: some survivors are EQUIVALENT — the
 * mutation changes the code but not its behavior ({kind:"not_ready"} vs {} when
 * only "ready"/"gone" are ever branched on), so no test can ever kill them.
 * Under block, an unannotatable equivalent would brick its file forever. This
 * verb records the human judgment auditable-in-band: status "equivalent" plus
 * the WHY, in the manifest the gate already reads.
 */
const FILE = "src/a.ts";
const META = {
	engine: "stryker",
	engineVersion: "9",
	dependencyGraphVersion: "1",
	environmentHash: "e",
	authoritativeAt: "t0",
};

function rec(mutantId: string): MutantRecord {
	return {
		mutantId,
		siteId: `${mutantId}-site`,
		mutator: "ObjectLiteral",
		originalLexeme: '{ kind: "not_ready" }',
		replacement: "{}",
		ordinalWithinSymbol: 0,
		status: "survived",
		firstSeen: "t0",
	};
}

function manifestWith(mutants: MutantRecord[]): MutationManifest {
	const symbol: SymbolRecord = {
		symbolId: "sym1",
		qualifiedName: "claimOne",
		symbolHash: "h1",
		mutants: Object.fromEntries(mutants.map((m) => [m.mutantId, m])),
		instability: { events: [], consecutiveStableRuns: 0, quarantined: false },
	};
	return { ...emptyManifest(META), files: { [FILE]: { sym1: symbol } } };
}

describe("acceptMutant", () => {
	it("flips a recorded survivor to equivalent, with the reason preserved", () => {
		const out = acceptMutant({
			base: manifestWith([rec("m1")]),
			file: FILE,
			mutantId: "m1",
			reason: "poll loop only branches on ready/gone; the default arm is unobservable",
		});
		expect(out).not.toBeNull();
		const stored = out?.files[FILE]?.sym1?.mutants.m1;
		expect(stored?.status).toBe("equivalent");
		expect(stored?.accepted_reason).toContain("unobservable");
	});

	it("keeps the accepted mutant in the accepted-survivor floor", () => {
		// The behavioral consequence: computeNewSurvivors consults this set, so an
		// accepted equivalent never blocks again.
		const out = acceptMutant({
			base: manifestWith([rec("m1")]),
			file: FILE,
			mutantId: "m1",
			reason: "r",
		});
		expect(out ? [...acceptedSurvivors(out, FILE)] : []).toContain("m1");
	});

	it("returns null for an unknown mutant id rather than inventing a record", () => {
		expect(
			acceptMutant({ base: manifestWith([rec("m1")]), file: FILE, mutantId: "nope", reason: "r" }),
		).toBeNull();
	});

	it("returns null for a file with no baseline", () => {
		expect(
			acceptMutant({ base: emptyManifest(META), file: FILE, mutantId: "m1", reason: "r" }),
		).toBeNull();
	});

	it("refuses an empty reason — the WHY is the point of the record", () => {
		expect(
			acceptMutant({ base: manifestWith([rec("m1")]), file: FILE, mutantId: "m1", reason: "  " }),
		).toBeNull();
	});

	it("does not mutate the input manifest", () => {
		const base = manifestWith([rec("m1")]);
		acceptMutant({ base, file: FILE, mutantId: "m1", reason: "r" });
		expect(base.files[FILE]?.sym1?.mutants.m1?.status).toBe("survived");
	});
});
