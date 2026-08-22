// ===========================================
// test-structure — wave-35 survivor-kill suite
// ===========================================
// Targets manifest-listed survived mutants for test-structure.ts (pass1_w35).
// Every case below was validated against a standalone regex/logic replica of
// the mutated site before being written here (see receipts note) so each
// assertion is a real distinguishing observation, not a guess.

import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { stripAllLiterals } from "../strip-helpers.js";
import {
	blockStartingWithin,
	extractTestBlocks,
	innermostBlockAt,
	type TestBlock,
} from "./test-structure.js";

function blocksOf(src: string) {
	return extractTestBlocks(stripAllLiterals(src).split("\n"));
}

describe("extractTestBlocks — paren-imbalance fallback (mutant c4edb72b: Math.max→Math.min)", () => {
	// test-contract: invariant — pathological unbalanced-paren input must use
	// the brace-based fallback bound, not collapse to the start line.
	it("falls back to the LARGER of i and findBlockEnd when call parens never balance", () => {
		const src = ["it('a', () => {", "  foo(", "});"].join("\n");
		const blocks = extractTestBlocks(src.split("\n"));
		expect(blocks).toHaveLength(1);
		expect(nonNull(blocks[0]).endLine).toBe(2);
	});
});

describe("extractTestBlocks — parenLine newline counting (mutant 193135434e: slice(0,parenInWindow)→m[0])", () => {
	// test-contract: invariant — a callee split from its title paren across a
	// line boundary must still resolve to the correct call-extent start line.
	it("counts newlines only up to the title-paren, not the whole match", () => {
		const src = ["it(", "'a', () => {", "  expect(1).toBe(1);", "});"].join("\n");
		const blocks = extractTestBlocks(src.split("\n"));
		expect(blocks).toHaveLength(1);
		expect(nonNull(blocks[0]).endLine).toBe(3);
	});
});

describe("extractTestBlocks — suite/context keyword classification (mutants 945a4374/d10e571f/c993483/2ae9b1d)", () => {
	// test-contract: public-api — suite() must map to "suite", not "test".
	it("classifies a bare `suite(...)` callsite as kind 'suite'", () => {
		const blocks = blocksOf("suite('s', () => {});");
		expect(blocks).toHaveLength(1);
		expect(nonNull(blocks[0]).kind).toBe("suite");
	});

	// test-contract: public-api — context() must map to "suite", not "test".
	it("classifies a bare `context(...)` callsite as kind 'suite'", () => {
		const blocks = blocksOf("context('s', () => {});");
		expect(blocks).toHaveLength(1);
		expect(nonNull(blocks[0]).kind).toBe("suite");
	});
});

describe("gateConditionsOf via extractTestBlocks — trim + empty-condition filtering (mutants dc87d2ec/51729621/6a68f2eb)", () => {
	// test-contract: invariant — a padded condition must be recorded trimmed,
	// so callers can match it exactly against known condition text.
	it("trims whitespace around a captured condition", () => {
		const blocks = blocksOf("it.skipIf( hasDocker )('a', () => {});");
		expect(nonNull(blocks[0]).gateConditions).toEqual(["hasDocker"]);
	});

	// test-contract: invariant — an empty modifier argument is not evidence
	// and must never appear in gateConditions.
	it("drops an empty `.skipIf()` condition instead of recording a blank string", () => {
		const blocks = blocksOf("it.skipIf()('a', () => {});");
		expect(nonNull(blocks[0]).gateConditions).toEqual([]);
	});
});

describe("innermostBlockAt — tie-break and size comparison (mutants a1a752364f/21a7dd7/8cb48c90)", () => {
	// test-contract: invariant — a later-processed but LARGER overlapping
	// block must never displace an earlier, smaller (deeper) containing one.
	it("keeps the earlier, smaller block over a later, larger overlapping one", () => {
		const blocks: TestBlock[] = [
			{ kind: "test", startLine: 0, endLine: 2, unconditionalGate: false, gateConditions: [], parent: -1 },
			{ kind: "test", startLine: 0, endLine: 10, unconditionalGate: false, gateConditions: [], parent: -1 },
		];
		expect(innermostBlockAt(blocks, 1)).toBe(0);
	});

	// test-contract: invariant — per docstring, ties prefer the later (deeper)
	// block; a strict '<' in place of '<=' would keep the earlier one instead.
	it("prefers the later block on an exact size tie", () => {
		const blocks: TestBlock[] = [
			{ kind: "test", startLine: 0, endLine: 2, unconditionalGate: false, gateConditions: [], parent: -1 },
			{ kind: "test", startLine: 0, endLine: 2, unconditionalGate: false, gateConditions: [], parent: -1 },
		];
		expect(innermostBlockAt(blocks, 1)).toBe(1);
	});

	// test-contract: invariant — the incumbent best's size must be computed
	// as (endLine - startLine); an addition would inflate it and let a
	// larger later candidate wrongly win.
	it("computes the current-best size via subtraction, not addition", () => {
		const blocks: TestBlock[] = [
			{ kind: "test", startLine: 5, endLine: 5, unconditionalGate: false, gateConditions: [], parent: -1 },
			{ kind: "test", startLine: 3, endLine: 6, unconditionalGate: false, gateConditions: [], parent: -1 },
		];
		expect(innermostBlockAt(blocks, 5)).toBe(0);
	});
});

describe("blockStartingWithin — range boundary (mutants 367607e3/e005ad34)", () => {
	// test-contract: invariant — a start line past toLine must not match; an
	// always-true comparison would wrongly return that block's index.
	it("does not match a block starting after the range end", () => {
		const blocks: TestBlock[] = [
			{ kind: "test", startLine: 10, endLine: 10, unconditionalGate: false, gateConditions: [], parent: -1 },
		];
		expect(blockStartingWithin(blocks, 0, 5)).toBe(-1);
	});

	// test-contract: boundary — startLine === toLine must count as inside the
	// (inclusive) range; a strict '<' would reject this boundary case.
	it("matches a block starting exactly on the range's inclusive upper bound", () => {
		const blocks: TestBlock[] = [
			{ kind: "test", startLine: 5, endLine: 5, unconditionalGate: false, gateConditions: [], parent: -1 },
		];
		expect(blockStartingWithin(blocks, 0, 5)).toBe(0);
	});
});

describe("CALLEE_ON_LINE_RE gate — whitespace tolerance (mutant 31f732da: \\s*→\\S* before [.(])", () => {
	// test-contract: invariant — `it (` (space before paren) is legitimate
	// formatting and must still be recognized as a test callsite.
	it("still detects a callee separated from its opening paren by a space", () => {
		const blocks = blocksOf(["it ('a', () => {", "});"].join("\n"));
		expect(blocks).toHaveLength(1);
	});
});

describe("BLOCK_START_RE anchoring — no spurious match on a nested callsite (mutant 6900afad: removed ^ anchor)", () => {
	// test-contract: bug — without the `^` anchor, an unanchored regex can
	// find the INNER it() call inside the window and misattribute it to the
	// outer (variable-titled, should-be-skipped) describe's line, producing
	// an extra bogus block.
	it("does not extract a variable-titled describe by matching a nested it() instead", () => {
		const src = ["describe(suiteName, () => {", "  it('inner', () => {", "  });", "});"].join("\n");
		const blocks = extractTestBlocks(src.split("\n"));
		expect(blocks).toHaveLength(1);
		expect(nonNull(blocks[0]).startLine).toBe(1);
	});
});

describe("BLOCK_START_RE modifier-chain whitespace (mutants 50d8a93d, 8a61a1dc)", () => {
	// test-contract: invariant — '.  skipIf(...)' must still parse the chain
	// and extract its condition, not silently drop the whole callsite.
	it("tolerates a space between the dot and the modifier name", () => {
		const blocks = blocksOf(["it.  skipIf(hasDocker)('a', () => {", "});"].join("\n"));
		expect(blocks).toHaveLength(1);
		expect(nonNull(blocks[0]).gateConditions).toEqual(["hasDocker"]);
	});

	// test-contract: invariant — '.skipIf (...)' must still parse the chain
	// and extract its condition, not silently drop the whole callsite.
	it("tolerates a space between the modifier name and its argument list", () => {
		const blocks = blocksOf(["it.skipIf (hasDocker)('a', () => {", "});"].join("\n"));
		expect(blocks).toHaveLength(1);
		expect(nonNull(blocks[0]).gateConditions).toEqual(["hasDocker"]);
	});
});

describe("BLOCK_START_RE modifier-args nested-paren skipping (mutants 66217d27/f00823e9/06467a31/14b9933e/43ba81d6/c31b54b1)", () => {
	// test-contract: invariant — '.skipIf(hasFeature() && y)' must still be
	// recognized as a whole callsite (nested empty parens included).
	it("skips past a modifier arg containing an empty nested call", () => {
		const blocks = blocksOf(["it.skipIf(hasFeature() && y)('a', () => {", "});"].join("\n"));
		expect(blocks).toHaveLength(1);
		expect(nonNull(blocks[0]).gateConditions).toEqual(["hasFeature() && y"]);
	});

	// test-contract: invariant — '.skipIf(hasFeature(x) && y)' must still be
	// recognized as a whole callsite (one level of nesting, non-empty).
	it("skips past a modifier arg containing a single-char nested call", () => {
		const blocks = blocksOf(["it.skipIf(hasFeature(x) && y)('a', () => {", "});"].join("\n"));
		expect(blocks).toHaveLength(1);
		expect(nonNull(blocks[0]).gateConditions).toEqual(["hasFeature(x) && y"]);
	});

	// test-contract: invariant — spaces between the title paren and the quote
	// must not break detection.
	it("tolerates extra whitespace before the title's opening quote", () => {
		const blocks = blocksOf(["it.skipIf(cond)(  'a', () => {", "});"].join("\n"));
		expect(blocks).toHaveLength(1);
	});

	// test-contract: invariant — spaces between the end of the modifier chain
	// and the title's opening paren must not break detection.
	it("tolerates extra whitespace between the modifier chain and the title paren", () => {
		const blocks = blocksOf(["it.skipIf(cond)  ('a', () => {", "});"].join("\n"));
		expect(blocks).toHaveLength(1);
	});
});

describe("CONDITIONAL_GATE_RE whitespace + nested-paren handling (mutants 1ae55d9e/4668f147/16f1fd82/ebf0d74e/60f852c5/bcc7ca71)", () => {
	// test-contract: invariant — the condition-capturing regex must match
	// '.  skipIf(...)' the same way the block-start regex does.
	it("tolerates a space between the dot and 'skipIf' when capturing the condition", () => {
		const blocks = blocksOf(["it.  skipIf(hasDocker)('a', () => {", "});"].join("\n"));
		expect(nonNull(blocks[0]).gateConditions).toEqual(["hasDocker"]);
	});

	// test-contract: invariant — the condition-capturing regex must match
	// '.skipIf (...)' the same way the block-start regex does.
	it("tolerates a space between 'skipIf' and its argument list when capturing the condition", () => {
		const blocks = blocksOf(["it.skipIf (hasDocker)('a', () => {", "});"].join("\n"));
		expect(nonNull(blocks[0]).gateConditions).toEqual(["hasDocker"]);
	});

	// test-contract: invariant — nested empty parens inside the condition
	// text must be preserved verbatim in gateConditions.
	it("captures a condition containing an empty nested call", () => {
		const blocks = blocksOf(["it.skipIf(hasFeature() && y)('a', () => {", "});"].join("\n"));
		expect(nonNull(blocks[0]).gateConditions).toEqual(["hasFeature() && y"]);
	});

	// test-contract: invariant — nested non-empty parens inside the condition
	// text must be preserved verbatim in gateConditions.
	it("captures a condition containing a single-char nested call", () => {
		const blocks = blocksOf(["it.skipIf(hasFeature(x) && y)('a', () => {", "});"].join("\n"));
		expect(nonNull(blocks[0]).gateConditions).toEqual(["hasFeature(x) && y"]);
	});
});

describe("UNCONDITIONAL_GATE_RE whitespace tolerance (mutant 905bd3bd: \\s*→\\S*)", () => {
	// test-contract: invariant — whitespace-padded '.skip'/'.todo'/'.fails'
	// must still be recognized as an unconditional gate.
	it("recognizes '.  skip' with extra whitespace after the dot as an unconditional gate", () => {
		const blocks = blocksOf(["it.  skip('a', () => {", "});"].join("\n"));
		expect(nonNull(blocks[0]).unconditionalGate).toBe(true);
	});
});
