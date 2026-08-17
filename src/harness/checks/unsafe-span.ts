// Escape-hatch SCOPE checks — how WIDE the escape hatch is, not whether one
// exists.
//
// rust_unsafe_span:
//   A Rust `unsafe { ... }` block spanning many lines hides unrelated safe
//   code from the borrow checker. Bun's Zig→Rust port data point: ~4% of the
//   port is unsafe and 78% of the unsafe blocks are a SINGLE line (a pointer
//   from C++ or one C call). A wide block is almost always scope creep — safe
//   code riding inside the hatch. The existing `rust_unsafe_blocks` check
//   (language-profiles) covers EXISTENCE + SAFETY comment; this check
//   measures SPAN only and deliberately does not duplicate the SAFETY-comment
//   requirement.
//
// suppression_block_span:
//   The JS/TS analog. A block-form eslint-disable comment with a matching
//   eslint-enable later turns the linter off for the whole region; when that
//   region spans many lines the suppression covers code that never needed it.
//   Line-form `// eslint-disable-next-line` is the narrow tool. A disable
//   with NO matching enable is file-level suppression — a different bug
//   class owned by the file-level suppression check — so it is deliberately
//   NOT reported here.

import {
	getExtension,
	type InlineMatch,
	isGeneratedFile,
	isTestFile,
	JS_TS_ALL_EXTS,
} from "./shared.js";
// Shared line table (this file's binary-search resolver was the model for it).
// Direct in-package import — shared.ts sits at its line cap and cannot carry
// another re-export line.
import { buildLineIndex } from "./shared-text-utils.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const REPORT_LINE_TRUNC = 150;
const MAX_MATCHES_PER_FILE = 10;
/** Nonblank interior lines an `unsafe { ... }` block may span before firing. */
const MAX_UNSAFE_SPAN_LINES = 5;
/** Total lines a disable→enable suppression region may span before firing. */
const MAX_SUPPRESSION_SPAN_LINES = 10;

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Count newlines in `text[from, to)` — keeps the scanner's line counter cheap. */
function countNewlines(text: string, from: number, to: number): number {
	let n = 0;
	for (let i = from; i < to; i++) {
		if (text.charAt(i) === "\n") n++;
	}
	return n;
}

/** Trimmed original-line excerpt for the report text. */
function rawLineExcerpt(rawLines: string[], lineNo: number): string {
	return (rawLines[lineNo - 1] ?? "").trim().slice(0, REPORT_LINE_TRUNC);
}

// ─── Rust-aware stripping ─────────────────────────────────────────────────────
//
// The shared stripCommentsAndStrings helper is JS/Python-flavoured and broke
// Rust four ways: `#` read as a line comment (attributes, r#"…"# raw
// strings), same-line-only string pairing, lifetime apostrophes opening
// phantom quote state, and non-nesting block comments. This scanner follows
// the Rust lexer and blanks only comment/string/char-literal content.

/** Blank `src[from, to)` in `out` with spaces; newlines are preserved. */
function blankRange(src: string, out: string[], from: number, to: number): void {
	for (let i = from; i < to; i++) {
		if (src.charAt(i) !== "\n") out[i] = " ";
	}
}

/** Blank a `//` comment; returns the index of the terminating newline (or end). */
function blankRustLineComment(src: string, out: string[], start: number): number {
	const eol = src.indexOf("\n", start);
	const end = eol === -1 ? src.length : eol;
	blankRange(src, out, start, end);
	return end;
}

/** Blank a `/* ... *​/` block comment. Rust block comments NEST. */
function blankRustBlockComment(src: string, out: string[], start: number): number {
	let depth = 1;
	let i = start + 2;
	while (i < src.length) {
		if (src.charAt(i) === "/" && src.charAt(i + 1) === "*") {
			depth++;
			i += 2;
		} else if (src.charAt(i) === "*" && src.charAt(i + 1) === "/") {
			depth--;
			i += 2;
			if (depth === 0) break;
		} else {
			i++;
		}
	}
	blankRange(src, out, start, i);
	return i;
}

/** Blank a plain/byte/C string from its opening `"`. May span lines. */
function blankRustString(src: string, out: string[], start: number): number {
	let i = start + 1;
	while (i < src.length) {
		const ch = src.charAt(i);
		if (ch === "\\") i += 2;
		else if (ch === '"') {
			i++;
			break;
		} else i++;
	}
	blankRange(src, out, start, i);
	return i;
}

/** Raw-string opener (`r"`, `r#"`, `br##"`, `cr#"`, …) at `i`, or null; the
 * previous char must not extend an identifier (`ptr` + `#` never opens). */
function rawStringOpenAt(src: string, i: number): { openLen: number; hashes: number } | null {
	if (i > 0 && /[A-Za-z0-9_"']/.test(src.charAt(i - 1))) return null;
	let j = i;
	if (src.charAt(j) === "b" || src.charAt(j) === "c") j++;
	if (src.charAt(j) !== "r") return null;
	j++;
	let hashes = 0;
	while (src.charAt(j) === "#") {
		hashes++;
		j++;
	}
	if (src.charAt(j) !== '"') return null;
	return { openLen: j + 1 - i, hashes };
}

/** Blank a raw string: no escapes; closes at `"` + the opener's hash count. */
function blankRustRawString(
	src: string,
	out: string[],
	start: number,
	openLen: number,
	hashes: number,
): number {
	const closer = '"' + "#".repeat(hashes);
	const closeIdx = src.indexOf(closer, start + openLen);
	const end = closeIdx === -1 ? src.length : closeIdx + closer.length;
	blankRange(src, out, start, end);
	return end;
}

/**
 * `'` opens a char literal (blank it: exactly `'x'`, or `'\...'` — escape
 * head then close, e.g. `'\n'` `'\u{7FFF}'` `'\''`) or marks a lifetime /
 * loop label (`'a`, `'static`, `<'a>`): keep — identifier chars are code.
 */
function blankRustCharLiteral(src: string, out: string[], start: number): number {
	const next = src.charAt(start + 1);
	if (next === "\\") {
		for (let i = start + 3; i < src.length; i++) {
			const ch = src.charAt(i);
			if (ch === "'") {
				blankRange(src, out, start, i + 1);
				return i + 1;
			}
			if (ch === "\n") break;
		}
		return start + 1;
	}
	if (next !== "" && next !== "'" && src.charAt(start + 2) === "'") {
		blankRange(src, out, start, start + 3);
		return start + 3;
	}
	return start + 1;
}

/** Strip comments, strings, and char literals from Rust source, one pass. */
function stripRustForScan(content: string): string {
	const out = content.split("");
	let i = 0;
	while (i < content.length) {
		const ch = content.charAt(i);
		const next = content.charAt(i + 1);
		if (ch === "/" && next === "/") i = blankRustLineComment(content, out, i);
		else if (ch === "/" && next === "*") i = blankRustBlockComment(content, out, i);
		else if (ch === '"') i = blankRustString(content, out, i);
		else if (ch === "'") i = blankRustCharLiteral(content, out, i);
		else if (ch === "r" || ch === "b" || ch === "c") {
			const raw = rawStringOpenAt(content, i);
			if (raw !== null) i = blankRustRawString(content, out, i, raw.openLen, raw.hashes);
			else i++;
		} else i++;
	}
	return out.join("");
}

// ─── rust_unsafe_span ─────────────────────────────────────────────────────────

/**
 * Block form only: `unsafe` immediately followed by `{`. `unsafe fn` /
 * `unsafe impl` / `unsafe trait` / `unsafe extern` never match — a token
 * always sits between `unsafe` and their `{`.
 */
const UNSAFE_BLOCK_OPEN_RE = /\bunsafe\s*\{/g;

/**
 * Map from each `{` offset to its matching `}` offset — one stack pass;
 * candidates resolve in O(1) and unbalanced opens (absent keys) cost nothing.
 * Replaces a per-candidate scan-to-EOF (quadratic on many-block files).
 */
function buildBraceMatchMap(text: string): Map<number, number> {
	const close = new Map<number, number>();
	const stack: number[] = [];
	for (let i = 0; i < text.length; i++) {
		const ch = text.charAt(i);
		if (ch === "{") stack.push(i);
		else if (ch === "}") {
			const open = stack.pop();
			if (open !== undefined) close.set(open, i);
		}
	}
	return close;
}

/**
 * Count nonblank stripped lines strictly between two 1-based lines
 * (exclusive on both ends). The blank test runs on STRIPPED lines, so
 * comment-only lines (SAFETY comments) never widen the reported span.
 */
function countNonblankBetween(
	strippedLines: string[],
	openLine: number,
	closeLine: number,
): number {
	let count = 0;
	for (let l = openLine + 1; l < closeLine; l++) {
		const text = strippedLines[l - 1];
		if (text !== undefined && text.trim() !== "") count++;
	}
	return count;
}

/**
 * Detect Rust `unsafe { ... }` blocks whose interior spans more than
 * MAX_UNSAFE_SPAN_LINES nonblank lines. Span only — block existence and the
 * SAFETY-comment convention belong to `rust_unsafe_blocks`.
 *
 * Check id: `rust_unsafe_span`
 *
 * Only fires on `.rs` source files; test files, generator-marked files, and
 * rust-bindgen output are exempt. Returns up to 10 `InlineMatch` findings,
 * each anchored at the `unsafe` keyword's line.
 */
export function checkRustUnsafeSpan(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".rs") return [];
	if (isTestFile(filePath)) return [];
	if (isGeneratedFile(content) || content.includes("rust-bindgen")) return [];

	const stripped = stripRustForScan(content);
	const strippedLines = stripped.split("\n");
	const rawLines = content.split("\n");
	// Repeated lookups over one string — the precomputed O(log n) form (a
	// per-call linear scan made adversarial many-candidate files quadratic).
	const lineIndex = buildLineIndex(stripped);
	const braceClose = buildBraceMatchMap(stripped);
	const matches: InlineMatch[] = [];

	const re = new RegExp(UNSAFE_BLOCK_OPEN_RE.source, "g");
	let hit: RegExpExecArray | null;
	while ((hit = re.exec(stripped)) !== null) {
		if (matches.length >= MAX_MATCHES_PER_FILE) break;
		const openIdx = hit.index + hit[0].length - 1;
		const closeIdx = braceClose.get(openIdx);
		if (closeIdx === undefined) continue;
		const openLine = lineIndex.lineAt(openIdx);
		const closeLine = lineIndex.lineAt(closeIdx);
		// Nonblank interior count can only exceed the cap when the interior
		// has more than cap TOTAL lines — skip the line walk for small blocks.
		if (closeLine - openLine - 1 <= MAX_UNSAFE_SPAN_LINES) continue;
		const span = countNonblankBetween(strippedLines, openLine, closeLine);
		if (span <= MAX_UNSAFE_SPAN_LINES) continue;
		const lineNo = lineIndex.lineAt(hit.index);
		matches.push({
			line: lineNo,
			text: `rust_unsafe_span: unsafe block spans ${span} nonblank lines — narrow it to the operations that need it (78% of Bun's post-port unsafe blocks are one line) — ${rawLineExcerpt(rawLines, lineNo)}`,
		});
	}
	return matches;
}

// ─── suppression_block_span ───────────────────────────────────────────────────

interface EslintDirective {
	kind: "disable" | "enable";
	/** 1-based line of the directive comment's opening delimiter. */
	line: number;
	/** Rule names listed on the directive; empty = bare (covers ALL rules). */
	rules: string[];
}

// Anchored at the comment body's start, so a doc comment (whose body begins
// with `*`) or a mid-comment mention never classifies as a directive. The
// `(?![\w-])` lookahead rejects the `-next-line` / `-line` suffixed forms.
const DIRECTIVE_BODY_RE = /^\s*eslint-(disable|enable)(?![\w-])/;

/** Rule names after the directive keyword; a ` -- ` tail is a justification. */
function parseRuleList(tail: string): string[] {
	const list = tail.split(/\s--(?:\s|$)/)[0] ?? "";
	return list
		.split(",")
		.map((rule) => rule.trim())
		.filter((rule) => rule !== "");
}

function parseDirectiveBody(body: string): { kind: "disable" | "enable"; rules: string[] } | null {
	const m = DIRECTIVE_BODY_RE.exec(body);
	if (m === null) return null;
	return {
		kind: m[1] === "disable" ? "disable" : "enable",
		rules: parseRuleList(body.slice(m[0].length)),
	};
}

/** Index of the newline ending the line comment at `start`, or text end. */
function skipLineComment(content: string, start: number): number {
	const eol = content.indexOf("\n", start + 2);
	return eol === -1 ? content.length : eol;
}

/**
 * Consume the block comment opening at `start`. Records a directive when the
 * comment body is a block-form eslint disable/enable. Returns the index just
 * past the closing delimiter (or text end when unterminated).
 */
function consumeBlockComment(
	content: string,
	start: number,
	line: number,
	directives: EslintDirective[],
): number {
	const close = content.indexOf("*/", start + 2);
	const bodyEnd = close === -1 ? content.length : close;
	const parsed = parseDirectiveBody(content.slice(start + 2, bodyEnd));
	if (parsed !== null) directives.push({ kind: parsed.kind, line, rules: parsed.rules });
	return close === -1 ? content.length : close + 2;
}

function isQuoteChar(ch: string): boolean {
	return ch === '"' || ch === "'" || ch === "`";
}

/**
 * Advance past the string literal whose opening quote sits at `start` and
 * return the index just past the closing quote. `"` / `'` literals stop at
 * an unescaped end-of-line (leaving the newline for the caller's line
 * counter); backtick templates span lines.
 */
function skipStringLiteral(content: string, start: number): number {
	const quote = content.charAt(start);
	for (let i = start + 1; i < content.length; i++) {
		const ch = content.charAt(i);
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === quote) return i + 1;
		if (ch === "\n" && quote !== "`") return i;
	}
	return content.length;
}

/**
 * Collect block-form eslint disable/enable directives in source order.
 * A tiny comment/string state machine over the RAW content — the directives
 * ARE comments, so stripping comments would delete the signal, while a bare
 * string-strip corrupts on apostrophes inside comments. Directives inside
 * string/template literals or line comments are correctly ignored.
 */
function collectEslintDirectives(content: string): EslintDirective[] {
	const directives: EslintDirective[] = [];
	let line = 1;
	let i = 0;
	while (i < content.length) {
		const ch = content.charAt(i);
		const next = content.charAt(i + 1);
		if (ch === "\n") {
			line++;
			i++;
		} else if (ch === "/" && next === "/") {
			i = skipLineComment(content, i);
		} else if (ch === "/" && next === "*") {
			const after = consumeBlockComment(content, i, line, directives);
			line += countNewlines(content, i, after);
			i = after;
		} else if (isQuoteChar(ch)) {
			const after = skipStringLiteral(content, i);
			line += countNewlines(content, i, after);
			i = after;
		} else {
			i++;
		}
	}
	return directives;
}

/** Line of the first enable after index `fromIdx` that re-enables `rule`, or
 * null. ESLint semantics: a bare enable re-enables everything; a scoped
 * enable re-enables only its listed rules — so it never closes a bare
 * disable (`rule === null`). */
function findEnableLineFor(
	directives: EslintDirective[],
	fromIdx: number,
	rule: string | null,
): number | null {
	for (let i = fromIdx + 1; i < directives.length; i++) {
		const d = directives[i];
		if (d === undefined || d.kind !== "enable") continue;
		if (d.rules.length === 0 || (rule !== null && d.rules.includes(rule))) return d.line;
	}
	return null;
}

/**
 * Widest bounded region opened by the disable at `idx`: each listed rule's
 * region ends at the first enable COVERING it (an enable for other rules
 * does not close it); a rule with no covering enable is file-level
 * suppression (another check's job) and contributes nothing.
 */
function widestBoundedSpan(directives: EslintDirective[], idx: number): number | null {
	const disable = directives[idx];
	if (disable === undefined) return null;
	const targets: (string | null)[] = disable.rules.length === 0 ? [null] : disable.rules;
	let widest: number | null = null;
	for (const rule of targets) {
		const enableLine = findEnableLineFor(directives, idx, rule);
		if (enableLine === null) continue;
		const span = enableLine - disable.line + 1;
		if (widest === null || span > widest) widest = span;
	}
	return widest;
}

/**
 * Detect a block-form eslint-disable comment whose matching eslint-enable
 * sits more than MAX_SUPPRESSION_SPAN_LINES lines away (span counted
 * inclusively over the disable..enable region, rule-aware; a multi-rule
 * disable reports its widest covered region). A disable none of whose rules
 * is ever re-enabled never fires here — that is file-level suppression,
 * owned by the file-level suppression check.
 *
 * Check id: `suppression_block_span`
 *
 * Only fires on JS/TS source files; test files are exempt. Returns up to 10
 * `InlineMatch` findings, each anchored at the disable directive's line.
 */
export function checkSuppressionSpan(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_ALL_EXTS.includes(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	const directives = collectEslintDirectives(content);
	const rawLines = content.split("\n");
	const matches: InlineMatch[] = [];

	for (let d = 0; d < directives.length; d++) {
		if (matches.length >= MAX_MATCHES_PER_FILE) break;
		const disable = directives[d];
		if (disable === undefined || disable.kind !== "disable") continue;
		const span = widestBoundedSpan(directives, d);
		if (span === null || span <= MAX_SUPPRESSION_SPAN_LINES) continue;
		matches.push({
			line: disable.line,
			text: `suppression_block_span: eslint-disable block spans ${span} lines before its eslint-enable — narrow the region or use eslint-disable-next-line — ${rawLineExcerpt(rawLines, disable.line)}`,
		});
	}
	return matches;
}
