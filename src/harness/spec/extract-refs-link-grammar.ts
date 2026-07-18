// Inline-link grammar for the ref/link extractors (spec-facts substrate) —
// split out of extract-refs.ts for the per-file line cap. One module owns the
// link-label source so renderInline's reducers and MD_LINK_RE cannot drift
// (round-7 #15); consumers import the compiled regexes only.

/** ONE escape-aware link-LABEL grammar — the single source string every link
 *  regex below is built from (round-7 #15: renderInline's old label had no
 *  escape arm, so "[a\]b](x.md)" slugged as "abxmd", not "ab"). Alternation-
 *  unrolled SINGLE loop: each iteration eats one plain char OR one `\`-escaped
 *  pair (the lead class excludes `\`, the escape arm starts with it —
 *  disjoint), bounding TOTAL per-`[` label work at 512 units. The old form
 *  gave each of up to 64 escape segments its OWN {0,512} tail — ~33k chars
 *  scannable from EVERY `[`, a measured 8.5s quadratic on ("["×512+"\x")×200
 *  and 39s at 320k scale (round-7 #20); the single loop holds those same
 *  inputs under ~165ms. Floored by the round-4 501-char-label test (the bound
 *  must stay >501); labels past 512 units stop matching — link text that long
 *  is degenerate. */
export const LINK_LABEL_SRC = String.raw`(?:[^\]\n\\]|\\.){0,512}`;

/** links/images → their text ($1), for renderInline. The destination admits
 *  balanced parens (≤2 levels) plus an angle `<…>` form so a heading link
 *  `[API](docs/a(b).md)` renders as `API`, not `API.md)` (round-5 #14), with
 *  `[^\S\n]`-bounded whitespace around dest and title — CommonMark allows
 *  spaces there, and JS `\s` (incl. nbsp) minus newline preserves what the old
 *  `[^)\n]` accepted (adversarial-verify amendment); the title accepts quoted
 *  OR parenthesized forms (round-5 #19). Hoisted module constant: compiled
 *  once, never per renderInline call. */
// The `(?<=…\[)` opener guard is backslash-PARITY-aware (round-7 #21, same as
// MD_LINK_RE): an escaped `\[` renders literally, so "\[x](url)" is NOT reduced.
export const INLINE_LINK_RE = new RegExp(
	String.raw`!?\[(?<=(?:^|[^\\])(?:\\\\)*\[)(${LINK_LABEL_SRC})\]\([ \t]{0,64}(?:<[^<>\n]{0,4096}>|(?:\\.|[^()\s\\]|\((?:[^()\s]|\([^()\s]{0,512}\)){0,512}\)){0,4096})(?:[ \t]{1,64}(?:"[^"\n]{0,2000}"|'[^'\n]{0,2000}'|\([^()\n]{0,2000}\)))?[ \t]{0,64}\)`,
	"g",
);

/** Reference links `[text][ref]` → their text ($1), for renderInline. Both
 *  the text and the ref name use the shared escape-aware label grammar. */
export const REF_LINK_RE = new RegExp(
	String.raw`!?\[(${LINK_LABEL_SRC})\]\[${LINK_LABEL_SRC}\]`,
	"g",
);

// The extractor's matcher: [text](target) and ![alt](target). Char classes are
// BOUNDED (round-2 #1): an unbounded `[^\]]*` scanned to EOL from every `[` is
// O(n²); the label is the shared LINK_LABEL_SRC above. The destination stays
// ONE capture group (extractAnchorLinks reads m[1]): either an angle `<…>`
// form (round-5 #19) or a bare dest that (a) may not start with `<` (round-5
// #22), (b) admits ≤2 levels of balanced parens with EVERY inner class bounded
// so no single atom is unbounded (round-5 #23; 3+ levels are a noted
// residual), then re-capped by total length in classifyLinkTarget.
// The opening guard is PARITY-aware (round-6 #21): `\[` after an EVEN run of
// backslashes is link-active ("\\[x](y)" renders one literal backslash then a
// LINK), while an odd run escapes it (an escaped-open `\[x](y)` is rejected).
// The lookbehind sits AFTER `\[` (round-7 #20 measurement): placed before it,
// the engine ran the variable-length backward scan at EVERY position, and a
// 320k pure-backslash line took a measured 53s — each odd offset walked its
// whole prefix. Gated behind the literal `\[` it runs only at real `[` chars,
// each scanning its own preceding backslash run once — same accept/reject
// everywhere, and the same line measures <1ms.
// Whitespace around dest/title is space/tab ONLY — NBSP is not a legal link
// separator (round-7 #24). The bare-dest atom admits a top-level `\.` escape
// so an escaped structural paren is a legal destination char ("foo\(bar",
// round-7 #23); it is `\`-disjoint from the char class to stay ReDoS-safe.
export const MD_LINK_RE = new RegExp(
	String.raw`!?\[(?<=(?:^|[^\\])(?:\\\\)*\[)${LINK_LABEL_SRC}\]\([ \t]{0,64}(<[^<>\n]{0,4096}>|(?!<)(?:\\.|[^()\s\\]|\((?:[^()\s]|\([^()\s]{0,512}\)){0,512}\)){1,4096})(?:[ \t]{1,64}(?:"[^"\n]{0,2000}"|'[^'\n]{0,2000}'|\([^()\n]{0,2000}\)))?[ \t]{0,64}\)`,
	"g",
);
