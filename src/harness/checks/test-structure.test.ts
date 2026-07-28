// ===========================================
// test-structure — masked test-block extraction
// ===========================================
// Pins the association scaffolding the test-portability detectors rely on:
// call extents from paren balancing (expression-bodied callbacks end at their
// own call, never at a later test's brace), gate info scoped to the modifier
// chain, parent containment, and the test-span query that keeps helper code
// from being treated as a test body.

import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import { stripAllLiterals } from "../strip-helpers.js";
import {
	blockStartingWithin,
	extractTestBlocks,
	gatedByChain,
	innermostBlockAt,
	inTestBlock,
} from "./test-structure.js";

function blocksOf(src: string) {
	return extractTestBlocks(stripAllLiterals(src).split("\n"));
}

describe("extractTestBlocks", () => {
	it("extracts a simple test with its span", () => {
		const src = ["it('adds', () => {", "  expect(add(1, 2)).toBe(3);", "});"].join("\n");
		const blocks = blocksOf(src);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({
			kind: "test",
			startLine: 0,
			endLine: 2,
			unconditionalGate: false,
			gateConditions: [],
			parent: -1,
		});
	});

	it("nests tests under their describe with parent links", () => {
		const src = [
			"describe('suite', () => {",
			"  it('a', () => {",
			"    expect(1).toBe(1);",
			"  });",
			"  it('b', () => {",
			"    expect(2).toBe(2);",
			"  });",
			"});",
		].join("\n");
		const blocks = blocksOf(src);
		expect(blocks.map((b) => b.kind)).toEqual(["suite", "test", "test"]);
		expect(nonNull(blocks[1]).parent).toBe(0);
		expect(nonNull(blocks[2]).parent).toBe(0);
		expect(nonNull(blocks[0]).endLine).toBe(7);
	});

	it("captures conditional gate arguments and unconditional markers", () => {
		const src = [
			"it.skipIf(!onMac)('a', () => {});",
			"it.runIf(hasDocker)('b', () => {});",
			"it.skip('c', () => {});",
			"it('d', () => {});",
		].join("\n");
		const blocks = blocksOf(src);
		expect(nonNull(blocks[0]).gateConditions).toEqual(["!onMac"]);
		expect(nonNull(blocks[1]).gateConditions).toEqual(["hasDocker"]);
		expect(nonNull(blocks[2]).unconditionalGate).toBe(true);
		expect(nonNull(blocks[3]).unconditionalGate).toBe(false);
		expect(nonNull(blocks[3]).gateConditions).toEqual([]);
	});

	it("matches a multi-line .skipIf chain within the start window", () => {
		const src = [
			"it.skipIf(",
			"  !onLinux",
			")('binds', () => {",
			"  expect(bind()).toBe(0);",
			"});",
		].join("\n");
		const blocks = blocksOf(src);
		expect(blocks).toHaveLength(1);
		expect(nonNull(blocks[0]).gateConditions).toHaveLength(1);
		expect(nonNull(blocks[0]).gateConditions[0]).toContain("!onLinux");
		expect(nonNull(blocks[0]).endLine).toBe(4);
	});

	it("matches a header whose title lands on the fourth line (round 5)", () => {
		const src = [
			"it.skipIf(",
			"  process.platform !== 'linux' ||",
			"  !dockerAvailable",
			")('binds', () => {",
			"  expect(bind()).toBe(0);",
			"});",
		].join("\n");
		const blocks = blocksOf(src);
		expect(blocks).toHaveLength(1);
		expect(nonNull(blocks[0]).endLine).toBe(5);
		expect(nonNull(blocks[0]).gateConditions[0]).toContain("dockerAvailable");
	});

	it("ends expression-bodied callbacks at their own call, not a later brace", () => {
		const src = [
			"it.skipIf(!onMac)('quick', () => expect(probe()).toBe(1));",
			"it('second', () => {",
			"  expect(2).toBe(2);",
			"});",
		].join("\n");
		const blocks = blocksOf(src);
		expect(blocks).toHaveLength(2);
		expect(nonNull(blocks[0]).endLine).toBe(0);
		expect(nonNull(blocks[1]).parent).toBe(-1);
		// The sibling must not inherit the expression-bodied test's gate.
		expect(gatedByChain(blocks, 1)).toBe(false);
	});

	it("spans a multi-line expression-bodied callback to its closing paren", () => {
		const src = [
			"it('a', () =>",
			"  expect(longCall()).resolves.toBe(1));",
			"it('b', () => { expect(1).toBe(1); });",
		].join("\n");
		const blocks = blocksOf(src);
		expect(nonNull(blocks[0]).endLine).toBe(1);
		expect(nonNull(blocks[1]).startLine).toBe(2);
		expect(nonNull(blocks[1]).parent).toBe(-1);
	});

	it("keeps a body-less it.todo from swallowing the next test", () => {
		const src = [
			"it.todo('handle the quirk');",
			"it('runs today', () => {",
			"  expect(run()).toBe(true);",
			"});",
		].join("\n");
		const blocks = blocksOf(src);
		expect(blocks).toHaveLength(2);
		expect(nonNull(blocks[0]).endLine).toBe(0);
		expect(nonNull(blocks[0]).unconditionalGate).toBe(true);
		const inner = innermostBlockAt(blocks, 2);
		expect(inner).toBe(1);
		expect(gatedByChain(blocks, inner)).toBe(false); // .todo's gate must not leak
	});

	it("does not extract variable-titled calls (callers fall back to file scope)", () => {
		const src = ["describe(suiteName, () => {", "  it(caseName, () => {});", "});"].join("\n");
		expect(blocksOf(src)).toEqual([]);
	});

	it("ignores callsites inside template and string fixtures (mask contract)", () => {
		const src = [
			"const fixture = `",
			"it('fake', () => {});",
			"`;",
			'const other = "it(\'also fake\', () => {});";',
		].join("\n");
		expect(blocksOf(src)).toEqual([]);
	});

	it("does not double-detect a start through a preceding blank line", () => {
		const src = ["", "it('a', () => {", "  expect(1).toBe(1);", "});"].join("\n");
		const blocks = blocksOf(src);
		expect(blocks).toHaveLength(1);
		expect(nonNull(blocks[0]).startLine).toBe(1);
	});
});

describe("containment and gating queries", () => {
	const src = [
		"describe.skipIf(IS_CI)('gated suite', () => {",
		"  it('child', () => {",
		"    expect(1).toBe(1);",
		"  });",
		"});",
		"it('outside', () => {",
		"  expect(2).toBe(2);",
		"});",
	].join("\n");
	const blocks = blocksOf(src);

	it("innermostBlockAt prefers the deepest containing block", () => {
		expect(nonNull(blocks[innermostBlockAt(blocks, 2)]).kind).toBe("test");
		expect(nonNull(blocks[innermostBlockAt(blocks, 0)]).kind).toBe("suite");
		expect(innermostBlockAt(blocks, 99)).toBe(-1);
	});

	it("gatedByChain inherits a describe.skipIf, but not across siblings", () => {
		expect(gatedByChain(blocks, innermostBlockAt(blocks, 2))).toBe(true);
		expect(gatedByChain(blocks, innermostBlockAt(blocks, 6))).toBe(false);
	});

	it("gatedByChain consults the condition predicate for conditional gates", () => {
		const child = innermostBlockAt(blocks, 2);
		expect(gatedByChain(blocks, child)).toBe(true); // default: any condition gates
		expect(gatedByChain(blocks, child, (c) => c.includes("platform"))).toBe(false);
	});

	it("blockStartingWithin finds the comment-above-test target", () => {
		expect(blockStartingWithin(blocks, 5, 7)).toBe(2);
		expect(blockStartingWithin(blocks, 99, 120)).toBe(-1);
	});
});

describe("inTestBlock", () => {
	const src = [
		"function maybeStartDocker() {",
		"  return null;",
		"}",
		"describe('s', () => {",
		"  const setup = prepare();",
		"  it('t', () => {",
		"    expect(setup).toBeDefined();",
		"  });",
		"});",
	].join("\n");
	const blocks = blocksOf(src);

	it("is true inside it-callbacks, false in helpers and describe-level code", () => {
		expect(inTestBlock(blocks, 1)).toBe(false); // helper body
		expect(inTestBlock(blocks, 4)).toBe(false); // describe-level setup
		expect(inTestBlock(blocks, 6)).toBe(true); // inside it
	});
});
