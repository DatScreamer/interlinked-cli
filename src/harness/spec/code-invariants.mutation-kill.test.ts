// Mutation-kill companion for code-invariants.ts (fleet-r3 pass1_w22).
// Every case below targets a specific surviving mutant from
// .interlinked/mutation-manifest.json; see scratch/fleet-r3/receipts/
// src_harness_spec_code-invariants.ts.jsonl for the full disposition,
// including the mutants judged suspected_equivalent (not reproduced here
// since no observable test can distinguish them).
import { describe, expect, it } from "vitest";
import {
	extractCodeInvariants,
	extractMarkdownInvariants,
	renderInvariantTaxonomy,
} from "./code-invariants.js";

describe("extractCodeInvariants — mutation kills", () => {
	// test-contract: boundary — extractCodeInvariants must cap a comment body at the
	// documented TEXT_CAP (240 chars), not the untruncated raw length.
	it("caps a long INVARIANT comment body at TEXT_CAP (240 chars)", () => {
		const longBody = "x".repeat(300);
		const out = extractCodeInvariants(`// INVARIANT: ${longBody}`);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toBe(longBody.slice(0, 240));
		expect(out[0]?.text).toHaveLength(240);
	});

	// test-contract: invariant — extractCodeInvariants' text field is documented as
	// trimmed; trailing whitespace inside the captured comment body must not survive.
	it("trims trailing whitespace from an INVARIANT comment body", () => {
		const out = extractCodeInvariants("// INVARIANT: hello   ");
		expect(out).toEqual([{ line: 1, kind: "invariant_comment", text: "hello" }]);
	});

	// test-contract: invariant — extractCodeInvariants' `line` field is documented as the
	// 1-based source line; an assertion on a non-first line must report its true line.
	it("reports the correct 1-based line number for an assertion on a later line", () => {
		const code = ["const a = 1;", "const b = 2;", "assert(a > b);"].join("\n");
		const out = extractCodeInvariants(code);
		expect(out).toEqual([{ line: 3, kind: "assertion", text: "assert(a > b);" }]);
	});

	// test-contract: boundary — extractCodeInvariants must cap an assertion line at the
	// documented TEXT_CAP (240 chars), not the untruncated raw length.
	it("caps a long assertion line at TEXT_CAP (240 chars)", () => {
		const longLine = `assert(${"x".repeat(300)})`;
		const out = extractCodeInvariants(longLine);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toBe(longLine.slice(0, 240));
		expect(out[0]?.text).toHaveLength(240);
	});

	// test-contract: invariant — extractCodeInvariants' text field is documented as
	// trimmed; leading indentation before an assert() call must not survive.
	it("trims leading indentation from an assertion line", () => {
		const out = extractCodeInvariants("    assert(x > 0);");
		expect(out).toEqual([{ line: 1, kind: "assertion", text: "assert(x > 0);" }]);
	});
});

describe("markdownInvariantFor / isValidRegistryId.(anonymous) / isFenceLine — mutation kills (via extractMarkdownInvariants)", () => {
	// test-contract: public-api — extractMarkdownInvariants must reject a registry id
	// whose middle segment starts with a digit (not a valid FG-INV-xx-style id).
	it("rejects a registry id whose middle segment starts with a digit", () => {
		const out = extractMarkdownInvariants("| AB-1XY-04 | desc |");
		expect(out).toEqual([]);
	});

	// test-contract: boundary — a registry-id segment longer than the 16-char cap
	// (1 + {0,15}) must be rejected in full, not accepted via a truncated 16-char match.
	it("rejects a registry id whose segment exceeds the 16-char cap", () => {
		const longSeg = "A" + "B".repeat(25);
		const out = extractMarkdownInvariants(`| ${longSeg}-99 | description text here |`);
		expect(out).toEqual([]);
	});

	// test-contract: public-api — extractMarkdownInvariants must not treat fence-like
	// backticks appearing MID-line (not a real fence opener) as toggling fence state, so
	// the valid registry row on the next line is not wrongly suppressed.
	it("does not treat mid-line backticks as a fence opener", () => {
		const md = ["some text ```", "| FG-INV-01 | real row |"].join("\n");
		const out = extractMarkdownInvariants(md);
		expect(out).toEqual([{ line: 2, kind: "registry_row", id: "FG-INV-01", text: "real row" }]);
	});

	// test-contract: public-api — extractMarkdownInvariants must still recognize a
	// properly-indented fence opener (leading spaces before the backticks) and suppress
	// the row inside it, per the documented fenced-block skip (round-2 #32).
	it("still recognizes an indented fence opener", () => {
		const md = ["   ```", "| FG-INV-02 | should be suppressed since inside fence |"].join("\n");
		const out = extractMarkdownInvariants(md);
		expect(out).toEqual([]);
	});

	// test-contract: boundary — a fence opener requires 3+ backticks; a single stray
	// backtick must not cross that threshold and must not be treated as a fence opener.
	it("does not treat a single backtick as a fence opener", () => {
		const md = ["`not a real fence marker", "| FG-INV-03 | should stay visible normally |"].join(
			"\n",
		);
		const out = extractMarkdownInvariants(md);
		expect(out).toEqual([
			{ line: 2, kind: "registry_row", id: "FG-INV-03", text: "should stay visible normally" },
		]);
	});

	// test-contract: boundary — a fence opener requires 3+ tildes; a single stray tilde
	// must not cross that threshold and must not be treated as a fence opener.
	it("does not treat a single tilde as a fence opener", () => {
		const md = [
			"~not a real fence marker",
			"| FG-INV-04 | should stay visible normally too |",
		].join("\n");
		const out = extractMarkdownInvariants(md);
		expect(out).toEqual([
			{ line: 2, kind: "registry_row", id: "FG-INV-04", text: "should stay visible normally too" },
		]);
	});

	// test-contract: boundary — a registry row's text must be capped at the documented
	// TEXT_CAP (240 chars), not the untruncated raw description length.
	it("caps a long registry-row description at TEXT_CAP (240 chars)", () => {
		const longDesc = "y".repeat(300);
		const out = extractMarkdownInvariants(`| AB-01 | ${longDesc}`);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toBe(longDesc.slice(0, 240));
		expect(out[0]?.text).toHaveLength(240);
	});

	// test-contract: invariant — a registry row's text field is documented as trimmed;
	// trailing whitespace in the description must not survive.
	it("trims trailing whitespace from a registry-row description", () => {
		const out = extractMarkdownInvariants("| AB-02 | hello world   ");
		expect(out).toEqual([{ line: 1, kind: "registry_row", id: "AB-02", text: "hello world" }]);
	});

	// test-contract: public-api — a registry row's description is documented as stripped
	// from its first literal pipe onward (the trailing-columns convention); a pipe
	// followed by MORE than one character must still be cleanly stripped away.
	it("strips everything from an embedded pipe onward in a registry-row description", () => {
		const out = extractMarkdownInvariants("| AB-03 | hello |world extra");
		expect(out).toEqual([{ line: 1, kind: "registry_row", id: "AB-03", text: "hello" }]);
	});

	// test-contract: boundary — doctrine lines are documented as requiring more than 20
	// trimmed chars; a short doctrine-keyword line under that threshold must be rejected.
	it("rejects a doctrine-keyword line shorter than 20 trimmed chars", () => {
		const out = extractMarkdownInvariants("x never y");
		expect(out).toEqual([]);
	});

	// test-contract: boundary — the doctrine length gate is strictly `> 20`; a line
	// trimmed to EXACTLY 20 chars sits on the boundary and must still be rejected.
	it("rejects a doctrine-keyword line exactly 20 trimmed chars long", () => {
		const line = "always " + "x".repeat(13);
		expect(line).toHaveLength(20);
		const out = extractMarkdownInvariants(line);
		expect(out).toEqual([]);
	});

	// test-contract: boundary — the doctrine length gate is documented as measuring the
	// TRIMMED line; heavy leading indentation must not push an otherwise-short doctrine
	// line over the 20-char threshold via its raw (untrimmed) length.
	it("does not let leading indentation push a short doctrine line over the length gate", () => {
		const out = extractMarkdownInvariants(" ".repeat(20) + "always ok");
		expect(out).toEqual([]);
	});

	// test-contract: boundary — a doctrine line's text must be capped at the documented
	// TEXT_CAP (240 chars), not the untruncated raw sentence length.
	it("caps a long doctrine sentence at TEXT_CAP (240 chars)", () => {
		const longLine = "always " + "z".repeat(300);
		const out = extractMarkdownInvariants(longLine);
		expect(out).toHaveLength(1);
		expect(out[0]?.text).toBe(longLine.trim().slice(0, 240));
		expect(out[0]?.text).toHaveLength(240);
	});

	// test-contract: invariant — a doctrine line's text field is documented as trimmed;
	// leading/trailing whitespace around the sentence must not survive.
	it("trims leading/trailing whitespace from a doctrine sentence's text", () => {
		const line = "  always keep this invariant sentence intact  ";
		const out = extractMarkdownInvariants(line);
		expect(out).toEqual([
			{ line: 1, kind: "doctrine", text: "always keep this invariant sentence intact" },
		]);
	});
});

describe("extractMarkdownInvariants — mutation kills", () => {
	// test-contract: public-api — extractMarkdownInvariants documents blockquote lines as
	// skipped regardless of leading indentation; an indented `>` marker must still be
	// recognized as a blockquote and suppressed.
	it("recognizes an indented blockquote marker and suppresses it", () => {
		const line = "   > properties here never change once committed to disk";
		const out = extractMarkdownInvariants(line);
		expect(out).toEqual([]);
	});

	// test-contract: invariant — extractMarkdownInvariants' `line` field is documented as
	// the 1-based source line; a row on a non-first line must report its true line.
	it("reports the correct 1-based line number for a row on a later line", () => {
		const md = ["intro text", "more text", "| FG-INV-05 | third line entry |"].join("\n");
		const out = extractMarkdownInvariants(md);
		expect(out).toEqual([
			{ line: 3, kind: "registry_row", id: "FG-INV-05", text: "third line entry" },
		]);
	});
});

describe("renderInvariantTaxonomy — mutation kills", () => {
	// test-contract: public-api — renderInvariantTaxonomy's documented output shape (head
	// block + one row per invariant + trailing blank line, newline-joined) is asserted
	// line-by-line for the zero-invariant case, pinning every literal line of the header
	// and the join separator itself.
	it("renders the exact head block + trailing blank line for zero invariants", () => {
		const rendered = renderInvariantTaxonomy("test.md", []);
		const lines = rendered.split("\n");
		expect(lines).toEqual([
			"# Invariant taxonomy — test.md (generated)",
			"",
			"One entry per extracted invariant: classify edits against these",
			"(consistent | contradicts | unrelated). Verbatim quotes; judgment",
			"belongs to the reviewer or the Tier-2 gate, never this extractor.",
			"",
			"",
		]);
	});
});

describe("code-invariants module regexes — mutation kills", () => {
	// test-contract: public-api — extractCodeInvariants documents INVARIANT/SAFETY
	// comment recognition as whitespace-flexible; a comment with NO space between the
	// marker and the keyword must still match.
	it("matches an INVARIANT comment with no space after the slashes", () => {
		const out = extractCodeInvariants("//INVARIANT: no space after slashes");
		expect(out).toEqual([{ line: 1, kind: "invariant_comment", text: "no space after slashes" }]);
	});

	// test-contract: public-api — extractCodeInvariants documents INVARIANT/SAFETY
	// comment recognition as whitespace-flexible; a comment WITH a space before the colon
	// must still match.
	it("matches an INVARIANT comment with a space before the colon", () => {
		const out = extractCodeInvariants("// INVARIANT : space before colon");
		expect(out).toEqual([{ line: 1, kind: "invariant_comment", text: "space before colon" }]);
	});

	// test-contract: public-api — extractCodeInvariants documents INVARIANT/SAFETY
	// comment recognition as whitespace-flexible; a comment with NO space after the colon
	// must still match.
	it("matches an INVARIANT comment with no space after the colon", () => {
		const out = extractCodeInvariants("// INVARIANT:nospaceaftercolon");
		expect(out).toEqual([{ line: 1, kind: "invariant_comment", text: "nospaceaftercolon" }]);
	});

	// test-contract: bug — the captured comment text must include its own first word; a
	// regressed capture boundary that swallows leading non-whitespace before the text
	// group would silently truncate every reported invariant's text.
	it("does not let the text-capture regex swallow the first word", () => {
		const out = extractCodeInvariants("// INVARIANT:immediatetext restofsentence");
		expect(out).toEqual([
			{ line: 1, kind: "invariant_comment", text: "immediatetext restofsentence" },
		]);
	});

	// test-contract: public-api — extractCodeInvariants documents assertion recognition
	// as whitespace-flexible; a debug_assert! call WITH a space before the paren must
	// still match.
	it("matches a debug_assert! call with a space before the paren", () => {
		const out = extractCodeInvariants("debug_assert! (x);");
		expect(out).toEqual([{ line: 1, kind: "assertion", text: "debug_assert! (x);" }]);
	});

	// test-contract: public-api — extractCodeInvariants documents assertion recognition
	// as whitespace-flexible; a plain assert() call with NO space before the paren must
	// still match.
	it("matches a plain assert() call with no space before the paren", () => {
		const out = extractCodeInvariants("assert(condition);");
		expect(out).toEqual([{ line: 1, kind: "assertion", text: "assert(condition);" }]);
	});

	// test-contract: public-api — extractCodeInvariants documents assertion recognition
	// as whitespace-flexible; a plain assert() call WITH a space before the paren must
	// still match.
	it("matches a plain assert() call with a space before the paren", () => {
		const out = extractCodeInvariants("assert (isValid);");
		expect(out).toEqual([{ line: 1, kind: "assertion", text: "assert (isValid);" }]);
	});

	// test-contract: public-api — extractMarkdownInvariants documents registry-row
	// recognition as anchored to the start of the line; a "|"-like bullet sequence
	// appearing MID-line must NOT be recognized as a registry row.
	it("does not recognize a registry row starting mid-line", () => {
		const out = extractMarkdownInvariants("some prose text | FG-INV-06 | fake mid-line row |");
		expect(out).toEqual([]);
	});

	// test-contract: public-api — extractMarkdownInvariants documents registry-row
	// recognition as tolerant of leading indentation; an indented row must still be
	// recognized.
	it("recognizes an indented registry row", () => {
		const out = extractMarkdownInvariants("  | FG-INV-07 | indented row entry |");
		expect(out).toEqual([
			{ line: 1, kind: "registry_row", id: "FG-INV-07", text: "indented row entry" },
		]);
	});

	// test-contract: public-api — extractMarkdownInvariants documents numbered-list
	// bullets ("1.", "12.", ...) as valid row markers regardless of digit count; a
	// two-digit numbered bullet must still be recognized.
	it("recognizes a two-digit numbered-list bullet", () => {
		const out = extractMarkdownInvariants("12. FG-INV-08: two-digit numbered bullet works fine");
		expect(out).toEqual([
			{
				line: 1,
				kind: "registry_row",
				id: "FG-INV-08",
				text: "two-digit numbered bullet works fine",
			},
		]);
	});

	// test-contract: public-api — extractMarkdownInvariants documents numbered-list
	// bullets as digit-prefixed; a standard single-digit numbered bullet must still be
	// recognized as a row marker.
	it("recognizes a single-digit numbered-list bullet", () => {
		const out = extractMarkdownInvariants("3. FG-INV-09 | standard numbered registry row");
		expect(out).toEqual([
			{ line: 1, kind: "registry_row", id: "FG-INV-09", text: "standard numbered registry row" },
		]);
	});

	// test-contract: public-api — extractMarkdownInvariants documents the gap between a
	// bullet marker and the id as whitespace-flexible; a bullet with NO space before the
	// id must still be recognized.
	it("recognizes a bullet with no space before the id", () => {
		const out = extractMarkdownInvariants("-FG-INV-10 | tight bullet no space works fine");
		expect(out).toEqual([
			{ line: 1, kind: "registry_row", id: "FG-INV-10", text: "tight bullet no space works fine" },
		]);
	});

	// test-contract: public-api — extractMarkdownInvariants documents the gap between the
	// separator and the description as whitespace-flexible; a separator with NO space
	// before the description must still be recognized.
	it("recognizes a separator with no space before the description", () => {
		const out = extractMarkdownInvariants("| FG-INV-11 |nospaceafterseparator");
		expect(out).toEqual([
			{ line: 1, kind: "registry_row", id: "FG-INV-11", text: "nospaceafterseparator" },
		]);
	});

	// test-contract: bug — the captured description must include its own first word; a
	// regressed capture boundary that swallows leading non-whitespace before the
	// description group would silently truncate every reported registry row's text.
	it("does not let the description-capture regex swallow the first word", () => {
		const out = extractMarkdownInvariants("| FG-INV-12 |swallowed realcontent");
		expect(out).toEqual([
			{ line: 1, kind: "registry_row", id: "FG-INV-12", text: "swallowed realcontent" },
		]);
	});
});
