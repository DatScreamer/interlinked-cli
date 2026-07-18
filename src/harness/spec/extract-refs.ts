// Headings, anchor slugs, section references, and markdown links
// (spec-facts substrate). Feeds spec_dangling_anchor / spec_xref_integrity
// (docs/design/spec-audit-runtime-checks.md §3.3, class B3).

import { decodeEntities as decodeEntitiesShared } from "./entity-names.js";
import { maskInlineIgnorable, withCommentBlockLines } from "./extract-refs-masking.js";
import type { AnchorLink, HeadingInfo, SectionRef } from "./types.js";

// CommonMark permits up to 3 leading spaces before an ATX heading (sol-max #23);
// 4+ is indented code, not a heading. The opening run may also end the line —
// "#" alone is a valid EMPTY heading (round-6 #11).
const HEADING_RE = /^ {0,3}(#{1,6})(?:\s+(.*))?$/;

/** Validate a dotted section-number token ("7", "7.3", "7.3.1") captured by
 *  the flat scan patterns. Split-based — no regex, provably linear. */
function asSectionNumber(token: string | undefined): string | undefined {
	if (!token) return undefined;
	const trimmed = token.endsWith(".") ? token.slice(0, -1) : token;
	if (!trimmed) return undefined;
	const parts = trimmed.split(".");
	const allNumeric = parts.every(
		(p) => p.length > 0 && [...p].every((c) => c >= "0" && c <= "9"),
	);
	return allNumeric ? trimmed : undefined;
}

/** GitHub-style anchor slug (lowercase, punctuation stripped, spaces to -).
 *  Public substrate API — checks and the ledger resolve anchors through it.
 *  Entity decoding lives in entity-names.ts (line-cap split; round-6 #12 keeps
 *  named and numeric references on ONE glyph filter). */
export function githubSlug(text: string): string {
	// GitHub slugs the RENDERED heading text (round-2 #23): a link
	// "[Install](url)" renders as "Install", HTML comments render NOTHING and
	// are removed outright — space-masking would hyphenate (round-6 #13) — raw
	// tags are dropped (sol-max #21: "<em>API</em>" → "api"), entities decode,
	// and each whitespace char becomes one hyphen — GitHub does NOT collapse
	// runs. The tag pattern matches only real HTML tags (`</?name …>`), so a
	// `<https://…>` autolink is NOT deleted (sol-max #11).
	return decodeEntitiesShared(
		renderInline(text)
			.replace(/<!--[^\n]{0,2000}?-->/g, "")
			.replace(/<\/?[a-z][a-z0-9]*(?:\s[^>\n]{0,200})?>/gi, ""),
	)
		.toLowerCase()
		.replace(/[`*_~[\]()]/g, "")
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.trim()
		.replace(/\s/g, "-");
}

/** Reduce inline markdown to its rendered text: link `[text](url)` → text,
 *  image `![alt](url)` → alt, autolinks/code kept as-is minus delimiters. The
 *  label scan is O(bound·n) from every `[`, so a bracket-only line carrying NO
 *  link/ref delimiter at all skips both replaces via a cheap substring guard
 *  (round-5 #2): "[".repeat(320k) drops from ~1.6s to one linear pass. The
 *  destination admits balanced parens (≤2 levels) plus an angle `<…>` form so a
 *  heading link `[API](docs/a(b).md)` renders as `API`, not `API.md)` (round-5
 *  #14), with `[^\S\n]`-bounded whitespace around dest and title — CommonMark
 *  allows spaces there, and JS `\s` (incl. nbsp) minus newline preserves what
 *  the old `[^)\n]` accepted (adversarial-verify amendment). Label bound 256
 *  keeps the guarded worst case (a line with BOTH delimiters) under budget;
 *  heading link TEXT longer than that is left unreduced (rare — link text is
 *  short). */
function renderInline(text: string): string {
	let out = text;
	if (out.includes("](")) {
		// links/images → text; balanced-paren / angle dest, bounded title
		out = out.replace(
			/!?\[([^\]\n]{0,256})\]\([^\S\n]{0,64}(?:<[^<>\n]{0,4096}>|(?:[^()\s]|\((?:[^()\s]|\([^()\s]{0,512}\)){0,512}\)){0,4096})(?:[^\S\n]{1,64}(?:"[^"\n]{0,2000}"|'[^'\n]{0,2000}'|\([^()\n]{0,2000}\)))?[^\S\n]{0,64}\)/g,
			"$1",
		);
	}
	if (out.includes("][")) {
		out = out.replace(/!?\[([^\]\n]{0,256})\]\[[^\]\n]{0,256}\]/g, "$1"); // reference links → text
	}
	return out;
}

/** Replace inline-code spans AND same-line HTML comments with equal-length
 *  spaces so their markdown is not parsed as live refs/links (sol-max #17/#19,
 *  round-5 #18/#20) while preserving column offsets. Impl lives in
 *  extract-refs-masking.ts (line-cap split): CommonMark equal-run backtick
 *  pairing — the old `(`+)[^\n]*?\1` paired UNEQUAL runs, wrongly masking the
 *  live §9 in "`§9``". Fed only to the ref/link scanners, never to
 *  block-structure decisions. */
function blankInlineCode(line: string): string {
	return maskInlineIgnorable(line);
}

/** Leading section number in a heading ("7.3" in "### 7.3 Phantoms"). */
function headingSectionNumber(text: string): string | undefined {
	const m = /^([\d.]{1,16})\s+/.exec(text);
	return asSectionNumber(m?.[1]);
}

/** Appendix letter in a heading ("C" in "## Appendix C — formats"). */
function headingAppendixLetter(text: string): string | undefined {
	const m = /^appendix\s+([a-z])\b/i.exec(text);
	return m?.[1]?.toUpperCase();
}

/**
 * Extract headings with deduplicated GitHub slugs (-1/-2 suffixes on
 * repeats, matching GitHub's anchor generation).
 */
/** A Setext underline: a run of "=" (level 1) or "-" (level 2) under a non-blank
 *  text line. At most 3 leading spaces — 4+ is indented code, not an underline
 *  (sol-max #13). */
function setextLevel(line: string): 1 | 2 | null {
	if (/^ {0,3}=+\s*$/.test(line)) return 1;
	if (/^ {0,3}-+\s*$/.test(line)) return 2;
	return null;
}

/** A Setext heading's TEXT line must be a PARAGRAPH — not blank, another
 *  underline, a THEMATIC BREAK, an ATX heading, a list item, a blockquote, or
 *  indented code (sol-max #16, round-5 #16). A blockquote marker `>` needs no
 *  following space, while an ATX heading DOES require one (`#tag` is paragraph
 *  text — sol-max #13). Indentation counts a leading tab as 4 columns
 *  (CommonMark tab stops), so a tab within the first 3 columns is indented
 *  code; a thematic break (`***`/`___`/spaced runs of 3+) is not paragraph
 *  text. `---` runs are already rejected as underlines by setextLevel. */
function isSetextTextEligible(line: string): boolean {
	if (line.trim() === "" || setextLevel(line) !== null) return false;
	// Indented code: 4+ leading spaces OR a tab reachable in the first 3 columns.
	if (/^(?: {0,3}\t| {4,})/.test(line)) return false;
	// Thematic break: ≤3 leading spaces then 3+ matching -, _, or * with optional
	// spaces/tabs between. ReDoS-safe: `\1` is a literal distinct from `[ \t]`,
	// so the adjacent quantifiers can never match the same char.
	if (/^ {0,3}([-_*])[ \t]*(?:\1[ \t]*){2,}$/.test(line)) return false;
	return !/^\s*(?:[-*+]\s|\d+[.)]\s|>|#{1,6}\s)/.test(line); // list / quote / ATX
}

/** Last index of the consecutive paragraph run starting at `i` — the lines a
 *  following Setext underline folds into ONE heading (sol-max #14). No line cap:
 *  a Setext heading may have any positive number of text lines, so the WHOLE
 *  paragraph folds in — a cap emitted a TRUNCATED suffix heading with wrong text
 *  and provenance (round-5 #15). Linearity comes from the run-start gate in
 *  headingAt (scans begin only at a run's first line, and runs are disjoint) —
 *  not from a cap; the folded TEXT is bounded separately by joinSetextText. */
function setextTextRunEnd(
	lines: string[],
	i: number,
	fencedLines: Set<number>,
): number {
	let j = i;
	// isSetextTextEligible already rejects underlines (setextLevel != null), so
	// the run stops right before the =/- underline without a separate check.
	while (
		j + 1 < lines.length &&
		!fencedLines.has(j + 2) &&
		isSetextTextEligible(lines[j + 1] ?? "")
	) {
		j++;
	}
	return j;
}

/** Whether line `i` (0-based) STARTS a paragraph run — its predecessor is not
 *  an unfenced, Setext-eligible run member. A Setext underline attaches to the
 *  WHOLE preceding paragraph, so a heading may begin only at the run's first
 *  line: starting mid-run folded a truncated suffix with wrong text and wrong
 *  provenance (round-5 #15). The gate is also the linearity guarantee for the
 *  uncapped run scan — interior lines return null in O(1), so each disjoint run
 *  is walked once. */
function isSetextRunStart(
	lines: string[],
	i: number,
	fencedLines: Set<number>,
): boolean {
	if (i === 0 || fencedLines.has(i)) return true;
	return !isSetextTextEligible(lines[i - 1] ?? "");
}

/** Cap on a folded Setext heading's TEXT length. Folding is unbounded in LINES
 *  (CommonMark allows any positive number), but the joined text feeds
 *  githubSlug, and a degenerate megabyte-scale fold would hand slugging an
 *  unbounded string (adversarial verify: 1MB fold → multi-second slug). Real
 *  multi-line Setext headings are far under this; past the cap the SLUG is
 *  truncated while line-range provenance stays exact. */
const SETEXT_TEXT_CAP = 4096;

/** Run lines joined by single spaces, capped at SETEXT_TEXT_CAP chars. */
function joinSetextText(lines: string[], i: number, j: number): string {
	let text = "";
	for (let k = i; k <= j && text.length < SETEXT_TEXT_CAP; k++) {
		const t = (lines[k] ?? "").trim();
		text = text ? `${text} ${t}` : t;
	}
	return text.length > SETEXT_TEXT_CAP ? text.slice(0, SETEXT_TEXT_CAP) : text;
}

/** One ATX or Setext heading resolved from line `i`, or null. Returns the
 *  text, level, and the number of extra lines (paragraph continuations +
 *  underline) the heading consumed after `i`. */
function headingAt(
	lines: string[],
	i: number,
	fencedLines: Set<number>,
): { text: string; level: number; consumed: number } | null {
	if (fencedLines.has(i + 1)) return null;
	const line = lines[i] ?? "";
	const atx = HEADING_RE.exec(line);
	if (atx) return { text: (atx[2] ?? "").trim(), level: (atx[1] ?? "#").length, consumed: 0 };
	// Setext: a paragraph run followed by an =/- underline, folded from the
	// run's FIRST line only (sol-max #14, round-5 #15).
	if (!isSetextTextEligible(line)) return null;
	if (!isSetextRunStart(lines, i, fencedLines)) return null;
	const j = setextTextRunEnd(lines, i, fencedLines);
	if (j + 1 >= lines.length || fencedLines.has(j + 2)) return null;
	const level = setextLevel(lines[j + 1] ?? "");
	if (level === null) return null;
	return { text: joinSetextText(lines, i, j), level, consumed: j - i + 1 };
}

export function extractHeadings(
	lines: string[],
	fencedLines: Set<number>,
): HeadingInfo[] {
	const out: HeadingInfo[] = [];
	// Whole-line HTML comment blocks are hidden content — no headings inside
	// (round-5 #20). Line-level only: block decisions still read RAW lines.
	const skip = withCommentBlockLines(lines, fencedLines);
	// Dedup against ALL previously emitted slugs (sol-max #18): "Setup / Setup-1 /
	// Setup" advances the third to "setup-2". The per-base suffix RESUMES where it
	// last stopped instead of restarting at 1, so N identical headings cost O(N),
	// not O(N²) (sol-max #15).
	const used = new Set<string>();
	const nextN = new Map<string, number>();
	for (let i = 0; i < lines.length; i++) {
		const h = headingAt(lines, i, skip);
		if (!h) continue;
		const base = githubSlug(h.text);
		let slug = base;
		let n = nextN.get(base) ?? 1;
		while (used.has(slug)) {
			slug = `${base}-${n}`;
			n++;
		}
		nextN.set(base, n);
		used.add(slug);
		const sectionNumber = headingSectionNumber(h.text);
		const appendixLetter = headingAppendixLetter(h.text);
		out.push({
			line: i + 1,
			level: h.level,
			text: h.text,
			slug,
			...(sectionNumber ? { sectionNumber } : {}),
			...(appendixLetter ? { appendixLetter } : {}),
		});
		i += h.consumed; // skip the Setext underline
	}
	return out;
}

// "§7.3" / "§§3–5" / "Section 7.3" / "Appendix C". Flat token captures
// (validated by asSectionNumber) keep the scan patterns free of nested
// quantifiers. The double-section form expands to both endpoints
// (intermediate sections are not required to exist — authors write §§3–5
// across renumbered gaps).
const SECTION_SIGN_RE = /§§?\s?([\d.]{1,16})(?:\s?[–—-]\s?([\d.]{1,16}))?/g;
const SECTION_WORD_RE = /\bSection\s+([\d.]{1,16})\b/g;
const APPENDIX_RE = /\bAppendix\s+([A-Z])\b/g;

/** A single letter, digit, or COMBINING MARK in ANY Unicode plane. Marks count
 *  as word-glue: a decomposed "é" ends in a mark, and a token glued to it
 *  ("éSection 7") is one word, not a boundary (round-6 #19). Boundary
 *  predicates test exactly one whole code point, never a lone surrogate. */
const BOUNDARY_WORD_RE = /[\p{L}\p{N}\p{M}]/u;

/** The whole code point (astral-safe) whose UTF-16 encoding STARTS at `pos`, or
 *  "" past end-of-string — `s[pos]` alone would yield just the high surrogate of
 *  an astral char. */
function codePointStartingAt(s: string, pos: number): string {
	const cp = s.codePointAt(pos);
	return cp === undefined ? "" : String.fromCodePoint(cp);
}

/** The whole code point (astral-safe) whose UTF-16 encoding ENDS just before
 *  `pos`, or "" at start-of-string. Back-step to pos-2 ONLY for a real surrogate
 *  PAIR — a low surrogate at pos-1 with no high surrogate before it is an
 *  unpaired code unit and must be read alone, not fused with the char before it
 *  (round-5 verify: "x\uDC00Section 7" must still emit the ref). */
function codePointEndingBefore(s: string, pos: number): string {
	if (pos <= 0) return "";
	const unit = s.charCodeAt(pos - 1);
	const prev = pos >= 2 ? s.charCodeAt(pos - 2) : 0;
	const isPair =
		unit >= 0xdc00 && unit <= 0xdfff && prev >= 0xd800 && prev <= 0xdbff;
	return codePointStartingAt(s, isPair ? pos - 2 : pos - 1);
}

/** Whether the char immediately AFTER match `m` runs the token into another
 *  letter OR digit (any Unicode, astral-safe) — the flat captures have no
 *  complete trailing boundary, so "§7.3abc", "§7.3é", "§7.3𝐀" (a surrogate
 *  pair), "Appendix Cé", and a 17-digit number would all truncate-and-mis-fire
 *  (sol-max #22/#16, round-5 #17). */
function runsIntoWordChar(line: string, m: RegExpMatchArray): boolean {
	const end = (m.index ?? 0) + (m[0]?.length ?? 0);
	return BOUNDARY_WORD_RE.test(codePointStartingAt(line, end));
}

/** Whether the char immediately BEFORE match `m` is a letter/digit (any Unicode,
 *  astral-safe). The word/appendix forms anchor on an ASCII `\b`, so a preceding
 *  NON-ASCII letter ("préSection 7", "préAppendix C") slips past `\b` and must be
 *  rejected here (round-5 #17). */
function precededByWordChar(line: string, m: RegExpMatchArray): boolean {
	return BOUNDARY_WORD_RE.test(codePointEndingBefore(line, m.index ?? 0));
}

/** Word-glue test for the WORD-anchored ref forms ("Section 7", "Appendix C"):
 *  the match must not run into a letter/digit on EITHER side (round-5 #17). The
 *  `§` sign form uses only the trailing half — `§` is self-delimiting. */
function hasWordCharGlue(line: string, m: RegExpMatchArray): boolean {
	return runsIntoWordChar(line, m) || precededByWordChar(line, m);
}

/** All section/appendix refs on one prose line. */
function refsOnLine(line: string, lineNo: number): SectionRef[] {
	const out: SectionRef[] = [];
	const add = (
		kind: SectionRef["kind"],
		ref: string | undefined,
		m: RegExpMatchArray,
	): void => {
		if (ref) out.push({ line: lineNo, kind, ref, raw: m[0] ?? "", col: m.index ?? 0 });
	};
	for (const m of line.matchAll(SECTION_SIGN_RE)) {
		// § is self-delimiting; only a trailing boundary is enforced (astral-safe).
		if (runsIntoWordChar(line, m)) continue;
		add("section", asSectionNumber(m[1]), m);
		add("section", asSectionNumber(m[2]), m);
	}
	for (const m of line.matchAll(SECTION_WORD_RE)) {
		if (hasWordCharGlue(line, m)) continue;
		add("section", asSectionNumber(m[1]), m);
	}
	for (const m of line.matchAll(APPENDIX_RE)) {
		// Appendix had NO boundary guard — "Appendix Cé" / "préAppendix C" mis-fired
		// (round-5 #17). Same Unicode boundary on both sides.
		if (hasWordCharGlue(line, m)) continue;
		add("appendix", m[1], m);
	}
	return out;
}

/** Lines occupied by a heading — ATX or Setext (text line AND its underline) —
 *  so section-ref scanning can skip them (sol-max #17). */
function headingOccupiedLines(lines: string[], fencedLines: Set<number>): Set<number> {
	const set = new Set<number>();
	for (let i = 0; i < lines.length; i++) {
		const h = headingAt(lines, i, fencedLines);
		if (!h) continue;
		for (let k = 0; k <= h.consumed; k++) set.add(i + 1 + k); // text lines + underline
		i += h.consumed;
	}
	return set;
}

/** Prose references to sections/appendices (heading lines excluded).
 *  Public substrate API — consumed by spec_dangling_anchor. */
export function extractSectionRefs(
	lines: string[],
	fencedLines: Set<number>,
): SectionRef[] {
	const skip = withCommentBlockLines(lines, fencedLines); // hidden comment blocks (round-5 #20)
	const headingLines = headingOccupiedLines(lines, skip);
	const out: SectionRef[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (skip.has(i + 1) || headingLines.has(i + 1)) continue;
		// Blank inline code + same-line comments so a literal `§9` example or a
		// commented-out §ref is not a live ref (sol-max #17, round-5 #20).
		out.push(...refsOnLine(blankInlineCode(lines[i] ?? ""), i + 1));
	}
	return out;
}

// [text](target) and ![alt](target). Targets with a scheme (http:, mailto:) are
// external and skipped; "#slug" is a same-file anchor; anything else is a relative
// path with an optional "#anchor". Char classes are BOUNDED (round-2 #1): an
// unbounded `[^\]]*` scanned to EOL from every `[` is O(n²). The LABEL bound is
// 512 (round-5 #2/#23) — it is the ReDoS-critical class scanned from every `[`,
// floored by the round-4 501-char-label test. The label admits an escaped
// bracket via an unrolled `\.`-tail (round-5 #19, `[a\]b](x)` — the lead class
// excludes `\`, the tail starts with it, so the two are disjoint); `(?<!\\)`
// rejects an escaped-open `\[x](y)`. The destination stays ONE capture group
// (extractAnchorLinks reads m[1]): either an angle `<…>` form (round-5 #19) or a
// bare dest that (a) may not start with `<` (round-5 #22), (b) admits ≤2 levels
// of balanced parens with EVERY inner class bounded so no single atom is
// unbounded (round-5 #23; 3+ levels are a noted residual), then re-capped by
// total length in classifyLinkTarget. Whitespace around dest/title uses
// `[^\S\n]` (JS whitespace minus newline, incl. nbsp — what the old `\s+`
// separator accepted) bounded to 64 (adversarial-verify amendment); the title
// accepts quoted OR parenthesized forms (round-5 #19).
// The opening guard is PARITY-aware (round-6 #21): `\[` after an EVEN run of
// backslashes is link-active ("\\[x](y)" renders one literal backslash then a
// LINK), while an odd run escapes it. Variable-length lookbehind, linear —
// each candidate `[` scans its own preceding backslash run once.
const MD_LINK_RE =
	/!?(?<=(?:^|[^\\])(?:\\\\)*)\[[^\]\n\\]{0,512}(?:\\.[^\]\n\\]{0,512}){0,64}\]\([^\S\n]{0,64}(<[^<>\n]{0,4096}>|(?!<)(?:[^()\s]|\((?:[^()\s]|\([^()\s]{0,512}\)){0,512}\)){1,4096})(?:[^\S\n]{1,64}(?:"[^"\n]{0,2000}"|'[^'\n]{0,2000}'|\([^()\n]{0,2000}\)))?[^\S\n]{0,64}\)/g;
const SCHEME_RE = /^[a-z][a-z0-9+.-]{0,63}:/i;

/** Normalize a captured link destination, or null for external/degenerate. An
 *  angle destination `<…>` arrives WITH its delimiters (one capture group serves
 *  both dest forms) — strip them; MD_LINK_RE only captures a well-formed `<…>`,
 *  so the endsWith guard is defense in depth (round-5 #19/#22). The length cap
 *  is the total-length backstop (round-5 #23): the regex bounds each atom, but
 *  nested paren groups still multiply. A `//`-prefixed target is scheme-RELATIVE
 *  — external, resolved against the host, never a local file (round-5 #21); a
 *  single-slash root-relative path is untouched. */
function resolveLinkDest(target: string): string | null {
	let dest = target;
	if (dest.startsWith("<")) {
		if (!dest.endsWith(">")) return null;
		dest = dest.slice(1, -1);
	}
	if (!dest || dest.length > 4096) return null;
	// CommonMark backslash escapes apply INSIDE destinations before any
	// classification: "http\://example.com" renders as the external URL, not a
	// local file named "http\:…" (round-6 #22). ASCII punctuation only.
	dest = dest.replace(/\\([!-/:-@[-`{-~])/g, "$1");
	if (SCHEME_RE.test(dest)) return null; // external scheme (http:, mailto:, …)
	if (dest.startsWith("//")) return null; // scheme-relative → external
	return dest;
}

/** Classify one link target into an AnchorLink (null = external/skip). */
function classifyLinkTarget(
	target: string,
	raw: string,
	line: number,
): AnchorLink | null {
	const dest = resolveLinkDest(target);
	if (dest === null) return null;
	if (dest.startsWith("#")) {
		const anchor = dest.slice(1);
		if (!anchor) return null; // placeholder link — placeholder_markdown_link's beat
		return { line, anchor, raw };
	}
	const hash = dest.indexOf("#");
	if (hash < 0) return { line, targetFile: dest, raw };
	const anchor = dest.slice(hash + 1);
	return {
		line,
		targetFile: dest.slice(0, hash),
		...(anchor ? { anchor } : {}),
		raw,
	};
}

/** Same-file anchors and relative-path links (external URLs excluded). */
export function extractAnchorLinks(
	lines: string[],
	fencedLines: Set<number>,
): AnchorLink[] {
	const out: AnchorLink[] = [];
	const skip = withCommentBlockLines(lines, fencedLines); // hidden comment blocks (round-5 #20)
	for (let i = 0; i < lines.length; i++) {
		if (skip.has(i + 1)) continue;
		// Blank inline-code spans (any backtick-run length) so a literal
		// `[plan](missing.md)` example is not read as a live link (sol-max #19).
		const original = lines[i] ?? "";
		const line = blankInlineCode(original);
		for (const m of line.matchAll(MD_LINK_RE)) {
			// Masking is column-preserving, so provenance slices the ORIGINAL
			// source — diagnostics must quote verbatim text, not the mask
			// ("[a<!--c-->b](x)" was recorded with spaces — round-6 #23).
			const raw = original.slice(m.index ?? 0, (m.index ?? 0) + (m[0]?.length ?? 0));
			const link = classifyLinkTarget(m[1] ?? "", raw, i + 1);
			if (link) out.push(link);
		}
	}
	return out;
}
