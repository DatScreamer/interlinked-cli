import { describe, expect, it } from "vitest";
import { directionFromTitle, parseLabeledCases } from "./case-parser.js";

// Wave pass1_w49 — targeted survivor kills for src/harness/check-evidence/case-parser.ts

describe("directionFromTitle — negative regex alternatives", () => {
	// Kills 4bef0a9756bab7b1: "no[ -]match" -> "no[^ -]match" would refuse a
	// space-separated "no match" phrase.
	it("reads a space-separated 'no match' phrase as negative", () => {
		expect(directionFromTitle("checks no match scenario")).toBe("negative");
	});
});

describe("directionFromTitle — CASE_PREFIX_RE (P/N prefix)", () => {
	// Kills 55257f7dc3791585: dropping the ^ anchor would let a P/N-shaped
	// fragment ANYWHERE in the title count as a prefix, not just at the start.
	it("does not treat a P/N-shaped fragment mid-title as a prefix", () => {
		expect(directionFromTitle("random preamble P1: real label")).toBeNull();
	});

	// Kills f054888f59f2474c: leading \s* -> \S* would refuse a title that
	// actually starts with whitespace before the P/N prefix.
	it("accepts a leading-space P1 prefix", () => {
		expect(directionFromTitle(" P1: foo")).toBe("positive");
	});

	// Kills b1b9cde9578e20cc: \d+ -> \d would refuse a two-digit case number.
	it("accepts a two-digit case number", () => {
		expect(directionFromTitle("P12: two digit case")).toBe("positive");
	});

	// Kills 4de862de06687208: trailing \s* -> \S* would refuse a space between
	// the digits and the separator punctuation.
	it("accepts a space before the prefix separator", () => {
		expect(directionFromTitle("P1 : spaced colon case")).toBe("positive");
	});
});

describe("parseLabeledCases — braceDelta / depth tracking", () => {
	// Kills 824912120f190640 (body emptied), 324caf13e61f560a (ch==='{' -> true),
	// 62dfbab65441e477 (ch==='{' -> ch!=='{'), 0ed1cea5ab357b02 ('}' -> ''),
	// 6af5e9f6bf80b711 (ch==='}' -> false), 3294cbdd53ebd9b4 (delta-- -> delta++):
	// each corrupts brace-depth tracking so the describe block never appears to
	// close, leaking its "positive" direction onto the unrelated top-level test.
	it("stops inheriting direction once the describe block actually closes", () => {
		const source = [
			'describe("must fire example", () => {',
			'\tit("t1");',
			"});",
			'it("t2");',
		].join("\n");
		const cases = parseLabeledCases(source);
		expect(cases.length).toBe(1);
		expect(cases[0]?.title).toBe("t1");
		expect(cases[0]?.direction).toBe("positive");
	});
});

describe("parseLabeledCases — isCommentLine", () => {
	// Kills 34f62c2e028e864f: startsWith("*") -> endsWith("*") would stop
	// recognizing a block-comment continuation line that starts with "*".
	it("ignores an opener written inside a '*'-prefixed comment continuation", () => {
		const source = ' * it("must fire fake");';
		expect(parseLabeledCases(source)).toEqual([]);
	});

	// Kills 661e53a2dec48da5: startsWith("/*") -> endsWith("/*") would stop
	// recognizing a line that opens with "/*" but does not end with it.
	it("ignores an opener written on a '/*'-opened comment line", () => {
		const source = '/* it("must fire slash-star", () => {}) */';
		expect(parseLabeledCases(source)).toEqual([]);
	});
});

describe("parseLabeledCases — popClosedFrames boundary + fallback value", () => {
	// Kills 64e7141be5479ace (body emptied), 091eb6596fdebc57 (while cond -> false),
	// 95558d6780c36c80 (<= -> <, off-by-one at the exact closesAt boundary),
	// 2ad4013b93eb3e7c (?? -> &&, forces the comparison value to 0),
	// 39b6f8edcbc949b3 (stack.length-1 -> +1, out-of-bounds read -> 0):
	// each prevents the inner describe frame from popping at the moment its
	// block closes, so the sibling test after it wrongly inherits the inner
	// frame's null direction instead of the outer frame's "positive".
	it("pops the inner describe frame exactly when its block closes", () => {
		const source = [
			'describe("must fire outer", () => {',
			'\tdescribe("neutral inner", () => {',
			'\t\tit("t1");',
			"\t});",
			'\tit("t2");',
			"});",
		].join("\n");
		const cases = parseLabeledCases(source);
		expect(cases.length).toBe(1);
		expect(cases[0]?.title).toBe("t2");
		expect(cases[0]?.direction).toBe("positive");
	});
});

describe("parseLabeledCases — top-level array init", () => {
	// Kills 1fafc2f0652dddc3: `[]` -> `["Stryker was here"]` would leave a
	// bogus placeholder entry in the result even for empty source.
	it("returns an empty array for empty source", () => {
		expect(parseLabeledCases("").length).toBe(0);
	});
});

describe("parseLabeledCases — BLOCK_RE whitespace gaps", () => {
	// Kills 4daaf6735d9d8e5c: the \s* between the optional `.each` method chain
	// and the optional `(args)` group becomes \S*, so a real space there (with
	// no space before the title paren) can no longer be consumed anywhere else
	// in the pattern and the whole opener fails to match.
	it("recognizes a .each(...) opener with a space before the args group", () => {
		const source = [
			'describe.each ([1,2])("must fire suite", () => {',
			'\tit("t1");',
			"});",
		].join("\n");
		const cases = parseLabeledCases(source);
		expect(cases.some((c) => c.title === "t1")).toBe(true);
	});

	// Kills 56d05ad0721f99f2: the \s* between the optional `(args)` group and
	// the title's opening paren becomes \S*, so a real space there (with no
	// space before the args group) breaks the match.
	it("recognizes a .each(...) opener with a space before the title paren", () => {
		const source = [
			'describe.each([1,2]) ("must fire suite2", () => {',
			'\tit("t2");',
			"});",
		].join("\n");
		const cases = parseLabeledCases(source);
		expect(cases.some((c) => c.title === "t2")).toBe(true);
	});

	// Kills 4e58738982b067a4: the \s* between the title's opening paren and its
	// leading quote becomes \S*, so a real space there breaks the match.
	it("recognizes an opener with a space between the paren and the quote", () => {
		const source = 'it( "must fire spaced open");';
		const cases = parseLabeledCases(source);
		expect(cases.some((c) => c.title === "must fire spaced open")).toBe(true);
	});
});
