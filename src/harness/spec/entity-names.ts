// Named HTML entity table for GitHub-style slugging (spec-facts substrate).
// Pure data — split out of extract-refs.ts for the per-file line cap.
//
// A curated common subset, NOT the full HTML5 table (~2100 names): the five
// reserved names, common symbols/punctuation, and accented Latin letters.
// Keys are lowercase; the consumer case-folds lookups (the slug lowercases its
// output, so `&Eacute;`→É→é lands on the same entry as `&eacute;`→é).
//
// How the consumer treats a hit matters more than the glyph itself
// (round-5 #13, amended per adversarial verify): entities decoding to a
// LETTER render into the slug ("Caf&eacute;" → "café"), while entities
// decoding to symbols/whitespace map to "" — GitHub's slugger strips those
// glyphs (nbsp, ½, ©, — …) rather than hyphenating or keeping them, so
// decode-then-strip and decode-to-empty are equivalent, and decode-to-empty
// avoids the two divergences the naive mapping caused (`&nbsp;`→" "→spurious
// hyphen; `&frac12;`→"½" kept as `\p{N}`). Unknown names are left literal by
// the consumer. The glyphs are recorded here so the table stays honest; the
// letter-vs-symbol decision lives in the consumer's one `\p{L}` test.
export const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	// The real glyph (U+00A0) as an escape — an invisible literal invites
	// space/nbsp mix-ups. The consumer's \p{L} filter maps it to "" anyway.
	nbsp: "\u00a0",
	copy: "©",
	reg: "®",
	trade: "™",
	mdash: "—",
	ndash: "–",
	hellip: "…",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	laquo: "«",
	raquo: "»",
	deg: "°",
	times: "×",
	divide: "÷",
	middot: "·",
	sect: "§",
	plusmn: "±",
	frac12: "½",
	cent: "¢",
	pound: "£",
	euro: "€",
	yen: "¥",
	micro: "µ",
	agrave: "à",
	aacute: "á",
	acirc: "â",
	atilde: "ã",
	auml: "ä",
	aring: "å",
	aelig: "æ",
	ccedil: "ç",
	egrave: "è",
	eacute: "é",
	ecirc: "ê",
	euml: "ë",
	igrave: "ì",
	iacute: "í",
	icirc: "î",
	iuml: "ï",
	ntilde: "ñ",
	ograve: "ò",
	oacute: "ó",
	ocirc: "ô",
	otilde: "õ",
	ouml: "ö",
	oslash: "ø",
	ugrave: "ù",
	uacute: "ú",
	ucirc: "û",
	uuml: "ü",
	yacute: "ý",
	yuml: "ÿ",
	szlig: "ß",
};

/** A numeric character reference's code point as text, or "" if out of range. */
function codePoint(n: number): string {
	return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

/** Glyph filter shared by BOTH entity notations (round-6 #12 — `&#160;` and
 *  `&nbsp;` must slug identically): keep letters (they render into the slug),
 *  ASCII digits, and `-` (GitHub keeps all three); everything else —
 *  whitespace, symbols, non-ASCII numerics like ½ — maps to "" the way
 *  GitHub's slugger strips those glyphs. */
function slugGlyph(ch: string): string {
	return /[\p{L}0-9-]/u.test(ch) ? ch : "";
}

/** Entity/numeric-reference matcher; group 1 decimal, 2 hex, 3 name. */
const ENTITY_RE = /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z][a-z0-9]{0,30}));/gi;

/** Resolve one entity match through `filter` (the glyph transform: slug-strip
 *  vs identity). The curated table is lowercase and case-FOLDED, so a valid
 *  uppercase variant ("&Eacute;"→É) decodes — at the cost of also accepting an
 *  invalid arbitrary casing ("&eAcUtE;"), a documented residual (round-7 #28):
 *  distinguishing valid from invalid casings needs the full case-sensitive
 *  HTML5 name table, deliberately not carried. `Object.hasOwn` gates the lookup
 *  so `&constructor;` cannot resolve through the prototype. */
function decodeEntityMatch(
	whole: string,
	dec: string | undefined,
	hex: string | undefined,
	name: string | undefined,
	filter: (ch: string) => string,
): string {
	if (dec !== undefined) return filter(codePoint(Number(dec)));
	if (hex !== undefined) return filter(codePoint(Number.parseInt(hex, 16)));
	const key = String(name).toLowerCase();
	const mapped = Object.hasOwn(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : undefined;
	return mapped === undefined ? whole : filter(mapped);
}

/** SLUG-view decode — the entities GitHub decodes before slugging, in ONE
 *  linear pass (sol-max #21, round-5 #13): recognized references become their
 *  glyph then slug-filter (letters survive, symbol/whitespace → ""), unknown
 *  references stay literal. Single-pass, so an entity assembled BY decoding
 *  (`&amp;copy;`) is not re-decoded, matching CommonMark. */
export function decodeEntities(text: string): string {
	return text.replace(ENTITY_RE, (whole, dec, hex, name) =>
		decodeEntityMatch(whole, dec, hex, name, slugGlyph),
	);
}

/** RAW decode — recognized references become their ACTUAL character (unknown
 *  literal). Used to interpret a link destination before scheme/fragment
 *  classification: "h&#116;tp://…" is the URL "http://…" (round-7 #17). */
export function decodeEntitiesRaw(text: string): string {
	return text.replace(ENTITY_RE, (whole, dec, hex, name) =>
		decodeEntityMatch(whole, dec, hex, name, (ch) => ch),
	);
}
