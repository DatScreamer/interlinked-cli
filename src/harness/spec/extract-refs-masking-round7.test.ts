import { describe, expect, it } from "vitest";
import { extractSpecFacts } from "./extract-facts.js";
import {
	htmlCommentBlockLines,
	maskCommentsKeepCode,
	maskInlineIgnorable,
	sameLineCommentBlockLines,
} from "./extract-refs-masking.js";
import { extractAnchorLinks, extractSectionRefs } from "./extract-refs.js";

const lines = (text: string): string[] => text.split("\n");
const noFences = new Set<number>();

describe("comment/code precedence — earlier construct wins (round-7 #24)", () => {
	it("keeps a ref live when the comment opens before the span opener", () => {
		// The backtick inside the comment is comment CONTENT; the trailing lone
		// backtick pairs with nothing, so §9 is rendered text.
		expect(extractSectionRefs(["Text <!-- ` --> §9 `"], noFences).map((r) => r.ref)).toEqual(["9"]);
	});

	it("literalizes a backtick inside a winning comment, column-preservingly", () => {
		const masked = maskInlineIgnorable("a <!-- ` --> b ` c");
		expect(masked).toBe("a            b ` c");
		expect(masked.length).toBe("a <!-- ` --> b ` c".length);
	});

	it("keeps a link live that the old code-first order swallowed", () => {
		const links = extractAnchorLinks(["x <!-- ` --> [a](missing.md) `"], noFences);
		expect(links.map((l) => l.targetFile)).toEqual(["missing.md"]);
	});

	it("still lets a span that STARTS first swallow a comment opener (parity)", () => {
		expect(maskInlineIgnorable("`<!-- x -->` §5 stays")).toContain("§5");
		expect(
			extractSectionRefs(["`x <!-- y` --> §9"], noFences).map((r) => r.ref),
		).toEqual(["9"]); // span 0..9 masks; stray --> and §9 are literal text
	});

	it("masks both constructs when disjoint, in either order (parity)", () => {
		expect(extractSectionRefs(["``a`b`` <!-- §9 -->"], noFences)).toEqual([]);
		expect(extractSectionRefs(["<!-- §9 --> `§8` §3"], noFences).map((r) => r.ref)).toEqual(["3"]);
	});

	it("leaves an unclosed mid-line comment literal while spans still mask (parity)", () => {
		expect(
			extractSectionRefs(["see `§9` <!-- open §4"], noFences).map((r) => r.ref),
		).toEqual(["4"]);
	});
});

describe("census mask — comments blank, code spans stay visible (round-7 #10)", () => {
	it("blanks a comment but keeps code-span content visible", () => {
		expect(maskCommentsKeepCode("`B1` <!-- B2 --> B3")).toBe("`B1`             B3");
	});

	it("keeps a span-protected comment literal (span starts first)", () => {
		expect(maskCommentsKeepCode("`<!-- B1 -->` end")).toBe("`<!-- B1 -->` end");
	});

	it("returns comment-free lines untouched", () => {
		expect(maskCommentsKeepCode("plain `code` text")).toBe("plain `code` text");
	});

	it("suppresses a same-line-comment count claim and id census at the seam", () => {
		const facts = extractSpecFacts("<!-- Six bets B1 B2 B3 -->", "a.md");
		expect(facts.countClaims).toEqual([]);
		expect(facts.namespaces).toEqual([]);
	});

	it("suppresses facts inside a multiline comment block at the seam", () => {
		const facts = extractSpecFacts("<!--\nSix bets\nB1 B2 B3\n-->", "a.md");
		expect(facts.countClaims).toEqual([]);
		expect(facts.namespaces).toEqual([]);
	});

	it("suppresses commented range claims and loose defined ids at the seam", () => {
		const facts = extractSpecFacts(
			"<!-- FG-INV-01 through FG-INV-20 -->\n| FG-INV-01 | a |\n| FG-INV-02 | b |\n<!-- - B7 -->",
			"a.md",
		);
		expect(facts.rangeClaims).toEqual([]);
		expect(facts.namespaces[0]?.max).toBe(2);
		expect(facts.looseDefinedIds).toEqual([]);
	});

	it("keeps live counts/ids next to a trailing comment (negative)", () => {
		const facts = extractSpecFacts("Six bets: B1 B2 B7. <!-- note -->", "a.md");
		expect(facts.countClaims[0]?.value).toBe(6);
		expect(facts.namespaces.map((n) => n.prefix)).toEqual(["B"]);
	});

	it("still censuses backticked ids — code renders as text (negative)", () => {
		const facts = extractSpecFacts("`B1` `B2` `B7` registered", "a.md");
		expect(facts.namespaces[0]?.uniqueCount).toBe(3);
	});

	it("keeps fenced registry ids counted and fact markers extracted (negative)", () => {
		const facts = extractSpecFacts(
			"cap <!-- fact:line_cap -->500<!-- /fact:line_cap -->\n```\nQ-1 x\nQ-2 y\n```",
			"a.md",
		);
		expect(facts.declaredFacts[0]?.value).toBe("500");
		expect(facts.namespaces.map((n) => n.prefix)).toEqual(["Q"]);
	});
});

describe("blockquote-container comment blocks (round-7 #25)", () => {
	it("hides refs and links inside a blockquoted comment block", () => {
		const doc = lines("> <!--\n> hidden §9 [x](missing.md)\n> -->");
		expect(extractSectionRefs(doc, noFences)).toEqual([]);
		expect(extractAnchorLinks(doc, noFences)).toEqual([]);
	});

	it("computes the hidden set through the container close line", () => {
		expect([...htmlCommentBlockLines(lines("> <!--\n> quoted\n> -->\n> live"), noFences)]).toEqual([
			1, 2, 3,
		]);
	});

	it("supports nested markers and marker-only close lines", () => {
		expect([...htmlCommentBlockLines(lines(">> <!--\n>> §9\n>> -->"), noFences)]).toEqual([1, 2, 3]);
		expect([...htmlCommentBlockLines(lines("> <!--\n>\n> -->"), noFences)]).toEqual([1, 2, 3]);
	});

	it("ends the block when a line drops the container prefix (negative)", () => {
		// Blockquote truncation: the unmarked line is a NEW paragraph — live.
		const refs = extractSectionRefs(lines("> <!--\nplain §3\n> -->"), noFences);
		expect(refs.map((r) => r.ref)).toEqual(["3"]);
	});

	it("does not hide a blockquoted same-line-close comment line (negative)", () => {
		expect(htmlCommentBlockLines(lines("> <!-- x -->\n> §3"), noFences).size).toBe(0);
		expect(extractSectionRefs(lines("> <!-- x -->\n> §3"), noFences).map((r) => r.ref)).toEqual([
			"3",
		]);
	});

	it("ignores fenced openers and keeps list-item containers residual (negative)", () => {
		expect(htmlCommentBlockLines(lines("> <!--\n> x"), new Set([1])).size).toBe(0);
		// "- <!--" is a LIST container — declared residual, stays live.
		expect(
			extractSectionRefs(lines("- <!--\n§9 here\n-->"), noFences).map((r) => r.ref),
		).toEqual(["9"]);
	});
});

describe("one-line type-2 HTML blocks suppress links, keep refs (round-7 #26)", () => {
	it("does not extract a link from the literal tail of a same-line-close block", () => {
		expect(extractAnchorLinks(["<!-- x --> [x](missing.md)"], noFences)).toEqual([]);
	});

	it("suppresses the tail link inside a blockquote container too", () => {
		expect(extractAnchorLinks(["> <!-- x --> [x](missing.md)"], noFences)).toEqual([]);
	});

	it("suppresses at up to 3 spaces of opener indent", () => {
		expect(extractAnchorLinks(["   <!-- note --> see [y](#gone)"], noFences)).toEqual([]);
	});

	it("computes the links-only set without touching multiline blocks", () => {
		expect([...sameLineCommentBlockLines(lines("<!-- a --> tail\n<!--\nx\n-->"), noFences)]).toEqual(
			[1],
		);
	});

	it("keeps refs on the visible tail live (negative for refs)", () => {
		expect(extractSectionRefs(["<!-- §9 --> and §3"], noFences).map((r) => r.ref)).toEqual(["3"]);
	});

	it("keeps a link after a MID-line comment live (negative)", () => {
		expect(
			extractAnchorLinks(["text <!-- x --> [a](#real)"], noFences).map((l) => l.anchor),
		).toEqual(["real"]);
	});

	it("keeps provenance links with embedded comments live (negative, round-6 #23)", () => {
		const links = extractAnchorLinks(["[a<!--c-->b](missing.md)"], noFences);
		expect(links[0]?.raw).toBe("[a<!--c-->b](missing.md)");
	});

	it("does not treat a 4-space-indented opener as a block (negative)", () => {
		expect(
			extractAnchorLinks(["    <!-- x --> [a](z.md)"], noFences).map((l) => l.targetFile),
		).toEqual(["z.md"]);
	});
});
