import { describe, expect, it } from "vitest";

import {
	buildOrPattern,
	escapeRegex,
	globToRegex,
	isMultiTermQuery,
	rankFilesByTermDensity,
	splitQueryTerms,
	type SearchMatch,
} from "./search-query.js";

function match(file: string, line: number, text: string): SearchMatch {
	return { file, line, text };
}

describe("search query helpers", () => {
	it("escapes regex metacharacters and builds OR patterns", () => {
		expect(escapeRegex("a+b")).toBe("a\\+b");
		expect(buildOrPattern(["a+b", "token"])).toBe("a\\+b|token");
		expect(new RegExp(buildOrPattern(["a+b", "token"])).test("a+b")).toBe(true);
	});

	it("expands glob literals, single-character wildcards, and recursive wildcards", () => {
		expect(globToRegex("foo.bar").test("foo.bar")).toBe(true);
		expect(globToRegex("foo.bar").test("fooXbar")).toBe(false);
		expect(globToRegex("src/*.ts").test("src/search.ts")).toBe(true);
		expect(globToRegex("src/*.ts").test("src/nested/search.ts")).toBe(false);
		expect(globToRegex("file?.ts").test("file1.ts")).toBe(true);
		expect(globToRegex("file?.ts").test("file12.ts")).toBe(false);
		expect(globToRegex("src/**/test.ts").test("src/a/deep/test.ts")).toBe(true);
	});

	it("removes natural-language stop words while retaining meaningful terms", () => {
		const stopWords =
			"the a an is are was were be been do does did has have had will would can could should may might shall on in at to for of with by from it its this that these those and or but not no if then so how what when where which who why";
		expect(splitQueryTerms(`${stopWords} alpha beta`)).toEqual(["alpha", "beta"]);
	});

	it("keeps two-character terms, rejects one-character noise, and strips punctuation", () => {
		expect(splitQueryTerms("go x alpha!")).toEqual(["go", "alpha"]);
		expect(splitQueryTerms("alpha  beta")).toEqual(["alpha", "beta"]);
	});

	it("recognizes multi-term queries after filtering and preserves regex-safe terms", () => {
		expect(isMultiTermQuery("find OAuth token")).toBe(true);
		expect(isMultiTermQuery("the token")).toBe(false);
		expect(isMultiTermQuery("token")).toBe(false);
	});

	it("ranks by distinct terms first and total matches second", () => {
		const matches = [
			match("few.ts", 1, "alpha"),
			match("many.ts", 1, "alpha beta"),
			match("many.ts", 2, "alpha beta"),
		];
		expect(rankFilesByTermDensity(matches, ["alpha", "beta"]).map((r) => r.file)).toEqual([
			"many.ts",
			"few.ts",
		]);
	});

	it("uses match count to break a tie in distinct-term density", () => {
		const matches = [
			match("few.ts", 1, "alpha"),
			match("many.ts", 1, "alpha"),
			match("many.ts", 2, "alpha"),
		];
		expect(rankFilesByTermDensity(matches, ["alpha", "beta"]).map((r) => r.file)).toEqual([
			"many.ts",
			"few.ts",
		]);
	});

	it("does not merge separate lines when matching terms", () => {
		const rankings = rankFilesByTermDensity(
			[match("split.ts", 1, "ab"), match("split.ts", 2, "cd")],
			["bc"],
		);
		expect(rankings[0]).toMatchObject({
			file: "split.ts",
			termsMatched: 0,
			matchedTerms: [],
			matchCount: 2,
		});
	});

	it("counts every match and reports all matched term names", () => {
		const rankings = rankFilesByTermDensity(
			[
				match("result.ts", 1, "OAuth token"),
				match("result.ts", 2, "validation"),
			],
			["OAuth", "token", "validation"],
		);
		expect(rankings[0]).toEqual({
			file: "result.ts",
			termsMatched: 3,
			totalTerms: 3,
			matchedTerms: ["OAuth", "token", "validation"],
			matchCount: 2,
		});
	});
});
