import { describe, expect, it } from "vitest";
import { extractHeadings } from "./extract-refs.js";
import { collectRefDefinitionLabels, githubSlug } from "./extract-refs-slug.js";

const lines = (t: string): string[] => t.split("\n");
const noFences = new Set<number>();

describe("githubSlug — baseline (moved out of extract-refs, round-7 split)", () => {
	it("lowercases, strips punctuation, hyphenates spaces", () => {
		expect(githubSlug("7.3 Phantom Protection (SSI)")).toBe("73-phantom-protection-ssi");
		expect(githubSlug("The `commit` stream — truth")).toBe("the-commit-stream--truth");
	});

	it("reduces inline links and images to their text", () => {
		expect(githubSlug("[Install](https://example.com) now")).toBe("install-now");
		expect(githubSlug("![img](x.png) caption")).toBe("img-caption");
	});

	it("decodes entities and drops tags but keeps autolinks", () => {
		expect(githubSlug("Dogs &amp; Cats")).toBe("dogs--cats");
		expect(githubSlug("<em>API</em>")).toBe("api");
		expect(githubSlug("<https://example.com>")).toBe("httpsexamplecom");
	});
});

describe("code-span-preserving slug (round-7 #14)", () => {
	it("renders code-span content as literal text, not parsed markdown/HTML", () => {
		expect(githubSlug("`<em>`")).toBe("em");
		expect(githubSlug("`[x](y)`")).toBe("xy");
		expect(githubSlug("The `<div>` element")).toBe("the-div-element");
	});

	it("keeps plain code spans and drops the CommonMark span-edge space", () => {
		expect(githubSlug("`commit`")).toBe("commit");
		expect(githubSlug("` code `")).toBe("code");
		expect(githubSlug("a `x` b")).toBe("a-x-b");
	});

	it("leaves an unpaired backtick literal (no code span)", () => {
		expect(githubSlug("a`b")).toBe("ab");
		expect(githubSlug("`§9``")).toBe("9"); // unequal runs → not a span; § stripped as punct
	});
});

describe("undefined reference links render literally (round-7 #16)", () => {
	it("keeps an undefined reference link literal in the slug", () => {
		expect(extractHeadings(lines("# text [a][ref] more"), noFences)[0]?.slug).toBe("text-aref-more");
	});

	it("reduces a reference link whose label IS defined", () => {
		const hs = extractHeadings(lines("# text [a][ref] more\n\n[ref]: https://example.com"), noFences);
		expect(hs[0]?.slug).toBe("text-a-more");
	});

	it("reduces a collapsed [text][] link only when text is a defined label", () => {
		expect(extractHeadings(lines("# see [foo][] now\n\n[foo]: /u"), noFences)[0]?.slug).toBe("see-foo-now");
		expect(extractHeadings(lines("# see [foo][] now"), noFences)[0]?.slug).toBe("see-foo-now");
	});

	it("bare githubSlug with no label map reduces reference links (legacy callers)", () => {
		expect(githubSlug("text [a][ref] more")).toBe("text-a-more");
	});
});

describe("slug pipeline (round-7 review fixes)", () => {
	it("keeps entities inside a code span literal (#26)", () => {
		expect(githubSlug("`&copy;`")).toBe("copy");
		expect(githubSlug("`&amp;`")).toBe("amp");
		expect(githubSlug("use `&#189;` here")).toBe("use-189-here"); // literal in code: &#189; → digits survive
	});

	it("lets a comment that opens first own its bracket, before link reduction (#20)", () => {
		expect(githubSlug("<!-- [x -->](url) Visible")).toBe("url-visible");
	});

	it("honors backslash parity on the slug link openers (#21)", () => {
		expect(githubSlug("\\[x](url)")).toBe("xurl"); // escaped [ → literal link
		expect(githubSlug("[x](url)")).toBe("x"); // real link reduces to text
		expect(
			extractHeadings(lines("# \\[x][ref] end\n\n[ref]: /u"), noFences)[0]?.slug,
		).toBe("xref-end"); // escaped ref stays literal even when defined
	});

	it("does not treat a destination-less [ref]: as a definition (#19)", () => {
		expect(extractHeadings(lines("[ref]:\n\n# [Text][ref]"), noFences).map((h) => h.slug)).toEqual([
			"textref",
		]);
		expect(extractHeadings(lines("[ref]: /u\n\n# [Text][ref]"), noFences).map((h) => h.slug)).toEqual([
			"text",
		]);
	});
});

describe("collectRefDefinitionLabels", () => {
	it("collects and normalizes definition labels; ignores masked/invalid ones", () => {
		const got = collectRefDefinitionLabels(
			lines("[Foo Bar]: /a\n`[masked]: /b`\n[a[b]: /c\n    [indented]: /d"),
		);
		expect(got.has("foo bar")).toBe(true); // normalized: trim + collapse + lowercase
		expect(got.has("masked")).toBe(false); // inside inline code
		expect(got.has("a[b")).toBe(false); // nested "[" → not a valid label
		expect(got.has("indented")).toBe(false); // 4-space indent → not an LRD
	});
});
