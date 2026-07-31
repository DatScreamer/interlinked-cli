import { describe, expect, it } from "vitest";
import { healManifestFiles } from "./manifest-heal.js";
import type { IdentityInstability, MutantRecord, MutantStatus, SymbolRecord } from "./types.js";

const CWD = "/repo/root";

function rec(mutantId: string, status: MutantStatus, overrides: Partial<MutantRecord> = {}): MutantRecord {
	return {
		mutantId,
		siteId: `${mutantId}-site`,
		mutator: "Op",
		originalLexeme: ">",
		replacement: ">=",
		ordinalWithinSymbol: 0,
		status,
		firstSeen: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function instability(overrides: Partial<IdentityInstability> = {}): IdentityInstability {
	return { events: [], consecutiveStableRuns: 0, quarantined: false, ...overrides };
}

function sym(symbolId: string, symbolHash: string, mutants: MutantRecord[] = [], inst?: IdentityInstability): SymbolRecord {
	return {
		symbolId,
		qualifiedName: "fn",
		symbolHash,
		mutants: Object.fromEntries(mutants.map((m) => [m.mutantId, m])),
		instability: inst ?? instability(),
	};
}

describe("healManifestFiles — the zero-allocation fast path", () => {
	it("P: returns the SAME object reference when every key is already canonical", () => {
		const files = { "src/a.ts": { s1: sym("s1", "h1", [rec("m1", "killed")]) } };
		expect(healManifestFiles(files, CWD)).toBe(files);
	});

	it("N: rebuilds (a NEW reference) when a key needs normalization", () => {
		const files = { [`${CWD}/src/a.ts`]: { s1: sym("s1", "h1") } };
		expect(healManifestFiles(files, CWD)).not.toBe(files);
	});

	it("N: rebuilds when a key is a test file", () => {
		const files = { "src/a.test.ts": { s1: sym("s1", "h1") } };
		expect(healManifestFiles(files, CWD)).not.toBe(files);
	});

	it("N: rebuilds when two keys collide onto the same canonical form", () => {
		const files = {
			[`${CWD}/src/a.ts`]: { s1: sym("s1", "h1") },
			"src/a.ts": { s2: sym("s2", "h2") },
		};
		expect(healManifestFiles(files, CWD)).not.toBe(files);
	});
});

describe("healManifestFiles — merge semantics", () => {
	it("P: merges an absolute-key duplicate into its repo-relative twin, keeping BOTH symbols", () => {
		const files = {
			[`${CWD}/src/a.ts`]: { s1: sym("s1", "h1", [rec("m1", "survived")]) },
			"src/a.ts": { s2: sym("s2", "h2", [rec("m2", "killed")]) },
		};
		const healed = healManifestFiles(files, CWD);
		expect(Object.keys(healed)).toEqual(["src/a.ts"]);
		const merged = healed["src/a.ts"] ?? {};
		expect(Object.keys(merged).sort()).toEqual(["s1", "s2"]);
	});

	it("P: same symbolId + same symbolHash on both sides unions their mutants", () => {
		const files = {
			[`${CWD}/src/a.ts`]: { s1: sym("s1", "h1", [rec("m1", "killed")]) },
			"src/a.ts": { s1: sym("s1", "h1", [rec("m2", "survived")]) },
		};
		const merged = healManifestFiles(files, CWD)["src/a.ts"]?.s1?.mutants ?? {};
		expect(Object.keys(merged).sort()).toEqual(["m1", "m2"]);
	});

	it("P: a status conflict on the SAME mutantId keeps the MORE CAUTIOUS status", () => {
		const files = {
			[`${CWD}/src/a.ts`]: { s1: sym("s1", "h1", [rec("m1", "survived")]) },
			"src/a.ts": { s1: sym("s1", "h1", [rec("m1", "killed")]) },
		};
		expect(healManifestFiles(files, CWD)["src/a.ts"]?.s1?.mutants.m1?.status).toBe("survived");
	});

	it("P: firstSeen takes the EARLIER of the two, independent of which status won", () => {
		const files = {
			[`${CWD}/src/a.ts`]: { s1: sym("s1", "h1", [rec("m1", "killed", { firstSeen: "2026-03-01T00:00:00Z" })]) },
			"src/a.ts": { s1: sym("s1", "h1", [rec("m1", "survived", { firstSeen: "2026-01-01T00:00:00Z" })]) },
		};
		expect(healManifestFiles(files, CWD)["src/a.ts"]?.s1?.mutants.m1?.firstSeen).toBe("2026-01-01T00:00:00Z");
	});

	it("P: a reviewed disposition wins the conflict even against a MORE CAUTIOUS unreviewed status", () => {
		const reviewed = rec("m1", "equivalent", { accepted_reason: "poll loop only branches on ready/gone" });
		const files = {
			[`${CWD}/src/a.ts`]: { s1: sym("s1", "h1", [reviewed]) },
			"src/a.ts": { s1: sym("s1", "h1", [rec("m1", "survived")]) },
		};
		const m1 = healManifestFiles(files, CWD)["src/a.ts"]?.s1?.mutants.m1;
		expect(m1?.status).toBe("equivalent");
		expect(m1?.accepted_reason).toContain("ready/gone");
	});

	it("N: a symbolId with DIFFERENT symbolHash on each side is NOT merged at the mutant level — the more recent side wins whole", () => {
		const older = sym("s1", "h1", [rec("m1", "survived", { firstSeen: "2026-01-01T00:00:00Z" })]);
		const newer = sym("s1", "h2", [rec("m9", "killed", { firstSeen: "2026-06-01T00:00:00Z" })]);
		const files = { [`${CWD}/src/a.ts`]: { s1: older }, "src/a.ts": { s1: newer } };
		const s1 = healManifestFiles(files, CWD)["src/a.ts"]?.s1;
		expect(s1?.symbolHash).toBe("h2");
		expect(Object.keys(s1?.mutants ?? {})).toEqual(["m9"]);
	});

	it("P: instability merges — quarantined=true if EITHER side says so, and the LOWER stable-run count", () => {
		const files = {
			[`${CWD}/src/a.ts`]: {
				s1: sym("s1", "h1", [rec("m1", "killed")], instability({ quarantined: true, consecutiveStableRuns: 1 })),
			},
			"src/a.ts": {
				s1: sym("s1", "h1", [rec("m1", "killed")], instability({ quarantined: false, consecutiveStableRuns: 5 })),
			},
		};
		const merged = healManifestFiles(files, CWD)["src/a.ts"]?.s1?.instability;
		expect(merged?.quarantined).toBe(true);
		expect(merged?.consecutiveStableRuns).toBe(1);
	});

	it("N: drops a test-file entry entirely, even when it's the only entry for that key", () => {
		const files = { "src/a.test.ts": { s1: sym("s1", "h1", [rec("m1", "survived")]) } };
		expect(healManifestFiles(files, CWD)).toEqual({});
	});
});
