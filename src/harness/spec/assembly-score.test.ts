import { describe, expect, it } from "vitest";
import {
	assemblyIndexOfText,
	assemblyIndexOfTokens,
	isTriviallyAssembled,
	literalAssemblyIndex,
	significance,
} from "./assembly-score.js";

describe("assemblyIndexOfTokens (Re-Pair approximation)", () => {
	it("charges reuse once: repetitive sequences compress far below length", () => {
		const repetitive = "a b a b a b a b a b a b a b a b".split(" ");
		const varied = "a b c d e f g h i j k l m n o p".split(" ");
		expect(assemblyIndexOfTokens(repetitive)).toBeLessThan(
			assemblyIndexOfTokens(varied),
		);
		expect(assemblyIndexOfTokens(varied)).toBe(16); // nothing to reuse
	});

	it("finds nested reuse (blocks built of blocks)", () => {
		// ABAB CDCD ABAB CDCD — hierarchy compresses better than flat count.
		const nested = "a b a b c d c d a b a b c d c d".split(" ");
		expect(assemblyIndexOfTokens(nested)).toBeLessThanOrEqual(8);
	});

	it("handles empty and singleton inputs", () => {
		expect(assemblyIndexOfTokens([])).toBe(0);
		expect(assemblyIndexOfTokens(["x"])).toBe(1);
	});

	it("does not collide when a token equals a pair delimiter (round-9 sol #1)", () => {
		// A repeated (NUL, x) pair must compress to exactly one rule. Under the
		// old delimiter-serialized pair key, the NUL token corrupted the decode
		// (split → empty tokens), so no replacement ever fired and the loop span
		// to the round cap. Correct result: 1 rule + final length 2 = 3.
		const NUL = "\u0000";
		expect(assemblyIndexOfTokens([NUL, "x", NUL, "x"])).toBe(3);
		// A space token (the earlier delimiter) must likewise not collide.
		expect(assemblyIndexOfTokens([" ", "y", " ", "y"])).toBe(3);
	});

	it("keeps nonterminals distinct from rule-id-shaped input tokens (round-9 sol #1)", () => {
		// Round 0's nonterminal used to be the string "0"; a real "0"/"1" token
		// could then be conflated with it. Object nonterminals compare by
		// identity, so a digit-token sequence compresses without confusion.
		expect(assemblyIndexOfTokens(["0", "1", "0", "1"])).toBe(3);
	});

	it("stays bounded on pathological inputs (round cap)", () => {
		const big = Array.from({ length: 5000 }, (_, i) => `${i % 7}`);
		const start = Date.now();
		const a = assemblyIndexOfTokens(big);
		expect(a).toBeGreaterThan(0);
		expect(Date.now() - start).toBeLessThan(3000);
	});
});

describe("isTriviallyAssembled — retires the hand-tuned exclusion lists", () => {
	it("marks every legacy exclusion-list value trivial", () => {
		// The policy-constant-drift list: {0,1,-1,2,100,1000,24,60,1024}.
		for (const v of ["0", "1", "-1", "2", "100", "1000", "24", "60", "1024"]) {
			expect(isTriviallyAssembled(v), v).toBe(true);
		}
	});

	it("generalizes beyond the list (round shapes nobody enumerated)", () => {
		for (const v of ["10000", "512", "4096", "500", "8000000"]) {
			expect(isTriviallyAssembled(v), v).toBe(true);
		}
	});

	it("keeps genuinely specific constants significant", () => {
		for (const v of ["86400", "65537", "31536000", "299792458", "1337"]) {
			expect(isTriviallyAssembled(v), v).toBe(false);
			expect(literalAssemblyIndex(v)).toBeGreaterThan(3);
		}
	});

	it("rejects non-decimal / empty forms outside the normalization contract (round-12 sol #4)", () => {
		// Number() accepts these, but literalAssemblyIndex extracts only decimal
		// digits — so they are NOT trivial (they must be scored, not suppressed).
		for (const v of ["", "0x10", "1e3", "0b101", "  ", "Infinity"]) {
			expect(isTriviallyAssembled(v), v).toBe(false);
		}
		// Decimal forms with grouping still classify normally.
		expect(isTriviallyAssembled("1_000")).toBe(true);
		expect(isTriviallyAssembled("1,000")).toBe(true);
	});

	it("rejects malformed separator placement (round-13 sol #3)", () => {
		for (const v of ["1__000", "1,,000", "_1000", "1000_", "1_.5", ",100"]) {
			expect(isTriviallyAssembled(v), v).toBe(false);
		}
	});

	it("does not misclassify unsafe-integer literals via lossy coercion (round-13 sol #4)", () => {
		// 2^53 + 1 coerces to 2^53 (a power of two) — must NOT be called trivial.
		expect(isTriviallyAssembled("9007199254740993")).toBe(false);
		// A genuinely round value within safe range still classifies.
		expect(isTriviallyAssembled("1000000")).toBe(true);
	});

	it("rejects malformed grouping and mixed separators (round-14 sol #2)", () => {
		for (const v of ["1,00,0", "10_00", "1,2_3", "1.0_0", "1_00", "1,0000"]) {
			expect(isTriviallyAssembled(v), v).toBe(false);
		}
		// Well-formed 3-digit grouping still classifies.
		expect(isTriviallyAssembled("1,000,000")).toBe(true);
		expect(isTriviallyAssembled("1_000_000")).toBe(true);
	});

	it("rejects fractional literals whose integer precision is unsafe (round-14 sol #3)", () => {
		// Rounds to 2^53 before any test could see the digit structure.
		expect(isTriviallyAssembled("9007199254740991.5")).toBe(false);
		// A short fractional round value is still fine.
		expect(isTriviallyAssembled("100.0")).toBe(true);
	});

	it("counts fractional digits toward the precision budget (round-15 sol #2)", () => {
		// 15 safe integer digits + a fractional digit = 16 significant digits;
		// the double rounds to 10^15 and would falsely read as a power of ten.
		expect(isTriviallyAssembled("999999999999999.9")).toBe(false);
		// 15 total significant digits is still exactly representable.
		expect(isTriviallyAssembled("100000000000000")).toBe(true);
	});

	it("ignores padding zeros when counting significant digits (round-16 sol #1)", () => {
		// Fractional padding zeros are representation-only: 0.1 with 16 padded
		// zeros is still a trivial 10^-1, not a 16-digit unsafe literal.
		expect(isTriviallyAssembled("0.1000000000000000")).toBe(true);
		// Trailing integer zeros likewise: 10^15 is a trivial power of ten.
		expect(isTriviallyAssembled("1000000000000000")).toBe(true);
		// But genuine 16-significant-digit precision is still rejected.
		expect(isTriviallyAssembled("999999999999999.9")).toBe(false);
		// A nonzero fractional digit is NOT a padding zero: the trailing-zero
		// strip leaves it in place, so the 17-digit value is correctly rejected
		// (guards the round-17 false-positive: this returns false, not true).
		expect(isTriviallyAssembled("1000000000000000.1")).toBe(false);
	});
});

describe("significance", () => {
	it("is zero for single copies regardless of complexity", () => {
		expect(significance(50, 1)).toBe(0);
	});

	it("ranks complex-recurring far above trivial-recurring", () => {
		const trivialRecurring = significance(1, 10);
		const complexRecurring = significance(9, 3);
		expect(complexRecurring).toBeGreaterThan(trivialRecurring * 10);
	});

	it("caps the exponent so scores stay finite and orderable", () => {
		expect(Number.isFinite(significance(10_000, 2))).toBe(true);
		expect(significance(10_000, 2)).toBe(significance(12, 2));
	});

	it("stays nonnegative and finite for malformed inputs (round-10 sol)", () => {
		// A negative/NaN assembly index is clamped to 0 (score = n − 1), never
		// NaN or a spuriously-ordered value; a non-finite copy number is "no
		// recurrence" (0). Ordering comparisons must never see a NaN.
		expect(significance(-1, 2)).toBe(significance(0, 2));
		expect(significance(Number.NaN, 2)).toBe(significance(0, 2));
		expect(significance(Number.NEGATIVE_INFINITY, 5)).toBe(significance(0, 5));
		expect(significance(9, Number.NaN)).toBe(0);
		expect(significance(9, Number.POSITIVE_INFINITY)).toBe(0);
		expect(Number.isNaN(significance(Number.NaN, Number.NaN))).toBe(false);
		// A huge FINITE copy number overflows the product to Infinity unless the
		// result itself is clamped (round-11 sol) — must stay finite.
		expect(Number.isFinite(significance(12, Number.MAX_VALUE))).toBe(true);
		expect(significance(12, Number.MAX_VALUE)).toBe(Number.MAX_VALUE);
	});

	it("text blocks: a repeated contract block outranks boilerplate", () => {
		const contract = assemblyIndexOfText(
			"the coordinator MUST persist availability receipts before proposing the marker through raft",
		);
		const boilerplate = assemblyIndexOfText("see also the notes above");
		expect(significance(contract, 3)).toBeGreaterThan(significance(boilerplate, 3));
	});
});
