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
	let prevChar = ""; // last significant (non-whitespace) code char

	let i = 0;
	while (i < n) {
		const top = stack[stack.length - 1] as ScanFrame;
		const c = content[i] ?? "";
		const c2 = i + 1 < n ? (content[i + 1] ?? "") : "";

		switch (top.k) {
			case "str": {
				if (c === "\\") {
					blank(i);
					if (i + 1 < n) blank(i + 1);
					i += 2;
					break;
				}
				if (c === "\n") {
					stack.pop(); // unterminated string — bail rather than swallow the file
					i += 1;
					break;
				}
				blank(i);
				if (c === top.quote) {
					stack.pop();
					prevChar = "v"; // a value just ended → a following `/` is division
				}
				i += 1;
				break;
			}
			case "block": {
				if (c === "*" && c2 === "/") {
					blank(i);
					blank(i + 1);
					i += 2;
					stack.pop();
					break;
				}
				blank(i);
				i += 1;
				break;
			}
			case "regex": {
				if (c === "\\") {
					blank(i);
					if (i + 1 < n) blank(i + 1);
					i += 2;
					break;
				}
				if (c === "\n") {
					stack.pop(); // unterminated regex — bail
					i += 1;
					break;
				}
				if (c === "[") top.cls = true;
				else if (c === "]") top.cls = false;
				const closing = c === "/" && !top.cls;
				blank(i);
				i += 1;
				if (closing) {
					stack.pop();
					prevChar = "v";
				}
				break;
			}
			case "tmpl": {
				if (c === "\\") {
					blank(i);
					if (i + 1 < n) blank(i + 1);
					i += 2;
					break;
				}
				if (c === "`") {
					blank(i);
					i += 1;
					stack.pop();
					prevChar = "v";
					break;
				}
				if (c === "$" && c2 === "{") {
					// Drop `${` and (later) the matching `}` so the interpolation's
					// net brace contribution is zero; keep the expression between.
					blank(i);
					blank(i + 1);
					i += 2;
					stack.push({ k: "code", brace: 0, expr: true });
					break;
				}
				blank(i);
				i += 1;
				break;
			}
			default: {
				// code (top-level or inside a `${…}` expression)
				if (c === "/" && c2 === "/") {
					while (i < n && content[i] !== "\n") {
						blank(i);
						i += 1;
					}
					break;
				}
				if (c === "/" && c2 === "*") {
					blank(i);
					blank(i + 1);
					i += 2;
					stack.push({ k: "block" });
					break;
				}
				if (c === '"' || c === "'") {
					blank(i);
					i += 1;
					stack.push({ k: "str", quote: c });
					break;
				}
				if (c === "`") {
					blank(i);
					i += 1;
					stack.push({ k: "tmpl" });
					break;
				}
				if (c === "/" && isRegexStart(prevChar, content, i)) {
					blank(i);
					i += 1;
					stack.push({ k: "regex", cls: false });
					break;
				}
				if (c === "{") {
					top.brace += 1;
					prevChar = "{";
					i += 1;
					break;
				}
				if (c === "}") {
					if (top.expr && top.brace === 0) {
						blank(i); // closes the `${…}` interpolation
						i += 1;
						stack.pop();
						prevChar = "v";
						break;
					}
					top.brace -= 1;
					prevChar = "}";
					i += 1;
					break;
				}
				if (!/\s/.test(c)) prevChar = c;
				i += 1;
				break;
			}
		}
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
