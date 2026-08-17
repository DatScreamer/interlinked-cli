// Wave-4 (fleet W6, fresh-eyes residue round) survivor-kill campaign for
// src/harness/checks/taste.ts. Companion to taste.test.ts,
// taste-mutation-kill.test.ts, taste-mutation-kill-wave2.test.ts, and
// taste-mutation-kill-wave3.test.ts — this file targets survivors that
// scratch/fleet-r3/receipts/src_harness_checks_taste.ts.jsonl's round-2
// pass had classified `suspected_equivalent` on a templated boilerplate
// "why" with no per-mutant argument. A structural re-read of
// `extractParamStr`'s `start === -1` early-return found it is NOT
// equivalent: when the second (paren-depth) loop runs with a corrupted
// `start` sentinel, it is UNGATED by the angle-bracket tracking that the
// first loop uses, so it can close on a completely unrelated `(...)` pair
// elsewhere in the accumulated signature and return non-null garbage
// instead of `null` — garbage this file constructs to read as 3 optional
// params, crossing `checkManyOptionalParams`'s reporting threshold where
// the original correctly emits nothing.
import { describe, expect, it } from "vitest";
import { checkManyOptionalParams } from "./taste.js";

describe("checkManyOptionalParams — extractParamStr sentinel kills (fresh-eyes)", () => {
	// Kills mutantId 4ef82f0d138e2eb8 (`start === -1` -> `false`),
	// 059a59c875a56185 (`let start = -1` -> `let start = 1`), and
	// 1c6bc31a52b012ea (the `-1` inside the `start === -1` comparison ->
	// `+1`). All three defeat the SAME early return, just via a different
	// route (forced-false condition, or a wrong sentinel value that makes
	// the still-correct `=== -1` comparison read false). Construction: an
	// unclosed `<` in the type-annotation position (legal for the
	// const-pattern gate, whose `[^=]+` swallows any non-`=` text
	// including `<`) means `extractParamStr`'s first loop — which only
	// tracks `<`/`>`, nothing else — never sees angle-depth return to 0,
	// so its own `(` (the real params paren) is always skipped and
	// `start` is never legitimately set. On pristine source this
	// correctly returns null and the line contributes nothing. On any of
	// the three mutants, the guarded early return is defeated and the
	// UNGATED second loop (no angle-bracket awareness at all) latches
	// onto the first "(...)" pair it finds ANYWHERE in the signature,
	// slicing from position 0 (or 2) up to that close paren — a string
	// which, via the stray `]` (an unmatched close bracket of a DIFFERENT
	// type, invisible to the `<`/`>` counter but very much counted by
	// `splitTopLevelParams`'s combined depth counter) rebalances back to
	// depth 0 before three `?:`-marked identifiers, each of which
	// `isOptionalParam` independently recognizes.
	// test-contract: invariant — extractParamStr's null-vs-garbage return
	// on malformed generics must not depend on which internal sentinel
	// happens to be corrupted; all three corruptions reach the same
	// UNGATED-second-loop code path.
	it("P: an unclosed generic in a const's type position does not manufacture optional params from unrelated parens", () => {
		const code = "const foo: X<] a?:num, b?:num, c?:num = (q) {";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([]);
	});

	// Kills mutantId c20a2d6452502c66 (`isOptionalParam`'s own copy of
	// the modifier-strip regex, `^(public|private|protected|readonly|
	// static)\s+` -> the SAME alternation with the leading `^` dropped).
	// Unanchored, "public" no longer has to be the first token of the
	// param — it can be stripped out of the MIDDLE of an identifier that
	// merely contains "public" as a substring followed by whitespace,
	// splicing the text on either side directly together. Constructed so
	// that splice manufactures a `?:` pair that was not adjacent before:
	// "flag?public : boolean" has its own `?` immediately followed by
	// 'p' (not ':'), so the ORIGINAL — "public" not at position 0, never
	// stripped — correctly finds no optional marker in this param. The
	// mutant strips "public " (with its trailing separating space) out of
	// the middle, joining "flag?" directly to ": boolean" and creating a
	// live `?:` the unmutated code never sees. Padded with two genuinely
	// optional params so the ORIGINAL sits at count 2 (below the
	// reporting threshold of 3) while the MUTANT reaches exactly 3.
	// test-contract: security — an anchor is not decorative on a strip
	// regex: applied mid-identifier it can delete attacker- or
	// author-controlled substrings and splice unrelated tokens together.
	it("P: an unanchored modifier-strip must not splice a substring match out of the middle of an identifier", () => {
		const code = "function foo(flag?public : boolean, other?: string, third?: number) {}";
		expect(checkManyOptionalParams(code, "f.ts")).toEqual([]);
	});
});
