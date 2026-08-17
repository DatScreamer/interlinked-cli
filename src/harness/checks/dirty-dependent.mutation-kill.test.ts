// Mutation-kill companion for dirty-dependent.ts (LEAN fleet W9, wave r3).
//
// Every test here targets an OBSERVABLE BEHAVIOR of one of the three exported
// functions (findDirtyDependents, looksCoordinated, formatDirtyDependentWarning).
// The file's internal helpers (parseHunkContexts, defNameFromContext,
// changedSymbols, changedLineIdentifiers, fallbackTopicSymbols, walkGraph,
// expandFrontier, recordIfDirty, compareMatches) are not exported, so most
// tests reach them indirectly through looksCoordinated's boolean result or
// findDirtyDependents' match list — see the `probeContext`/`probeExpect`
// harness below for how a specific internal capture is pinned precisely
// despite that indirection.
//
// Structural-equivalence notes (not tested here — no distinguishing
// behavior exists) live in
// scratch/fleet-r3/receipts/src_harness_checks_dirty-dependent.ts.jsonl.

import { describe, expect, it } from "vitest";
import {
	findDirtyDependents,
	formatDirtyDependentWarning,
	looksCoordinated,
} from "./dirty-dependent.js";

function makeNeighbors(map: Record<string, string[]>) {
	return (f: string) => map[f] ?? [];
}
const isTestFile = (f: string) => /\.(test|spec)\.[tj]sx?$/.test(f);

describe("HUNK_HEADER anchors and digit/comma boundaries (via changedSymbols' header parse)", () => {
	const UNRELATED_HEADER_DIFF = "@@ -1,2 +1,3 @@ export function OtherFn(y) {";

	// test-contract: boundary — HUNK_HEADER is anchored with `^`: a
	// "@@ ... @@" shape embedded mid-line (not at the line start) must NOT be
	// recognized as a hunk header. If it were, side A would extract a real
	// (but spurious) def-name and, finding no cross-reference with an
	// unrelated diff, wrongly report "not coordinated" (false) instead of
	// correctly falling open on insufficient evidence (true) — since neither
	// changedSymbols nor the fallback (no +/- lines on this single-line
	// diff) can find a real topic for a header-less line.
	it("does not recognize a '@@ ... @@' pattern embedded mid-line as a hunk header", () => {
		const diffA = "xx@@ -1,2 +1,3 @@ function EmbeddedName(x) {";
		expect(looksCoordinated([diffA, UNRELATED_HEADER_DIFF])).toBe(true);
	});

	// test-contract: boundary — each header variant below is a real hunk-header
	// shape (multi-digit line/count numbers on either side of the diff, an
	// omitted optional count) that HUNK_HEADER must still recognize as a real
	// header with a real captured context. A header the regex fails to match
	// yields no def-name for side A, so looksCoordinated falls open (true)
	// instead of correctly finding no cross-reference with an unrelated diff
	// (false).
	it.each([
		["a multi-digit first line number", "@@ -12,3 +1,3 @@ function TwelveCtx(x) {"],
		["a first number with no optional ',count'", "@@ -1 +1,3 @@ function NoCommaCtx(x) {"],
		["a multi-digit first count", "@@ -1,23 +1,3 @@ function TwoDigitCount(x) {"],
		["a multi-digit second line number", "@@ -1,2 +12,3 @@ function SecondMultiDigit(x) {"],
		["a second number with no optional ',count'", "@@ -1,2 +1 @@ function NoCommaPlus(x) {"],
		["a multi-digit second count", "@@ -1,2 +1,23 @@ function PlusTwoDigitCount(x) {"],
	])("recognizes a hunk header with %s", (_label, diffA) => {
		expect(looksCoordinated([diffA, UNRELATED_HEADER_DIFF])).toBe(false);
	});
});

describe("COORD_STOP_WORDS excludes JS/TS keywords and universal globals from the fallback topic set", () => {
	// Excludes "let", "var", "new", "Map", "Set" — all length 3, so the
	// `tok.length < 4` filter in fallbackTopicSymbols already excludes them
	// before the stop-word membership check is ever reached; mutating their
	// string value is unobservable (suspected_equivalent, see receipts).
	const NON_COLLAPSED_STOP_WORDS = [
		"function", "class", "interface", "type", "enum", "import", "export",
		"from", "default", "return", "true", "false", "null", "undefined",
		"void", "this", "throw", "async", "await", "yield", "static", "public",
		"private", "protected", "readonly", "extends", "implements",
		"namespace", "module", "abstract", "string", "number", "boolean",
		"object", "Record", "Array", "Promise", "Date", "Error", "RegExp",
		"Buffer", "console", "process",
	];
	const unrelatedDiffB = [
		"@@ -1,2 +1,3 @@ export function totallyUnrelatedTopic(q) {",
		"-  doStuff(q);",
		"+  doStuff(q, extra);",
	].join("\n");

	// test-contract: invariant — a stop word appearing alone on a changed line
	// is prose/boilerplate (a keyword or a universal global), never a
	// project-specific identifier, so it must leave that side's topic set
	// EMPTY (falling open to "insufficient evidence", true) rather than
	// becoming a real fallback topic that fails to cross-reference an
	// unrelated diff and so wrongly reports "not coordinated" (false).
	it.each(NON_COLLAPSED_STOP_WORDS)(
		"keeps '%s' out of the fallback topic set",
		(word) => {
			expect(looksCoordinated([`+${word}`, unrelatedDiffB])).toBe(true);
		},
	);
});

describe("changedLineIdentifiers add/delete line classification", () => {
	const diffA = "@@ -1,2 +1,3 @@ export function ZTRAP(x) {";
	function diffBWith(trapLine: string): string {
		return `+ZANCHOR\n${trapLine}`;
	}

	// test-contract: boundary — a context line (starts with neither a real
	// "+" add marker nor a real "-" delete marker) must contribute no tokens
	// at all.
	it("excludes a plain context line that starts with neither '+' nor '-'", () => {
		expect(looksCoordinated([diffA, diffBWith(" ZTRAP")])).toBe(false);
	});

	// test-contract: boundary — a genuine single-dash delete line (distinct
	// from the "--- a/file" diff-header line) must be included.
	it("includes a genuine single-dash delete line", () => {
		expect(looksCoordinated([diffA, diffBWith("-ZTRAP")])).toBe(true);
	});

	// test-contract: boundary — a "+++ b/file" diff-header line must be
	// excluded even though it starts with "+".
	it("excludes a '+++' file-header line", () => {
		expect(looksCoordinated([diffA, diffBWith("+++ZTRAP")])).toBe(false);
	});

	// test-contract: boundary — a "--- a/file" diff-header line must be
	// excluded even though it starts with "-".
	it("excludes a '---' file-header line", () => {
		expect(looksCoordinated([diffA, diffBWith("---ZTRAP")])).toBe(false);
	});

	// test-contract: boundary — a line is classified by its LEADING
	// character only; a line that merely ends with "-" is not a delete line.
	it("does not classify a line as a delete line just because it ends with '-'", () => {
		expect(looksCoordinated([diffA, diffBWith(" ZTRAP-")])).toBe(false);
	});
});

describe("changedSymbols only records a real, non-null extracted name", () => {
	// test-contract: bug — a hunk context that yields no recognizable name
	// (defNameFromContext returns null) must contribute NOTHING to the topic
	// set. Adding the null value itself would give side A a non-empty-but-
	// useless topic, which skips the fallback extraction that would
	// otherwise find the real cross-reference below.
	it("does not add a null placeholder when the hunk context has no recognizable def name", () => {
		const diffA = "@@ -1,2 +1,3 @@ just a plain context phrase";
		const diffB = "@@ -1,2 +1,3 @@ export function RealTopicX(z) {";
		expect(looksCoordinated([diffA, diffB])).toBe(true);
	});
});

describe("defNameFromContext capture boundaries (via the probeContext/probeExpect harness)", () => {
	// probeContext gives side A a companion fallback-worthy line
	// ("+UnrelatedFallbackWord") so side A stays non-empty even when
	// extraction from `context` fails — otherwise EVERY failed extraction
	// would fall open (true) via the "insufficient evidence" path and mask
	// the mutant behind the same true result as a correct extraction.
	function probeContext(context: string): string {
		return `@@ -1,2 +1,3 @@ ${context}\n+UnrelatedFallbackWord`;
	}
	// probeExpect gives side B a real (non-fallback) unrelated topic
	// ("ProbeAnchor") plus a body line containing exactly `expectedName`, so
	// looksCoordinated(...) is true iff defNameFromContext(context) is
	// exactly `expectedName` — a wrong capture or a null capture both read
	// as false, never accidentally true.
	function probeExpect(expectedName: string): string {
		return `@@ -1,2 +1,3 @@ export function ProbeAnchor(q) {\n+${expectedName}`;
	}

	// test-contract: boundary — each row pins one capture-boundary rule of
	// defNameFromContext's three sub-patterns (byKeyword/byBinding/
	// byCallable): required vs optional whitespace, the name's required
	// first-char class, full-vs-truncated capture length, and priority
	// ordering between the three sub-patterns.
	it.each([
		[
			"byKeyword requires >=1 whitespace char (not exactly 1, not non-whitespace) and a letter/_/$ name start",
			"please function  MultiSpaceName does a thing",
			"MultiSpaceName",
		],
		[
			"byKeyword takes priority over an earlier byCallable match in the same context",
			"helper(cond) && function RealName(x) {",
			"RealName",
		],
		[
			"byBinding requires >=1 whitespace char (not exactly 1, not non-whitespace) and a letter/_/$ name start",
			"const  MultiSpaceVar does a thing",
			"MultiSpaceVar",
		],
		[
			"byBinding captures the FULL name (not a fixed-width prefix, not a punctuation-inverted trailing class)",
			"const RealVarLong does a thing",
			"RealVarLong",
		],
		[
			"byBinding takes priority over an earlier byCallable match in the same context",
			"helper(x) const RealVar does a thing",
			"RealVar",
		],
		[
			"byCallable captures the full identifier before '(' with zero mandatory whitespace and a [\\w$] trailing class",
			"doStuff(x)",
			"doStuff",
		],
		[
			"byCallable's whitespace before the punctuation is optional (zero-or-more), not mandatory",
			"doStuff (x)",
			"doStuff",
		],
	])("%s", (_label, context, expectedName) => {
		expect(looksCoordinated([probeContext(context), probeExpect(expectedName)])).toBe(true);
	});

	// test-contract: bug — when none of the three name patterns match, the
	// function must return null rather than indexing a null match array.
	// Indexing null throws, which would crash looksCoordinated (and the
	// pre-commit dirty-dependent check built on it) on ordinary hunk context
	// text with no def-name shape at all, e.g. prose or a merge-commit line.
	it("returns null (not a thrown TypeError) when no pattern matches at all", () => {
		expect(
			looksCoordinated([probeContext("just a plain phrase"), probeExpect("Whatever")]),
		).toBe(false);
	});
});

describe("fallbackTopicSymbols length and identifier-shape filters", () => {
	// test-contract: boundary — the length floor is `< 4` (strictly shorter
	// than 4 is excluded); a 4-character identifier-shaped token sits AT the
	// floor and must still be kept.
	it("keeps a 4-character token in the fallback topic set", () => {
		const diffA = "+abcd\n+alwaysKeptWord";
		const diffB = "@@ -1,2 +1,3 @@ export function ProbeAnchor(q) {\n+abcd";
		expect(looksCoordinated([diffA, diffB])).toBe(true);
	});

	// test-contract: boundary — a token must START with a letter/_/$ to
	// become a fallback topic. A digit-led token is line-number/hash-shaped
	// noise even when it contains letters later on, and must be excluded on
	// that basis (not merely "contains no letters anywhere").
	it("excludes a digit-led token even though it contains letters later in the token", () => {
		const diffA = "+123extra\n+alwaysKeptWord";
		const diffB = "@@ -1,2 +1,3 @@ export function ProbeAnchor(q) {\n+123extra";
		expect(looksCoordinated([diffA, diffB])).toBe(false);
	});
});

describe("looksCoordinated control flow: fallback triggering and the second cross-reference loop", () => {
	// test-contract: bug — side B's fallback must trigger when
	// changedSymbols(diffB) is genuinely empty; skipping it leaves symsB
	// empty and fails the whole comparison open (true) even though B has
	// real fallback content that legitimately does not cross-reference A.
	it("still runs the fallback for side B when its hunk context yields no real name", () => {
		const diffA = "@@ -1,2 +1,3 @@ export function AlphaTopic(x) {";
		const diffB = "+BetaTopic";
		expect(looksCoordinated([diffA, diffB])).toBe(false);
	});

	// test-contract: bug — side B's fallback must NOT override an already-
	// real, non-empty changedSymbols result; doing so replaces a correct
	// topic with an unrelated fallback token and can erase a genuine
	// cross-reference that the real topic would have found.
	it("does not let the fallback overwrite a real (non-empty) changedSymbols result for side B", () => {
		const diffA = ["@@ -1,2 +1,3 @@ export function UnrelatedA(x) {", "+RealDefName"].join("\n");
		const diffB = ["@@ -1,2 +1,3 @@ export function RealDefName(x) {", "+FallbackWord"].join("\n");
		expect(looksCoordinated([diffA, diffB])).toBe(true);
	});

	// test-contract: bug — when side B has no topic at all (even after
	// fallback), the function must fail open (true) regardless of side A;
	// ignoring B's emptiness produces a wrong "not coordinated" verdict.
	it("fails open when side B has no topic at all, even though side A does", () => {
		const diffA = "@@ -1,2 +1,3 @@ export function SoloTopic(x) {";
		const diffB = "+ab";
		expect(looksCoordinated([diffA, diffB])).toBe(true);
	});

	// test-contract: bug — the second cross-reference loop (B's topic found
	// among A's changed-line tokens) must actually return true on a match.
	// It is not redundant with the first loop (A's topic found among B's
	// tokens): the two diffs are not symmetric in what each one mentions.
	it("finds a coordinated match via side B's topic appearing in side A's tokens", () => {
		const diffA = ["@@ -1,2 +1,3 @@ export function TopicA(x) {", "+SharedMarker"].join("\n");
		const diffB = "@@ -1,2 +1,3 @@ export function SharedMarker(x) {";
		expect(looksCoordinated([diffA, diffB])).toBe(true);
	});
});

describe("compareMatches ordering: isTest tier, then hopCount, then lexicographic", () => {
	// test-contract: invariant — when isTest is equal on both sides, the
	// isTest comparison must not decide the order by itself; hopCount must
	// still control it.
	it("orders two non-test matches by ascending hopCount, not by isTest alone", () => {
		const result = findDirtyDependents({
			stagedFiles: ["src/a.ts"],
			unstagedDirtyFiles: ["src/near.ts", "src/far.ts"],
			getImporters: makeNeighbors({
				"src/a.ts": ["src/near.ts", "src/mid.ts"],
				"src/mid.ts": ["src/far.ts"],
			}),
			isTestFile,
		});
		expect(result.map((r) => r.dirtyFile)).toEqual(["src/near.ts", "src/far.ts"]);
	});

	// test-contract: invariant — when isTest AND hopCount are both equal (a
	// genuine tie), the (staged, dirtyFile, direction) lexicographic compare
	// must still run so the output order is deterministic across runs.
	it("breaks an isTest+hopCount tie lexicographically", () => {
		const result = findDirtyDependents({
			stagedFiles: ["src/a.ts"],
			unstagedDirtyFiles: ["src/zzz.ts", "src/aaa.ts"],
			getImporters: makeNeighbors({ "src/a.ts": ["src/zzz.ts", "src/aaa.ts"] }),
			isTestFile,
		});
		expect(result.map((r) => r.dirtyFile)).toEqual(["src/aaa.ts", "src/zzz.ts"]);
	});

	// test-contract: invariant — the hopCount comparison must be a genuine
	// ascending numeric compare (not a magnitude-broken sum, not silently
	// skipped in favor of the lexicographic compare); a lower hopCount must
	// sort first even when its dirtyFile name sorts later lexicographically.
	it("sorts a lower hopCount first even when its name sorts later lexicographically", () => {
		const result = findDirtyDependents({
			stagedFiles: ["src/a.ts"],
			unstagedDirtyFiles: ["src/zzz.ts", "src/aaa.ts"],
			getImporters: makeNeighbors({
				"src/a.ts": ["src/zzz.ts", "src/mid.ts"],
				"src/mid.ts": ["src/aaa.ts"],
			}),
			isTestFile,
		});
		expect(result.map((r) => r.dirtyFile)).toEqual(["src/zzz.ts", "src/aaa.ts"]);
	});
});

describe("recordIfDirty cross-walk dedup", () => {
	// test-contract: invariant — the seenPair dedup must persist ACROSS
	// separate walkGraph calls for the same staged file (e.g. a caller-
	// supplied duplicate entry in stagedFiles), not just within one walk's
	// own visited-node set — each walkGraph call gets a fresh visited set,
	// so only seenPair (shared on ctx across the whole findDirtyDependents
	// call) can catch this case.
	it("does not double-record the same match when the same staged file is listed twice", () => {
		const result = findDirtyDependents({
			stagedFiles: ["src/a.ts", "src/a.ts"],
			unstagedDirtyFiles: ["src/b.ts"],
			getImporters: makeNeighbors({ "src/a.ts": ["src/b.ts"] }),
			isTestFile,
		});
		expect(result).toHaveLength(1);
	});
});

describe("expandFrontier frontier integrity", () => {
	// test-contract: invariant — the next BFS frontier must be built solely
	// from real graph edges (ctx.expand(f) for each real f already in the
	// frontier). It must never contain a hardcoded/placeholder node,
	// because a caller's getImporters/getDependencies could coincidentally
	// resolve that literal string into real (and wrongly-surfaced) files.
	it("never seeds the next frontier with a node that isn't a real graph neighbor", () => {
		const getImporters = (f: string) => (f === "Stryker was here" ? ["src/secretDirty.ts"] : []);
		const result = findDirtyDependents({
			stagedFiles: ["src/a.ts"],
			unstagedDirtyFiles: ["src/secretDirty.ts"],
			getImporters,
			isTestFile,
		});
		expect(result).toEqual([]);
	});
});

describe("walkGraph BFS bounds", () => {
	// test-contract: invariant — the BFS must start FROM the staged file
	// itself (frontier seeded with [start]), so the staged file's own
	// direct importers/dependencies are queried on the very first hop.
	it("queries the staged file's own direct importers (frontier is not seeded empty)", () => {
		const result = findDirtyDependents({
			stagedFiles: ["src/a.ts"],
			unstagedDirtyFiles: ["src/b.ts"],
			getImporters: makeNeighbors({ "src/a.ts": ["src/b.ts"] }),
			isTestFile,
		});
		expect(result).toHaveLength(1);
	});

	// test-contract: boundary — maxDepth is an INCLUSIVE bound: a target
	// reachable at exactly maxDepth hops must still be found.
	it("reaches a target at exactly maxDepth hops (inclusive bound)", () => {
		const result = findDirtyDependents({
			stagedFiles: ["src/a.ts"],
			unstagedDirtyFiles: ["src/c.test.ts"],
			getImporters: makeNeighbors({
				"src/a.ts": ["src/b.ts"],
				"src/b.ts": ["src/c.test.ts"],
			}),
			isTestFile,
			maxDepth: 2,
		});
		expect(result).toHaveLength(1);
		expect(result[0]?.hopCount).toBe(2);
	});
});

describe("formatDirtyDependentWarning exact rendering", () => {
	// test-contract: public-api — the rendered warning is text an agent
	// reads and acts on; its exact shape (headline, per-line hop suffix and
	// TEST tag defaults, no spurious "...and 0 more" suffix when nothing was
	// truncated, footer verbatim) is the contract — not "contains some
	// expected substrings". A single direct (hopCount===1), non-test match
	// must render with BOTH per-line defaults empty.
	it("renders the exact single-match message with no truncation suffix and no hop/TEST decoration", () => {
		const msg = formatDirtyDependentWarning({
			matches: [
				{
					staged: "src/a.ts",
					dirtyFile: "src/b.ts",
					direction: "importer",
					hopCount: 1,
					isTest: false,
				},
			],
		});
		expect(msg).toBe(
			"[interlinked:dirty-dependent] About to commit a file with a dirty, unstaged companion on the import graph. The commit may not be self-contained.\n" +
				"  - src/b.ts imports src/a.ts, but is dirty in the working tree\n" +
				"Stage the companion too (`git add <file>`), stash it (`git stash --keep-index`), " +
				"or split the commit deliberately — but don't ship code whose tests passed only locally.",
		);
	});

	// test-contract: public-api — multiple shown lines must be newline-
	// joined (not concatenated with no separator), so each match renders on
	// its own line rather than running together.
	it("newline-joins multiple match lines", () => {
		const msg = formatDirtyDependentWarning({
			matches: [
				{ staged: "src/a.ts", dirtyFile: "src/b.ts", direction: "importer", hopCount: 1, isTest: false },
				{ staged: "src/a.ts", dirtyFile: "src/c.ts", direction: "importer", hopCount: 1, isTest: false },
			],
		});
		expect(msg).toBe(
			"[interlinked:dirty-dependent] About to commit a file with a dirty, unstaged companion on the import graph. The commit may not be self-contained.\n" +
				"  - src/b.ts imports src/a.ts, but is dirty in the working tree\n" +
				"  - src/c.ts imports src/a.ts, but is dirty in the working tree\n" +
				"Stage the companion too (`git add <file>`), stash it (`git stash --keep-index`), " +
				"or split the commit deliberately — but don't ship code whose tests passed only locally.",
		);
	});
});
