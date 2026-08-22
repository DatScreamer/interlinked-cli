import { describe, expect, it } from "vitest";
import {
	assemblyIndexOfText,
	assemblyIndexOfTokens,
	isTriviallyAssembled,
	literalAssemblyIndex,
	significance,
} from "./assembly-score.js";

// Wave 29 survivor-kill pass. Each case is hand-traced against the pristine
// algorithm and cross-checked with a reference re-implementation (see
// scratch/fleet-r3/sim*.py) before being committed here — see receipts at
// scratch/fleet-r3/receipts/src_harness_spec_assembly-score.ts.jsonl.

describe("assemblyIndexOfTokens — mutant-killing cases", () => {
	// test-contract: boundary — mutant cfe2bd0f383fe19c: 'count > bestCount' -> '>='.
	// Two disjoint pairs tie at count 2 ((a,b) and (b,b)); '>' keeps the
	// first-seen tie, '>=' lets the later one overwrite it, changing which
	// pair merges first and thus the final compressed length.
	it("keeps the FIRST max-count pair on a tie, not the last (count > bestCount)", () => {
		expect(assemblyIndexOfTokens(["a", "b", "a", "b", "b", "b"])).toBe(5);
	});

	// test-contract: invariant — mutants 6408219c7f64ef46 (whole merge condition
	// -> true) and b79223c305f5fba6 (&& -> || on the last clause). Both mutations make the
	// merge fire on tokens that don't actually match bestA/bestB, corrupting
	// the compressed sequence for this input the same way.
	it("only merges positions where both bestA and bestB actually match", () => {
		expect(assemblyIndexOfTokens(["a", "a", "a", "b"])).toBe(4);
	});

	// test-contract: boundary — mutant c34c938ea587b0b7: 'seq[i + 1] === bestB' -> 'true'.
	// Forcing the bestB check true makes every bestA-matching position merge
	// regardless of its right neighbor, corrupting round-0's output before a
	// second, unintended merge round happens.
	it("requires the right neighbor to equal bestB, not just the left to equal bestA", () => {
		expect(assemblyIndexOfTokens(["a", "a", "a", "b", "b", "b"])).toBe(6);
	});

	// test-contract: invariant — a no-op merge branch or else branch (mutants
	// e072f28a1f67b3ef, aad2f58aeec6991f) drops a token from the compressed
	// output instead of emitting or carrying it forward.
	it("emits the nonterminal on merge and carries non-merged tokens forward", () => {
		expect(assemblyIndexOfTokens(["a", "a", "a"])).toBe(3);
	});
});

describe("assemblyIndexOfText — mutant-killing cases", () => {
	// test-contract: invariant — mutant 109c6e6616b1037c drops '.filter(Boolean)' from
	// 'text.split(/\s+/).filter(Boolean)'. Leading whitespace then leaves an
	// empty-string token in the array, changing the token count.
	it("filters the empty leading token produced by leading whitespace", () => {
		expect(assemblyIndexOfText(" a b")).toBe(assemblyIndexOfText("a b"));
		expect(assemblyIndexOfText(" a b")).toBe(2);
	});

	// test-contract: boundary — mutant 2698f38b8b3ce403 — '/\s+/' -> '/\S+/' (splits on
	// non-whitespace runs instead of whitespace runs), which tokenizes the
	// SPACES between words instead of the words themselves.
	it("tokenizes on whitespace runs, not non-whitespace runs", () => {
		expect(assemblyIndexOfText("a b c")).toBe(3);
	});
});

describe("isTriviallyAssembled — mutant-killing cases", () => {
	// test-contract: boundary — mutant 97398088231e5911 — drops the leading '^' from the
	// comma-grouped alternative, letting an unanchored SUFFIX of a malformed
	// literal (first group > 3 digits) satisfy the format check.
	it("rejects a malformed comma-first-group even when a valid suffix would match unanchored", () => {
		expect(isTriviallyAssembled("10000,000")).toBe(false);
	});

	// test-contract: boundary — mutant f2eae5b1809f9277 — narrows the comma branch's
	// first-group quantifier from '\d{1,3}' to '\d' (exactly one digit),
	// wrongly rejecting a well-formed 3-digit first group.
	it("accepts a well-formed 3-digit first group before the first comma", () => {
		expect(isTriviallyAssembled("100,000")).toBe(true);
	});

	// test-contract: boundary — mutant af25ab80487f0b95 (comma branch's fractional '\d+'
	// narrowed to '\d', exactly one digit) and f1ae0ddf0c0d3597 (comma
	// branch's fractional '\d' swapped to '\D', non-digit). Both reject a
	// legitimate 2-digit fractional part that the real grammar allows.
	it("accepts a multi-digit fractional part on the comma-grouped form", () => {
		expect(isTriviallyAssembled("1,000.00")).toBe(true);
	});

	// test-contract: boundary — mutant d927495949a66ecf — drops the leading '^' from the
	// underscore-grouped alternative (mirror of 97398088231e5911).
	it("rejects a malformed underscore-first-group even with a matching unanchored suffix", () => {
		expect(isTriviallyAssembled("10000_000")).toBe(false);
	});

	// test-contract: boundary — mutant 5c6224bd0c06890f — narrows the underscore branch's
	// first-group quantifier to a single digit (mirror of f2eae5b1809f9277).
	it("accepts a well-formed 3-digit first group before the first underscore", () => {
		expect(isTriviallyAssembled("100_000")).toBe(true);
	});

	// test-contract: boundary — mutant dae28638162ed657 (underscore branch fractional '\d+'
	// -> '\d') and de17f63ae7e7e295 (underscore branch fractional '\d' -> '\D'
	// ). Mirror of the comma-branch fractional pair above.
	it("accepts a multi-digit fractional part on the underscore-grouped form", () => {
		expect(isTriviallyAssembled("1_000.00")).toBe(true);
	});

	// test-contract: boundary — mutant 0613b2e39ff63744 — drops the trailing '$' from the
	// underscore branch, so a valid PREFIX (ignoring trailing garbage that
	// Number() would still parse, like a trailing space) wrongly satisfies
	// the format check.
	it("rejects trailing garbage after an otherwise well-formed underscore literal", () => {
		expect(isTriviallyAssembled("1_000 ")).toBe(false);
	});

	// test-contract: boundary — mutant 9480a328ccb44c69 — '/^0+/' -> '/^0/' in the
	// significant-digit calc strips only one leading zero instead of all of
	// them, so a value with many leading zeros but a short true significant
	// span wrongly trips the '>15' precision guard.
	it("strips ALL leading zeros before measuring significant-digit precision", () => {
		expect(isTriviallyAssembled(`${"0".repeat(20)}1`)).toBe(true);
	});

	// test-contract: boundary — mutant 8fdfca1e0955805d — a '/0+$/' -> '/0$/' narrowing
	// (only one char stripped instead of the whole run) on a trailing-zero
	// regex; the manifest doesn't pin which of the two same-shaped literals
	// in this function it targets, so both sites are exercised directly.
	it("strips the WHOLE trailing-zero run when measuring significant-digit precision", () => {
		expect(isTriviallyAssembled(`1${"0".repeat(20)}`)).toBe(true);
	});
	// test-contract: boundary — mutant 8fdfca1e0955805d's second candidate site
	// (round-number trailing-zero strip), covered separately from the
	// precision-calc site above since the manifest doesn't pin which one it hit.
	it("strips the WHOLE trailing-zero run when detecting the k·10^m round-number shape", () => {
		expect(isTriviallyAssembled("600")).toBe(true);
	});

	// test-contract: boundary — mutant 81bcaecbe915d22d — 'sigDigits.length > 15' ->
	// '>= 15'. 2**47 has exactly 15 significant digits with no boundary
	// zeros to strip, landing exactly on the boundary the mutant misreads.
	it("does not reject exactly-15-significant-digit values at the precision boundary", () => {
		expect(isTriviallyAssembled("140737488355328")).toBe(true);
	});

	// test-contract: boundary — mutant 5037ddfab402caae ('digits.length > 1' -> 'true')
	// and 33fd7b06d78e416f ('digits.length > 1' -> '>= 1'). Both remove the
	// guard that stops a single nonzero digit (trivially "all trailing
	// zeros" by the arithmetic) from being misread as a round number.
	it("does not classify a single-digit non-trivial value as round via the trailing-zero shape", () => {
		expect(isTriviallyAssembled("5")).toBe(false);
	});

	// test-contract: boundary — mutant 0b1d50c21e2296cb — 'value === 12' -> 'false'. 12 is
	// not caught by any earlier heuristic (not <=2, not a power of 2 or 10,
	// no trailing zero), so only the clock-value clause classifies it.
	it("classifies 12 as trivial via the clock/space-basis clause", () => {
		expect(isTriviallyAssembled("12")).toBe(true);
	});
});

describe("literalAssemblyIndex — mutant-killing cases", () => {
	// test-contract: boundary — mutant 52a4b03ec08f8ace — 'isTriviallyAssembled(raw)' ->
	// 'false', which always skips the "return 1" shortcut even for a
	// round-number literal.
	it("returns 1 immediately for a trivially-assembled literal", () => {
		expect(literalAssemblyIndex("100")).toBe(1);
	});

	// test-contract: boundary — mutant 67b72a4ff968eb2a — the digit-extraction replace's
	// deletion string '""' -> '"Stryker was here!"', which inserts literal
	// text at every stripped non-digit character instead of deleting it.
	it("deletes non-digit characters rather than inserting replacement text", () => {
		expect(literalAssemblyIndex("-1337")).toBe(7);
	});
});

describe("significance — mutant-killing cases", () => {
	// test-contract: boundary — mutant 1fd6849541e31c40 — 'copyNumber <= 1' -> 'false',
	// which removes the early return for copyNumber values BELOW 1 (where the
	// (copyNumber - 1) factor going negative is not itself a safe backstop —
	// unlike copyNumber === 1, it does not zero the product).
	it("stays zero (not negative) for a copy number below 1", () => {
		expect(significance(9, 0)).toBe(0);
	});

	// test-contract: boundary — mutant 03e44411a226c798 — 'copyNumber - 1' -> 'copyNumber
	// + 1' in the significance formula's multiplier.
	it("multiplies by (copyNumber - 1), not (copyNumber + 1)", () => {
		expect(significance(0, 3)).toBe(2);
	});
});
