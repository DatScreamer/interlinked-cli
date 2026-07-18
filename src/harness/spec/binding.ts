// Claim↔namespace binding rules, shared by the single-file checks
// (checks/spec-structure.ts) and the cross-file ledger. A count claim is
// only checkable when evidence ties its noun to an ID namespace — this is
// the FP control that keeps ordinary prose quantities inert
// (docs/design/spec-audit-runtime-checks.md §3.3).

import { isSingularNounEndingInS, singularize } from "./extract-counts.js";
import type { CountClaim, IdNamespace, SpecFacts } from "./types.js";

type Heading = SpecFacts["headings"][number];

/** Lines on which any id of the namespace appears. */
export function idLineSet(ns: IdNamespace): Set<number> {
	const set = new Set<number>();
	for (const id of ns.ids) {
		for (const line of id.sites) set.add(line);
	}
	return set;
}

/** DEFINITION-site lines only (registry rows) — heading binding requires a real
 *  registry in the section, not incidental prose mentions (FP control). */
export function defLineSet(ns: IdNamespace): Set<number> {
	const set = new Set<number>();
	for (const id of ns.ids) {
		for (const line of id.defSites) set.add(line);
	}
	return set;
}

/** Section-end line per heading, computed ONCE per file and memoized (sol-max
 *  #12): a heading's section runs until the next heading of the same-or-higher
 *  level. Keyed by heading line. */
const sectionEndCache = new WeakMap<SpecFacts, Map<number, number>>();
function sectionEnds(facts: SpecFacts): Map<number, number> {
	const cached = sectionEndCache.get(facts);
	if (cached) return cached;
	const hs = facts.headings;
	const ends = new Map<number, number>();
	for (let i = 0; i < hs.length; i++) {
		const h = hs[i];
		if (!h) continue;
		let end = facts.lineCount;
		for (let j = i + 1; j < hs.length; j++) {
			const n = hs[j];
			if (n && n.level <= h.level) {
				end = n.line - 1;
				break;
			}
		}
		ends.set(h.line, end);
	}
	sectionEndCache.set(facts, ends);
	return ends;
}

/** Whether any of `lines` falls inside the section (headingLine, end]. */
function sectionContainsLine(
	headingLine: number,
	end: number,
	lines: Set<number>,
): boolean {
	for (const line of lines) {
		if (line > headingLine && line <= end) return true;
	}
	return false;
}

/** Smallest value in a set, by iteration — `Math.min(...set)` overflows the call
 *  stack on a large registry (sol-max #9: ~130k defined ids is valid markdown). */
function minOf(nums: Set<number>): number {
	let m = Number.POSITIVE_INFINITY;
	for (const n of nums) if (n < m) m = n;
	return m;
}

/** Whole-word noun match — substring matching would let "operations" bind
 *  "operation" claims to unrelated registries (Codex round-4 #7). */
function headingNamesNoun(headingText: string, claim: CountClaim): boolean {
	const words = headingText.toLowerCase().split(/[^a-z]+/);
	return words.includes(claim.noun) || words.includes(claim.nounSingular);
}

/** Lines carrying more than one count claim. The same-line proximity signal is
 *  ambiguous there — "six bets B1…B6 and four gates G1…G4" would cross-bind bet↔G
 *  and gate↔B — so on such lines binding must come from the heading path instead
 *  (sol-max round-5 #10). Computed once per file. */
function multiClaimLines(facts: SpecFacts): Set<number> {
	const counts = new Map<number, number>();
	for (const c of facts.countClaims) counts.set(c.line, (counts.get(c.line) ?? 0) + 1);
	const multi = new Set<number>();
	for (const [line, n] of counts) if (n > 1) multi.add(line);
	return multi;
}

/** The owning heading of a namespace's defined ids, or null — the value hoisted
 *  out of the per-claim loop so binding is O(namespaces·headings), not cubic
 *  (sol-max round-5 #1). */
function ownerOf(facts: SpecFacts, defLines: Set<number>, ends: Map<number, number>): Heading | null {
	if (defLines.size === 0) return null;
	// Only the DEEPEST heading owning the defs may name the claim's noun (sol-max
	// #7): an ancestor section ("# Six protocol requirements") also contains them
	// but does not name the registry.
	return deepestOwnerHeading(facts, minOf(defLines), ends);
}

/** Per-claim bind test given the namespace's precomputed owning heading and the
 *  file's ambiguous (multi-claim) lines. Shared by the public predicate and the
 *  internal binding loop so the two can never drift. */
function claimBindsGivenOwner(
	claim: CountClaim,
	idLines: Set<number>,
	owner: Heading | null,
	ambiguousLines: Set<number>,
): boolean {
	if (idLines.has(claim.line) && !ambiguousLines.has(claim.line)) return true;
	return owner !== null && headingNamesNoun(owner.text, claim);
}

/**
 * A count-claim noun binds to a namespace when they co-occur on one UNAMBIGUOUS
 * line (a line with a single claim — sol-max #10), or when a heading names the
 * noun and the namespace's DEFINED ids sit in that heading's section ("## The six
 * bets" over the B1..B7 table). The heading path requires DEFINITION sites
 * (sol-max #9) so a retired-list mention ("## Six bets\nB1, B2 were removed")
 * does not bind — consistent with heading-derived binding below.
 */
export function claimBindsToNamespace(
	claim: CountClaim,
	facts: SpecFacts,
	idLines: Set<number>,
	defLines: Set<number>,
): boolean {
	const owner = ownerOf(facts, defLines, sectionEnds(facts));
	return claimBindsGivenOwner(claim, idLines, owner, multiClaimLines(facts));
}

/** Headings whose plural word is almost never a registry noun. */
const HEADING_NOUN_STOP = new Set([
	"notes",
	"contents",
	"changes",
	"updates",
	"options",
	"docs",
	"details",
	"examples",
	"steps",
	"tools",
]);

/** The registry noun a heading names — the FIRST plural word (≥4 chars, not
 *  stoplisted), singularized with the same function count claims use, or null.
 *  First (not all, not last): a heading leads with its subject, so "## Bets and
 *  owners" yields "bet" — the real registry noun (sol-max #11) without binding a
 *  secondary noun that would fabricate drift (sol-max #8). */
function headingRegistryNoun(headingText: string): string | null {
	for (const w of headingText.toLowerCase().split(/[^a-z]+/)) {
		if (
			w.length >= 4 &&
			w.endsWith("s") &&
			!HEADING_NOUN_STOP.has(w) &&
			!isSingularNounEndingInS(w) // "Access"/"Status" are singular, not the registry noun (sol-max #12)
		) {
			return singularize(w);
		}
	}
	return null;
}

/** The DEEPEST heading owning `minDef` — the nearest heading above it whose
 *  section still spans it (sol-max #10). An ancestor section also contains the
 *  defs, but only this immediate owner names the registry. */
function deepestOwnerHeading(
	facts: SpecFacts,
	minDef: number,
	ends: Map<number, number>,
): Heading | null {
	let owner: Heading | null = null;
	for (const h of facts.headings) {
		const spans = (ends.get(h.line) ?? facts.lineCount) >= minDef;
		// `<=`, not `<`: a heading line is itself a valid definition site, so a
		// registry whose earliest def is on the heading ("## Bets B1") is still
		// owned by that heading (sol-max #11).
		if (h.line <= minDef && h.line > (owner?.line ?? -1) && spans) owner = h;
	}
	return owner;
}

/** Bind the registry noun of the deepest heading owning this namespace's
 *  defined ids (sol-max #10/#11). */
function appendHeadingBindings(
	facts: SpecFacts,
	ns: IdNamespace,
	key: string,
	bind: (noun: string, key: string) => void,
	ends: Map<number, number>,
): void {
	const defLines = defLineSet(ns);
	if (defLines.size === 0) return;
	const owner = deepestOwnerHeading(facts, minOf(defLines), ends);
	if (!owner) return;
	const noun = headingRegistryNoun(owner.text);
	if (noun) bind(noun, key);
}

/**
 * Noun→namespace binding evidence within one file: which (style-qualified)
 * namespace prefixes each claim noun binds to. The ledger merges these per
 * file to check claims in files that don't enumerate the ids themselves
 * (README says "six bets"; the plan is where bets↔B is established).
 */
export function localNounBindings(facts: SpecFacts): Map<string, Set<string>> {
	const bindings = new Map<string, Set<string>>();
	const bind = (noun: string, key: string): void => {
		const set = bindings.get(noun);
		if (set) set.add(key);
		else bindings.set(noun, new Set([key]));
	};
	const ends = sectionEnds(facts);
	const ambiguousLines = multiClaimLines(facts);
	for (const ns of facts.namespaces) {
		if (ns.uniqueCount < 2) continue;
		const idLines = idLineSet(ns);
		// Owner computed ONCE per namespace (invariant across claims) — the fix for
		// the cubic namespace×claim×heading blowup (sol-max round-5 #1).
		const owner = ownerOf(facts, defLineSet(ns), ends);
		const key = `${ns.style} ${ns.prefix}`;
		for (const claim of facts.countClaims) {
			if (claimBindsGivenOwner(claim, idLines, owner, ambiguousLines)) {
				bind(claim.nounSingular, key);
			}
		}
		appendHeadingBindings(facts, ns, key, bind, ends);
	}
	return bindings;
}
