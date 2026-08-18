// Portability lint family (Plan 25 lane 6,
// docs/plans/25-refactor-readiness-program.md). Three advisory, post-phase
// detectors for constructs that defeat static analysis, porting agents, or
// cross-language numeric models:
//   dynamic_code_execution     — eval(/new Function(/require(non-literal)/import(non-literal)
//   builtin_prototype_mutation — monkey-patching a builtin prototype or global
//   float_equality_comparison  — === / !== against a float literal
//
// dynamic_code_execution's eval(/new Function( triggers overlap with the
// existing pre_block `eval_usage` hard rail (entries-errors.ts, security
// framing: code-injection risk) — that gate blocks the WRITE outright, so in
// a harness-guarded repo those two branches are expected to fire near zero
// (the gate already scrubbed them). This check is advisory/post: it fires on
// whatever is ALREADY on disk (pre-existing legacy code, or code introduced
// through a documented INTERLINKED_DISABLE_* bypass) under a PORTABILITY
// framing, and adds require(non-literal)/import(non-literal), which no
// existing check covers. Defense-in-depth is deliberate — the same pattern
// secrets detection already uses (both PreToolUse and PostToolUse).

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_ALL_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";
// `offsetToLine` (1-based, valid across strip-with-blanking because the
// stripper preserves line count) is shared — see shared-text-utils.ts. Direct
// in-package import: shared.ts sits at its line cap and cannot carry another
// re-export line.
import { offsetToLine } from "./shared-text-utils.js";

const MAX_MATCHES_PER_FILE = 10;
const REPORT_LINE_TRUNC = 150;
const PAREN_SEARCH_CAP = 4000;

// ─── Shared scan helpers ────────────────────────────────────────────────────

/** Record one match at `offset`, deduped per line, bounded by the caller. */
function pushMatch(
	stripped: string,
	rawLines: string[],
	offset: number,
	message: string,
	matches: InlineMatch[],
	seen: Set<number>,
): void {
	const lineNo = offsetToLine(stripped, offset);
	if (seen.has(lineNo)) return;
	seen.add(lineNo);
	const text = (rawLines[lineNo - 1] ?? "").trim().slice(0, REPORT_LINE_TRUNC);
	matches.push({ line: lineNo, text: `${message} — ${text}` });
}

/** Scan `stripped` for every occurrence of `re`, recording each as `message`. */
function scanSimpleTrigger(
	stripped: string,
	rawLines: string[],
	re: RegExp,
	message: string,
	matches: InlineMatch[],
	seen: Set<number>,
): void {
	const local = new RegExp(re.source, re.flags);
	let m: RegExpExecArray | null;
	while ((m = local.exec(stripped))) {
		if (matches.length >= MAX_MATCHES_PER_FILE) return;
		pushMatch(stripped, rawLines, m.index, message, matches, seen);
	}
}

// ─── 1. dynamic_code_execution ─────────────────────────────────────────────

const EVAL_RE = /(?<![.\w$])eval\s*\(/g;
const NEW_FUNCTION_RE = /\bnew\s+Function\s*\(/g;
const REQUIRE_RE = /(?<![.\w$])require\s*\(/g;
const DYNAMIC_IMPORT_RE = /(?<![.\w$])import\s*\(/g;

/** Matching close paren for the `(` at `openIdx` in `s`, bounded search.
 *  -1 when no match is found within the bound. */
function findCloseParen(s: string, openIdx: number): number {
	let depth = 0;
	const end = Math.min(s.length, openIdx + PAREN_SEARCH_CAP);
	for (let i = openIdx; i < end; i++) {
		const c = s.charAt(i);
		if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return i;
	}
	return -1;
}

/**
 * True when a call argument (already run through `stripCommentsAndStrings`,
 * which collapses a string literal's interior to a fixed 2-char token) was a
 * PLAIN single- or double-quoted string literal with nothing else in the
 * argument slot. Deliberately does NOT accept backtick templates — the
 * stripper collapses both interpolated and plain templates to the identical
 * `` `` `` token, so there is no way to tell them apart post-strip; treating
 * every template as "not a plain literal" is the safe direction (a rare
 * extra advisory flag on a plain-template path, never a missed dynamic one).
 */
function isStaticStringArg(strippedArg: string): boolean {
	const t = strippedArg.trim();
	return t === '""' || t === "''";
}

/** Scan for every occurrence of `re` (a `require(`/`import(`-shaped call
 *  opener) and record it only when its first argument is NOT a plain string
 *  literal. */
function scanNonLiteralCallTrigger(
	stripped: string,
	rawLines: string[],
	re: RegExp,
	message: string,
	matches: InlineMatch[],
	seen: Set<number>,
): void {
	const local = new RegExp(re.source, re.flags);
	let m: RegExpExecArray | null;
	while ((m = local.exec(stripped))) {
		if (matches.length >= MAX_MATCHES_PER_FILE) return;
		const openIdx = m.index + m[0].length - 1;
		const closeIdx = findCloseParen(stripped, openIdx);
		if (closeIdx === -1) continue;
		const arg = stripped.slice(openIdx + 1, closeIdx);
		if (isStaticStringArg(arg)) continue;
		pushMatch(stripped, rawLines, m.index, message, matches, seen);
	}
}

/**
 * Detect `eval(`, `new Function(`, `require(<non-literal>)`, and
 * `import(<non-literal>)` — constructs that defeat every static analyzer AND
 * every porting agent, since the executed code is not visible in the source
 * text. Skips test files (sandboxed-eval and mock-dynamic-require fixtures
 * are common and legitimate there) and non-JS/TS files.
 */
export function detectDynamicCodeExecution(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_ALL_EXTS.includes(getExtension(filePath))) return [];
	if (content.length === 0) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const rawLines = content.split("\n");
	const matches: InlineMatch[] = [];
	const seen = new Set<number>();

	scanSimpleTrigger(stripped, rawLines, EVAL_RE, "dynamic_code_execution: eval(", matches, seen);
	if (matches.length < MAX_MATCHES_PER_FILE) {
		scanSimpleTrigger(
			stripped,
			rawLines,
			NEW_FUNCTION_RE,
			"dynamic_code_execution: new Function(",
			matches,
			seen,
		);
	}
	if (matches.length < MAX_MATCHES_PER_FILE) {
		scanNonLiteralCallTrigger(
			stripped,
			rawLines,
			REQUIRE_RE,
			"dynamic_code_execution: require( with a non-literal argument",
			matches,
			seen,
		);
	}
	if (matches.length < MAX_MATCHES_PER_FILE) {
		scanNonLiteralCallTrigger(
			stripped,
			rawLines,
			DYNAMIC_IMPORT_RE,
			"dynamic_code_execution: import( with a non-literal argument",
			matches,
			seen,
		);
	}

	return matches;
}

// ─── 2. builtin_prototype_mutation ─────────────────────────────────────────

const PROTOTYPE_TARGETS =
	"String|Array|Object|Number|Boolean|Function|RegExp|Date|Error|Map|Set|WeakMap|WeakSet|Promise|Symbol";
/** `<Builtin>.prototype.<member> =` — excludes `==`/`===`/`=>` via the
 *  trailing negative lookahead. A read (`.call(`, no `=`) never matches. */
const PROTOTYPE_ASSIGN_RE = new RegExp(
	String.raw`\b(?:${PROTOTYPE_TARGETS})\.prototype\.[A-Za-z_$][\w$]*\s*=(?![=>])`,
	"g",
);

// Bare-identifier reassignment is restricted to builtins that are, in
// practice, never legitimate local variable / type-param names (Array,
// Object, JSON, Math, Promise, RegExp, Reflect, Proxy) — String/Number/
// Boolean/Map/Set/Date/Error stay OUT of this list (too collision-prone as
// ordinary identifiers) but remain covered by PROTOTYPE_ASSIGN_RE above,
// where the `.prototype.` context is unambiguous regardless of the base
// name's commonness.
const GLOBAL_REASSIGN_TARGETS = "Array|Object|JSON|Math|Promise|RegExp|Reflect|Proxy";
/** Anchored to the start of a (trimmed) line so `type Foo = Array<...>` and
 *  `obj.Array = x` (property access, not the global) never match — only a
 *  bare `Array = ...` statement does. */
const GLOBAL_BARE_REASSIGN_RE = new RegExp(
	String.raw`^\s*(?:${GLOBAL_REASSIGN_TARGETS})\s*=(?![=>])`,
	"gm",
);
/** `window.`/`globalThis.`/`global.` prefix is unambiguous regardless of
 *  line position, so this form doesn't need the line-anchor. */
const GLOBAL_SCOPED_REASSIGN_RE = new RegExp(
	String.raw`\b(?:window|globalThis|global)\.(?:${GLOBAL_REASSIGN_TARGETS})\s*=(?![=>])`,
	"g",
);

/**
 * Detect monkey-patching of a built-in's prototype (`String.prototype.pad =
 * ...`) or reassignment of a global builtin (`Array = ...`,
 * `globalThis.JSON = ...`). These patterns do not translate across
 * languages — a porting agent has nowhere to put them — and defeat any
 * static analyzer that assumes builtin semantics are stable.
 */
export function detectBuiltinPrototypeMutation(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_ALL_EXTS.includes(getExtension(filePath))) return [];
	if (content.length === 0) return [];

	const stripped = stripCommentsAndStrings(content);
	const rawLines = content.split("\n");
	const matches: InlineMatch[] = [];
	const seen = new Set<number>();

	scanSimpleTrigger(
		stripped,
		rawLines,
		PROTOTYPE_ASSIGN_RE,
		"builtin_prototype_mutation: assignment into a builtin prototype",
		matches,
		seen,
	);
	if (matches.length < MAX_MATCHES_PER_FILE) {
		scanSimpleTrigger(
			stripped,
			rawLines,
			GLOBAL_BARE_REASSIGN_RE,
			"builtin_prototype_mutation: reassignment of a global builtin",
			matches,
			seen,
		);
	}
	if (matches.length < MAX_MATCHES_PER_FILE) {
		scanSimpleTrigger(
			stripped,
			rawLines,
			GLOBAL_SCOPED_REASSIGN_RE,
			"builtin_prototype_mutation: reassignment of a global builtin",
			matches,
			seen,
		);
	}

	return matches;
}

// ─── 3. float_equality_comparison ──────────────────────────────────────────

/** A numeric literal that CONTAINS A DOT — `0.1`, `3.14`, `.5`, `1.` — never
 *  a bare integer. */
const FLOAT_LITERAL_SRC = String.raw`-?(?:\d+\.\d+|\.\d+|\d+\.)`;
const FLOAT_RIGHT_RE = new RegExp(String.raw`(?:===|!==)\s*(${FLOAT_LITERAL_SRC})(?!\d)`, "g");
const FLOAT_LEFT_RE = new RegExp(String.raw`(?<![\w.])(${FLOAT_LITERAL_SRC})\s*(?:===|!==)`, "g");

/**
 * Detect `===` / `!==` where one operand is a float literal (contains a
 * dot). Float equality is both a bug class (rounding makes exact equality
 * unreliable) and a cross-language numeric-model trap (the same literal can
 * compare differently under a different language's float representation).
 * Operates on comment/string-stripped content, so a string that merely LOOKS
 * like a float (`version === "3.14"`) and a `.toBe(0.1)` test assertion
 * (no `===`/`!==` token at all) never match.
 */
export function detectFloatEqualityComparison(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_ALL_EXTS.includes(getExtension(filePath))) return [];
	if (content.length === 0) return [];

	const stripped = stripCommentsAndStrings(content);
	const rawLines = content.split("\n");
	const matches: InlineMatch[] = [];
	const seen = new Set<number>();
	const message = "float_equality_comparison: === / !== compares against a float literal";

	scanSimpleTrigger(stripped, rawLines, FLOAT_RIGHT_RE, message, matches, seen);
	if (matches.length < MAX_MATCHES_PER_FILE) {
		scanSimpleTrigger(stripped, rawLines, FLOAT_LEFT_RE, message, matches, seen);
	}

	return matches;
}

// ─── Python parity (plan 25) ────────────────────────────────────────────────
// The same portability class in Python idiom. One combined detector: each
// trap kind labels its own match, so the finding names the specific problem
// without three more registry ids.

const PY_EVAL_EXEC_RE = /\b(?:eval|exec)\s*\(/g;
const PY_MUTABLE_DEFAULT_RE = /\bdef\s+\w+\s*\([^)]*=\s*(?:\[\]|\{\}|set\(\)|dict\(\)|list\(\))/g;
const PY_STAR_IMPORT_RE = /^[ \t]*from\s+[\w.]+\s+import\s+\*/gm;
const PY_TEST_PATH_RE = /(^|\/)test_[^/]+\.py$|_test\.py$|(^|\/)tests\//;

/** Strip strings via the shared helper, then blank `#` comments (the shared
 *  stripper only knows JS comment syntax). Line count is preserved. */
function stripPySyntax(content: string): string {
	return stripCommentsAndStrings(content).replace(/#[^\n]*/g, "");
}

/**
 * Python portability traps: eval()/exec() (dynamic code, invisible to every
 * static tool), mutable default arguments (shared-state bug class with no
 * cross-language equivalent), and `from x import *` (defeats import
 * resolution for analyzers and porting agents alike).
 */
export function detectPythonPortabilityTraps(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".py") return [];
	if (content.length === 0) return [];
	if (PY_TEST_PATH_RE.test(filePath.replace(/\\/g, "/"))) return [];

	const stripped = stripPySyntax(content);
	const rawLines = content.split("\n");
	const matches: InlineMatch[] = [];
	const seen = new Set<number>();

	scanSimpleTrigger(
		stripped,
		rawLines,
		PY_EVAL_EXEC_RE,
		"python_portability_trap: eval()/exec() executes invisible code",
		matches,
		seen,
	);
	if (matches.length < MAX_MATCHES_PER_FILE) {
		scanSimpleTrigger(
			stripped,
			rawLines,
			PY_MUTABLE_DEFAULT_RE,
			"python_portability_trap: mutable default argument is shared across calls",
			matches,
			seen,
		);
	}
	if (matches.length < MAX_MATCHES_PER_FILE) {
		scanSimpleTrigger(
			stripped,
			rawLines,
			PY_STAR_IMPORT_RE,
			"python_portability_trap: `from x import *` defeats static import resolution",
			matches,
			seen,
		);
	}
	return matches;
}
