import { describe, expect, it } from "vitest";
import {
	extractAnchorLinks,
	extractHeadings,
	extractSectionRefs,
} from "./extract-refs.js";
import {
	backtickRuns,
	htmlCommentBlockLines,
	maskCodeSpans,
	maskInlineComments,
	maskInlineIgnorable,
	withCommentBlockLines,
} from "./extract-refs-masking.js";

const lines = (text: string): string[] => text.split("\n");
const noFences = new Set<number>();

describe("maskCodeSpans — CommonMark equal-run pairing (round-5 #18)", () => {
	it("does NOT pair unequal backtick runs, so the content stays live", () => {
		expect(maskCodeSpans("See `§9``")).toBe("See `§9``");
		expect(extractSectionRefs(["See `§9``"], noFences).map((r) => r.ref)).toEqual(["9"]);
	});

	it("pairs equal runs and masks content column-preservingly", () => {
		expect(maskCodeSpans("a `x` b")).toBe("a     b");
		expect(maskCodeSpans("``x``")).toBe("     ");
		const masked = maskCodeSpans("keep `gone` keep");
		expect(masked.length).toBe("keep `gone` keep".length);
		expect(masked).toBe("keep        keep");
	});

	it("treats unequal runs INSIDE a span as content (`` `foo` ``)", () => {
		expect(maskCodeSpans("`` `foo` ``")).toBe("           ");
	});

	it("pairs the first two equal runs and leaves the trailing lone opener literal", () => {
		expect(maskCodeSpans("` start `a` end")).toBe("         a` end");
		expect(backtickRuns("``a`b``").map(([, l]) => l)).toEqual([2, 1, 2]);
		expect(maskCodeSpans("``a`b``")).toBe("       ");
	});

	it("stays linear on 640k-char alternating backtick lines (verify redos case)", () => {
		// The rejected per-iteration-indexOf design measured 1726ms here; the
		// run-scanner is single-pass. Direct call keeps this cheap enough not to
		// starve parallel vitest workers running the other perf pins.
		const start = Date.now();
		maskCodeSpans("`a".repeat(320_000));
		expect(Date.now() - start).toBeLessThan(500);
		const smoke = Date.now();
		extractSectionRefs(["`a".repeat(60_000)], noFences);
		expect(Date.now() - smoke).toBeLessThan(500);
	});
});

describe("inline comment masking (round-5 #20)", () => {
	it("masks fully-contained comments, preserving columns", () => {
		expect(maskInlineComments("a <!-- x --> b")).toBe("a            b");
		expect(maskInlineComments("<!--a--><!--b-->c")).toBe("                c");
		expect(maskInlineComments("no comment")).toBe("no comment");
	});

	it("leaves an unclosed comment open-tail untouched (block layer's job)", () => {
		expect(maskInlineComments("text <!-- open")).toBe("text <!-- open");
	});

	it("suppresses refs/links inside a same-line comment but keeps neighbors live", () => {
		expect(extractSectionRefs(["See §4 <!-- note -->"], noFences).map((r) => r.ref)).toEqual(["4"]);
		expect(extractAnchorLinks(["<!-- [x](missing.md) -->"], noFences)).toEqual([]);
		expect(extractSectionRefs(["<!-- §9 --> and §3"], noFences).map((r) => r.ref)).toEqual(["3"]);
	});

	it("masks code spans before comments (a comment inside a span is span content)", () => {
		expect(maskInlineIgnorable("`<!-- x -->` §5 stays")).toContain("§5");
		expect(extractSectionRefs(["`<!-- a --> §9` gone, §5 stays"], noFences).map((r) => r.ref)).toEqual(["5"]);
	});
});

describe("whole-line HTML comment blocks (round-5 #20)", () => {
	it("hides multiline comment-block lines from headings, refs, and links", () => {
		expect(extractHeadings(lines("<!--\n# Fake\n-->"), noFences)).toEqual([]);
		expect(extractSectionRefs(lines("<!--\n§9\n-->"), noFences)).toEqual([]);
		expect(extractAnchorLinks(lines("<!--\n[x](missing.md)\n-->"), noFences)).toEqual([]);
	});

	it("computes the hidden set with 1-based lines and fence awareness", () => {
		expect([...htmlCommentBlockLines(lines("<!--\nhidden\n-->\nlive"), noFences)]).toEqual([1, 2, 3]);
		// A "<!--" INSIDE a fence is literal text, not a comment opener.
		expect(htmlCommentBlockLines(lines("<!--\nx"), new Set([1])).size).toBe(0);
		const merged = withCommentBlockLines(lines("<!--\n-->"), new Set([9]));
		expect([...merged].sort((a, b) => a - b)).toEqual([1, 2, 9]);
	});

	it("does NOT fabricate a Setext heading from a masked trailing comment (verify breakage)", () => {
		expect(extractHeadings(lines("Para\n--- <!-- c -->"), noFences)).toEqual([]);
		expect(extractSectionRefs(lines("Para §3\n--- <!-- c -->"), noFences).map((r) => r.ref)).toEqual(["3"]);
		expect(extractHeadings(lines("Title\n===== <!-- note -->"), noFences)).toEqual([]);
	});

	it("does not poison a real heading's slug via a phantom twin (verify breakage)", () => {
		const hs = extractHeadings(lines("Setup\n--- <!--c-->\n## Setup"), noFences);
		expect(hs.map((h) => h.slug)).toEqual(["setup"]);
	});

	it("keeps current behavior for a comment OPENING mid-line and closing later (residual)", () => {
		const hs = extractHeadings(lines("Title <!-- x\n-->\n==="), noFences);
		expect(hs).toHaveLength(1);
		expect(hs[0]?.level).toBe(1);
	});
});
