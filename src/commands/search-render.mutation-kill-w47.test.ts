import { describe, expect, it } from "vitest";
import { renderFull, renderNormal } from "./search-render.js";
import type { FileRanking, SearchResult } from "./search-query.js";

// biome-ignore lint: control-char regex is intentional (ANSI escape stripping)
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

function occurrences(haystack: string, needle: string): number {
	let count = 0;
	let idx = haystack.indexOf(needle);
	while (idx !== -1) {
		count++;
		idx = haystack.indexOf(needle, idx + needle.length);
	}
	return count;
}

function baseResult(overrides: Partial<SearchResult> = {}): SearchResult {
	return {
		query: "myquery",
		engine: "ripgrep",
		matches: [],
		total: 0,
		truncated: false,
		searched_files: 3,
		elapsed_ms: 7,
		...overrides,
	};
}

describe("renderNormal — positive (must fire correctly)", () => {
	it("N1: single match, total=1 — singular wording, blank separators, no stray text", () => {
		const result = baseResult({
			matches: [{ file: "a.ts", line: 5, text: "hello world" }],
			total: 1,
		});
		const out = renderNormal(result);
		const lines = out.split("\n");

		// pluralization: "1 match" not "1 matches" (kills 4d4534726551d273 +
		// the ternary "" -> Stryker mutant sharing that expression)
		expect(out).toContain("1 match ·");
		expect(out).not.toContain("1 matches ·");

		// blank line right after the header/count line (line45 push(""));
		// header() itself embeds "\n" + title + "\n" + divider, shifting the
		// split index by 2.
		expect(lines[4]).toBe("");
		// blank line at the end of the per-file group (line78 push(""))
		expect(lines[lines.length - 1]).toBe("");

		// the match line itself: line-number prefix + text survive
		expect(out).toContain("   5:");
		expect(out).toContain("hello world");
		expect(out).toContain("a.ts");

		expect(out).not.toContain("Stryker was here");
	});

	it("N2: no matches — shows the empty-result message, nothing else", () => {
		const result = baseResult({ matches: [], total: 0 });
		const out = renderNormal(result);
		expect(out).toContain("No matches found.");
		expect(out).not.toContain("Stryker was here");
	});

	it("N3: ranking summary header, percentage bar, and joined term list", () => {
		const result = baseResult({
			matches: [{ file: "f.ts", line: 1, text: "z" }],
			total: 1,
		});
		const rankings: FileRanking[] = [
			{ file: "f.ts", termsMatched: 2, totalTerms: 2, matchedTerms: ["foo", "bar"], matchCount: 2 },
		];
		const out = renderNormal(result, rankings);
		expect(out).toContain("Most relevant files:");
		expect(out).toContain("[foo, bar]");
		expect(out).toContain("100%");
		expect(out).not.toContain("Stryker was here");
	});

	it("N4: empty rankings array suppresses the ranking summary entirely", () => {
		const result = baseResult({
			matches: [{ file: "f.ts", line: 1, text: "z" }],
			total: 1,
		});
		const out = renderNormal(result, []);
		expect(out).not.toContain("Most relevant files:");
		expect(out).not.toContain("Stryker was here");
	});

	it("N5: only the top 10 rankings are listed", () => {
		const result = baseResult({
			matches: [{ file: "a.ts", line: 1, text: "x" }],
			total: 1,
		});
		const rankings: FileRanking[] = Array.from({ length: 11 }, (_, i) => ({
			file: `rank${i}.ts`,
			termsMatched: 1,
			totalTerms: 1,
			matchedTerms: ["t"],
			matchCount: 1,
		}));
		const out = renderNormal(result, rankings);
		expect(out).toContain("rank9.ts");
		expect(out).not.toContain("rank10.ts");
	});

	it("N6: file group ordering follows ranking order, not match encounter order", () => {
		const result = baseResult({
			matches: [
				{ file: "a.ts", line: 1, text: "match-a" },
				{ file: "b.ts", line: 2, text: "match-b" },
			],
			total: 2,
		});
		const rankings: FileRanking[] = [
			{ file: "b.ts", termsMatched: 1, totalTerms: 1, matchedTerms: ["t"], matchCount: 1 },
			{ file: "a.ts", termsMatched: 1, totalTerms: 1, matchedTerms: ["t"], matchCount: 1 },
		];
		const out = renderNormal(result, rankings);
		const idxB = out.indexOf("b.ts");
		const idxA = out.indexOf("a.ts");
		expect(idxB).toBeGreaterThanOrEqual(0);
		expect(idxA).toBeGreaterThanOrEqual(0);
		expect(idxB).toBeLessThan(idxA);
	});

	it("N7: a ranked file with zero real matches is skipped, not rendered", () => {
		const result = baseResult({
			matches: [{ file: "a.ts", line: 3, text: "only a match" }],
			total: 1,
		});
		const rankings: FileRanking[] = [
			{ file: "b.ts", termsMatched: 1, totalTerms: 2, matchedTerms: ["x"], matchCount: 0 },
			{ file: "a.ts", termsMatched: 2, totalTerms: 2, matchedTerms: ["x", "y"], matchCount: 1 },
		];
		const out = stripAnsi(renderNormal(result, rankings));
		expect(out).toContain("only a match");
		// b.ts appears once, in the ranking-summary line; it must NOT also
		// get a second occurrence as a rendered file-group heading.
		expect(occurrences(out, "b.ts")).toBe(1);
	});

	it("N8: truncated=true appends the 'more matches' notice with the correct remainder", () => {
		const result = baseResult({
			matches: [{ file: "a.ts", line: 1, text: "x" }],
			total: 5,
			truncated: true,
		});
		const out = renderNormal(result);
		expect(out).toContain("4 more matches");
	});

	it("N9: truncated=false never shows the 'more matches' notice", () => {
		const result = baseResult({
			matches: [{ file: "a.ts", line: 1, text: "x" }],
			total: 1,
			truncated: false,
		});
		const out = renderNormal(result);
		expect(out).not.toContain("more matches");
	});

	it("N10: output is joined with real newlines, not concatenated", () => {
		const result = baseResult({
			matches: [{ file: "a.ts", line: 1, text: "x" }],
			total: 1,
		});
		const out = renderNormal(result);
		expect(out.split("\n").length).toBeGreaterThan(3);
	});
});

describe("renderFull — positive (must fire correctly)", () => {
	it("F1: header carries the query text", () => {
		const result = baseResult({ query: "abc123" });
		const out = renderFull(result);
		expect(out).toContain('Search: "abc123"');
	});

	it("F2: no matches — shows the empty-result message", () => {
		const result = baseResult({ matches: [], total: 0 });
		const out = renderFull(result);
		expect(out).toContain("No matches found.");
	});

	it("F3: per-match heading, text line, and blank separators render", () => {
		const result = baseResult({
			matches: [{ file: "a.ts", line: 5, text: "hello world" }],
			total: 1,
		});
		const out = renderFull(result);
		const plain = stripAnsi(out);
		const lines = out.split("\n");
		expect(plain).toContain("a.ts:5");
		expect(plain).toContain("> hello world");
		// header() embeds "\n" + title + "\n" + divider, shifting the index by 2
		expect(lines[4]).toBe("");
		expect(lines[lines.length - 1]).toBe("");
		expect(plain).not.toContain("Stryker was here");
	});

	it("F4: context_before and context_after lines render when present", () => {
		const result = baseResult({
			matches: [
				{
					file: "a.ts",
					line: 5,
					text: "hello world",
					context_before: ["ctx-before-line"],
					context_after: ["ctx-after-line"],
				},
			],
			total: 1,
		});
		const out = renderFull(result);
		expect(out).toContain("ctx-before-line");
		expect(out).toContain("ctx-after-line");
	});

	it("F5: ranking summary shows when rankings are passed", () => {
		const result = baseResult({
			matches: [{ file: "a.ts", line: 1, text: "x" }],
			total: 1,
		});
		const rankings: FileRanking[] = [
			{ file: "a.ts", termsMatched: 1, totalTerms: 1, matchedTerms: ["t"], matchCount: 1 },
		];
		const out = renderFull(result, rankings);
		expect(out).toContain("Most relevant files:");
	});

	it("F6: truncated=true appends the 'more matches' notice", () => {
		const result = baseResult({
			matches: [{ file: "a.ts", line: 1, text: "x" }],
			total: 5,
			truncated: true,
		});
		const out = renderFull(result);
		expect(out).toContain("4 more matches");
	});

	it("F7: truncated=false never shows the 'more matches' notice", () => {
		const result = baseResult({
			matches: [{ file: "a.ts", line: 1, text: "x" }],
			total: 1,
			truncated: false,
		});
		const out = renderFull(result);
		expect(out).not.toContain("more matches");
	});

	it("F8: output is joined with real newlines, not concatenated", () => {
		const result = baseResult({
			matches: [{ file: "a.ts", line: 1, text: "x" }],
			total: 1,
		});
		const out = renderFull(result);
		expect(out.split("\n").length).toBeGreaterThan(3);
	});
});
