import { describe, expect, it } from "vitest";
import { extractHeadings } from "./extract-refs.js";

const lines = (text: string): string[] => text.split("\n");
const noFences = new Set<number>();
const th = (text: string) =>
	extractHeadings(lines(text), noFences).map((h) => [h.text, h.level]);

describe("Setext block-construct openers (round-7 #18)", () => {
	// A run-START link-reference definition or HTML-block opener is not a
	// setext-able paragraph — no heading.
	it("does not read a run-start link-reference definition as setext text", () => {
		expect(extractHeadings(lines("[foo]: /url\n---"), noFences)).toEqual([]);
		expect(extractHeadings(lines("[a]: b.md\n==="), noFences)).toEqual([]);
		expect(extractHeadings(lines("   [x]: y\n---"), noFences)).toEqual([]);
	});

	it("does not read a run-start HTML-block opener as setext text", () => {
		expect(extractHeadings(lines("<div>\n---"), noFences)).toEqual([]);
		expect(extractHeadings(lines("</section>\n==="), noFences)).toEqual([]);
		expect(extractHeadings(lines("<x-custom a>\n---"), noFences)).toEqual([]);
	});

	it("does not spawn a phantom heading from a multi-line HTML block", () => {
		// <div> is a run-start opener; bar stays a run CONTINUATION (eligibility
		// unchanged), so neither line becomes a heading.
		expect(extractHeadings(lines("<div>\nbar\n---"), noFences)).toEqual([]);
	});

	// The block-opener check is run-start ONLY — an INTERIOR LRD/HTML line must
	// still FOLD into the paragraph (not truncate — round-5 #15 must not return).
	it("folds an interior link-reference definition into the paragraph", () => {
		expect(th("A\n[foo]: /url\nB\n---")).toEqual([["A [foo]: /url B", 2]]);
	});

	it("folds an interior HTML line into the paragraph", () => {
		expect(th("A\n<br>\nB\n---")).toEqual([["A <br> B", 2]]);
	});

	// Not actually block openers — these stay ordinary paragraphs → h2.
	it("keeps a bracket line that is not a valid LRD as a paragraph", () => {
		expect(th("[a[b]: x\n---")).toEqual([["[a[b]: x", 2]]);
	});

	it("keeps non-tag angle text as a paragraph", () => {
		expect(th("<!>\n---")).toEqual([["<!>", 2]]);
		expect(th("</ x>\n---")).toEqual([["</ x>", 2]]);
		expect(th("a < b\n---")).toEqual([["a < b", 2]]);
	});

	it("keeps a destination-less [foo]: as a paragraph, not an LRD veto (#13)", () => {
		expect(th("[foo]:\n---")).toEqual([["[foo]:", 2]]);
		// a complete LRD is still vetoed
		expect(extractHeadings(lines("[foo]: /url\n---"), noFences)).toEqual([]);
	});

	it("keeps an inline tag with trailing text as a paragraph (#14)", () => {
		expect(th("<em>text\n---")).toEqual([["<em>text", 2]]);
		expect(th("<strong>x</strong> y\n---")).toEqual([["<strong>x</strong> y", 2]]);
		// a real block tag / standalone tag is still vetoed
		expect(extractHeadings(lines("<div>\n---"), noFences)).toEqual([]);
		expect(extractHeadings(lines("<x-custom a>\n---"), noFences)).toEqual([]);
	});

	it("stays linear on a near-cap bracket flood (ReDoS budget)", () => {
		const evil = Array(10_000).fill(`[${"a".repeat(997)}]x`);
		const start = Date.now();
		extractHeadings([...evil, "==="], noFences);
		expect(Date.now() - start).toBeLessThan(500);
	});
});

describe("Setext lone-dash underline (round-7 #17 — finding rejected)", () => {
	// The reviewer claimed a lone "-" is an empty list item, not a setext
	// underline. That is WRONG: an empty list item cannot interrupt a paragraph
	// (CommonMark §5.3), and a single "-" is too short for a thematic break, so
	// it IS a valid setext-2 underline. Current behavior is spec-correct.
	it("reads a single dash under a paragraph as an h2 underline", () => {
		expect(th("Foo\n-")).toEqual([["Foo", 2]]);
	});

	it("reads a single equals under a paragraph as an h1 underline", () => {
		expect(th("Title\n=")).toEqual([["Title", 1]]);
	});

	it("does not treat a lone dash after a blank line as a heading", () => {
		// No open paragraph to underline → the dash is its own (list) line.
		expect(extractHeadings(lines("Foo\n\n-"), noFences)).toEqual([]);
	});
});
