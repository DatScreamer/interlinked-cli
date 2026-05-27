import { describe, expect, it } from "vitest";

import { looksLikeReDoS, safeCompileRegex } from "./redos-validation.js";

describe("looksLikeReDoS — positive shapes (catastrophic backtracking)", () => {
	it("detects nested quantifier (a+)*", () => {
		expect(looksLikeReDoS("(a+)*")).toBe(true);
	});

	it("detects nested quantifier (a*b)+", () => {
		expect(looksLikeReDoS("(a*b)+")).toBe(true);
	});

	it("detects nested quantifier with character class (\\w+)*", () => {
		expect(looksLikeReDoS("(\\w+)*")).toBe(true);
	});

	it("detects wildcard group (.*)*", () => {
		expect(looksLikeReDoS("(.*)*")).toBe(true);
	});

	it("detects wildcard group (.*X)+ — wildcard followed by anything under rep", () => {
		expect(looksLikeReDoS("(.*X)+")).toBe(true);
	});

	it("detects prefix-overlap alternation (a|aa)+", () => {
		expect(looksLikeReDoS("(a|aa)+")).toBe(true);
	});

	it("detects prefix-overlap alternation (ab|a)*", () => {
		expect(looksLikeReDoS("(ab|a)*")).toBe(true);
	});

	it("detects three-way prefix overlap (a|aa|aaa)+", () => {
		expect(looksLikeReDoS("(a|aa|aaa)+")).toBe(true);
	});
});

describe("looksLikeReDoS — negative shapes (safe patterns)", () => {
	it("does not flag non-overlapping alternation (a|b)*", () => {
		expect(looksLikeReDoS("(a|b)*")).toBe(false);
	});

	it("does not flag distinct-branch alternation (foo|bar|baz)+", () => {
		expect(looksLikeReDoS("(foo|bar|baz)+")).toBe(false);
	});

	it("does not flag simple quantifier [a-z]+", () => {
		expect(looksLikeReDoS("[a-z]+")).toBe(false);
	});

	it("does not flag sequential quantifiers a*b*c*", () => {
		expect(looksLikeReDoS("a*b*c*")).toBe(false);
	});

	it("does not flag anchored alphanumeric ^[A-Z][a-z]+$", () => {
		expect(looksLikeReDoS("^[A-Z][a-z]+$")).toBe(false);
	});

	it("does not flag bounded patterns \\d{3}-\\d{4}", () => {
		expect(looksLikeReDoS("\\d{3}-\\d{4}")).toBe(false);
	});

	it("does not flag email-shaped regex without nested quantifier", () => {
		expect(looksLikeReDoS("[\\w.+-]+@[\\w.-]+\\.[A-Za-z]{2,}")).toBe(false);
	});
});

describe("safeCompileRegex", () => {
	it("returns null for a ReDoS-prone pattern", () => {
		expect(safeCompileRegex("(a+)*")).toBeNull();
	});

	it("returns null for an invalid regex", () => {
		// Unmatched paren — `new RegExp` throws SyntaxError.
		expect(safeCompileRegex("(")).toBeNull();
	});

	it("returns a compiled RegExp for a safe pattern", () => {
		const re = safeCompileRegex("foo[0-9]+");
		expect(re).not.toBeNull();
		expect(re?.test("foo123")).toBe(true);
		expect(re?.test("foo")).toBe(false);
	});

	it("passes flags through to the RegExp constructor", () => {
		const re = safeCompileRegex("hello", "gi");
		expect(re).not.toBeNull();
		expect(re?.flags).toContain("g");
		expect(re?.flags).toContain("i");
	});
});
