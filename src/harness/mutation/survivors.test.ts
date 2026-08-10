import { describe, expect, it } from "vitest";
import { provenanceOf, stampProvenance } from "./manifest.js";
import { remedyFor, restrictToFiles, type SurvivorFilter, summarizeSurvivors } from "./survivors.js";
import type { MutantRecord, MutantStatus, MutationManifest, SymbolRecord } from "./types.js";

// ===========================================
// Fixture builders — a manifest is deeply nested, so building one inline in
// every test buries the assertion. These keep each test's INPUT to the one
// property it is about.
// ===========================================

let seq = 0;
function mutant(status: MutantStatus, over: Partial<MutantRecord> = {}): MutantRecord {
	seq += 1;
	return {
		mutantId: `m${seq}`,
		siteId: `s${seq}`,
		mutator: "EqualityOperator",
		originalLexeme: "===",
		replacement: "!==",
		ordinalWithinSymbol: 0,
		status,
		firstSeen: "2026-08-01T00:00:00.000Z",
		...over,
	};
}

function symbol(name: string, mutants: MutantRecord[], over: Partial<SymbolRecord> = {}): SymbolRecord {
	return {
		symbolId: `sym-${name}`,
		qualifiedName: name,
		symbolHash: "hash",
		mutants: Object.fromEntries(mutants.map((m) => [m.mutantId, m])),
		instability: { events: [], consecutiveStableRuns: 3, quarantined: false },
		...over,
	};
}

function manifestOf(files: Record<string, SymbolRecord[]>): MutationManifest {
	return {
		version: 1,
		generation: 7,
		authoritativeAt: "2026-08-09T00:00:00.000Z",
		engine: "stryker",
		engineVersion: "8",
		dependencyGraphVersion: "1",
		environmentHash: "env",
		files: Object.fromEntries(
			Object.entries(files).map(([file, syms]) => [file, Object.fromEntries(syms.map((s) => [s.symbolId, s]))]),
		),
	};
}

function summarize(files: Record<string, SymbolRecord[]>, filter: SurvivorFilter = {}) {
	return summarizeSurvivors(manifestOf(files), filter);
}

describe("summarizeSurvivors — counting", () => {
	it("P1: counts an undispositioned survivor as open work", () => {
		const s = summarize({ "src/a.ts": [symbol("f", [mutant("survived"), mutant("killed")])] });
		expect(s.totals.open).toBe(1);
		expect(s.totals.killed).toBe(1);
		expect(s.files[0]?.open).toBe(1);
	});

	it("P2: separates dispositioned survivors from open ones", () => {
		const s = summarize({
			"src/a.ts": [
				symbol("f", [
					mutant("survived"),
					mutant("survived", { disposition: { kind: "dead_code", resolution: "delete" } }),
				]),
			],
		});
		expect(s.totals.open).toBe(1);
		expect(s.totals.dispositioned).toBe(1);
		expect(s.totals.survived).toBe(2);
	});

	it("P3: treats legacy accepted_reason prose as a disposition, not open work", () => {
		const s = summarize({
			"src/a.ts": [symbol("f", [mutant("survived", { accepted_reason: "reviewed by hand" })])],
		});
		expect(s.totals.open).toBe(0);
		expect(s.totals.dispositioned).toBe(1);
	});

	it("P4: counts uncovered separately — it is a distinct work class", () => {
		const s = summarize({ "src/a.ts": [symbol("f", [mutant("uncovered"), mutant("survived")])] });
		expect(s.totals.uncovered).toBe(1);
		expect(s.totals.open).toBe(1);
	});

	it("P5: scores timeout as a detection and uncovered as undetected", () => {
		const s = summarize({
			"src/a.ts": [symbol("f", [mutant("killed"), mutant("timeout"), mutant("uncovered"), mutant("survived")])],
		});
		expect(s.totals.score).toBeCloseTo(0.5, 5);
	});

	it("N1: an all-killed manifest yields no open work and a perfect score", () => {
		const s = summarize({ "src/a.ts": [symbol("f", [mutant("killed"), mutant("killed")])] });
		expect(s.totals.open).toBe(0);
		expect(s.totals.score).toBe(1);
		expect(s.mutants).toEqual([]);
	});

	it("N2: an empty manifest is a valid, empty summary (score 1, no NaN)", () => {
		const s = summarize({});
		expect(s.totals).toMatchObject({ files: 0, symbols: 0, mutants: 0, open: 0 });
		expect(s.totals.score).toBe(1);
	});
});

describe("summarizeSurvivors — filtering", () => {
	it("P1: --file narrows to matching paths, case-insensitively", () => {
		const s = summarize(
			{ "src/a.ts": [symbol("f", [mutant("survived")])], "src/b.ts": [symbol("g", [mutant("survived")])] },
			{ file: "A.TS" },
		);
		expect(s.files.map((f) => f.file)).toEqual(["src/a.ts"]);
		expect(s.totals.open).toBe(1);
	});

	it("P2: --mutator narrows to one operator across every file", () => {
		const s = summarize(
			{
				"src/a.ts": [
					symbol("f", [mutant("survived", { mutator: "BooleanLiteral" }), mutant("survived", { mutator: "ArithmeticOperator" })]),
				],
			},
			{ mutator: "boolean" },
		);
		expect(s.totals.open).toBe(1);
		expect(s.mutants[0]?.mutator).toBe("BooleanLiteral");
	});

	it("P3: includeDispositioned lists judged survivors alongside open ones", () => {
		const files = {
			"src/a.ts": [symbol("f", [mutant("survived", { accepted_reason: "why" }), mutant("survived")])],
		};
		expect(summarize(files).mutants).toHaveLength(1);
		expect(summarize(files, { includeDispositioned: true }).mutants).toHaveLength(2);
	});

	it("P4: exists() marks a file whose path is gone as stale", () => {
		const s = summarize(
			{ "src/gone.ts": [symbol("f", [mutant("survived")])], "src/here.ts": [symbol("g", [mutant("survived")])] },
			{ exists: (f) => f !== "src/gone.ts" },
		);
		expect(s.totals.staleFiles).toBe(1);
		expect(s.files.find((f) => f.file === "src/gone.ts")?.stale).toBe(true);
		expect(s.files.find((f) => f.file === "src/here.ts")?.stale).toBe(false);
	});

	it("N1: no exists() predicate marks nothing stale", () => {
		const s = summarize({ "src/a.ts": [symbol("f", [mutant("survived")])] });
		expect(s.totals.staleFiles).toBe(0);
		expect(s.files[0]?.stale).toBe(false);
	});

	it("N2: a non-matching --file filter yields an empty, non-throwing summary", () => {
		const s = summarize({ "src/a.ts": [symbol("f", [mutant("survived")])] }, { file: "nope" });
		expect(s.files).toEqual([]);
		expect(s.totals.open).toBe(0);
	});
});

describe("restrictToFiles", () => {
	const twoFiles = {
		"src/a.ts": [symbol("f", [mutant("survived"), mutant("killed")])],
		"src/b.ts": [symbol("g", [mutant("survived"), mutant("survived"), mutant("killed")])],
	};

	it("P1: recomputes the totals for the kept subset — a narrowed view never reports the whole repo's debt", () => {
		const kept = restrictToFiles(summarize(twoFiles), new Set(["src/a.ts"]));
		expect(kept.totals.open).toBe(1);
		expect(kept.totals.mutants).toBe(2);
		expect(kept.totals.files).toBe(1);
		expect(kept.totals.symbols).toBe(1);
		expect(kept.totals.score).toBeCloseTo(0.5, 5);
	});

	it("P2: drops the symbol and mutant rows of excluded files", () => {
		const kept = restrictToFiles(summarize(twoFiles), new Set(["src/a.ts"]));
		expect(kept.symbols.every((r) => r.file === "src/a.ts")).toBe(true);
		expect(kept.mutants.every((m) => m.file === "src/a.ts")).toBe(true);
	});

	it("P3: keeping every file reproduces the original totals", () => {
		const full = summarize(twoFiles);
		const kept = restrictToFiles(full, new Set(full.files.map((f) => f.file)));
		expect(kept.totals).toEqual(full.totals);
	});

	it("N1: keeping nothing yields zeroed totals, not the repo-wide ones", () => {
		const kept = restrictToFiles(summarize(twoFiles), new Set());
		expect(kept.totals).toMatchObject({ files: 0, mutants: 0, open: 0, symbols: 0 });
		expect(kept.files).toEqual([]);
	});

	it("N2: an unknown path in the keep-set adds nothing", () => {
		const kept = restrictToFiles(summarize(twoFiles), new Set(["src/a.ts", "src/nope.ts"]));
		expect(kept.totals.files).toBe(1);
	});
});

describe("summarizeSurvivors — ranking", () => {
	it("P1: files rank by open survivor count, worst first", () => {
		const s = summarize({
			"src/small.ts": [symbol("f", [mutant("survived")])],
			"src/big.ts": [symbol("g", [mutant("survived"), mutant("survived"), mutant("survived")])],
		});
		expect(s.files.map((f) => f.file)).toEqual(["src/big.ts", "src/small.ts"]);
	});

	it("P2: equal open counts break ties by worse score, then path — a total order", () => {
		const s = summarize({
			"src/b.ts": [symbol("f", [mutant("survived"), mutant("killed")])],
			"src/a.ts": [symbol("g", [mutant("survived"), mutant("killed")])],
			"src/c.ts": [symbol("h", [mutant("survived")])],
		});
		expect(s.files.map((f) => f.file)).toEqual(["src/c.ts", "src/a.ts", "src/b.ts"]);
	});

	it("P3: the mutator rollup ranks by open count and reports an escape rate", () => {
		const s = summarize({
			"src/a.ts": [
				symbol("f", [
					mutant("survived", { mutator: "BooleanLiteral" }),
					mutant("survived", { mutator: "BooleanLiteral" }),
					mutant("killed", { mutator: "EqualityOperator" }),
					mutant("survived", { mutator: "EqualityOperator" }),
				]),
			],
		});
		expect(s.mutators[0]).toMatchObject({ mutator: "BooleanLiteral", open: 2, total: 2, escapeRate: 1 });
		expect(s.mutators[1]).toMatchObject({ mutator: "EqualityOperator", open: 1, total: 2, escapeRate: 0.5 });
	});

	it("P4: a quarantined symbol is reported as such", () => {
		const s = summarize({
			"src/a.ts": [
				symbol("f", [mutant("survived")], {
					instability: { events: [], consecutiveStableRuns: 0, quarantined: true },
				}),
			],
		});
		expect(s.symbols[0]?.quarantined).toBe(true);
	});

	it("N1: symbols with only killed mutants are not listed as work", () => {
		const s = summarize({
			"src/a.ts": [symbol("clean", [mutant("killed")]), symbol("dirty", [mutant("survived")])],
		});
		expect(s.symbols.map((r) => r.qualifiedName)).toEqual(["dirty"]);
	});

	it("N2: ranking is stable across two runs over the same manifest", () => {
		const files = {
			"src/a.ts": [symbol("f", [mutant("survived")])],
			"src/b.ts": [symbol("g", [mutant("survived")])],
		};
		expect(summarize(files).files.map((f) => f.file)).toEqual(summarize(files).files.map((f) => f.file));
	});
});


describe("summarizeSurvivors — measurement provenance", () => {
	const provenance = {
		at: "2026-08-09T00:00:00.000Z",
		scope: "import_graph" as const,
		testCount: 12,
		surface: "sweep" as const,
	};

	it("P1: attaches a file's recorded provenance to its row", () => {
		const m = manifestOf({ "src/a.ts": [symbol("f", [mutant("survived")])] });
		m.fileProvenance = { "src/a.ts": provenance };
		const s = summarizeSurvivors(m);
		expect(s.files[0]?.provenance).toEqual(provenance);
		expect(s.totals.unqualifiedFiles).toBe(0);
	});

	it("P2: counts files with no provenance as unqualified", () => {
		const m = manifestOf({
			"src/a.ts": [symbol("f", [mutant("survived")])],
			"src/b.ts": [symbol("g", [mutant("survived")])],
		});
		m.fileProvenance = { "src/a.ts": provenance };
		expect(summarizeSurvivors(m).totals.unqualifiedFiles).toBe(1);
	});

	it("P3: a manifest with no provenance map at all is entirely unqualified", () => {
		const s = summarize({
			"src/a.ts": [symbol("f", [mutant("survived")])],
			"src/b.ts": [symbol("g", [mutant("killed")])],
		});
		expect(s.totals.unqualifiedFiles).toBe(2);
		expect(s.files.every((f) => f.provenance === null)).toBe(true);
	});

	it("N1: restricting to a subset recounts the unqualified files too", () => {
		const m = manifestOf({
			"src/a.ts": [symbol("f", [mutant("survived")])],
			"src/b.ts": [symbol("g", [mutant("survived")])],
		});
		m.fileProvenance = { "src/a.ts": provenance };
		const kept = restrictToFiles(summarizeSurvivors(m), new Set(["src/a.ts"]));
		expect(kept.totals.unqualifiedFiles).toBe(0);
	});

	it("N2: provenance for a file the filter excluded never leaks into the summary", () => {
		const m = manifestOf({ "src/a.ts": [symbol("f", [mutant("survived")])] });
		m.fileProvenance = { "src/other.ts": provenance };
		expect(summarizeSurvivors(m).files[0]?.provenance).toBeNull();
	});
});

describe("stampProvenance / provenanceOf", () => {
	it("P1: stamps a file and reads it back through the canonical key", () => {
		const m = manifestOf({ "src/a.ts": [symbol("f", [mutant("survived")])] });
		const stamped = stampProvenance({
			manifest: m,
			file: "./src/a.ts",
			provenance: { at: "2026-08-09T00:00:00.000Z", scope: "import_graph", testCount: 3, surface: "measure" },
			cwd: "/repo",
		});
		expect(provenanceOf(stamped, "src/a.ts", "/repo")?.testCount).toBe(3);
	});

	it("P2: is pure — the input manifest is not mutated", () => {
		const m = manifestOf({ "src/a.ts": [symbol("f", [mutant("survived")])] });
		stampProvenance({
			manifest: m,
			file: "src/a.ts",
			provenance: { at: "t", scope: "glob_fallback", testCount: 0, surface: "per_edit" },
			cwd: "/repo",
		});
		expect(m.fileProvenance).toBeUndefined();
	});

	it("P3: re-stamping replaces the previous regime rather than merging it", () => {
		const m = manifestOf({ "src/a.ts": [symbol("f", [mutant("survived")])] });
		const once = stampProvenance({
			manifest: m,
			file: "src/a.ts",
			provenance: { at: "t1", scope: "glob_fallback", testCount: 0, surface: "per_edit" },
			cwd: "/repo",
		});
		const twice = stampProvenance({
			manifest: once,
			file: "src/a.ts",
			provenance: { at: "t2", scope: "import_graph", testCount: 9, surface: "sweep" },
			cwd: "/repo",
		});
		expect(provenanceOf(twice, "src/a.ts", "/repo")).toMatchObject({ at: "t2", scope: "import_graph", testCount: 9 });
	});

	it("N1: an unstamped file reads as null, never as a default regime", () => {
		const m = manifestOf({ "src/a.ts": [symbol("f", [mutant("survived")])] });
		expect(provenanceOf(m, "src/a.ts", "/repo")).toBeNull();
	});

	it("N2: stamping one file leaves the others unqualified", () => {
		const m = manifestOf({
			"src/a.ts": [symbol("f", [mutant("survived")])],
			"src/b.ts": [symbol("g", [mutant("survived")])],
		});
		const stamped = stampProvenance({
			manifest: m,
			file: "src/a.ts",
			provenance: { at: "t", scope: "import_graph", testCount: 1, surface: "sweep" },
			cwd: "/repo",
		});
		expect(provenanceOf(stamped, "src/b.ts", "/repo")).toBeNull();
	});
});


describe("remedyFor — which job kills these survivors", () => {
	const at = "2026-08-09T00:00:00.000Z";

	it("P1: no test in scope means a test must be written", () => {
		expect(remedyFor({ at, scope: "import_graph", testCount: 0, surface: "sweep" })).toBe("write_test");
	});

	it("P2: one or more tests in scope means the assertions are too weak", () => {
		expect(remedyFor({ at, scope: "import_graph", testCount: 1, surface: "sweep" })).toBe("strengthen_tests");
		expect(remedyFor({ at, scope: "import_graph", testCount: 40, surface: "sweep" })).toBe("strengthen_tests");
	});

	it("P3: the scope kind does not change the job — only the test count does", () => {
		expect(remedyFor({ at, scope: "glob_fallback", testCount: 0, surface: "measure" })).toBe("write_test");
		expect(remedyFor({ at, scope: "glob_fallback", testCount: 2, surface: "measure" })).toBe("strengthen_tests");
	});

	it("N1: an unqualified file gets no job assigned, rather than a guess", () => {
		expect(remedyFor(null)).toBe("unknown");
	});
});

describe("summarizeSurvivors — open survivors grouped by job", () => {
	const at = "2026-08-09T00:00:00.000Z";

	it("P1: counts each file's open survivors under its own job", () => {
		const m = manifestOf({
			"src/untested.ts": [symbol("f", [mutant("survived"), mutant("survived")])],
			"src/weak.ts": [symbol("g", [mutant("survived")])],
			"src/old.ts": [symbol("h", [mutant("survived"), mutant("survived"), mutant("survived")])],
		});
		m.fileProvenance = {
			"src/untested.ts": { at, scope: "import_graph", testCount: 0, surface: "sweep" },
			"src/weak.ts": { at, scope: "import_graph", testCount: 7, surface: "sweep" },
		};
		expect(summarizeSurvivors(m).totals.openByRemedy).toEqual({
			write_test: 2,
			strengthen_tests: 1,
			unknown: 3,
		});
	});

	it("P2: the row carries the same job as the totals grouped it under", () => {
		const m = manifestOf({ "src/a.ts": [symbol("f", [mutant("survived")])] });
		m.fileProvenance = { "src/a.ts": { at, scope: "import_graph", testCount: 0, surface: "sweep" } };
		expect(summarizeSurvivors(m).files[0]?.remedy).toBe("write_test");
	});

	it("N1: killed mutants add nothing to any job", () => {
		const m = manifestOf({ "src/a.ts": [symbol("f", [mutant("killed"), mutant("killed")])] });
		m.fileProvenance = { "src/a.ts": { at, scope: "import_graph", testCount: 3, surface: "sweep" } };
		expect(summarizeSurvivors(m).totals.openByRemedy).toEqual({ write_test: 0, strengthen_tests: 0, unknown: 0 });
	});

	it("N2: restricting to a subset regroups the jobs for that subset only", () => {
		const m = manifestOf({
			"src/a.ts": [symbol("f", [mutant("survived")])],
			"src/b.ts": [symbol("g", [mutant("survived")])],
		});
		m.fileProvenance = {
			"src/a.ts": { at, scope: "import_graph", testCount: 0, surface: "sweep" },
			"src/b.ts": { at, scope: "import_graph", testCount: 5, surface: "sweep" },
		};
		const kept = restrictToFiles(summarizeSurvivors(m), new Set(["src/b.ts"]));
		expect(kept.totals.openByRemedy).toEqual({ write_test: 0, strengthen_tests: 1, unknown: 0 });
	});
});
