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
	const lines = content.split("\n");
	const MAX_MATCHES = 5;

	NOT_IMPLEMENTED_MESSAGE_RE.lastIndex = 0;
	let match: RegExpExecArray | null = NOT_IMPLEMENTED_MESSAGE_RE.exec(content);
	while (match !== null && matches.length < MAX_MATCHES) {
		const message = match[1].trim();
		if (NOT_IMPLEMENTED_PHRASES.test(message)) {
			const offset = match.index;
			const lineIdx = (content.slice(0, offset).match(/\n/g) || []).length;
			matches.push({
				line: lineIdx + 1,
				text: `stub throw new Error with placeholder message ("${message.slice(0, 60)}") — finish the implementation or delete the stub`,
			});
		}
		match = NOT_IMPLEMENTED_MESSAGE_RE.exec(content);
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

// ==========================================================================
// 6. `as unknown as X` double cast
// ==========================================================================
// Agents reach for this when a single `as` won't satisfy TypeScript. Lying
// to the type system through a wider escape hatch. Distinct from `as any`.

const DOUBLE_CAST_RE = /\bas\s+unknown\s+as\s+([A-Z][\w$<>[\],\s]*)/;

/** Public API — flags `x as unknown as Foo` double-cast escape hatch. */
export function checkDoubleCastUnknown(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		const m = DOUBLE_CAST_RE.exec(strippedLines[i]);
		if (!m) continue;
		const target = m[1].trim().slice(0, 30);
		matches.push({
			line: i + 1,
			text: `\`as unknown as ${target}\` — double-cast bypasses the type system. Validate at the boundary instead. ${originalLines[i].trim().slice(0, 80)}`,
		});
	}
	return matches;
}

// ==========================================================================
// 7. Union widened with `string`
// ==========================================================================
// `type X = "a" | "b" | string` defeats the union — TS narrows it back to
// `string`. Agent-specific anti-pattern: writing the literal alternatives
// AND the wide type "to be safe."

const TYPE_ALIAS_ANCHOR_RE = /^\s*(?:export\s+)?type\s+\w+/;
// Match `"a" | "b" | string` where `string` is bare (not followed by `&`).
// Negative lookahead `(?!\s*&)` excludes the branded-string pattern
// `string & {}`, which is the recommended fix and must not be flagged.
const UNION_LITERAL_THEN_BARE_STRING_RE =
	/(?:["'][^"']*["']\s*\|\s*)+\s*(?:\(\s*)?string\b(?!\s*&)/;
const UNION_BARE_STRING_THEN_LITERAL_RE =
	/(?<!&\s*)\bstring\b(?!\s*&)\s*\|\s*(?:["'][^"']*["']\s*(?:\|\s*["'][^"']*["']\s*)*)/;

const TYPE_ALIAS_WINDOW_LINES = 6;

/** Public API — flags string-literal unions widened by a bare `string`. */
export function checkUnionWidenedWithString(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const stripped = stripCommentsAndStrings(content);
	const strippedLines = stripped.split("\n");
	const originalLines = content.split("\n");

	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		if (!TYPE_ALIAS_ANCHOR_RE.test(strippedLines[i])) continue;
		const window = originalLines
			.slice(i, Math.min(originalLines.length, i + TYPE_ALIAS_WINDOW_LINES))
			.join(" ");
		const widensWithString =
			UNION_LITERAL_THEN_BARE_STRING_RE.test(window) ||
			UNION_BARE_STRING_THEN_LITERAL_RE.test(window);
		if (!widensWithString) continue;
		matches.push({
			line: i + 1,
			text: `union widened with bare \`string\`: ${originalLines[i].trim().slice(0, 130)} — the literal alternatives are erased.`,
		});
	}
	return matches;
}

// ==========================================================================
// 8. NODE_ENV branch in production
// ==========================================================================
// `process.env.NODE_ENV === "test"` (or "development") inside non-test
// source — branches production behavior on the test mode. Different harm
// class than env-as-config.

const NODEENV_BRANCH_RE =
	/\bprocess\s*\.\s*env\s*\.\s*NODE_ENV\s*[!=]==?\s*['"](test|development|dev|staging|local)['"]/;

const CONFIG_FILE_BASES = new Set([
	"vite",
	"vitest",
	"tsup",
	"biome",
	"next",
	"remix",
	"nuxt",
	"astro",
	"webpack",
	"rollup",
	"tailwind",
	"playwright",
	"jest",
	"babel",
	"postcss",
	"svelte",
	"eslint",
	"prettier",
]);
const CONFIG_FILE_TAIL_RE = /\.config\.[mc]?[jt]sx?$/;

function isProjectConfigFile(filePath: string): boolean {
	const last = filePath.replace(/\\/g, "/").split("/").pop() || "";
	if (!CONFIG_FILE_TAIL_RE.test(last)) return false;
	const base = last.split(".")[0];
	return CONFIG_FILE_BASES.has(base);
}

/** Public API — flags `process.env.NODE_ENV` comparisons in production source. */
export function checkNodeEnvBranchInProd(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (isProjectConfigFile(filePath)) return [];
	if (filePath.includes("/setup") || filePath.includes("/bootstrap")) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	// Strip comments only — string literals are essential to this check
	// because the literal compared value (`"test"` / `"development"`) is
	// exactly what the regex inspects.
	const stripped = stripComments(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		const m = NODEENV_BRANCH_RE.exec(strippedLines[i]);
		if (!m) continue;
		const matchedEnv = m[1];
		matches.push({
			line: i + 1,
			text: `production code branches on NODE_ENV (matched value: ${matchedEnv}): ${originalLines[i].trim().slice(0, 110)}`,
		});
	}
	return matches;
}

// ==========================================================================
// 9. Fetch without timeout / abort
// ==========================================================================
// `fetch(url)` and `axios.{get,post,...}(url)` calls without `signal:` /
// `timeout:` in their options. Window scan over up to 10 forward lines
// to allow for multi-line options objects.

const FETCH_CALL_RE = /\bfetch\s*\(/;
const AXIOS_CALL_RE = /\baxios\s*\.\s*(?:get|post|put|patch|delete|request)\s*\(/;
const TIMEOUT_OR_SIGNAL_RE = /\b(?:signal|timeout|AbortSignal|AbortController)\b/;
// Cloudflare Worker entry handler — `async fetch(request: Request, env: Env, ctx: ExecutionContext)`
// or `fetch(req: Request, ...)` as a method on the default ExportedHandler. NOT a
// `fetch()` call; the runtime invokes it on incoming requests. Detect by the
// `: Request` typed parameter — that string essentially never appears inside a
// fetch() function call.
const FETCH_HANDLER_DECL_RE = /(?:^|\s|,)\(?\s*(?:async\s+)?fetch\s*\(\s*\w+\s*:\s*Request\b/;
// Member-access `<receiver>.fetch(` where the receiver is NOT a global-namespace
// alias. The global `fetch` is invoked bare; member calls like
// `env.ASSETS.fetch(request)` (Cloudflare service / static-asset / Durable-Object
// bindings) and `stub.fetch(req)` dispatch through the runtime's binding plumbing,
// which doesn't accept a per-call `AbortSignal`/timeout the way `globalThis.fetch`
// does. We still flag the namespaced globals (`globalThis`/`self`/`window`/`global`).
const FETCH_GLOBAL_NS = /\b(?:globalThis|self|window|global)$/;
const FETCH_MEMBER_RECEIVER_RE = /([\w$.]+)\.fetch\s*\(/;

const FETCH_CONTEXT_LINES = 10;

function fetchHasTimeoutInWindow(strippedLines: string[], startIdx: number): boolean {
	const end = Math.min(strippedLines.length, startIdx + FETCH_CONTEXT_LINES + 1);
	const window = strippedLines.slice(startIdx, end).join("\n");
	return TIMEOUT_OR_SIGNAL_RE.test(window);
}

/**
 * True when the `fetch(` on this line is a member call on a runtime binding
 * (`env.ASSETS.fetch(...)`, a service-binding stub, a Durable-Object stub) rather
 * than the global `fetch`. Those dispatch through Workers binding plumbing and
 * don't take a per-call `AbortSignal`/timeout, so flagging them is a false
 * positive. Namespaced globals (`globalThis.fetch` etc.) are NOT treated as
 * bindings — they still need a timeout.
 */
function isBindingFetchCall(line: string): boolean {
	const m = FETCH_MEMBER_RECEIVER_RE.exec(line);
	if (!m) return false;
	const receiver = m[1];
	return !FETCH_GLOBAL_NS.test(receiver);
}

/** Public API — flags fetch / axios calls without an abort signal or timeout. */
export function checkFetchWithoutTimeout(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const stripped = stripCommentsAndStrings(content);
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		const isFetch = FETCH_CALL_RE.test(strippedLines[i]);
		const isAxios = AXIOS_CALL_RE.test(strippedLines[i]);
		if (!isFetch && !isAxios) continue;
		// Skip Cloudflare Worker entry handler — the `fetch(req: Request, ...)`
		// method declaration on the default ExportedHandler is invoked by the
		// runtime, not a `fetch()` call we'd want to add a timeout to.
		if (isFetch && FETCH_HANDLER_DECL_RE.test(strippedLines[i])) continue;
		// Skip runtime binding member calls (`env.ASSETS.fetch(request)`, service /
		// DO stubs) — they don't accept a per-call AbortSignal/timeout.
		if (isFetch && isBindingFetchCall(strippedLines[i])) continue;
		if (fetchHasTimeoutInWindow(strippedLines, i)) continue;
		const label = isFetch ? "fetch()" : "axios call";
		matches.push({
			line: i + 1,
			text: `${label} without signal: / timeout: option — slow upstreams will leak request handles. Pass an AbortController.signal or per-call timeout.`,
		});
	}
	return matches;
}

// ==========================================================================
// 10. Promise.all on unbounded array
// ==========================================================================
// `Promise.all(arr.map(asyncFn))` where `arr` traces back to a function
// parameter, fetched value, or unbounded source. Fans out N requests; with
// 10K rows you get 10K parallel sockets.

const PROMISE_ALL_MAP_RE = /\bPromise\s*\.\s*all\s*\(\s*([\w$]+)\s*\.\s*map\s*\(/;
const PROMISE_ALL_INLINE_RE = /\bPromise\s*\.\s*all\s*\(\s*\[/;
const ARRAY_FROM_FINITE_RE = /\bArray\s*\.\s*from\s*\(\s*\{\s*length\s*:\s*\d+/;

function isLocallyBoundedArray(line: string, ident: string): boolean {
	const literalAssign = new RegExp(`\\b${ident}\\s*=\\s*\\[`);
	return literalAssign.test(line) || ARRAY_FROM_FINITE_RE.test(line);
}

/** Public API — flags `Promise.all(<ident>.map(...))` patterns. */
export function checkUnboundedPromiseAll(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		if (PROMISE_ALL_INLINE_RE.test(strippedLines[i])) continue;
		const m = PROMISE_ALL_MAP_RE.exec(strippedLines[i]);
		if (!m) continue;
		const ident = m[1];
		if (isLocallyBoundedArray(strippedLines[i], ident)) continue;
		matches.push({
			line: i + 1,
			text: `Promise.all(${ident}.map(...)) fans out unboundedly. Use p-limit / pMap({concurrency}) to cap parallelism: ${originalLines[i].trim().slice(0, 100)}`,
		});
	}
	return matches;
}

// ==========================================================================
// 11. Synchronous I/O on hot paths
// ==========================================================================
// `*Sync(...)` calls inside HTTP handler / route / middleware files or in
// functions whose names imply request handling. Narrow scope keeps FPs out
// of CLIs and one-shot scripts.

const HOT_PATH_DIR_RE = /(?:^|\/)(?:handlers|routes|api|middleware|controllers)(?:\/|$)/;
// Handler-shaped function names. Two families:
//   1. `handle` / `route` / `onRequest` / `on<Capital>` — prefix match is
//      safe: these strings essentially never begin a non-handler identifier.
//   2. Bare HTTP verbs (`get` / `post` / `put` / `patch` / `delete` /
//      `fetch` / `serve`) — these MUST be the WHOLE identifier. A `\w*`
//      suffix here is the FP source: `getActivityPath`, `getSessionsDir`,
//      `getUnsyncedEvents`, `deleteRecord`, `fetchPage`, … are plain
//      getters/helpers in ordinary library code, not route handlers. A
//      router method is registered as exactly `get(` / `post(` etc., so
//      anchoring the verb to a full identifier keeps the true positives
//      (`function get(req) {…}`, `router.get(...)`) while dropping the
//      camelCase-helper false positives.
const HOT_PATH_PREFIX_NAMES = "handle|route|onRequest|on[A-Z]\\w*";
const HOT_PATH_VERB_NAMES = "get|post|put|patch|delete|fetch|serve";
const HOT_PATH_FN_NAME_RE = new RegExp(
	`\\b(?:async\\s+)?function\\s+(?:(?:${HOT_PATH_PREFIX_NAMES})\\w*|(?:${HOT_PATH_VERB_NAMES}))\\s*\\(`,
);
const HOT_PATH_ARROW_RE = new RegExp(
	`\\b(?:const|let|var)\\s+(?:(?:${HOT_PATH_PREFIX_NAMES})\\w*|(?:${HOT_PATH_VERB_NAMES}))\\s*[:=]\\s*(?:async\\s*)?\\(`,
);
const SYNC_IO_RE =
	/\b(?:readFileSync|writeFileSync|appendFileSync|execSync|spawnSync|statSync|lstatSync|mkdirSync|readdirSync|unlinkSync|rmSync|copyFileSync|renameSync|chmodSync|openSync|closeSync|realpathSync)\s*\(/;

function fileLooksLikeHotPath(content: string, filePath: string): boolean {
	const norm = filePath.replace(/\\/g, "/");
	if (HOT_PATH_DIR_RE.test(norm)) return true;
	return HOT_PATH_FN_NAME_RE.test(content) || HOT_PATH_ARROW_RE.test(content);
}

/** Public API — flags sync I/O calls inside HTTP-handler-shaped files. */
export function checkSyncIoOnHotPath(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (isCliFile(filePath)) return [];
	if (filePath.includes("/scripts/") || filePath.includes("/bench/")) return [];
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (!fileLooksLikeHotPath(content, filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 5;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		const m = SYNC_IO_RE.exec(strippedLines[i]);
		if (!m) continue;
		const callName = m[0].replace(/\s+/g, "").replace(/\($/, "");
		matches.push({
			line: i + 1,
			text: `sync I/O on hot path (${callName}): ${originalLines[i].trim().slice(0, 100)} — blocks the event loop under load.`,
		});
	}
	return matches;
}
