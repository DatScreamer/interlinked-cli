// Demo-data detection (Batch 8).
//
// Three detectors that catch the most insidious failure mode in
// agent-authored UI/demo code: the agent fails the integration, silently
// substitutes hallucinated data, and ships something that looks plausible
// to humans inspecting the rendered page.
//
//   1. demo_data_unmarked — static smell regex over edited content.
//      Fires on agent-thumbprint fake data (test emails, faker imports,
//      Stripe test cards, lorem ipsum, sentinel UUIDs, mock/fake/dummy/sample
//      identifier prefixes) UNLESS the file declares an `@demo-data:`
//      directive within ~10 lines above the match.
//
//   2. silent_demo_fallback — catches the `try { real API call } catch {
//      return [literal data] }` pattern. The catch-fallback variant is the
//      worst case — it ships to production and degrades silently when the
//      upstream is flaky.
//
//   3. demo_runtime_missing_banner — when any source file imports the
//      vendored `demoData` helper, the project's root layout must mount
//      `<DemoBanner />` so users see the demo banner.
//
//   4. placeholder_data_in_ui — the high-signal slice: placeholder data
//      RENDERED into a user-facing UI file, where a human reads it as
//      production truth. Scoped to .tsx/.jsx/.vue/.svelte/.astro/.html and
//      to rendered positions, so it earns a default gate where the broader
//      demo_data_unmarked stays advisory.
//
// All directives use the `// @demo-data: <reason>` convention; the reason
// is required (empty `@demo-data:` doesn't suppress).

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_EXTS,
	stripComments,
} from "./shared.js";

// ==========================================================================
// 1. demo_data_unmarked
// ==========================================================================

interface DemoSmellPattern {
	re: RegExp;
	label: string;
}

// Stripe / payment test PANs — canonical list.
const TEST_CARD_LITERALS: readonly string[] = [
	"4242424242424242",
	"4111111111111111",
	"5555555555554444",
	"378282246310005",
	"4000056655665556",
	"6011111111111117",
];

const SMELL_PATTERNS: readonly DemoSmellPattern[] = [
	{
		re: /[A-Za-z0-9._%+-]+@(?:example\.(?:com|org|net)|test\.(?:com|org|local)|acme\.test|fake\.com)/i,
		label: "test-email literal",
	},
	{
		re: /\b(?:foo|jane|john)\.?(?:doe|smith|test|user)?@/i,
		label: "placeholder-name email",
	},
	{
		re: /\b555[-.\s]?\d{3,4}[-.\s]?\d{0,4}\b/,
		label: "test phone (555 prefix)",
	},
	{
		re: /\b(?:123-45-6789|000-00-0000|999-99-9999)\b/,
		label: "test SSN",
	},
	{
		re: new RegExp(`\\b(?:${TEST_CARD_LITERALS.join("|")})\\b`),
		label: "Stripe / payment test card",
	},
	{
		re: /\b(?:0{8}-0{4}-0{4}-0{4}-0{12}|f{8}-f{4}-f{4}-f{4}-f{12}|a{8}-a{4}-a{4}-a{4}-a{12})\b/i,
		label: "sentinel UUID",
	},
	{
		re: /\b[Ll]orem\s+[Ii]psum\b/,
		label: "lorem ipsum",
	},
	{
		re: /\bfrom\s+["']@?(?:faker-js\/faker|faker|chance|casual|@ngneat\/falso|@anatine\/zod-mock)["']/,
		label: "faker / chance / falso import",
	},
	{
		re: /\b(?:const|let|var)\s+(mock|fake|stub|sample|dummy|demo|placeholder|seed|temp|fixture)[A-Z][\w$]*\s*[=:]/,
		label: "demo/mock identifier prefix",
	},
	{
		re: /\bexport\s+(?:const|function)\s+(get|fetch|load)Mock\w+/,
		label: "exported mock getter",
	},
];

// RFC 2606 / RFC 6761 test domains — separate list because they're often
// embedded in URL strings rather than emails.
const RFC_TEST_DOMAIN_RE =
	/\bhttps?:\/\/[^/\s"'`]*\.(?:example\.(?:com|org|net)|test|invalid|localhost|example)\b/i;

const DEMO_DIRECTIVE_RE = /\/\/\s*@demo-data\s*:\s*(\S.*)$/;
const DIRECTIVE_LOOKBACK = 10;

const SKIPPED_PATH_RE =
	/(?:^|\/)(?:__fixtures__|__mocks__|fixtures|mocks|test-data|seed-data|seeds)(?:\/|$)/;

function lineHasNearbyDemoDirective(lines: string[], lineIdx: number): boolean {
	const start = Math.max(0, lineIdx - DIRECTIVE_LOOKBACK);
	for (let i = start; i <= lineIdx; i++) {
		const m = DEMO_DIRECTIVE_RE.exec(lines[i]);
		if (m && m[1].trim().length >= 4) return true;
	}
	return false;
}

/** Public API — flags fake-data smell patterns without `@demo-data:` directive. */
export function checkDemoDataUnmarked(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (SKIPPED_PATH_RE.test(filePath.replace(/\\/g, "/"))) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 8;

	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		const line = lines[i];

		// Pattern bank 1: SMELL_PATTERNS. Count all hits per line, not just
		// the first — multi-declaration lines are common in seed/demo data.
		for (const pat of SMELL_PATTERNS) {
			if (matches.length >= MAX_MATCHES) break;
			const globalRe = new RegExp(pat.re.source, pat.re.flags.includes("g") ? pat.re.flags : pat.re.flags + "g");
			const hits = line.match(globalRe);
			if (!hits || hits.length === 0) continue;
			if (lineHasNearbyDemoDirective(lines, i)) continue;
			for (let h = 0; h < hits.length && matches.length < MAX_MATCHES; h++) {
				matches.push({
					line: i + 1,
					text: `unmarked demo data (${pat.label}): ${hits[h].slice(0, 80)}. Mark with \`// @demo-data: <reason>\` directly above, or wrap with demoData() from the vendored runtime.`,
				});
			}
		}

		// Pattern bank 2: RFC test-domain URLs (separate so the message is specific).
		if (
			matches.length < MAX_MATCHES &&
			RFC_TEST_DOMAIN_RE.test(line) &&
			!lineHasNearbyDemoDirective(lines, i)
		) {
			matches.push({
				line: i + 1,
				text: `unmarked demo data (RFC test domain): ${line.trim().slice(0, 110)}. Mark with \`// @demo-data: <reason>\` or move to a config file.`,
			});
		}
	}

	return matches;
}

// ==========================================================================
// 2. silent_demo_fallback
// ==========================================================================

const ASYNC_REAL_CALL_RE =
	/\b(?:await\s+)?(?:fetch|axios\s*\.\s*\w+|client\.\w+|api\.\w+|http\s*\.\s*\w+)\s*\(/;
const LITERAL_FALLBACK_RE = /^\s*return\s+[[{]/;

/** Public API — flags `try { real call } catch { return literal }` patterns. */
export function checkSilentDemoFallback(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const stripped = stripComments(content);
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	const tryRe = /\btry\s*\{/g;
	tryRe.lastIndex = 0;
	let m: RegExpExecArray | null = tryRe.exec(stripped);
	while (m !== null && matches.length < MAX_MATCHES) {
		const tryStart = m.index;
		const tryBlock = extractBlockAfter(stripped, tryStart + m[0].length - 1);
		if (!tryBlock) {
			m = tryRe.exec(stripped);
			continue;
		}
		// The `catch` clause should immediately follow the try block.
		const afterTry = tryBlock.endOffset;
		const catchMatch = /^\s*catch(?:\s*\([^)]*\))?\s*\{/.exec(stripped.slice(afterTry));
		if (!catchMatch) {
			m = tryRe.exec(stripped);
			continue;
		}
		const catchStart = afterTry + catchMatch.index + catchMatch[0].length - 1;
		const catchBlock = extractBlockAfter(stripped, catchStart);
		if (!catchBlock) {
			m = tryRe.exec(stripped);
			continue;
		}

		const tryHasRealCall = ASYNC_REAL_CALL_RE.test(tryBlock.body);
		const catchReturnsLiteral = catchBlock.body
			.split("\n")
			.some((line) => LITERAL_FALLBACK_RE.test(line));

		if (tryHasRealCall && catchReturnsLiteral) {
			const lineIdx = (stripped.slice(0, tryStart).match(/\n/g) || []).length;
			matches.push({
				line: lineIdx + 1,
				text: `silent demo fallback: real API call in \`try\`, literal data returned from \`catch\`. The catch silently substitutes fake data when the upstream fails — production users see invented results. Re-throw, return a typed error, or mark the fallback with demoData() so the UI shows a banner.`,
			});
		}

		m = tryRe.exec(stripped);
	}

	return matches;
}

interface BlockExtraction {
	body: string;
	endOffset: number;
}

function extractBlockAfter(text: string, openIdx: number): BlockExtraction | null {
	if (text[openIdx] !== "{") return null;
	let depth = 1;
	for (let i = openIdx + 1; i < text.length; i++) {
		const ch = text[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return { body: text.slice(openIdx + 1, i), endOffset: i + 1 };
		}
	}
	return null;
}

// ==========================================================================
// 3. demo_runtime_missing_banner
// ==========================================================================

const ROOT_LAYOUT_PATHS = [
	"app/layout.tsx",
	"app/layout.jsx",
	"src/app/layout.tsx",
	"src/app/layout.jsx",
	"pages/_app.tsx",
	"pages/_app.jsx",
	"src/pages/_app.tsx",
	"src/main.tsx",
	"src/main.jsx",
	"src/index.tsx",
	"src/index.jsx",
	"App.tsx",
	"src/App.tsx",
];

function isRootLayoutFile(filePath: string): boolean {
	const norm = filePath.replace(/\\/g, "/");
	for (const root of ROOT_LAYOUT_PATHS) {
		if (norm.endsWith(`/${root}`) || norm === root) return true;
	}
	return false;
}

// Match imports from the package's own subpath, the legacy `@interlinked/`
// scope (kept for transition), and any relative `*/demo-runtime` path so
// users who vendor a copy still trigger the banner check.
const DEMO_RUNTIME_IMPORT_RE =
	/\bfrom\s+["'](?:interlinked-cli\/demo-runtime|@interlinked\/demo-runtime|\.{1,2}\/[^"']*demo-runtime)["']/;
const DEMO_BANNER_USAGE_RE = /<\s*DemoBanner\s*\/?>/;

/** Public API — flags root-layout files that import demoData but don't render DemoBanner. */
export function checkDemoRuntimeMissingBanner(content: string, filePath: string): InlineMatch[] {
	if (!isRootLayoutFile(filePath)) return [];
	if (!DEMO_RUNTIME_IMPORT_RE.test(content)) return [];
	if (DEMO_BANNER_USAGE_RE.test(content)) return [];
	return [
		{
			line: 1,
			text: `root layout imports demo-runtime helpers but does not render <DemoBanner />. Without the banner, users have no signal that the page contains demo data. Add \`import { DemoBanner } from "interlinked-cli/demo-runtime";\` and render <DemoBanner /> inside the body of this layout.`,
		},
	];
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
		const t = m[1].trim();
		if (t) out.push(t);
	}
	for (const m of line.matchAll(/>\s*\{([^{}]+)\}\s*</g)) {
		const t = m[1].trim();
		if (t) out.push(t);
	}
	for (const m of line.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
		if (m[1].trim()) out.push(m[1].trim());
	}
	const standalone = /^\s*\{([^{}]+)\}\s*$/.exec(line);
	if (standalone && standalone[1].trim()) out.push(standalone[1].trim());
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
	const code = analyzedLines[i];
	const hasNumber = extractRenderedSegments(code).some((s) =>
		/\d{2,}/.test(s.replace(/[,_\s]/g, "")),
	);
	if (!hasNumber) return null;
	const marked = "hardcoded number a comment marks as placeholder";
	if (PLACEHOLDER_COMMENT_RE.test(commentTextOf(originalLines[i], code))) return marked;
	for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
		if (originalLines[j].trim() === "") continue;
		return PLACEHOLDER_COMMENT_RE.test(commentTextOf(originalLines[j], analyzedLines[j]))
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
			placeholderSignalOnLine(analyzedLines[i]) ??
			markedNumberDetail(i, originalLines, analyzedLines);
		if (!detail || lineHasNearbyDemoDirective(originalLines, i)) continue;
		matches.push({
			line: i + 1,
			text: `placeholder data rendered to a user (${detail}): ${originalLines[i].trim().slice(0, 100)}`,
		});
	}
	return matches;
}
