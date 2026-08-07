import { describe, expect, it } from "vitest";
import { nonNull } from "../../lib/non-null.js";
import {
	buildNearMissWarning,
	countOccurrences,
	findClosestSpans,
	findOccurrenceLines,
	firstDivergenceLine,
	formatNearMisses,
	formatRescue,
	suggestUniqueAnchor,
} from "../edit-diagnostics.js";

describe("findClosestSpans", () => {
	it("returns no matches when target is empty", () => {
		expect(findClosestSpans("foo\nbar", "")).toEqual([]);
	});

	it("returns no matches when content is empty", () => {
		expect(findClosestSpans("", "foo")).toEqual([]);
	});

	it("returns no matches when target longer than file", () => {
		expect(findClosestSpans("a\nb", "a\nb\nc\nd")).toEqual([]);
	});

	it("finds whitespace-variant single-line near miss", () => {
		const content = ["function foo() {", "  return 1;", "}"].join("\n");
		const target = "function foo () {";
		const misses = findClosestSpans(content, target, 3);
		expect(misses.length).toBeGreaterThan(0);
		expect(nonNull(misses[0]).line).toBe(1);
		expect(nonNull(misses[0]).similarity).toBeGreaterThan(0.7);
	});

	it("finds multi-line near miss with one differing line", () => {
		const content = [
			"export function bar() {",
			"  const x = 1;",
			"  return x + 1;",
			"}",
			"",
			"export function baz() {",
			"  return 2;",
			"}",
		].join("\n");
		const target = ["export function bar() {", "  const x = 2;", "  return x + 1;", "}"].join(
			"\n",
		);
		const misses = findClosestSpans(content, target, 3);
		expect(nonNull(misses[0]).line).toBe(1);
		expect(nonNull(misses[0]).similarity).toBeGreaterThan(0.6);
	});

	it("returns up to N matches when several spans qualify", () => {
		const content = [
			"function alpha() {}",
			"function beta() {}",
			"function gamma() {}",
			"function delta() {}",
		].join("\n");
		const target = "function omega() {}";
		const misses = findClosestSpans(content, target, 3);
		expect(misses.length).toBeLessThanOrEqual(3);
		expect(misses.every((m) => m.similarity >= 0.4)).toBe(true);
	});

	it("returns empty when nothing similar enough", () => {
		const content = "completely\nunrelated\ncontent\nhere";
		const target = "xQzZyY!@#$%^&*";
		expect(findClosestSpans(content, target)).toEqual([]);
	});

	it("dedupes overlapping windows by keeping the highest score", () => {
		const content = [
			"const x = 1;",
			"const x = 1;",
			"const x = 1;",
			"const y = 2;",
			"const z = 3;",
		].join("\n");
		const target = ["const x = 1;", "const x = 1;"].join("\n");
		const misses = findClosestSpans(content, target, 3);
		// Three overlapping windows would all match; dedup should collapse them
		// such that consecutive results don't overlap.
		for (let i = 1; i < misses.length; i++) {
			expect(Math.abs(nonNull(misses[i]).line - nonNull(misses[i - 1]).line)).toBeGreaterThanOrEqual(2);
		}
	});

	it("ranks higher-similarity spans first", () => {
		const content = [
			"function foo(x: number): number { return x; }",
			"function fooo(x: string): string { return x; }",
		].join("\n");
		const target = "function foo(x: number): number { return x; }";
		const misses = findClosestSpans(content, target, 2);
		expect(nonNull(misses[0]).line).toBe(1);
		expect(nonNull(misses[0]).similarity).toBe(1);
		if (misses.length > 1) {
			expect(nonNull(misses[0]).similarity).toBeGreaterThan(nonNull(misses[1]).similarity);
		}
	});
});

describe("formatNearMisses", () => {
	it("returns empty string for no misses", () => {
		expect(formatNearMisses([])).toBe("");
	});

	it("formats with line, percent, and snippet", () => {
		const formatted = formatNearMisses([
			{ line: 42, endLine: 42, snippet: "function foo()", lines: ["function foo()"], similarity: 0.875 },
		]);
		expect(formatted).toContain("L42");
		expect(formatted).toContain("88%");
		expect(formatted).toContain("function foo()");
	});

	it("joins multiple misses with newlines", () => {
		const formatted = formatNearMisses([
			{ line: 1, endLine: 1, snippet: "a", lines: ["a"], similarity: 1 },
			{ line: 5, endLine: 5, snippet: "b", lines: ["b"], similarity: 0.6 },
		]);
		expect(formatted.split("\n").length).toBe(2);
	});
});

describe("firstDivergenceLine", () => {
	it("returns null when target and span are identical line-for-line", () => {
		expect(firstDivergenceLine("a\nb\nc", ["a", "b", "c"])).toBeNull();
	});

	it("returns the 1-based index of the first differing line", () => {
		expect(firstDivergenceLine("a\nb\nc", ["a", "X", "c"])).toBe(2);
	});
});

describe("countOccurrences", () => {
	it("returns 0 for an empty target", () => {
		expect(countOccurrences("abcabc", "")).toBe(0);
	});

	it("counts non-overlapping exact occurrences", () => {
		expect(countOccurrences("abcabcabc", "abc")).toBe(3);
	});

	it("returns 0 when the target never appears", () => {
		expect(countOccurrences("hello world", "xyz")).toBe(0);
	});
});

describe("findOccurrenceLines", () => {
	it("returns an empty array for an empty target", () => {
		expect(findOccurrenceLines("line1\nline2", "")).toEqual([]);
	});

	it("returns the 1-based start line of each occurrence", () => {
		const content = "alpha\nneedle here\nbeta\nneedle again";
		expect(findOccurrenceLines(content, "needle")).toEqual([2, 4]);
	});

	it("returns an empty array when nothing matches", () => {
		expect(findOccurrenceLines("no match here", "zzz")).toEqual([]);
	});
});

describe("formatRescue", () => {
	it("returns an empty string when there are no misses", () => {
		expect(formatRescue([], "target")).toBe("");
	});

	it("renders the best span fenced, with the divergence line called out", () => {
		const misses = [
			{
				line: 3,
				endLine: 4,
				snippet: "function foo() {",
				lines: ["function foo() {", "  return 2;"],
				similarity: 0.8,
			},
		];
		const rescue = formatRescue(misses, "function foo() {\n  return 1;");
		expect(rescue).toContain("lines 3–4");
		expect(rescue).toContain("80% similar");
		expect(rescue).toContain("```");
		expect(rescue).toContain("function foo() {");
		expect(rescue).toContain("  return 2;");
		expect(rescue).toContain("First line differing from your old_string: line 4.");
	});

	it("uses a ~~~~ fence when the span itself contains a ``` line", () => {
		const misses = [
			{
				line: 1,
				endLine: 2,
				snippet: "```ts",
				lines: ["```ts", "code"],
				similarity: 0.9,
			},
		];
		const rescue = formatRescue(misses, "```ts\ncode");
		expect(rescue).toContain("~~~~");
	});

	it("lists runner-up matches when more than one miss is given", () => {
		const misses = [
			{ line: 1, endLine: 1, snippet: "best", lines: ["best"], similarity: 0.9 },
			{ line: 10, endLine: 10, snippet: "second", lines: ["second"], similarity: 0.5 },
		];
		const rescue = formatRescue(misses, "best");
		expect(rescue).toContain("Also similar:");
		expect(rescue).toContain("L10");
	});

	it("elides very long spans down to head + tail", () => {
		const longLines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
		const misses = [
			{
				line: 1,
				endLine: 60,
				snippet: "line 0",
				lines: longLines,
				similarity: 1,
			},
		];
		const rescue = formatRescue(misses, longLines.join("\n"));
		expect(rescue).toContain("lines elided");
		expect(rescue).not.toContain("line 30");
		expect(rescue).toContain("line 0");
		expect(rescue).toContain("line 59");
	});
});

describe("buildNearMissWarning", () => {
	it("wraps the rescue block with a file path and retry instruction", () => {
		const misses = [
			{ line: 5, endLine: 5, snippet: "const x = 1;", lines: ["const x = 1;"], similarity: 1 },
		];
		const warning = buildNearMissWarning("src/foo.ts", misses, "const x = 1;");
		expect(warning).toContain("[interlinked:edit-near-miss] old_string not found in src/foo.ts");
		expect(warning).toContain("const x = 1;");
		expect(warning).toContain("Retry with the exact current text — no re-read needed.");
	});
});

describe("suggestUniqueAnchor", () => {
	it("returns null when the target is unique or absent", () => {
		expect(suggestUniqueAnchor("only one match here", "only one")).toBeNull();
		expect(suggestUniqueAnchor("nothing matches", "zzz")).toBeNull();
	});

	it("extends forward by one line when that disambiguates", () => {
		const content = [
			"function foo() {",
			"  return 1;",
			"}",
			"function foo() {",
			"  return 2;",
			"}",
		].join("\n");
		const anchor = suggestUniqueAnchor(content, "function foo() {");
		expect(anchor).not.toBeNull();
		expect(countOccurrences(content, anchor ?? "")).toBe(1);
		expect(anchor).toContain("return 1;");
	});

	it("falls back to extending backward when forward extension can't disambiguate", () => {
		// Both occurrences of TARGET sit on the last line, so there is no
		// newline after the first occurrence (forward extension fails
		// immediately); the preceding line disambiguates it instead.
		const content = "prefix\nline2 TARGET stuff TARGET";
		const anchor = suggestUniqueAnchor(content, "TARGET");
		expect(anchor).not.toBeNull();
		expect(countOccurrences(content, anchor ?? "")).toBe(1);
		expect(anchor).toContain("line2 TARGET");
	});

	it("returns null when neither direction can disambiguate within the extension budget", () => {
		// Two byte-for-byte identical blocks: extending up to 3 lines in
		// either direction from TARGET produces the same candidate text in
		// both copies, so uniqueness can never be achieved.
		const block = ["same", "same", "same", "TARGET", "same", "same", "same"].join("\n");
		const content = `${block}\n${block}`;
		expect(suggestUniqueAnchor(content, "TARGET")).toBeNull();
	});
});
