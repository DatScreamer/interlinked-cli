// Mutation-kill companion for trigram-index-query.ts.
//
// filterByAdjacency / passesAdjacencyCheck / getMasksForFile are module-
// private (not exported) — every case here reaches them indirectly through
// the public queryIndex() surface, using QueryView fixtures that put
// specific files on specific sides of each internal branch.
import { describe, expect, it } from "vitest";
import {
	EARLY_TERMINATION_THRESHOLD,
	nextCharBit,
	packTrigram,
	type PostingList,
} from "./trigram-primitives.js";
import { getAllFileIds, getFilePath, queryIndex, type QueryView } from "./trigram-index-query.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------
function makePosting(entries: Array<{ fileId: number; locMask: number; nextMask: number }>): PostingList {
	const sorted = [...entries].sort((a, b) => a.fileId - b.fileId);
	return {
		fileIds: Uint32Array.from(sorted.map((e) => e.fileId)),
		locMasks: Uint8Array.from(sorted.map((e) => e.locMask)),
		nextMasks: Uint8Array.from(sorted.map((e) => e.nextMask)),
	};
}

function makeView(opts: {
	files?: string[];
	postings?: Map<number, PostingList>;
	stopTrigrams?: Set<number>;
	dirtyOverrides?: Map<number, Set<number> | null>;
	dirtyNewFiles?: Map<string, { id: number; trigrams: Set<number> }>;
}): QueryView {
	return {
		files: opts.files ?? [],
		postings: opts.postings ?? new Map(),
		stopTrigrams: opts.stopTrigrams ?? new Set(),
		dirtyOverrides: opts.dirtyOverrides ?? new Map(),
		dirtyNewFiles: opts.dirtyNewFiles ?? new Map(),
	};
}

const ids = (s: Set<number>): number[] => [...s].sort((a, b) => a - b);

// triA/triB is a realistic consecutive pair ("abc","bcd", sharing "bc").
const triA = packTrigram("a".charCodeAt(0), "b".charCodeAt(0), "c".charCodeAt(0));
const triB = packTrigram("b".charCodeAt(0), "c".charCodeAt(0), "d".charCodeAt(0));
const thirdCharOfB = triB & 0xff;
const nextBitForD = nextCharBit(thirdCharOfB);

// Base 3-file adjacency fixture: file0 genuinely passes (locMask AND nextMask
// both overlap); file1 fails on the locMask/position check; file2 passes
// locMask but fails on the nextMask/next-char check. This isolates the two
// distinct `return false` sites inside passesAdjacencyCheck.
function fxAdjBase(): QueryView {
	const postings = new Map<number, PostingList>([
		[
			triA,
			makePosting([
				{ fileId: 0, locMask: 1, nextMask: nextBitForD },
				{ fileId: 1, locMask: 1, nextMask: nextBitForD },
				{ fileId: 2, locMask: 1, nextMask: 0 },
			]),
		],
		[
			triB,
			makePosting([
				{ fileId: 0, locMask: 2, nextMask: 0 }, // consecutive with A -> locMask passes
				{ fileId: 1, locMask: 1, nextMask: 0 }, // non-consecutive -> locMask FAILS
				{ fileId: 2, locMask: 2, nextMask: 0 }, // consecutive -> locMask passes, nextMask FAILS
			]),
		],
	]);
	return makeView({ files: ["f0.ts", "f1.ts", "f2.ts"], postings });
}

// ---------------------------------------------------------------------------
// getFilePath
// ---------------------------------------------------------------------------
describe("getFilePath", () => {
	// test-contract: public-api — getFilePath must resolve a dirty-new-file id
	// to ITS OWN path, not just the first map entry.
	it("P1: resolves the second dirty-new-file entry by its own id, not the first", () => {
		const view = makeView({
			files: [],
			dirtyNewFiles: new Map([
				["a.ts", { id: 5, trigrams: new Set<number>() }],
				["b.ts", { id: 6, trigrams: new Set<number>() }],
			]),
		});
		expect(getFilePath(view, 6)).toBe("b.ts");
	});

	// test-contract: public-api — an id matching nothing (not in `files`, not
	// in dirtyNewFiles) resolves to undefined.
	it("N1: unknown id resolves to undefined", () => {
		const view = makeView({
			files: [],
			dirtyNewFiles: new Map([["a.ts", { id: 5, trigrams: new Set<number>() }]]),
		});
		expect(getFilePath(view, 99)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// getAllFileIds
// ---------------------------------------------------------------------------
describe("getAllFileIds", () => {
	// test-contract: invariant — a file with a non-null dirtyOverrides entry
	// (recomputed trigrams, not deleted) is still INCLUDED.
	it("P1: file with a non-null override is included alongside untouched files", () => {
		const view = makeView({
			files: ["a.ts", "b.ts"],
			dirtyOverrides: new Map([[0, new Set([123])]]),
		});
		expect(ids(getAllFileIds(view))).toEqual([0, 1]);
	});

	// test-contract: invariant — a file whose override is explicitly `null`
	// (deleted) is EXCLUDED; an untouched file in between stays included.
	it("N1: a null-override (deleted) file is excluded; untouched files remain", () => {
		const view = makeView({
			files: ["a.ts", "b.ts", "c.ts"],
			dirtyOverrides: new Map([
				[0, new Set([1])],
				[1, null],
			]),
		});
		expect(ids(getAllFileIds(view))).toEqual([0, 2]);
	});
});

// ---------------------------------------------------------------------------
// queryIndex — usable-trigram gating / early-termination boundary
// ---------------------------------------------------------------------------
describe("queryIndex — usable-trigram gating", () => {
	// test-contract: invariant — when every required trigram is filtered out
	// (empty requiredTrigrams here), queryIndex returns ALL files WITHOUT ever
	// applying adjacency filtering — the usable.length===0 early return
	// bypasses trigramSequences entirely.
	it("P1: empty requiredTrigrams returns every file, ignoring a would-narrow trigramSequences", () => {
		const postings = new Map<number, PostingList>([
			[
				triA,
				makePosting([
					{ fileId: 0, locMask: 1, nextMask: nextBitForD },
					{ fileId: 1, locMask: 1, nextMask: nextBitForD },
				]),
			],
			[
				triB,
				makePosting([
					{ fileId: 0, locMask: 2, nextMask: 0 }, // consecutive -> would PASS adjacency
					{ fileId: 1, locMask: 1, nextMask: 0 }, // non-consecutive -> would FAIL adjacency
				]),
			],
		]);
		const view = makeView({ files: ["f0.ts", "f1.ts"], postings });
		expect(ids(queryIndex(view, [], [[triA, triB]]))).toEqual([0, 1]);
	});

	// test-contract: invariant — a required trigram entirely absent from the
	// index (zero candidates) is a definitive miss for the whole query, even
	// when another required trigram would otherwise match a file.
	it("N1: a required trigram with zero candidates makes the whole query miss", () => {
		const postings = new Map<number, PostingList>([
			[triA, makePosting([{ fileId: 0, locMask: 0, nextMask: 0 }])],
			// triB has no posting entry at all -> zero candidates
		]);
		const view = makeView({ files: ["f0.ts"], postings });
		expect(ids(queryIndex(view, [triA, triB]))).toEqual([]);
	});
});

describe("queryIndex — EARLY_TERMINATION_THRESHOLD boundary", () => {
	// test-contract: boundary — once the running intersection shrinks to
	// EXACTLY EARLY_TERMINATION_THRESHOLD candidates, queryIndex stops
	// intersecting further required trigrams; a later trigram that would have
	// narrowed the result further is never applied.
	it("P1: intersection stops at exactly EARLY_TERMINATION_THRESHOLD candidates", () => {
		const T = EARLY_TERMINATION_THRESHOLD;
		const t1 = packTrigram(1, 1, 1);
		const t2 = packTrigram(2, 2, 2);
		const t3 = packTrigram(3, 3, 3);
		const range = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => offset + i);
		const mk = (fileIds: number[]) =>
			makePosting(fileIds.map((fileId) => ({ fileId, locMask: 0, nextMask: 0 })));
		const postings = new Map<number, PostingList>([
			[t1, mk(range(T + 1))], // raw size T+1 (smallest -> processed 1st)
			[t2, mk([...range(T), 9000, 9001])], // raw size T+2; intersect with t1 -> exactly T
			[t3, mk([0, ...range(T + 3, 20000)])], // raw size T+4 (largest -> processed last, if reached)
		]);
		const view = makeView({ files: [], postings });
		expect(queryIndex(view, [t1, t2, t3]).size).toBe(T);
	});
});

// ---------------------------------------------------------------------------
// queryIndex — adjacency filtering (filterByAdjacency / passesAdjacencyCheck
// / getMasksForFile, all reached through the exported queryIndex surface)
// ---------------------------------------------------------------------------
describe("queryIndex — adjacency filtering", () => {
	// test-contract: invariant — of three candidates sharing the required
	// trigram, only the one that is truly adjacent for the queried sequence
	// (both locMask position AND nextMask next-char overlap) survives.
	it("P1: adjacency filtering keeps only the genuinely-adjacent file, drops the locMask-fail and nextMask-fail files", () => {
		const view = fxAdjBase();
		expect(ids(queryIndex(view, [triA], [[triA, triB]]))).toEqual([0]);
	});

	// test-contract: invariant — when the paired trigram in a sequence is a
	// registered stop trigram, adjacency verification for that pair is
	// skipped (masks aren't tracked for stop trigrams) and the candidate
	// passes trivially, rather than being checked against absent real masks.
	it("P2: a stop-trigram in the sequence pair skips the real mask check (trivial pass for all candidates)", () => {
		const view: QueryView = { ...fxAdjBase(), stopTrigrams: new Set([triA]) };
		expect(ids(queryIndex(view, [triB], [[triA, triB]]))).toEqual([0, 1, 2]);
	});

	// test-contract: invariant — a file marked dirty (present in
	// dirtyOverrides) skips real mask verification and passes trivially, even
	// when a stale base-posting entry for it would fail if actually checked;
	// a clean file at the same site is genuinely checked and fails for real.
	it("P3: a dirty-override file trivially passes adjacency even when its stale base masks would fail", () => {
		const postings = new Map<number, PostingList>([
			[
				triA,
				makePosting([
					{ fileId: 0, locMask: 1, nextMask: nextBitForD },
					{ fileId: 1, locMask: 1, nextMask: nextBitForD },
				]),
			],
			[
				triB,
				makePosting([
					{ fileId: 0, locMask: 1, nextMask: 0 }, // stale/non-consecutive -> would FAIL if real-checked
					{ fileId: 1, locMask: 1, nextMask: 0 }, // clean file, genuinely non-consecutive -> FAILS for real
				]),
			],
		]);
		const view = makeView({
			files: ["d0.ts", "d1.ts"],
			postings,
			dirtyOverrides: new Map([[0, new Set([triA, triB])]]),
		});
		expect(ids(queryIndex(view, [triA], [[triA, triB]]))).toEqual([0]);
	});

	// test-contract: invariant — a newly-added dirty file (present only in
	// dirtyNewFiles) skips real mask verification and passes trivially, even
	// when a stale base-posting entry also exists for the same id; a
	// genuinely clean base-only file at a different id is real-checked.
	it("P4: a dirty-new-file id trivially passes even though its own stale base masks would fail if real-checked", () => {
		const postings = new Map<number, PostingList>([
			[
				triA,
				makePosting([
					{ fileId: 0, locMask: 1, nextMask: nextBitForD },
					{ fileId: 100, locMask: 1, nextMask: nextBitForD },
				]),
			],
			[
				triB,
				makePosting([
					{ fileId: 0, locMask: 1, nextMask: 0 }, // non-consecutive -> real check FAILS
					{ fileId: 100, locMask: 1, nextMask: 0 }, // ALSO non-consecutive if real-checked
				]),
			],
		]);
		const view = makeView({
			files: ["f0.ts"],
			postings,
			dirtyNewFiles: new Map([["new100.ts", { id: 100, trigrams: new Set([triA, triB]) }]]),
		});
		expect(ids(queryIndex(view, [triA], [[triA, triB]]))).toEqual([100]);
	});
});
