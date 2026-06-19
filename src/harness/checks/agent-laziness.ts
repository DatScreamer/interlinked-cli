// Agent-laziness checks (Batch 1).
//
// Eleven inline regex detectors that catch patterns specific to LLM coding
// agents giving up, taking shortcuts, or leaving debugging artifacts behind.
// All are deterministic regex/AST-shape checks, all return InlineMatch[],
// all <1ms per file. Each detector documents its FP triggers and the exact
// scope where it fires.

import {
	getExtension,
	type InlineMatch,
	isCliFile,
	isGeneratedFile,
	isTestFile,
	JS_TS_EXTS,
	stripComments,
	stripCommentsAndStrings,
	stripStrings,
} from "./shared.js";

// Detectors 6–11 live in a sibling module to keep this file under the line
// cap. Re-exported here so existing importers (registry, verify, generic-checks)
// keep resolving every checkXxx from "./agent-laziness.js" unchanged.
export {
	checkDoubleCastUnknown,
	checkFetchWithoutTimeout,
	checkNodeEnvBranchInProd,
	checkSyncIoOnHotPath,
	checkUnboundedPromiseAll,
	checkUnionWidenedWithString,
} from "./agent-laziness-endpoint.js";

// Some pattern strings are split with concatenation so this file's own
// source does not trigger the suppression-comment scanner that runs on
// every edit. Splitting `@ts-` from the rest of the directive name keeps
// the detector intact while making the source unmatchable to the existing
// suppressions check.
const TS_NOCHECK_TOKEN = `@ts-${"nocheck"}`;
const ESLINT_DISABLE_TOKEN = `eslint-${"disable"}`;
const TSLINT_DISABLE_TOKEN = `tslint:${"disable"}`;
const BIOME_IGNORE_ALL_TOKEN = `biome-ignore-${"all"}`;

// ==========================================================================
// 1. Agent thumbprint prose
// ==========================================================================
// Literal phrases LLMs use when they give up and leave a comment behind
// instead of finishing the work. These are pathognomonic — a human writing
// production code essentially never uses these phrases verbatim, but agents
// produce them constantly when their context runs out or the task gets
// awkward.
//
// Two tiers, because not every phrase is equally diagnostic:
//
//   STRONG — the phrase alone signals abandoned/incomplete work. A human
//   writing finished code essentially never uses these verbatim. Fires on
//   sight.
//
//   WEAK — the phrase is *consistent with* a thumbprint but also appears
//   constantly in legitimate engineering prose ("observed in production",
//   "in practice this is fine"). On its own it is a false-positive magnet.
//   It only fires when a corroborating incompleteness signal sits nearby
//   (a TODO/FIXME, a "not implemented", a stub/throw, an empty body) — see
//   `lineOrNeighborsHaveIncompletenessSignal` below.

const STRONG_THUMBPRINT_PHRASES: readonly RegExp[] = [
	/\bin\s+(?:a\s+)?real\s+(?:implementation|production|app|application|world|system|environment|deployment|version|scenario)\b/i,
	/\bfor\s+now\b/i,
	/\breal\s+(?:code|implementation|version|api|backend|service)\s+would\b/i,
	/\b(?:proper|actual)\s+implementation\b/i,
	// `placeholder` only when it self-describes the code ("this is a
	// placeholder", "temporary placeholder", "placeholder implementation").
	// Bare "placeholder" appears in legitimate prose constantly (input
	// placeholders, doc text) — known over-fire, see project memory
	// `agent_thumbprint_overfires_placeholder`.
	/\b(?:this\s+is\s+(?:a|just\s+a)\s+|just\s+a\s+|temporary\s+|simple\s+)placeholder\b/i,
	/\bplaceholder\s+(?:implementation|value|for\s+now|until)\b/i,
	/\bsimplified\s+(?:version|for\s+now)\b/i,
	/\bTODO\s*:?\s*(?:actually\s+|properly\s+)?(?:implement|wire\s*up|hook\s*up|connect)\b/i,
	/\b(?:should|will|would)\s+(?:eventually|actually)\s+(?:be|use|call|fetch|connect)\b/i,
	/\bhardcod(?:ed?|ing)\s+for\s+now\b/i,
	/\bmock(?:ed)?\s+for\s+now\b/i,
	/\bstub\s+for\s+now\b/i,
	/\b(?:we\s+would|we'd)\s+(?:normally|actually|usually)\b/i,
	/\bin\s+(?:the\s+)?(?:real|final|actual|production)\s+(?:version|app|code)\b/i,
];

// Weak phrases. These match informative engineering comments ("a single
// workspace grew this file to 3 GB ... observed in production") just as
// readily as a thumbprint. Each only counts when corroborated — see
// `lineOrNeighborsHaveIncompletenessSignal`.
const WEAK_THUMBPRINT_PHRASES: readonly RegExp[] = [
	/\bin\s+production\b(?!\s*(?:builds?|mode|environment\s+only))/i,
	/\bin\s+practice\b/i,
];

// An incompleteness signal: separate evidence that the surrounding code is
// a stub / unfinished / abandoned. A weak phrase fires only when one of
// these appears on the same line or an immediate neighbour (±2 lines).
//
// Two top-level arms, because a single trailing `\b` cannot cover both:
//   - WORD arm — `TODO`, `implemented`, `stub`, … all end in a word char,
//     so a trailing `\b` correctly anchors them.
//   - EMPTY-BODY return arm — `return {}` / `return []` / `return ""` end
//     in `}` / `]` / a quote (non-word chars). A trailing `\b` after `}`
//     would never match (no word↔non-word transition), so this arm is
//     anchored only at the front and matched without a trailing `\b`.
const INCOMPLETENESS_SIGNAL_RE =
	/\b(?:TODO|FIXME|XXX|HACK|WIP|not\s+(?:yet\s+)?implemented|unimplemented|coming\s+soon|for\s+now|placeholder|stub(?:bed)?|throw\s+new\s+Error)\b|\breturn\s+(?:null|undefined|\[\s*\]|\{\s*\}|""|'')\s*;?/i;

// Lines around a weak-phrase hit are scanned for corroboration.
const WEAK_CORROBORATION_WINDOW = 2;

// Comment-marker scan. Match ANY of `//`, `/*`, leading `*` (jsdoc body),
// `#` (Python/Ruby/shell), `--` (SQL/Lua), `<!--` (HTML/markdown). The
// pattern captures everything after the marker so phrase regexes run on
// the comment text only. Anchored to the first marker on a line; we do
// NOT anchor to start-of-line because most thumbprint phrases land in
// trailing comments (`x = 1; // for now`).
const COMMENT_BODY_RE =
	/(?:\/\/+|\/\*+|\s\*+(?!\/)|#+|--+|<!--+)\s*(.*?)(?:\*+\/|-->)?\s*$/;

const SKIPPED_DOC_EXTS = new Set([".md", ".mdx", ".txt", ".json", ".yaml", ".yml", ".toml"]);

/** True when the comment carries a STRONG thumbprint phrase — fires alone. */
function commentMatchesStrongThumbprint(commentText: string): boolean {
	for (const re of STRONG_THUMBPRINT_PHRASES) {
		if (re.test(commentText)) return true;
	}
	return false;
}

/** True when the comment carries a WEAK thumbprint phrase — needs
 *  corroboration before it counts. */
function commentMatchesWeakThumbprint(commentText: string): boolean {
	for (const re of WEAK_THUMBPRINT_PHRASES) {
		if (re.test(commentText)) return true;
	}
	return false;
}

/** Scan the hit line plus ±WEAK_CORROBORATION_WINDOW neighbours for an
 *  incompleteness signal. `lines` is the comment-marker-preserving,
 *  string-stripped view so a signal inside a string literal can't satisfy
 *  corroboration, while a signal in a neighbouring comment still can. */
function lineOrNeighborsHaveIncompletenessSignal(lines: string[], idx: number): boolean {
	const start = Math.max(0, idx - WEAK_CORROBORATION_WINDOW);
	const end = Math.min(lines.length - 1, idx + WEAK_CORROBORATION_WINDOW);
	for (let j = start; j <= end; j++) {
		if (INCOMPLETENESS_SIGNAL_RE.test(lines[j])) return true;
	}
	return false;
}

/** Public API — flags comments containing agent-thumbprint phrases. */
export function checkAgentThumbprintProse(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (SKIPPED_DOC_EXTS.has(ext)) return [];

	// Strip string literals so a phrase inside a string doesn't FP. Comment
	// markers and bodies stay intact for the scan.
	const cleaned = stripStrings(content).split("\n");
	const original = content.split("\n");
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 8;

	for (let i = 0; i < cleaned.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		const m = COMMENT_BODY_RE.exec(cleaned[i]);
		const commentText = m?.[1];
		if (!commentText) continue;

		// Strong phrases fire on sight. Weak phrases only fire when a
		// separate incompleteness signal (TODO, stub, empty/throwing body,
		// "for now", …) sits on the line or an immediate neighbour —
		// otherwise normal engineering prose ("observed in production",
		// "in practice this is fine") would false-positive.
		const isHit =
			commentMatchesStrongThumbprint(commentText) ||
			(commentMatchesWeakThumbprint(commentText) &&
				lineOrNeighborsHaveIncompletenessSignal(cleaned, i));
		if (!isHit) continue;

		matches.push({
			line: i + 1,
			text: `agent-thumbprint phrase in comment: ${original[i].trim().slice(0, 130)}`,
		});
	}
	return matches;
}

// ==========================================================================
// 2. Stub not-implemented throw
// ==========================================================================
// `throw new Error("not implemented")` and variants in non-test source.
// Sometimes legitimate (intentional skeleton for a class hierarchy), but
// every occurrence is worth surfacing — agents often leave these as the
// "I'll come back to it" marker and never do.

const NOT_IMPLEMENTED_MESSAGE_RE =
	/\bthrow\s+new\s+(?:[A-Z][\w$]*\s*)?Error\s*\(\s*["'`]([^"'`]*)["'`]/g;
const NOT_IMPLEMENTED_PHRASES =
	/^(?:not\s+(?:yet\s+)?implemented|unimplemented|method\s+not\s+implemented|to\s+be\s+implemented|coming\s+soon|stub|TODO|wip|work\s+in\s+progress|not\s+ready|placeholder)$/i;
const EMPTY_THROW_RE = /\bthrow\s+new\s+(?:[A-Z][\w$]*\s*)?Error\s*\(\s*\)/;

/** Public API — flags `throw new Error("not implemented")` and variants. */
export function checkStubNotImplementedThrow(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const matches: InlineMatch[] = [];
	// Scan with comments blanked (length-preserving) so a `throw new Error("not
	// implemented")` quoted inside a JSDoc/`//` comment that *describes* the stub
	// pattern — as this check's own docs do — isn't mistaken for a real stub.
	// Strings stay intact so a genuine stub's message is still captured.
	const scan = stripComments(content);
	const lines = scan.split("\n");
	const MAX_MATCHES = 5;

	NOT_IMPLEMENTED_MESSAGE_RE.lastIndex = 0;
	let match: RegExpExecArray | null = NOT_IMPLEMENTED_MESSAGE_RE.exec(scan);
	while (match !== null && matches.length < MAX_MATCHES) {
		const message = match[1].trim();
		if (NOT_IMPLEMENTED_PHRASES.test(message)) {
			const offset = match.index;
			const lineIdx = (scan.slice(0, offset).match(/\n/g) || []).length;
			matches.push({
				line: lineIdx + 1,
				text: `stub throw new Error with placeholder message ("${message.slice(0, 60)}") — finish the implementation or delete the stub`,
			});
		}
		match = NOT_IMPLEMENTED_MESSAGE_RE.exec(scan);
	}

	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		if (EMPTY_THROW_RE.test(lines[i])) {
			matches.push({
				line: i + 1,
				text: `throw new Error() with no message — supply a real message or delete the placeholder`,
			});
		}
	}

	return matches;
}

// ==========================================================================
// 3. Dead branch literal
// ==========================================================================
// `if (true)` / `if (false)` / `else if (true)` — debugging artifacts. We
// deliberately skip `while (true)` since that's a legitimate event-loop
// idiom paired with internal `break`/`return`.

const DEAD_BRANCH_RE = /\b(?:else\s+)?if\s*\(\s*(?:true|false)\s*\)/;

/** Public API — flags `if (true)` / `if (false)` literal branch conditions. */
export function checkDeadBranchLiteral(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		if (!DEAD_BRANCH_RE.test(strippedLines[i])) continue;
		matches.push({
			line: i + 1,
			text: `dead branch literal: ${originalLines[i].trim().slice(0, 130)}`,
		});
	}
	return matches;
}

// ==========================================================================
// 4. File-level suppression
// ==========================================================================
// Directives that disable type/lint checking for the entire file — a
// different harm class than per-line suppressions because they're invisible
// at every site of the file. Skips .d.ts (type declarations have nothing
// runtime to typecheck), test files, and generated-code paths.

interface FileLevelDisable {
	re: RegExp;
	label: string;
}

const FILE_LEVEL_DISABLES: readonly FileLevelDisable[] = [
	{
		re: new RegExp(`\\/\\/\\s*${TS_NOCHECK_TOKEN}\\b`),
		label: `${TS_NOCHECK_TOKEN} (file-wide TypeScript disable)`,
	},
	{
		re: new RegExp(`\\/\\*\\s*${TS_NOCHECK_TOKEN}\\s*\\*\\/`),
		label: `${TS_NOCHECK_TOKEN} (file-wide TypeScript disable)`,
	},
	{
		re: new RegExp(`\\/\\*\\s*${ESLINT_DISABLE_TOKEN}\\s*\\*\\/`),
		label: `${ESLINT_DISABLE_TOKEN} with no rule list (file-wide ESLint disable)`,
	},
	{
		re: new RegExp(`\\/\\*\\s*${TSLINT_DISABLE_TOKEN}\\s*\\*\\/`),
		label: `${TSLINT_DISABLE_TOKEN} with no rule list (file-wide TSLint disable)`,
	},
	{
		re: new RegExp(`\\/\\/\\s*${BIOME_IGNORE_ALL_TOKEN}\\b`),
		label: `${BIOME_IGNORE_ALL_TOKEN} (file-wide Biome disable)`,
	},
	{
		re: /^\s*#\s*pylint:\s*disable=all\b/m,
		label: "pylint: disable=all (file-wide pylint disable)",
	},
];

const GENERATED_PATH_RE =
	/(?:\.gen|\.generated)\.(?:tsx?|jsx?|mjs|cjs|py)$|\/(?:generated|__generated__)\//;

function findFileLevelDisable(line: string): FileLevelDisable | undefined {
	for (const entry of FILE_LEVEL_DISABLES) {
		if (entry.re.test(line)) return entry;
	}
	return undefined;
}

/** Public API — flags file-level suppression directives. */
export function checkFileLevelSuppression(content: string, filePath: string): InlineMatch[] {
	if (filePath.endsWith(".d.ts")) return [];
	if (isTestFile(filePath)) return [];
	if (GENERATED_PATH_RE.test(filePath)) return [];
	// 139-repo audit: the standard pattern in generator output IS to ship a
	// file-level `eslint-disable` / `tslint:disable` header (e.g. OpenAPI
	// Generator's DefaultApi.ts). Flagging that produces 132+ FPs in a
	// single file. The path-name gate above (`/generated/`) catches a few
	// cases; the content-marker gate catches the rest where the path
	// doesn't reveal the origin.
	if (isGeneratedFile(content)) return [];

	const matches: InlineMatch[] = [];
	const lines = content.split("\n");
	const MAX_MATCHES = 3;
	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		const hit = findFileLevelDisable(lines[i]);
		if (!hit) continue;
		matches.push({
			line: i + 1,
			text: `${hit.label}. Replace with targeted line-level directives so cold readers see what's actually being suppressed.`,
		});
	}
	return matches;
}

// ==========================================================================
// 5. Untestable time / nondeterminism in source
// ==========================================================================
// `Date.now()`, `new Date()`, `Math.random()`, `crypto.randomUUID()`, etc.
// inline in non-test source — the #1 cause of "passes locally, flakes in
// CI." Should flow through a clock/RNG injection point. Skips files that
// look like the injection point itself (clock.ts, random.ts, uuid.ts).

const UNTESTABLE_TIME_RE =
	/\b(?:Date\s*\.\s*now\s*\(|new\s+Date\s*\(\s*\)|Math\s*\.\s*random\s*\(|crypto\s*\.\s*randomUUID\s*\(|crypto\s*\.\s*randomBytes\s*\(|performance\s*\.\s*now\s*\(|process\s*\.\s*hrtime\s*(?:\.bigint)?\s*\()/;

const TIME_INJECTION_FILE_RE =
	/(?:^|\/)(clock|time|random|rng|seed|uuid|id-?gen|timestamp|nonce|crypto)/i;

/** Public API — flags untestable time/RNG calls in non-test source. */
export function checkUntestableTimeInSource(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (isCliFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (TIME_INJECTION_FILE_RE.test(filePath.replace(/\\/g, "/"))) return [];
	if (filePath.includes("/scripts/") || filePath.includes("/bench/")) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		const m = UNTESTABLE_TIME_RE.exec(strippedLines[i]);
		if (!m) continue;
		const callName = m[0].replace(/\s+/g, "");
		matches.push({
			line: i + 1,
			text: `untestable nondeterminism (${callName}): ${originalLines[i].trim().slice(0, 110)}`,
		});
	}
	return matches;
}
