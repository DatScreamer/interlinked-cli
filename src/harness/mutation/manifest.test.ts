import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acceptedSurvivors,
	appendReceipt,
	applyMeasuredRun,
	changedSymbols,
	clearManifestCache,
	computeNewSurvivors,
	emptyManifest,
	loadManifest,
	type MeasuredMutant,
	makeManifestPersister,
	mutationManifestPath,
	mutationReceiptsPath,
	quarantinedSymbols,
	saveManifest,
} from "./manifest.js";
import type {
	MutantIdentity,
	MutantRecord,
	MutantStatus,
	MutationManifest,
	MutationReceipt,
	SymbolRecord,
} from "./types.js";

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

	it("P: serves the SAME parsed object while the file is unchanged (per-edit parse cost)", () => {
		// The daemon calls loadManifest on EVERY code-edit PreToolUse. At 46MB a
		// fresh JSON.parse costs ~300MB transient heap per call — measured live
		// 2026-07-28 as the rss-ceiling kill loop. Unchanged file ⇒ identical
		// object, no re-parse.
		const m = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] })]);
		saveManifest(dir, m);
		const first = loadManifest(dir);
		const second = loadManifest(dir);
		expect(second).toBe(first);
	});

	it("P: the persisted BYTES are a loadable manifest, independent of any in-process cache", () => {
		// Guards the persist against cache-tautology: with save-primes-cache, a
		// broken write (e.g. an empty file) would be invisible to a save→load
		// round-trip because the cache serves the good object. Read the raw disk
		// bytes instead — this is what a FRESH daemon will actually parse.
		const m = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] })]);
		saveManifest(dir, m);
		const parsed = JSON.parse(readFileSync(mutationManifestPath(dir), "utf-8"));
		expect(parsed).toEqual(m);
	});

	it("P: saveManifest primes the cache — the next load returns the saved object itself", () => {
		// A measured-clean pass persists the refreshed manifest; without priming,
		// every persist invalidates the read cache and the NEXT edit re-parses
		// 46MB (~300MB transient) — the cache would self-defeat under exactly the
		// traffic it exists for.
		const m = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] })]);
		saveManifest(dir, m);
		expect(loadManifest(dir)).toBe(m);
	});

	it("P: clearManifestCache drops the resident copy so the next load re-parses", () => {
		// The idle-shrink path: a daemon idle for minutes should not stay a
		// ~1GB jetsam target for the sake of a cache the next event can rebuild
		// in ~200ms. After clearing, identity must change (fresh parse).
		const m = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] })]);
		saveManifest(dir, m);
		const first = loadManifest(dir);
		clearManifestCache();
		const second = loadManifest(dir);
		expect(second).not.toBe(first);
		expect(second).toEqual(first);
	});

	it("N: a rewritten manifest is re-parsed (mtime/size key)", () => {
		const m = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] })]);
		saveManifest(dir, m);
		const first = loadManifest(dir);
		// A second symbol changes the serialized SIZE, so the re-parse triggers
		// deterministically regardless of filesystem mtime granularity.
		const m2 = manifestWith(FILE, [
			sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] }),
			sym({ symbolId: "s2", symbolHash: "h2", mutants: [rec("m2", "killed")] }),
		]);
		saveManifest(dir, m2);
		const second = loadManifest(dir);
		expect(second).not.toBe(first);
		expect(Object.keys(second?.files[FILE] ?? {})).toHaveLength(2);
	});
});

describe("applyMeasuredRun (measured-clean refresh)", () => {
	const AT = "2026-06-28T12:00:00Z";

	it("bumps the generation and stamps authoritativeAt", () => {
		const base = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "h1" })]);
		const out = applyMeasuredRun({
			base,
			file: FILE,
			overlayHashes: overlay([["s1", "h1-CHANGED"]]),
			measured: [measured("m1", "s1", "killed")],
			at: AT,
		});
		expect(out.generation).toBe(base.generation + 1);
		expect(out.authoritativeAt).toBe(AT);
		expect(base.files[FILE]?.s1?.symbolHash).toBe("h1"); // base untouched (pure)
	});

	it("preserves firstSeen for a persisting mutantId and stamps new ones", () => {
		const base = manifestWith(FILE, [
			sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] }),
		]);
		const out = applyMeasuredRun({
			base,
			file: FILE,
			overlayHashes: overlay([["s1", "h1-CHANGED"]]),
			measured: [measured("m1", "s1", "killed"), measured("m2", "s1", "killed")],
			at: AT,
		});
		const mutants = out.files[FILE]?.s1?.mutants ?? {};
		expect(mutants.m1?.firstSeen).toBe("2026-01-01T00:00:00Z"); // preserved
		expect(mutants.m1?.status).toBe("killed"); // status refreshed
		expect(mutants.m2?.firstSeen).toBe(AT); // new mutant stamped now
	});

	it("carries an unchanged, unmeasured symbol forward verbatim (differential skip)", () => {
		const prior = sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] });
		const base = manifestWith(FILE, [prior]);
		const out = applyMeasuredRun({
			base,
			file: FILE,
			overlayHashes: overlay([["s1", "h1"]]),
			measured: [],
			at: AT,
		});
		expect(out.files[FILE]?.s1).toBe(prior); // same record, knowledge kept
	});

	it("quarantines on mutantId churn under an UNCHANGED hash", () => {
		const base = manifestWith(FILE, [
			sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "killed")] }),
		]);
		const out = applyMeasuredRun({
			base,
			file: FILE,
			overlayHashes: overlay([["s1", "h1"]]), // hash unchanged…
			measured: [measured("mX", "s1", "killed")], // …but the ids differ → churn
			at: AT,
		});
		const inst = out.files[FILE]?.s1?.instability;
		expect(inst?.quarantined).toBe(true);
		expect(inst?.events.at(-1)).toEqual({ at: AT, kind: "id_churn" });
	});

	it("does NOT count new ids in a hash-CHANGED symbol as churn", () => {
		const base = manifestWith(FILE, [
			sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "killed")] }),
		]);
		const out = applyMeasuredRun({
			base,
			file: FILE,
			overlayHashes: overlay([["s1", "h1-CHANGED"]]), // edited symbol…
			measured: [measured("mX", "s1", "killed")], // …new ids are expected
			at: AT,
		});
		const inst = out.files[FILE]?.s1?.instability;
		expect(inst?.quarantined).toBe(false);
		expect(inst?.consecutiveStableRuns).toBe(1);
	});

	it("drops symbols no longer present in the overlay (deleted code)", () => {
		const base = manifestWith(FILE, [
			sym({ symbolId: "s1", symbolHash: "h1" }),
			sym({ symbolId: "s2", symbolHash: "h2" }),
		]);
		const out = applyMeasuredRun({
			base,
			file: FILE,
			overlayHashes: overlay([["s1", "h1"]]),
			measured: [],
			at: AT,
		});
		expect(Object.keys(out.files[FILE] ?? {})).toEqual(["s1"]);
	});
});

describe("receipt persistence", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mut-receipts-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const receipt: MutationReceipt = {
		overlayHash: "a".repeat(64),
		generation: 1,
		sites: [{ mutantId: "m1", symbolId: "s1", status: "killed" }],
		engine: "stryker",
		engineVersion: "1.0.0",
		measuredAt: "2026-06-28T12:00:00Z",
	};

	it("appends one JSON line per receipt", () => {
		appendReceipt(dir, receipt);
		appendReceipt(dir, { ...receipt, generation: 2 });
		const lines = readFileSync(mutationReceiptsPath(dir), "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] ?? "{}").generation).toBe(1);
		expect(JSON.parse(lines[1] ?? "{}").generation).toBe(2);
	});

	it("makeManifestPersister writes both the manifest and the receipt", () => {
		const persist = makeManifestPersister(dir);
		const manifest = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "h1" })]);
		persist(manifest, receipt);
		expect(loadManifest(dir)?.files[FILE]?.s1?.symbolHash).toBe("h1");
		expect(readFileSync(mutationReceiptsPath(dir), "utf-8")).toContain('"overlayHash":"a');
	});
});

// ---------------------------------------------------------------------------
// Phase D ratchet: 16 survivors of 129. This module is the ratchet's FLOOR — a
// silently-wrong load or merge does not fail loudly, it changes what counts as
// "new", which is the one thing every mutation verdict is measured against.
// ---------------------------------------------------------------------------

describe("loadManifest — a malformed file must read as absent, never as empty", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mut-load-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns null when no manifest exists", () => {
		expect(loadManifest(dir)).toBeNull();
	});

	it("round-trips a manifest it saved", () => {
		const m = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "h1" })]);
		saveManifest(dir, m);
		expect(loadManifest(dir)?.files[FILE]?.s1?.symbolHash).toBe("h1");
	});

	it("returns null on unparseable JSON rather than throwing", () => {
		writeFileSync(mutationManifestPath(dir), "{ not json");
		expect(loadManifest(dir)).toBeNull();
	});

	it("rejects a manifest from a different schema version", () => {
		// Reading a v2 file as v1 would silently reinterpret every record.
		writeFileSync(mutationManifestPath(dir), JSON.stringify({ version: 2, files: {} }));
		expect(loadManifest(dir)).toBeNull();
	});

	it("rejects a manifest with no files map", () => {
		writeFileSync(mutationManifestPath(dir), JSON.stringify({ version: 1 }));
		expect(loadManifest(dir)).toBeNull();
	});

	it("rejects a JSON scalar where an object was expected", () => {
		for (const body of ["null", "7", '"x"']) {
			writeFileSync(mutationManifestPath(dir), body);
			expect(loadManifest(dir)).toBeNull();
		}
	});
});

describe("changedSymbols — what counts as changed decides what counts as new", () => {
	const entry = (symbolId: string, symbolHash: string) =>
		new Map([[symbolId, { symbolId, qualifiedName: "fn", symbolHash }]]);

	it("treats a symbol with no prior record as changed", () => {
		// A brand-new symbol has nothing to compare against, so everything in it is
		// new work; calling it unchanged would skip it entirely.
		const base = manifestWith(FILE, []);
		expect([...changedSymbols(base, FILE, entry("s1", "h1"))]).toEqual(["s1"]);
	});

	it("treats a differing hash as changed", () => {
		const base = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "old" })]);
		expect([...changedSymbols(base, FILE, entry("s1", "new"))]).toEqual(["s1"]);
	});

	it("treats an identical hash as UNCHANGED", () => {
		const base = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "same" })]);
		expect([...changedSymbols(base, FILE, entry("s1", "same"))]).toEqual([]);
	});

	it("ignores a prior record for a different file", () => {
		const base = manifestWith("src/other.ts", [sym({ symbolId: "s1", symbolHash: "same" })]);
		expect([...changedSymbols(base, FILE, entry("s1", "same"))]).toEqual(["s1"]);
	});
});

describe("applyMeasuredRun — carrying knowledge forward", () => {
	const hashes = (symbolId: string, symbolHash: string) =>
		new Map([[symbolId, { symbolId, qualifiedName: "fn", symbolHash }]]);

	it("preserves firstSeen for a mutant that was already known", () => {
		// firstSeen is how long a survivor has been tolerated; resetting it on every
		// run would erase the age of every finding.
		const base = manifestWith(FILE, [
			sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] }),
		]);
		const out = applyMeasuredRun({
			base,
			file: FILE,
			overlayHashes: hashes("s1", "h1"),
			measured: [measured("m1", "s1", "survived")],
			at: "2026-06-06T00:00:00Z",
		});
		expect(out.files[FILE]?.s1?.mutants.m1?.firstSeen).toBe("2026-01-01T00:00:00Z");
	});

	it("stamps firstSeen from this run for a mutant never seen before", () => {
		const base = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "h1" })]);
		const out = applyMeasuredRun({
			base,
			file: FILE,
			overlayHashes: hashes("s1", "h1"),
			measured: [measured("m9", "s1", "survived")],
			at: "2026-06-06T00:00:00Z",
		});
		expect(out.files[FILE]?.s1?.mutants.m9?.firstSeen).toBe("2026-06-06T00:00:00Z");
	});

	it("carries an unchanged, unmeasured symbol forward verbatim", () => {
		// Differential runs skip unchanged symbols; dropping them would discard
		// knowledge and make every later run look like a first sighting.
		const prior = sym({ symbolId: "s1", symbolHash: "h1", mutants: [rec("m1", "survived")] });
		const out = applyMeasuredRun({
			base: manifestWith(FILE, [prior]),
			file: FILE,
			overlayHashes: hashes("s1", "h1"),
			measured: [],
			at: "2026-06-06T00:00:00Z",
		});
		expect(out.files[FILE]?.s1).toEqual(prior);
	});

	it("bumps the generation so a refreshed manifest is distinguishable", () => {
		const base = manifestWith(FILE, [sym({ symbolId: "s1", symbolHash: "h1" })]);
		const out = applyMeasuredRun({
			base,
			file: FILE,
			overlayHashes: hashes("s1", "h1"),
			measured: [measured("m1", "s1", "killed")],
			at: "2026-06-06T00:00:00Z",
		});
		expect(out.generation).toBe(base.generation + 1);
	});
});
