import { describe, expect, it } from "vitest";
import {
	extractAnchorLinks,
	extractHeadings,
	extractSectionRefs,
	githubSlug,
} from "./extract-refs.js";

const lines = (text: string): string[] => text.split("\n");
const noFences = new Set<number>();

// Wall-clock budget for the ReDoS-guard perf tests below. These assert the
// bracket/backslash scanners stay LINEAR on adversarial 40k–320k inputs; a real
// catastrophic-backtracking regression is exponential (seconds→minutes), so a
// generous ceiling still catches it while tolerating slow/loaded CI runners
// (the 240k case clocks ~0.6s on the ubuntu runner vs well under 0.1s locally —
// a tight 500ms budget flaked there). Do not tighten to chase local speed.
const REDOS_GUARD_MS = 3000;

describe("githubSlug", () => {
	it("lowercases, strips punctuation, hyphenates spaces", () => {
		expect(githubSlug("7.3 Phantom Protection (SSI)")).toBe(
			"73-phantom-protection-ssi",
		);
		expect(githubSlug("The `commit` stream — truth")).toBe(
			"the-commit-stream--truth",
		);
	});

	it("decodes basic HTML entities before slugging (rendered-text rule)", () => {
		expect(githubSlug("Dogs &amp; Cats")).toBe("dogs--cats");
		expect(githubSlug("a &lt;b&gt; c")).toBe("a-b-c");
	});
});

describe("extractHeadings", () => {
	it("extracts level, text, slug, section number, appendix letter", () => {
		const hs = extractHeadings(
			lines("## 7.3 Phantoms\n### Appendix C — formats\n# Plain title"),
			noFences,
		);
		expect(hs[0]).toEqual(
			expect.objectContaining({
				line: 1,
				level: 2,
				sectionNumber: "7.3",
				slug: "73-phantoms",
			}),
		);
		expect(hs[1]?.appendixLetter).toBe("C");
		expect(hs[2]?.sectionNumber).toBeUndefined();
	});

	it("dedupes repeated slugs with -1/-2 suffixes (GitHub behavior)", () => {
		const hs = extractHeadings(
			lines("## Setup\n## Setup\n## Setup"),
			noFences,
		);
		expect(hs.map((h) => h.slug)).toEqual(["setup", "setup-1", "setup-2"]);
	});

	it("ignores heading-looking lines inside fences", () => {
		const hs = extractHeadings(lines("# Real\n# Fenced"), new Set([2]));
		expect(hs.map((h) => h.text)).toEqual(["Real"]);
	});

	it("slugs rendered text: links become their text (round-2 #23)", () => {
		const hs = extractHeadings(
			lines("# [Install](https://example.com) now"),
			noFences,
		);
		expect(hs[0]?.slug).toBe("install-now");
	});

	it("extracts Setext (underline) headings (round-2 #23)", () => {
		// Blank lines separate the paragraphs, so "body" is not folded into "Sub".
		const hs = extractHeadings(lines("Title\n=====\n\nbody\n\nSub\n---"), noFences);
		expect(hs.map((h) => [h.text, h.level, h.slug])).toEqual([
			["Title", 1, "title"],
			["Sub", 2, "sub"],
		]);
	});

	it("folds a multi-line paragraph under one Setext underline into one heading (sol-max #14)", () => {
		const hs = extractHeadings(lines("First line\nsecond line\n---"), noFences);
		expect(hs.map((h) => [h.text, h.level, h.slug])).toEqual([
			["First line second line", 2, "first-line-second-line"],
		]);
	});
});

describe("extractSectionRefs", () => {
	it("extracts §, §§-range endpoints, Section-word, and Appendix refs", () => {
		const refs = extractSectionRefs(
			lines("See §7.3 and §§3–5; also Section 2.1 and Appendix C."),
			noFences,
		);
		expect(refs.map((r) => `${r.kind}:${r.ref}`)).toEqual([
			"section:7.3",
			"section:3",
			"section:5",
			"section:2.1",
			"appendix:C",
		]);
	});

	it("skips heading lines and fenced lines", () => {
		expect(extractSectionRefs(lines("## 7.3 About §9"), noFences)).toEqual([]);
		expect(extractSectionRefs(lines("see §9"), new Set([1]))).toEqual([]);
	});

	it("drops malformed dotted tokens and trims trailing periods", () => {
		const refs = extractSectionRefs(
			lines("see §7.3. Then §.5 and §7..3 are noise"),
			noFences,
		);
		expect(refs.map((r) => r.ref)).toEqual(["7.3"]);
	});
});

describe("extractAnchorLinks", () => {
	it("classifies same-file anchors, cross-file paths, and path#anchor", () => {
		const links = extractAnchorLinks(
			lines(
				"[a](#setup) then [b](./other.md#deep-dive) then [c](docs/plan.md) and ![img](assets/x.png)",
			),
			noFences,
		);
		expect(links).toEqual([
			expect.objectContaining({ anchor: "setup" }),
			expect.objectContaining({ targetFile: "./other.md", anchor: "deep-dive" }),
			expect.objectContaining({ targetFile: "docs/plan.md" }),
			expect.objectContaining({ targetFile: "assets/x.png" }),
		]);
	});

	it("skips external schemes and empty anchors", () => {
		const links = extractAnchorLinks(
			lines("[x](https://a.b) [m](mailto:a@b.c) [p](#)"),
			noFences,
		);
		expect(links).toEqual([]);
	});

	it("stays linear on bracket-heavy malformed lines (round-2 #1 ReDoS)", () => {
		const evil = "[".repeat(80_000);
		const start = Date.now();
		expect(extractAnchorLinks([evil], noFences)).toEqual([]);
		expect(Date.now() - start).toBeLessThan(REDOS_GUARD_MS);
	});
});

describe("markdown-parsing hardening (sol-max batch 1)", () => {
	it("slugs bracket-heavy input in linear time (#15) and drops raw tags/entities (#21)", () => {
		const start = Date.now();
		githubSlug("[".repeat(40_000));
		expect(Date.now() - start).toBeLessThan(REDOS_GUARD_MS);
		expect(githubSlug("<em>API</em>")).toBe("api");
		expect(githubSlug("Dogs &#38; Cats")).toBe("dogs--cats");
	});

	it("does not treat list items, blockquotes, or indented code as Setext headings (#16)", () => {
		expect(extractHeadings(["- list item", "---"], noFences)).toEqual([]);
		expect(extractHeadings(["> quote", "---"], noFences)).toEqual([]);
		expect(extractHeadings(["    code", "==="], noFences)).toEqual([]);
	});

	it("excludes Setext heading text from section-ref scanning (#17)", () => {
		expect(extractSectionRefs(lines("About §9\n---"), noFences)).toEqual([]);
	});

	it("dedups slugs against ALL emitted slugs, never twice (#18)", () => {
		expect(
			extractHeadings(lines("## Setup\n## Setup-1\n## Setup"), noFences).map((h) => h.slug),
		).toEqual(["setup", "setup-1", "setup-2"]);
	});

	it("ignores markdown inside inline code (#19) and keeps links with titles (#20)", () => {
		expect(extractAnchorLinks(["`[plan](missing.md)`"], noFences)).toEqual([]);
		expect(
			extractAnchorLinks(['[plan](docs/plan.md "Plan")'], noFences).map((l) => l.targetFile),
		).toEqual(["docs/plan.md"]);
	});

	it("rejects a section token that runs into letters (#22) and extracts indented ATX headings (#23)", () => {
		expect(extractSectionRefs(["See §7.3abc"], noFences)).toEqual([]);
		expect(extractHeadings(["   ## Setup"], noFences).map((h) => h.slug)).toEqual(["setup"]);
	});
});

describe("markdown-parsing hardening (sol-max batch 2)", () => {
	it("drops unknown named entities and preserves autolinks (round-4 #10/#11)", () => {
		expect(githubSlug("Dogs&copy;Cats")).toBe("dogscats");
		expect(githubSlug("<https://example.com>")).toBe("httpsexamplecom");
	});

	it("keeps realistic long links but stays ReDoS-bounded (round-4 #12)", () => {
		expect(
			extractAnchorLinks([`[${"a".repeat(501)}](missing.md)`], noFences).map((l) => l.targetFile),
		).toEqual(["missing.md"]);
		const start = Date.now();
		githubSlug("[".repeat(40_000));
		expect(Date.now() - start).toBeLessThan(REDOS_GUARD_MS);
	});

	it("dedups repeated headings in linear time (round-4 #15)", () => {
		const start = Date.now();
		extractHeadings(Array(10_000).fill("## Setup"), noFences);
		expect(Date.now() - start).toBeLessThan(REDOS_GUARD_MS);
	});

	it("rejects section tokens running into digits or unicode letters (round-4 #16)", () => {
		expect(extractSectionRefs(["Section 7.3abc here"], noFences)).toEqual([]);
		expect(extractSectionRefs(["See §7.3é"], noFences)).toEqual([]);
	});

	it("ignores §-refs inside inline code (round-4 #17)", () => {
		expect(extractSectionRefs(["Use `§9` as a literal"], noFences)).toEqual([]);
	});

	it("parses single-quote titles, balanced parens; rejects escaped brackets (round-4 #18)", () => {
		const t = (s: string) => extractAnchorLinks([s], noFences).map((l) => l.targetFile);
		expect(t("[x](docs/a.md 'Title')")).toEqual(["docs/a.md"]);
		expect(t("[x](docs/a(b).md)")).toEqual(["docs/a(b).md"]);
		expect(extractAnchorLinks(["\\[x](missing.md)"], noFences)).toEqual([]);
	});

	it("blanks backtick-RUN code spans, not just single backticks (round-4 #19)", () => {
		expect(extractAnchorLinks(["``[x](missing.md)``"], noFences)).toEqual([]);
	});
});

describe("link grammar (round-5 #2/#14/#19/#21/#22/#23)", () => {
	const targets = (s: string) =>
		extractAnchorLinks([s], noFences).map((l) => l.targetFile);

	it("renders real links, refs, and images through the delimiter guard (#2)", () => {
		expect(githubSlug("[Install](https://example.com) now")).toBe("install-now");
		// An UNDEFINED reference link renders literally (round-7 #16) — the old
		// "text-a-more" pin encoded that bug. The DEFINED case is pinned in the
		// extract-refs-slug round-7 suite.
		expect(extractHeadings(lines("# text [a][ref] more"), noFences)[0]?.slug).toBe(
			"text-aref-more",
		);
		expect(extractHeadings(lines("# ![img](x.png) caption"), noFences)[0]?.slug).toBe(
			"img-caption",
		);
	});

	it("leaves delimiter-free text unchanged when the guard skips (#2)", () => {
		expect(githubSlug("plain heading text")).toBe("plain-heading-text");
		expect(githubSlug("array[i] and array[j]")).toBe("arrayi-and-arrayj");
		expect(githubSlug("function(x) returns")).toBe("functionx-returns");
	});

	it("stays under budget on 320k brackets via the guard; regex path at 240k (#2)", () => {
		const start = Date.now();
		expect(extractHeadings(lines(`# ${"[".repeat(320_000)}`), noFences)).toHaveLength(1);
		expect(Date.now() - start).toBeLessThan(REDOS_GUARD_MS);
		const regexPath = Date.now();
		expect(extractAnchorLinks(["[".repeat(240_000)], noFences)).toEqual([]);
		expect(Date.now() - regexPath).toBeLessThan(REDOS_GUARD_MS);
	});

	it("slugs a heading link with balanced destination parens as its text (#14)", () => {
		expect(githubSlug("[API](docs/a(b).md)")).toBe("api");
		expect(githubSlug("[Guide](a(b(c)).md)")).toBe("guide");
		expect(githubSlug("[X](docs/a.md (Title))")).toBe("x");
	});

	it("accepts paren title, angle dest, escaped-label bracket, 2-level nesting (#19)", () => {
		expect(targets("[x](docs/a.md (Title))")).toEqual(["docs/a.md"]);
		expect(targets("[x](<docs/a b.md>)")).toEqual(["docs/a b.md"]);
		expect(targets("[a\\]b](x.md)")).toEqual(["x.md"]);
		expect(targets("[x](a(b(c)).md)")).toEqual(["a(b(c)).md"]);
	});

	it("rejects escaped-open, unclosed, and 3+-level nesting (#19 residual)", () => {
		expect(extractAnchorLinks(["\\[x](missing.md)"], noFences)).toEqual([]);
		expect(extractAnchorLinks(["[x](a(b(c(d))).md)"], noFences)).toEqual([]);
		expect(extractAnchorLinks(["[x](y"], noFences)).toEqual([]);
	});

	it("keeps whitespace tolerance around dest and before titles (verify amendment)", () => {
		expect(targets("[x](a.md )")).toEqual(["a.md"]);
		expect(targets("[x]( a.md)")).toEqual(["a.md"]);
		expect(githubSlug("[x](a.md )")).toBe("x");
		expect(extractHeadings(lines("# [API](docs/x.md ) note"), noFences)[0]?.slug).toBe(
			"api-note",
		);
		expect(targets('[x](a.md "T")')).toEqual(["a.md"]);
		// NBSP is NOT a legal link separator (round-7 #24): a link whose only
		// dest/title separator is U+00A0 renders literally, not as a link.
		expect(targets('[x](a.md "T")')).toEqual([]);
	});

	it("treats scheme-relative // targets as external (#21) but keeps real paths", () => {
		expect(extractAnchorLinks(["[x](//example.com/a)"], noFences)).toEqual([]);
		expect(extractAnchorLinks(["[y](<//cdn.example.com/z>)"], noFences)).toEqual([]);
		expect(targets("[a](/root-relative.md)")).toEqual(["/root-relative.md"]);
		expect(targets("[b](./rel.md)")).toEqual(["./rel.md"]);
	});

	it("rejects a bare destination starting with an unmatched < (#22)", () => {
		expect(extractAnchorLinks(["[x](<bad)"], noFences)).toEqual([]);
		expect(extractAnchorLinks(["[y](<)"], noFences)).toEqual([]);
		expect(targets("[x](<a b.md>)")).toEqual(["a b.md"]);
		expect(targets("[y](a<b.md)")).toEqual(["a<b.md"]);
	});

	it("enforces a real total-length destination cap under budget (#23)", () => {
		const start = Date.now();
		expect(extractAnchorLinks([`[x]((${"a".repeat(100_000)}))`], noFences)).toEqual([]);
		expect(extractAnchorLinks([`[x](${"a".repeat(100_000)})`], noFences)).toEqual([]);
		expect(Date.now() - start).toBeLessThan(REDOS_GUARD_MS);
		expect(targets(`[x](${"a".repeat(400)}.md)`)).toEqual([`${"a".repeat(400)}.md`]);
	});
});

describe("entity decode + unicode boundaries (round-5 #13/#17)", () => {
	it("decodes letter entities so rendered letters survive slugging (#13)", () => {
		expect(githubSlug("Caf&eacute;")).toBe("café");
		expect(githubSlug("Ma&ntilde;ana")).toBe("mañana");
		expect(githubSlug("&Eacute;tude")).toBe("étude");
	});

	it("leaves an unrecognized named reference literal (#13)", () => {
		expect(githubSlug("&bogus;")).toBe("bogus");
		expect(githubSlug("A&notreal;B")).toBe("anotrealb");
		expect(githubSlug("&constructor;")).toBe("constructor");
	});

	it("strips known symbol entities like GitHub instead of decoding them live (#13 amendment)", () => {
		expect(githubSlug("Getting&nbsp;Started")).toBe("gettingstarted");
		expect(githubSlug("Save &frac12; now")).toBe("save--now");
		expect(githubSlug("Dogs&copy;Cats")).toBe("dogscats");
		expect(githubSlug("&amp;copy;")).toBe("copy"); // single-pass: no double decode
	});

	it("keeps prior outputs and the unbounded tag-name strip (verify amendment)", () => {
		expect(githubSlug("Dogs &amp; Cats")).toBe("dogs--cats");
		expect(githubSlug("a &lt;b&gt; c")).toBe("a-b-c");
		expect(githubSlug(`<${"a".repeat(70)}>tag`)).toBe("tag");
		expect(githubSlug("R&D and Q&A")).toBe("rd-and-qa");
	});

	it("rejects refs glued to trailing letters/digits in any plane (#17)", () => {
		expect(extractSectionRefs(["§7.3𝐀"], noFences)).toEqual([]);
		expect(extractSectionRefs(["Section 7.3𝐀"], noFences)).toEqual([]);
		expect(extractSectionRefs(["Appendix C𝐀"], noFences)).toEqual([]);
		expect(extractSectionRefs(["Appendix Cé"], noFences)).toEqual([]);
	});

	it("rejects word/appendix refs glued to a leading non-ASCII letter (#17)", () => {
		expect(extractSectionRefs(["préSection 7"], noFences)).toEqual([]);
		expect(extractSectionRefs(["préAppendix C"], noFences)).toEqual([]);
		expect(extractSectionRefs(["ΩSection 3"], noFences)).toEqual([]);
	});

	it("still emits at legitimate boundaries; unpaired surrogate is not a word char", () => {
		const kinds = (l: string) =>
			extractSectionRefs([l], noFences).map((r) => `${r.kind}:${r.ref}`);
		expect(kinds("(§7.3)")).toEqual(["section:7.3"]);
		expect(kinds("in Appendix C.")).toEqual(["appendix:C"]);
		expect(kinds("Appendix C 𝐀")).toEqual(["appendix:C"]);
		expect(kinds("x\udc00Section 7")).toEqual(["section:7"]);
	});
});

describe("Setext structure (round-5 #15/#16)", () => {
	it("folds a paragraph longer than the old 8-line cap into ONE heading at line 1 (#15)", () => {
		const text = Array.from({ length: 10 }, (_, k) => `line ${k + 1}`);
		const hs = extractHeadings([...text, "---"], noFences);
		expect(hs).toHaveLength(1);
		expect(hs[0]).toEqual(
			expect.objectContaining({ line: 1, level: 2, text: text.join(" ") }),
		);
	});

	it("does not fold across a blank line (#15)", () => {
		const hs = extractHeadings(lines("intro one\nintro two\n\nTitle\n==="), noFences);
		expect(hs.map((h) => [h.text, h.level])).toEqual([["Title", 1]]);
	});

	it("emits no heading for a long paragraph with no underline, in linear time (#15)", () => {
		const start = Date.now();
		expect(extractHeadings(Array(100_000).fill("a"), noFences)).toEqual([]);
		expect(Date.now() - start).toBeLessThan(REDOS_GUARD_MS);
	});

	it("caps degenerate megabyte folds without losing the heading (#15 amendment)", () => {
		const start = Date.now();
		const big = extractHeadings([...Array(2000).fill("[".repeat(500)), "==="], noFences);
		expect(big).toHaveLength(1);
		expect(big[0]).toEqual(expect.objectContaining({ line: 1, level: 1 }));
		const wide = extractHeadings([...Array(40).fill("[".repeat(8000)), "==="], noFences);
		expect(wide).toHaveLength(1);
		expect(Date.now() - start).toBeLessThan(REDOS_GUARD_MS);
	});

	it("rejects thematic breaks as Setext text (#16)", () => {
		expect(extractHeadings(["***", "---"], noFences)).toEqual([]);
		expect(extractHeadings(["___", "---"], noFences)).toEqual([]);
		expect(extractHeadings(["* * *", "---"], noFences)).toEqual([]);
		expect(extractHeadings(["- - -", "==="], noFences)).toEqual([]);
	});

	it("rejects tab-indented code as Setext text (#16)", () => {
		expect(extractHeadings(["\tcode", "==="], noFences)).toEqual([]);
		expect(extractHeadings(["  \tcode", "==="], noFences)).toEqual([]);
	});

	it("recognizes an empty ATX heading (round-6 #11)", () => {
		const hs = extractHeadings(["#"], noFences);
		expect(hs.map((h) => [h.level, h.text])).toEqual([[1, ""]]);
	});

	it("applies one glyph filter to numeric AND named entities (round-6 #12)", () => {
		expect(githubSlug("Getting&#160;Started")).toBe("gettingstarted");
		expect(githubSlug("Save &#189; now")).toBe("save--now");
		expect(githubSlug("&#53; steps")).toBe("5-steps");
	});

	it("removes inline HTML comments from heading slugs (round-6 #13)", () => {
		expect(extractHeadings(["# Setup <!-- old -->"], noFences)[0]?.slug).toBe("setup");
	});

	it("treats combining marks as word-glue on both sides (round-6 #19)", () => {
		expect(extractSectionRefs(["éSection 7"], noFences)).toEqual([]);
		expect(extractSectionRefs(["Appendix Ćase"], noFences)).toEqual([]);
	});

	it("honors backslash PARITY on the link opener (round-6 #21)", () => {
		expect(
			extractAnchorLinks(["\\\\[x](missing.md)"], noFences).map((l) => l.targetFile),
		).toEqual(["missing.md"]);
		expect(extractAnchorLinks(["\\[x](missing.md)"], noFences)).toEqual([]);
	});

	it("applies backslash escapes inside destinations before classifying (round-6 #22)", () => {
		expect(extractAnchorLinks(["[x](http\\://example.com)"], noFences)).toEqual([]);
	});

	it("records raw provenance from the ORIGINAL line, not the mask (round-6 #23)", () => {
		const links = extractAnchorLinks(["[a<!--c-->b](missing.md)"], noFences);
		expect(links[0]?.raw).toBe("[a<!--c-->b](missing.md)");
	});

	it("still emits headings for emphasis runs, dashed text, and 3-space indents (#16)", () => {
		expect(
			extractHeadings(["***emphasis***", "---"], noFences).map((h) => [h.text, h.level]),
		).toEqual([["***emphasis***", 2]]);
		expect(extractHeadings(["-- x", "---"], noFences).map((h) => [h.text, h.level])).toEqual([
			["-- x", 2],
		]);
		expect(
			extractHeadings(["   three space", "==="], noFences).map((h) => [h.text, h.level]),
		).toEqual([["three space", 1]]);
	});
});

describe("shared link-label grammar + bounded scans (round-7 #15/#20)", () => {
	const targets = (s: string) =>
		extractAnchorLinks([s], noFences).map((l) => l.targetFile);

	it("keeps extracting labels that mix long runs and escapes (#20)", () => {
		expect(targets(`[${"a".repeat(400)}\\]${"b".repeat(80)}](x.md)`)).toEqual(["x.md"]);
		expect(targets("[a\\]b\\]c](x.md)")).toEqual(["x.md"]);
		expect(targets("[a\\[b](x.md)")).toEqual(["x.md"]);
	});

	it("bounds TOTAL label work: escape-segment bombs and bracket floods run linear (#20)", () => {
		const start = Date.now();
		expect(extractAnchorLinks([("[".repeat(512) + "\\x").repeat(200)], noFences)).toEqual([]);
		expect(extractAnchorLinks([("[".repeat(512) + "\\x").repeat(622)], noFences)).toEqual([]);
		expect(extractAnchorLinks(["[".repeat(320_000)], noFences)).toEqual([]);
		expect(Date.now() - start).toBeLessThan(REDOS_GUARD_MS);
	});

	it("still finds a real link after an escape-bomb prefix, on the regex path (#20)", () => {
		const start = Date.now();
		expect(targets(`${("[".repeat(512) + "\\x").repeat(200)}](y)`)).toEqual(["y"]);
		expect(Date.now() - start).toBeLessThan(REDOS_GUARD_MS);
	});

	it("holds the regex path under budget at 240k brackets with a real tail link (#20)", () => {
		const start = Date.now();
		expect(targets(`${"[".repeat(240_000)}](y)`)).toEqual(["y"]);
		expect(Date.now() - start).toBeLessThan(REDOS_GUARD_MS);
	});

	it("rejects labels past the 512-unit total bound, trailing escapes, escaped openers (#20)", () => {
		expect(extractAnchorLinks([`[${"a".repeat(600)}](x.md)`], noFences)).toEqual([]);
		expect(extractAnchorLinks(["[a\\](x.md)"], noFences)).toEqual([]);
		expect(extractAnchorLinks(["\\[a\\]b](x.md)"], noFences)).toEqual([]);
	});

	it("keeps opener parity linear on 320k backslash runs (#20 measurement)", () => {
		const start = Date.now();
		expect(extractAnchorLinks(["\\".repeat(320_000)], noFences)).toEqual([]);
		expect(targets(`${"\\".repeat(320_000)}[x](y)`)).toEqual(["y"]);
		expect(extractAnchorLinks([`${"\\".repeat(319_999)}[x](y)`], noFences)).toEqual([]);
		expect(Date.now() - start).toBeLessThan(REDOS_GUARD_MS);
	});

	it("slugs escaped-bracket labels as their rendered text (#15)", () => {
		expect(githubSlug("[a\\]b](x.md)")).toBe("ab");
		expect(extractHeadings(["# [a\\]b](x.md) note"], noFences)[0]?.slug).toBe("ab-note");
		expect(githubSlug("[a\\]b][ref]")).toBe("ab");
	});

	it("leaves non-link bracket text unreduced; masks still win (#15)", () => {
		expect(githubSlug("[a\\](x.md)")).toBe("axmd");
		expect(githubSlug("plain [brackets] text")).toBe("plain-brackets-text");
		expect(extractAnchorLinks(["`[a\\]b](x.md)`"], noFences)).toEqual([]);
	});
});

describe("round-7 review batch (refs / links / slug)", () => {
	const tgt = (s: string) => extractAnchorLinks([s], noFences).map((l) => l.targetFile);

	it("reads section-number/appendix metadata through heading emphasis (#11)", () => {
		expect(extractHeadings(lines("## **7.3 Phantoms**"), noFences)[0]?.sectionNumber).toBe("7.3");
		expect(extractHeadings(lines("## *Appendix C*"), noFences)[0]?.appendixLetter).toBe("C");
	});

	it("does not read a §ref/appendix inside a link destination or title (#16)", () => {
		expect(extractSectionRefs(["see [x](https://e.com/#§9)"], noFences)).toEqual([]);
		expect(extractSectionRefs(['[x](foo "Appendix C")'], noFences)).toEqual([]);
		expect(extractSectionRefs(["see §9 in [x](y)"], noFences).map((r) => r.ref)).toEqual(["9"]);
	});

	it("entity-decodes a link destination before classifying it (#17)", () => {
		expect(extractAnchorLinks(["[x](h&#116;tp://example.com)"], noFences)).toEqual([]); // → external
		expect(extractAnchorLinks(["[x](#caf&eacute;)"], noFences)[0]?.anchor).toBe("café");
	});

	it("accepts an escaped structural paren in a destination (#23)", () => {
		expect(tgt("[x](foo\\(bar)")).toEqual(["foo(bar"]);
	});

	it("strips self-closing and hyphenated custom tags from slugs (#25)", () => {
		expect(githubSlug("A<br/>B")).toBe("ab");
		expect(githubSlug("<x-y>API</x-y>")).toBe("api");
	});
});
