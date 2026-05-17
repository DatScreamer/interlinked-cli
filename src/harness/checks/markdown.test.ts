import { describe, expect, it } from "vitest";
import { checkPlaceholderMarkdownLinks } from "./markdown.js";

describe("checkPlaceholderMarkdownLinks", () => {
	// ── Positive cases: real placeholder links that must be flagged ──
	it("flags an empty-href link [text]()", () => {
		const matches = checkPlaceholderMarkdownLinks(
			"See [click here]() for details.\n",
			"docs/guide.md",
		);
		expect(matches).toHaveLength(1);
		expect(matches[0].line).toBe(1);
	});

	it("flags an anchor-only placeholder link [text](#)", () => {
		const matches = checkPlaceholderMarkdownLinks("Jump to [the section](#).\n", "README.md");
		expect(matches).toHaveLength(1);
	});

	it("flags a whitespace-only href [text]( )", () => {
		const matches = checkPlaceholderMarkdownLinks("A [broken link]( ) here.\n", "notes.mdx");
		expect(matches).toHaveLength(1);
	});

	it("flags each placeholder link on its own line", () => {
		const content = "[one]()\nsome prose\n[two](#)\n";
		const matches = checkPlaceholderMarkdownLinks(content, "x.markdown");
		expect(matches).toHaveLength(2);
		expect(matches.map((m) => m.line)).toEqual([1, 3]);
	});

	// ── Negative cases: legitimate patterns that must NOT be flagged ──
	it("does not flag a real URL link", () => {
		const matches = checkPlaceholderMarkdownLinks(
			"See [the docs](https://example.com/x).\n",
			"guide.md",
		);
		expect(matches).toEqual([]);
	});

	it("does not flag a real same-page anchor link", () => {
		const matches = checkPlaceholderMarkdownLinks(
			"Jump to [setup](#installation-steps).\n",
			"guide.md",
		);
		expect(matches).toEqual([]);
	});

	it("does not flag reference-style links", () => {
		const content = "See [the guide][guide].\n\n[guide]: https://example.com/guide\n";
		const matches = checkPlaceholderMarkdownLinks(content, "guide.md");
		expect(matches).toEqual([]);
	});

	it("does not flag placeholder-link syntax inside a fenced code block", () => {
		const content = "Example:\n\n```md\n[text]()\n```\n\nDone.\n";
		const matches = checkPlaceholderMarkdownLinks(content, "guide.md");
		expect(matches).toEqual([]);
	});

	it("does not run on non-markdown files", () => {
		const matches = checkPlaceholderMarkdownLinks("const link = '[x]()';\n", "src/app.ts");
		expect(matches).toEqual([]);
	});
});
