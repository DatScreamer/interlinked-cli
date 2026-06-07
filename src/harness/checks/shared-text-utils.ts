// Text utility helpers extracted from shared.ts — comment & string stripping.
// Imported by shared.ts and re-exported; do not import this directly from
// outside the checks/ package — consume via shared.ts instead.

import type { InlineMatch } from "./shared.js";

// ===========================================
// Comment & String Stripping Helpers
// ===========================================

/**
 * Strip comments from content, preserving line count and positions.
 * Replaces comment content with spaces so that line numbers remain stable.
 *
 * Handles:
 * - Single-line comments: `// ...` (JS/TS/Rust/Go/C/Java) and `# ...` (Python)
 * - Multi-line comments: `/* ... *​/` (JS/TS/Rust/Go/C/Java)
 * - Python docstrings on a single line: `""" ... """` and `''' ... '''`
 */

/**
 * Index of the first `//` or `#` line-comment marker on `line` that is NOT
 * inside a string literal, or -1 if there is none. `stripComments` runs
 * before strings are stripped, so it must track string state itself —
 * otherwise the `//` in a `"https://..."` URL literal reads as a comment and
 * everything after it (including the string's own closing quote) is blanked,
 * which then prevents `stripStrings` from recognising the literal at all.
 * Regex literals are not tracked — a pre-existing limitation of this stripper.
 */
function firstUnquotedCommentIndex(line: string): number {
	let quote: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quote !== null) {
			if (ch === "\\" && i + 1 < line.length) {
				i++; // skip the escaped character
			} else if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "/" && line[i + 1] === "/") {
			return i;
		}
		if (ch === "#") {
			return i;
		}
	}
	return -1;
}

export function stripComments(content: string): string {
	const lines = content.split("\n");
	let inBlockComment = false;

	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];
		if (line === undefined) continue;

		if (inBlockComment) {
			const endIdx = line.indexOf("*/");
			if (endIdx === -1) {
				// Entire line is inside a block comment — blank it
				lines[i] = " ".repeat(line.length);
				continue;
			}
			// Blank up to and including the closing */
			const blanked = " ".repeat(endIdx + 2) + line.slice(endIdx + 2);
			lines[i] = blanked;
			line = blanked;
			inBlockComment = false;
		}

		// Python single-line docstrings: """ ... """ or ''' ... '''
		line = line.replace(/"""[^"]*"""/g, (m) => " ".repeat(m.length));
		line = line.replace(/'''[^']*'''/g, (m) => " ".repeat(m.length));

		// Handle /* ... */ that open and close on the same line (possibly multiple)
		let searchFrom = 0;
		while (searchFrom < line.length) {
			const openIdx = line.indexOf("/*", searchFrom);
			if (openIdx === -1) break;
			const closeIdx = line.indexOf("*/", openIdx + 2);
			if (closeIdx === -1) {
				// Block comment opens and continues to next line(s)
				line = line.slice(0, openIdx) + " ".repeat(line.length - openIdx);
				inBlockComment = true;
				break;
			}
			// Same-line block comment
			const before = line.slice(0, openIdx);
			const blanked = " ".repeat(closeIdx + 2 - openIdx);
			const after = line.slice(closeIdx + 2);
			line = before + blanked + after;
			searchFrom = openIdx + blanked.length;
		}

		// Single-line comments: // (JS/TS/Rust/Go/C/Java) and # (Python).
		// String-aware so the // inside a "https://..." URL literal — or a #
		// inside any string — is not mistaken for a comment.
		const commentStart = firstUnquotedCommentIndex(line);

		if (commentStart !== -1) {
			line = line.slice(0, commentStart) + " ".repeat(line.length - commentStart);
		}

		lines[i] = line;
	}

	return lines.join("\n");
}

/**
 * Strip string literal content from content, preserving line count.
 * Replaces the interior of string literals with empty content so that
 * patterns inside strings do not trigger false positive matches.
 *
 * Handles: `"..."`, `'...'`, and `` `...` `` (single-line only).
 */
export function stripStrings(content: string): string {
	const lines = content.split("\n");
	let templateDepth = 0; // Track nested template literal depth
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];
		if (line === undefined) continue;

		// Inside a multi-line template literal: blank the line, track backticks
		if (templateDepth > 0) {
			for (let j = 0; j < line.length; j++) {
				if (line[j] === "\\" && j + 1 < line.length) {
					j++; // skip escaped char
				} else if (line[j] === "`") {
					templateDepth--;
					if (templateDepth === 0) break;
				}
			}
			lines[i] = "";
			continue;
		}

		// Replace content inside double-quoted strings
		line = line.replace(/"(?:[^"\\]|\\.)*"/g, '""');
		// Replace content inside single-quoted strings
		line = line.replace(/'(?:[^'\\]|\\.)*'/g, "''");
		// Replace content inside backtick template strings (single-line only)
		line = line.replace(/`(?:[^`\\]|\\.)*`/g, "``");

		// Check for unclosed backticks (multi-line template literal opening).
		// Count unescaped backticks remaining — odd count means one is unclosed.
		const remaining = (line.match(/(?<!\\)`/g) || []).length;
		if (remaining % 2 === 1) {
			templateDepth = 1;
		}

		lines[i] = line;
	}
	return lines.join("\n");
}

// ===========================================
// Brace-balanced scanner for scope/complexity analysis
// ===========================================
// The complexity walkers (`cyclomatic.ts`, `complexity.ts`) find each function
// body by counting `{`/`}` on the stripped source, so they need the strip to
// preserve STRUCTURAL brace balance. The general two-pass
// `stripStrings(stripComments())` does NOT: it blanks multi-line template
// continuation lines wholesale, deleting the braces of `${…}` interpolation
// code and leaving the count unbalanced (clean.ts: 89/89 → 61/59), which makes
// walkBraceBody run off the end of the file and over-count complexity to EOF.
//
// `stripForBraceScan` below is the dedicated fix: a single-pass char scanner
// that blanks comment / string / template-text / regex content (→ spaces,
// newlines preserved) while KEEPING structural braces and `${…}` interpolation
// *expression* code (its braces are balanced real code). It is deliberately NOT
// wired into `stripCommentsAndStrings` — the ~50 general consumers depend on
// that one keeping string delimiters and leaving regex intact, so swapping them
// onto the scanner shifts their match counts (verified: 14 test regressions).

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/** Chars that, immediately before `/`, start a regex literal (not division). */
const REGEX_PRECEDER_CHARS = new Set([
	"", "(", "[", "{", ",", ";", ":", "=", "!", "&", "|", "?", "+", "-", "*", "%", "^", "~", "<", ">",
]);
/** Keywords that can precede a regex literal: `return /x/`, `typeof /x/`, … */
const REGEX_PRECEDER_WORDS = new Set([
	"return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "do", "else", "yield", "await", "case",
]);

type ScanFrame =
	| { k: "code"; brace: number; expr: boolean }
	| { k: "str"; quote: string }
	| { k: "tmpl" }
	| { k: "block" }
	| { k: "regex"; cls: boolean };

/** The identifier run ending just before `slashIdx` (skipping whitespace). */
function precedingWord(content: string, slashIdx: number): string {
	let j = slashIdx - 1;
	while (j >= 0 && /\s/.test(content[j] ?? "")) j--;
	const end = j;
	while (j >= 0 && IDENT_CHAR.test(content[j] ?? "")) j--;
	return content.slice(j + 1, end + 1);
}

function isRegexStart(prevChar: string, content: string, slashIdx: number): boolean {
	if (REGEX_PRECEDER_CHARS.has(prevChar)) return true;
	if (IDENT_CHAR.test(prevChar)) return REGEX_PRECEDER_WORDS.has(precedingWord(content, slashIdx));
	return false;
}

/**
 * One step of {@link stripForBraceScan}. Each handler advances the cursor `i`
 * past the chars it consumes (blanking them) and returns the next cursor plus
 * the next `prevChar`. `stack` is mutated in place (push/pop) and the active
 * frame's mutable fields (`brace`/`cls`/`expr`) are updated on the object, so
 * those propagate without being threaded through the return value.
 */
type ScanStep = { i: number; prevChar: string };

type BlankFn = (idx: number) => void;

/** Consume one char inside a `"`/`'` string literal frame. */
function stepStr(
	content: string,
	n: number,
	i: number,
	top: Extract<ScanFrame, { k: "str" }>,
	stack: ScanFrame[],
	prevChar: string,
	blank: BlankFn,
): ScanStep {
	const c = content[i] ?? "";
	if (c === "\\") {
		blank(i);
		if (i + 1 < n) blank(i + 1);
		return { i: i + 2, prevChar };
	}
	if (c === "\n") {
		stack.pop(); // unterminated string — bail rather than swallow the file
		return { i: i + 1, prevChar };
	}
	blank(i);
	if (c === top.quote) {
		stack.pop();
		return { i: i + 1, prevChar: "v" }; // a value just ended → following `/` is division
	}
	return { i: i + 1, prevChar };
}

/** Consume one char inside a `/* … *​/` block-comment frame. */
function stepBlock(
	content: string,
	i: number,
	stack: ScanFrame[],
	prevChar: string,
	blank: BlankFn,
): ScanStep {
	const c = content[i] ?? "";
	const c2 = content[i + 1] ?? "";
	if (c === "*" && c2 === "/") {
		blank(i);
		blank(i + 1);
		stack.pop();
		return { i: i + 2, prevChar };
	}
	blank(i);
	return { i: i + 1, prevChar };
}

/** Consume one char inside a regex-literal frame. */
function stepRegex(
	content: string,
	i: number,
	top: Extract<ScanFrame, { k: "regex" }>,
	stack: ScanFrame[],
	prevChar: string,
	blank: BlankFn,
): ScanStep {
	const c = content[i] ?? "";
	if (c === "\\") {
		blank(i);
		if (i + 1 < content.length) blank(i + 1);
		return { i: i + 2, prevChar };
	}
	if (c === "\n") {
		stack.pop(); // unterminated regex — bail
		return { i: i + 1, prevChar };
	}
	if (c === "[") top.cls = true;
	else if (c === "]") top.cls = false;
	const closing = c === "/" && !top.cls;
	blank(i);
	if (closing) {
		stack.pop();
		return { i: i + 1, prevChar: "v" };
	}
	return { i: i + 1, prevChar };
}

/** Consume one char inside a template-literal frame (outside `${…}`). */
function stepTmpl(
	content: string,
	n: number,
	i: number,
	stack: ScanFrame[],
	prevChar: string,
	blank: BlankFn,
): ScanStep {
	const c = content[i] ?? "";
	const c2 = i + 1 < n ? (content[i + 1] ?? "") : "";
	if (c === "\\") {
		blank(i);
		if (i + 1 < n) blank(i + 1);
		return { i: i + 2, prevChar };
	}
	if (c === "`") {
		blank(i);
		stack.pop();
		return { i: i + 1, prevChar: "v" };
	}
	if (c === "$" && c2 === "{") {
		// Drop `${` and (later) the matching `}` so the interpolation's net brace
		// contribution is zero; keep the expression between.
		blank(i);
		blank(i + 1);
		stack.push({ k: "code", brace: 0, expr: true });
		return { i: i + 2, prevChar };
	}
	blank(i);
	return { i: i + 1, prevChar };
}

/**
 * In a `code` frame, handle the char if it OPENS a comment / string / template /
 * regex frame (pushing that frame). Returns the step, or `null` when the char is
 * not a frame opener and brace/whitespace handling should run instead.
 */
function stepCodeOpener(
	content: string,
	n: number,
	i: number,
	stack: ScanFrame[],
	prevChar: string,
	blank: BlankFn,
): ScanStep | null {
	const c = content[i] ?? "";
	const c2 = i + 1 < n ? (content[i + 1] ?? "") : "";
	if (c === "/" && c2 === "/") {
		let j = i;
		while (j < n && content[j] !== "\n") {
			blank(j);
			j += 1;
		}
		return { i: j, prevChar };
	}
	if (c === "/" && c2 === "*") {
		blank(i);
		blank(i + 1);
		stack.push({ k: "block" });
		return { i: i + 2, prevChar };
	}
	if (c === '"' || c === "'") {
		blank(i);
		stack.push({ k: "str", quote: c });
		return { i: i + 1, prevChar };
	}
	if (c === "`") {
		blank(i);
		stack.push({ k: "tmpl" });
		return { i: i + 1, prevChar };
	}
	if (c === "/" && isRegexStart(prevChar, content, i)) {
		blank(i);
		stack.push({ k: "regex", cls: false });
		return { i: i + 1, prevChar };
	}
	return null;
}

/** In a `code` frame, handle `{` / `}` brace tracking and the plain-char tail. */
function stepCodeBrace(
	content: string,
	i: number,
	top: Extract<ScanFrame, { k: "code" }>,
	stack: ScanFrame[],
	prevChar: string,
	blank: BlankFn,
): ScanStep {
	const c = content[i] ?? "";
	if (c === "{") {
		top.brace += 1;
		return { i: i + 1, prevChar: "{" };
	}
	if (c === "}") {
		if (top.expr && top.brace === 0) {
			blank(i); // closes the `${…}` interpolation
			stack.pop();
			return { i: i + 1, prevChar: "v" };
		}
		top.brace -= 1;
		return { i: i + 1, prevChar: "}" };
	}
	return { i: i + 1, prevChar: /\s/.test(c) ? prevChar : c };
}

/** Consume one char in a `code` frame (top-level or inside a `${…}` expr). */
function stepCode(
	content: string,
	n: number,
	i: number,
	top: Extract<ScanFrame, { k: "code" }>,
	stack: ScanFrame[],
	prevChar: string,
	blank: BlankFn,
): ScanStep {
	return (
		stepCodeOpener(content, n, i, stack, prevChar, blank) ??
		stepCodeBrace(content, i, top, stack, prevChar, blank)
	);
}

/** Dispatch one scan step to the handler for the active frame kind. */
function stepScan(
	content: string,
	n: number,
	i: number,
	top: ScanFrame,
	stack: ScanFrame[],
	prevChar: string,
	blank: BlankFn,
): ScanStep {
	switch (top.k) {
		case "str":
			return stepStr(content, n, i, top, stack, prevChar, blank);
		case "block":
			return stepBlock(content, i, stack, prevChar, blank);
		case "regex":
			return stepRegex(content, i, top, stack, prevChar, blank);
		case "tmpl":
			return stepTmpl(content, n, i, stack, prevChar, blank);
		default:
			return stepCode(content, n, i, top, stack, prevChar, blank);
	}
}

/**
 * Brace-balanced strip for SCOPE / COMPLEXITY analysis (`cyclomatic.ts`,
 * `complexity.ts`). Replaces comment / string / template-text / regex
 * characters with spaces (newlines kept, so line + column positions stay
 * stable) while preserving structural code — including the expression inside
 * `${…}` interpolations, whose `${` and matching `}` are themselves removed so
 * each interpolation's net brace contribution is zero. `strip-brace-balance`
 * pins the resulting `{`/`}` balance.
 *
 * Distinct from {@link stripCommentsAndStrings} ON PURPOSE: this blanks string
 * delimiters and strips regex bodies (correct for brace/keyword scope
 * counting), whereas the general stripper keeps delimiters and leaves regex
 * intact — a contract its ~50 consumers rely on. Do not merge them.
 */
export function stripForBraceScan(content: string): string {
	const out = content.split("");
	const n = content.length;
	const blank = (idx: number): void => {
		const ch = out[idx];
		if (ch !== "\n" && ch !== "\r") out[idx] = " ";
	};
	const stack: ScanFrame[] = [{ k: "code", brace: 0, expr: false }];

	let i = 0;
	let prevChar = ""; // last significant (non-whitespace) code char
	while (i < n) {
		const top = stack[stack.length - 1] as ScanFrame;
		const step = stepScan(content, n, i, top, stack, prevChar, blank);
		i = step.i;
		prevChar = step.prevChar;
	}
	return out.join("");
}

/**
 * Strip both comments and strings from content. Comments are stripped first (so
 * string-like content in comments is removed), then strings. Preserves line
 * count. General-purpose: consumed by ~50 inline checks via the `shared.ts`
 * barrel, which rely on string delimiters being KEPT and regex left intact.
 * For brace/scope-sensitive analysis use {@link stripForBraceScan} instead.
 */
export function stripCommentsAndStrings(content: string): string {
	return stripStrings(stripComments(content));
}

/**
 * Scan original lines but match against pre-stripped lines.
 * Returns matches from the original content for display, but only
 * where the stripped content matches the pattern.
 */
export function scanLinesStripped(
	originalLines: string[],
	strippedLines: string[],
	pattern: RegExp,
	maxMatches: number,
): InlineMatch[] {
	const matches: InlineMatch[] = [];
	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= maxMatches) break;
		const strippedLine = strippedLines[i];
		const originalLine = originalLines[i];
		if (strippedLine === undefined || originalLine === undefined) continue;
		if (pattern.test(strippedLine)) {
			matches.push({
				line: i + 1,
				text: originalLine.trim().slice(0, 150),
			});
		}
	}
	return matches;
}
