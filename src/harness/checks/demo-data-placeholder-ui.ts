// interlinked-tdd: exempt
// Demo-data detection — placeholder_data_in_ui (Batch 8, decomposed sibling).
//
// The high-signal slice of demo-data detection plus the shared
// `@demo-data:` directive lookback used across the family. Extracted from
// demo-data.ts to keep that module under the per-file line cap. Behavior is
// byte-identical to the original; demo-data.ts re-imports
// `lineHasNearbyDemoDirective` from here.

import { nonNull } from "../../lib/non-null.js";
import { getExtension, type InlineMatch, isTestFile } from "./shared.js";

const DEMO_DIRECTIVE_RE = /\/\/\s*@demo-data\s*:\s*(\S.*)$/;
const DIRECTIVE_LOOKBACK = 10;

export function lineHasNearbyDemoDirective(lines: string[], lineIdx: number): boolean {
	const start = Math.max(0, lineIdx - DIRECTIVE_LOOKBACK);
	for (let i = start; i <= lineIdx; i++) {
		const m = DEMO_DIRECTIVE_RE.exec(nonNull(lines[i]));
		if (m && nonNull(m[1]).trim().length >= 4) return true;
	}
	return false;
}

// ==========================================================================
// 4. placeholder_data_in_ui
// ==========================================================================
//
// The high-signal slice of demo-data detection. demo_data_unmarked scans
// every JS and TS file and stays advisory because it drowns in fixtures
// and tests. This one is scoped to data RENDERED into a user-facing UI
// file, where a human reads it as a real production value, so it earns a
// default gate.
//
// Fires only on an explicit signal, each one in a rendered position:
//   A  a hardcoded number whose nearby comment says it is not real
//   B  a value read from a mock / fake / dummy / stub / fixture-named name
//   C  canonical filler copy as text, such as lorem ipsum or "your X here"
//   D  a known filler-image host such as placehold.co or picsum.photos
//   E  a number whose digits are an obvious filler shape, such as 1111
//      or 123456
//
// Suppressed when the rendered UI itself carries a visible disclaimer such
// as "sample data" or "not real" — the agent has labelled it, which is the
// second accepted resolution. A code comment alone is not enough — the
// label has to be on screen. The @demo-data directive and an
// interlinked-ignore directive also suppress.

/** UI files whose rendered output a human reads as production truth. */
const UI_RENDER_EXTS = new Set([".tsx", ".jsx", ".vue", ".svelte", ".astro", ".html", ".htm"]);

/** Cap on findings reported per file. */
const MAX_UI_MATCHES = 8;

/** Demo / example / fixture trees where filler data is expected and
 *  understood as such — not production UI. */
const UI_NONPROD_DIR_RE =
	/(?:^|\/)(?:__fixtures__|__mocks__|fixtures|mocks|test-data|seed-data|seeds|examples?|demos?|stories|\.storybook|playground|sandbox)(?:\/|$)/i;

/** Storybook / story-file naming — dev-facing surfaces, not production UI. */
const UI_STORY_FILE_RE = /\.stor(?:y|ies)\.[jt]sx?$/i;

/** Filler-data markers in a comment. Deliberately specific: a generic
 *  work-remaining note is not a marker — the comment has to actually say
 *  the data itself is not real. */
const PLACEHOLDER_COMMENT_RE =
	/\bplaceholder\b|\bhard[\s-]?coded\b|\bfabricated\b|\bmade[\s-]?up\b|\b(?:dummy|fake|mock(?:ed)?|sample|bogus|filler|temp(?:orary)?|junk)\s+(?:data|values?|numbers?|figures?|stats?|content|copy|text)\b|\bnot\s+(?:real|actual|live|production)\s+(?:data|values?|numbers?|figures?)\b|\b(?:real|actual)\s+(?:data|values?|numbers?|figures?)\s+(?:pending|needed|tbd|later|here|goes|coming)\b|\breplace\b[^.;\n]{0,40}?\b(?:real|actual|live|production)\b|\b(?:wire|hook)\s+(?:\w+\s+){0,2}up\b/i;

/** mock / fake / dummy / stub / fixture name roots — prefix, suffix, and
 *  SCREAMING_CASE forms. Two roots are intentionally left out because they
 *  routinely name real values: a `sampleRate`-style name and a
 *  `placeholderText`-style name are real data, not fakes. */
const PLACEHOLDER_IDENT_RE =
	/\b(?:mock|fake|dummy|stub|fixture)[A-Z][A-Za-z0-9_$]*\b|\b[A-Za-z][A-Za-z0-9_$]*(?:Mock|Fake|Dummy|Stub|Fixture)\b|\b(?:MOCK|FAKE|DUMMY|STUB|FIXTURE)_[A-Z0-9_]+\b/;

/** Canonical filler copy — unmistakable when rendered as UI text. */
const PLACEHOLDER_COPY_RE =
	/\blorem\s+ipsum\b|\byour\s+\w+(?:\s+\w+)?\s+here\b|\binsert\s+\w+(?:\s+\w+)?\s+here\b|\b\w+(?:\s+\w+)?\s+goes\s+here\b|\bplaceholder\s+(?:text|copy|content)\b|\b(?:sample|dummy|filler)\s+text\b/i;

/** Image hosts that exist only to serve filler images. */
const PLACEHOLDER_IMAGE_HOST_RE =
	/\b(?:via\.placeholder\.com|placehold\.(?:co|it|jp)|placeholder\.com|placekitten\.com|placebear\.com|placeimg\.com|baconmockup\.com|loremflickr\.com|placecage\.com|fillmurray\.com|dummyimage\.com|picsum\.photos|lorempixel\.com|unsplash\.it)/i;

/** Rendered text that visibly tells the user the data is not real — the
 *  on-screen disclaimer that satisfies the "label it" resolution. */
const UI_DISCLAIMER_RE =
	/\b(?:sample|demo|dummy|mock|example|test|fake|placeholder|preview|simulated|representative)\s+(?:data|values?|figures?|numbers?|content)\b|\bnot\s+(?:real|actual|production|live)\b|\bfor\s+illustration\b|\billustrative\b|\bexample\s+only\b/i;

/** User-visible JSX/HTML attributes whose value reaches the screen. */
const VISIBLE_ATTR_RE =
	/\b(?:value|defaultValue|label|title|alt|placeholder|aria-?[Ll]abel|caption|heading|subtitle|tooltip|text|content)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^{}]*)\})/g;

/** Pull every rendered fragment off one line: JSX/HTML text nodes, `{expr}`
 *  children, `{{ expr }}` mustaches, and user-visible attribute values. */
function extractRenderedSegments(line: string): string[] {
	const out: string[] = [];
	for (const m of line.matchAll(/>([^<>{}]*)</g)) {
		const t = nonNull(m[1]).trim();
		if (t) out.push(t);
	}
	for (const m of line.matchAll(/>\s*\{([^{}]+)\}\s*</g)) {
		const t = nonNull(m[1]).trim();
		if (t) out.push(t);
	}
	for (const m of line.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
		if (nonNull(m[1]).trim()) out.push(nonNull(m[1]).trim());
	}
	const standalone = /^\s*\{([^{}]+)\}\s*$/.exec(line);
	if (standalone && nonNull(standalone[1]).trim()) out.push(nonNull(standalone[1]).trim());
	for (const m of line.matchAll(VISIBLE_ATTR_RE)) {
		const v = (m[1] ?? m[2] ?? m[3] ?? "").trim();
		if (v) out.push(v);
	}
	return out;
}

/** True for a digit string that is an unmistakable filler shape: one digit
 *  repeated 4+ times (1111, 99999) or a strictly consecutive ascending or
 *  descending run of length 5+ (12345, 987654). Thresholds are set so a
 *  plausible real value (a year, `1,234`) never qualifies. */
function isPlaceholderDigits(d: string): boolean {
	if (d.length >= 4 && /^(\d)\1+$/.test(d)) return true;
	if (d.length < 5) return false;
	let asc = true;
	let desc = true;
	for (let i = 1; i < d.length; i++) {
		const step = d.charCodeAt(i) - d.charCodeAt(i - 1);
		if (step !== 1) asc = false;
		if (step !== -1) desc = false;
	}
	return asc || desc;
}

/** The first unmistakable filler-shaped number in a rendered fragment. */
function firstPlaceholderDigits(seg: string): string | null {
	for (const num of seg.matchAll(/\d[\d.,_]*\d|\d/g)) {
		if (isPlaceholderDigits(num[0].replace(/\D/g, ""))) return num[0].trim();
	}
	return null;
}

/** Strip block comments (JS, JSX, and HTML) length- and line-preservingly
 *  so commented-out markup is not mistaken for rendered UI. Line comments
 *  are blanked too, except when part of a URL scheme. `#` is deliberately
 *  untouched: it is not a comment in any UI language and blanking it would
 *  eat `#fff` colours and `href="#anchor"` text. */
function stripUiComments(content: string): string {
	const blank = (m: string): string => m.replace(/[^\n]/g, " ");
	const noBlocks = content
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/<!--[\s\S]*?-->/g, blank);
	return noBlocks
		.split("\n")
		.map((line) => {
			for (let idx = line.indexOf("//"); idx !== -1; idx = line.indexOf("//", idx + 2)) {
				if (idx === 0 || line[idx - 1] !== ":") {
					return line.slice(0, idx) + " ".repeat(line.length - idx);
				}
			}
			return line;
		})
		.join("\n");
}

/** The comment text on a line — the span `stripUiComments` blanked. The
 *  stripper is length-preserving, so the first..last blanked-position span
 *  in the original recovers the comment (interior spaces included). */
function commentTextOf(original: string, stripped: string): string {
	let min = -1;
	let max = -1;
	for (let i = 0; i < original.length; i++) {
		if (stripped[i] === " " && original[i] !== " ") {
			if (min === -1) min = i;
			max = i;
		}
	}
	return min === -1 ? "" : original.slice(min, max + 1);
}

/** True when the rendered UI itself shows a visible disclaimer — the agent
 *  has labelled the data, which is the second accepted resolution. */
function fileHasVisibleDisclaimer(analyzedLines: string[]): boolean {
	for (const line of analyzedLines) {
		for (const seg of extractRenderedSegments(line)) {
			if (UI_DISCLAIMER_RE.test(seg)) return true;
		}
	}
	return false;
}

/** Signals B, C, D, and E on one line — the first hit's detail, or null. */
function placeholderSignalOnLine(code: string): string | null {
	const host = PLACEHOLDER_IMAGE_HOST_RE.exec(code);
	if (host) return `placeholder image host ${host[0]}`;
	for (const seg of extractRenderedSegments(code)) {
		const ident = PLACEHOLDER_IDENT_RE.exec(seg);
		if (ident) return `${ident[0]} is a mock/fake-named value`;
		const copy = PLACEHOLDER_COPY_RE.exec(seg);
		if (copy) return `placeholder copy "${copy[0]}"`;
		const digits = firstPlaceholderDigits(seg);
		if (digits) return `placeholder-shaped number ${digits}`;
	}
	return null;
}

/** Signal A — a number rendered on line `i` whose own comment, or the
 *  nearest preceding non-blank line's comment, marks it as not real. */
function markedNumberDetail(
	i: number,
	originalLines: string[],
	analyzedLines: string[],
): string | null {
	const code = nonNull(analyzedLines[i]);
	const hasNumber = extractRenderedSegments(code).some((s) =>
		/\d{2,}/.test(s.replace(/[,_\s]/g, "")),
	);
	if (!hasNumber) return null;
	const marked = "hardcoded number a comment marks as placeholder";
	if (PLACEHOLDER_COMMENT_RE.test(commentTextOf(nonNull(originalLines[i]), code))) return marked;
	for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
		if (nonNull(originalLines[j]).trim() === "") continue;
		return PLACEHOLDER_COMMENT_RE.test(
			commentTextOf(nonNull(originalLines[j]), nonNull(analyzedLines[j])),
		)
			? marked
			: null;
	}
	return null;
}

/** Public API — flags filler data rendered into a user-facing UI. */
export function checkPlaceholderDataInUi(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (!UI_RENDER_EXTS.has(getExtension(filePath))) return [];
	const norm = filePath.replace(/\\/g, "/");
	if (UI_NONPROD_DIR_RE.test(norm) || UI_STORY_FILE_RE.test(norm)) return [];

	const originalLines = content.split("\n");
	const analyzedLines = stripUiComments(content).split("\n");
	if (fileHasVisibleDisclaimer(analyzedLines)) return [];

	const matches: InlineMatch[] = [];
	for (let i = 0; i < analyzedLines.length && matches.length < MAX_UI_MATCHES; i++) {
		const detail =
			placeholderSignalOnLine(nonNull(analyzedLines[i])) ??
			markedNumberDetail(i, originalLines, analyzedLines);
		if (!detail || lineHasNearbyDemoDirective(originalLines, i)) continue;
		matches.push({
			line: i + 1,
			text: `placeholder data rendered to a user (${detail}): ${nonNull(originalLines[i]).trim().slice(0, 100)}`,
		});
	}
	return matches;
}
