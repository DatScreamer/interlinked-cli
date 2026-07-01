import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acceptedSurvivors,
	changedSymbols,
	computeNewSurvivors,
	emptyManifest,
	loadManifest,
	type MeasuredMutant,
	mutationManifestPath,
	quarantinedSymbols,
	saveManifest,
} from "./manifest.js";
import type { MutantIdentity, MutantRecord, MutantStatus, MutationManifest, SymbolRecord } from "./types.js";

const FILE = "src/a.ts";
const META = {
	engine: "stryker",
	engineVersion: "1.0.0",
	dependencyGraphVersion: "g1",
	environmentHash: "env1",
	authoritativeAt: "2026-01-01T00:00:00Z",
};

function rec(mutantId: string, status: MutantStatus): MutantRecord {
	return {
		mutantId,
		siteId: `${mutantId}-site`,
		mutator: "Op",
		originalLexeme: ">",
		replacement: ">=",
		ordinalWithinSymbol: 0,
		status,
		firstSeen: "2026-01-01T00:00:00Z",
	};
}

interface SymSpec {
	symbolId: string;
	symbolHash: string;
	mutants?: MutantRecord[];
	quarantined?: boolean;
}

function sym(spec: SymSpec): SymbolRecord {
	const mutants: Record<string, MutantRecord> = {};
	for (const m of spec.mutants ?? []) mutants[m.mutantId] = m;
	return {
		symbolId: spec.symbolId,
		qualifiedName: "fn",
		symbolHash: spec.symbolHash,
		mutants,
		instability: { events: [], consecutiveStableRuns: 0, quarantined: spec.quarantined ?? false },
	};
}

function manifestWith(file: string, symbols: SymbolRecord[]): MutationManifest {
	const records: Record<string, SymbolRecord> = {};
	for (const s of symbols) records[s.symbolId] = s;
	return { ...emptyManifest(META), files: { [file]: records } };
}

function measured(mutantId: string, symbolId: string, status: MutantStatus): MeasuredMutant {
	const identity: MutantIdentity = {
		mutantId,
		siteId: `${mutantId}-site`,
		symbolId,
		qualifiedName: "fn",
		mutator: "Op",
		originalLexeme: ">",
		replacement: ">=",
		ordinalWithinSymbol: 0,
	};
	return { identity, status };
}

const overlay = (entries: Array<[string, string]>): Map<string, { qualifiedName: string; symbolHash: string }> =>
	new Map(entries.map(([id, hash]) => [id, { qualifiedName: "fn", symbolHash: hash }]));

describe("changedSymbols", () => {
	it("flags new and hash-changed symbols, skips unchanged", () => {
		const base = manifestWith(FILE, [
			sym({ symbolId: "s1", symbolHash: "h1" }),
			sym({ symbolId: "s2", symbolHash: "h2" }),
		]);
		const changed = changedSymbols(
			base,
			FILE,
			overlay([
				["s1", "h1"], // unchanged
				["s2", "h2-NEW"], // changed
				["s3", "h3"], // new
			]),
		);
		expect([...changed].sort()).toEqual(["s2", "s3"]);
	});

	it("treats a file absent from the manifest as empty (no records)", () => {
		const empty = emptyManifest(META);
		expect(changedSymbols(empty, "src/missing.ts", overlay([["s1", "h1"]]))).toEqual(new Set(["s1"]));
		expect([...acceptedSurvivors(empty, "src/missing.ts")]).toEqual([]);
		expect([...quarantinedSymbols(empty, "src/missing.ts")]).toEqual([]);
	});
});

describe("acceptedSurvivors / quarantinedSymbols", () => {
	it("collects survived+equivalent mutantIds and quarantined symbols", () => {
		const base = manifestWith(FILE, [
			sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived"), rec("m2", "killed")] }),
			sym({ symbolId: "s2", symbolHash: "h2", mutants: [rec("m3", "equivalent")], quarantined: true }),
		]);
		expect([...acceptedSurvivors(base, FILE)].sort()).toEqual(["m1", "m3"]);
		expect([...quarantinedSymbols(base, FILE)]).toEqual(["s2"]);
	});
});

describe("computeNewSurvivors (the invariant)", () => {
	const base = manifestWith(FILE, [
		sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("accepted", "survived")] }),
		sym({ symbolId: "s2", symbolHash: "h2", quarantined: true }),
	]);
	const sets = {
		changed: changedSymbols(base, FILE, overlay([["s1", "h1-CHANGED"], ["s2", "h2-CHANGED"], ["s3", "h3"]])),
		accepted: acceptedSurvivors(base, FILE),
		quarantined: quarantinedSymbols(base, FILE),
	};

	it("blocks a NEW survivor in a changed, non-quarantined symbol", () => {
		const out = computeNewSurvivors([measured("fresh", "s3", "survived")], sets, "now");
		expect(out.map((r) => r.mutantId)).toEqual(["fresh"]);
	});

	it("does not block a grandfathered (accepted) survivor", () => {
		expect(computeNewSurvivors([measured("accepted", "s1", "survived")], sets, "now")).toEqual([]);
	});

	it("does not block a survivor in a quarantined symbol", () => {
		expect(computeNewSurvivors([measured("q", "s2", "survived")], sets, "now")).toEqual([]);
	});

	it("does not block a killed mutant, nor a survivor in an unchanged symbol", () => {
		expect(computeNewSurvivors([measured("k", "s3", "killed")], sets, "now")).toEqual([]);
		const unchanged = { ...sets, changed: new Set<string>() };
		expect(computeNewSurvivors([measured("x", "s3", "survived")], unchanged, "now")).toEqual([]);
	});
});

describe("manifest I/O", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mut-manifest-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("round-trips through save/load", () => {
		const m = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] })]);
		saveManifest(dir, m);
		expect(loadManifest(dir)).toEqual(m);
	});

	it("returns null when no manifest exists", () => {
		expect(loadManifest(dir)).toBeNull();
	});

	it("returns null on malformed JSON", () => {
		writeFileSync(mutationManifestPath(dir), "not json {", "utf-8");
		expect(loadManifest(dir)).toBeNull();
	});

	it("returns null on an unsupported version", () => {
		writeFileSync(mutationManifestPath(dir), JSON.stringify({ version: 2, files: {} }), "utf-8");
		expect(loadManifest(dir)).toBeNull();
	});
});
