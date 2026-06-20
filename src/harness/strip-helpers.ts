// ===========================================
// Shared Strip Helpers for inline checks
// ===========================================
// Canonical implementations used by taste-checks.ts, generic-checks.ts, and
// anywhere else we need to scan source code with certain lexical
// constructs blanked.
//
// Two invariants hold across ALL strippers here:
//
//   1. Offset preservation. Every stripper replaces blanked content with
//      exactly the same number of characters (spaces for non-newline chars,
//      newlines preserved). This means `match.index` on the stripped output
//      points at the same character in the original content — downstream
//      line-number reports do not drift.
//
//   2. Comment awareness. Backticks and quote characters inside line
//      comments and block comments do not toggle template or string state.
//      This avoids the bug where a backtick in a source file comment flips
//      the parser into "inside template" mode and blanks out code after it.

import { nonNull } from "../lib/non-null.js";

// Re-exported from a sibling: the template-interpolation extraction cluster
// was carved out to keep this module under the per-file line cap. External
// importers (write-content-guards.ts, tests) keep importing it from here.
export { extractTemplateInterpolationExpressions } from "./strip-helpers-interpolation.js";

/**
 * Strip the interior of template literals across multi-line spans.
 * Preserves backticks and newlines so line numbers stay stable. Both the
 * template body AND `${...}` interpolations are blanked to spaces — so
 * downstream brace-counting (findBlockEnd) doesn't treat interpolation
 * braces as block delimiters. Backticks inside line/block comments are
 * ignored.
 *
 * Interpolation content is blanked because no current check needs to read
 * it as code; checks that operate on block shape (findBlockEnd,
 * checkAssertionFreeTest, checkConditionalInTest) need the template to
 * behave like opaque string content.
 */
export function stripTemplateLiterals(content: string): string {
	const s: TplStripState = {
		out: [],
		inTpl: false,
		interpDepth: 0,
		inLineComment: false,
		inBlockComment: false,
		inString: null,
	};
	let i = 0;

	while (i < content.length) {
		const ch = nonNull(content[i]);
		const next = content[i + 1] ?? "";

		if (s.inLineComment) {
			i = handleTplLineComment(ch, i, s);
		} else if (s.inBlockComment) {
			i = handleTplBlockComment(ch, next, i, s);
		} else if (s.inString) {
			// Pass string content through untouched so comment/template
			// markers inside strings (e.g. "@types/*", "foo`bar") don't
			// corrupt state tracking for later lines.
			i = handleTplString(content, ch, next, i, s);
		} else if (!s.inTpl) {
			i = handleTplOutsideTemplate(ch, next, i, s);
		} else if (s.interpDepth === 0) {
			i = handleTplBody(content, ch, next, i, s);
		} else {
			// Inside `${...}` — track brace depth to know when the
			// interpolation ends; the content and braces are blanked so
			// downstream brace-counting sees the interpolation as opaque.
			i = handleTplInterpolation(ch, i, s);
		}
	}

	return s.out.join("");
}

/**
 * Loop-carried state for {@link stripTemplateLiterals}. All keys are always
 * present; `inString` is a union including `null` so it is never absent.
 * Each per-state handler below mutates this in place and returns the index to
 * resume scanning from — mirroring the original single-loop `continue`s exactly.
 */
interface TplStripState {
	out: string[];
	inTpl: boolean;
	interpDepth: number;
	inLineComment: boolean;
	inBlockComment: boolean;
	inString: '"' | "'" | null;
}

/** Inside a `//` line comment: copy verbatim, exit on newline. */
function handleTplLineComment(ch: string, i: number, s: TplStripState): number {
	s.out.push(ch);
	if (ch === "\n") s.inLineComment = false;
	return i + 1;
}

/** Inside a `/*` block comment: copy verbatim, exit on the closing delimiter. */
function handleTplBlockComment(ch: string, next: string, i: number, s: TplStripState): number {
	s.out.push(ch);
	if (ch === "*" && next === "/") {
		s.out.push(next);
		s.inBlockComment = false;
		return i + 2;
	}
	return i + 1;
}

/**
 * Inside a string literal: pass content through untouched so comment/template
 * markers inside strings don't corrupt state tracking for later lines.
 */
function handleTplString(
	content: string,
	ch: string,
	next: string,
	i: number,
	s: TplStripState,
): number {
	if (ch === "\\" && i + 1 < content.length) {
		s.out.push(ch, next);
		return i + 2;
	}
	s.out.push(ch);
	if (ch === s.inString) s.inString = null;
	return i + 1;
}

/**
 * Outside any template: detect comment openers / string openers / a backtick
 * that begins a template. Everything else is copied verbatim.
 */
function handleTplOutsideTemplate(
	ch: string,
	next: string,
	i: number,
	s: TplStripState,
): number {
	if (ch === "/" && next === "/") {
		s.inLineComment = true;
		s.out.push(ch, next);
		return i + 2;
	}
	if (ch === "/" && next === "*") {
		s.inBlockComment = true;
		s.out.push(ch, next);
		return i + 2;
	}
	if (ch === '"' || ch === "'") {
		s.inString = ch;
		s.out.push(ch);
		return i + 1;
	}
	s.out.push(ch);
	if (ch === "`") s.inTpl = true;
	return i + 1;
}

/**
 * Inside a template body (`interpDepth === 0`): blank the body to spaces while
 * preserving backticks and newlines. A leading escape blanks both chars; a
 * `${` opens an interpolation (the `${` itself is blanked).
 */
function handleTplBody(
	content: string,
	ch: string,
	next: string,
	i: number,
	s: TplStripState,
): number {
	if (ch === "\\" && i + 1 < content.length) {
		// Escape inside template body — blank both chars.
		s.out.push(" ", " ");
		return i + 2;
	}
	if (ch === "`") {
		s.out.push("`");
		s.inTpl = false;
	} else if (ch === "$" && next === "{") {
		// Enter interpolation — blank the `${` itself.
		s.out.push(" ", " ");
		s.interpDepth = 1;
		return i + 2;
	} else {
		s.out.push(ch === "\n" ? "\n" : " ");
	}
	return i + 1;
}

/**
 * Inside a `${...}` interpolation: track brace depth to find the end, but blank
 * the content (and the braces) so downstream brace-counting sees it as opaque.
 */
function handleTplInterpolation(ch: string, i: number, s: TplStripState): number {
	if (ch === "{") s.interpDepth++;
	else if (ch === "}") {
		s.interpDepth--;
		if (s.interpDepth === 0) {
			s.out.push(" ");
			return i + 1;
		}
	}
	s.out.push(ch === "\n" ? "\n" : " ");
	return i + 1;
}

/**
 * Strip line and block comments. Replaces comment characters with spaces of
 * the same length; preserves newlines.
 */
export function stripComments(content: string): string {
	const out: string[] = [];
	let i = 0;
	let inLineComment = false;
	let inBlockComment = false;
	let inString: '"' | "'" | null = null;
	let inTpl = false;

	while (i < content.length) {
		const ch = nonNull(content[i]);
		const next = content[i + 1] ?? "";

		if ((inString || inTpl) && ch === "\\" && i + 1 < content.length) {
			out.push(ch, next);
			i += 2;
			continue;
		}

		if (inLineComment) {
			if (ch === "\n") {
				inLineComment = false;
				out.push(ch);
			} else {
				out.push(" ");
			}
			i++;
			continue;
		}
		if (inBlockComment) {
			if (ch === "*" && next === "/") {
				out.push(" ", " ");
				inBlockComment = false;
				i += 2;
				continue;
			}
			out.push(ch === "\n" ? "\n" : " ");
			i++;
			continue;
		}
		if (inString) {
			out.push(ch);
			if (ch === inString) inString = null;
			i++;
			continue;
		}
		if (inTpl) {
			out.push(ch);
			if (ch === "`") inTpl = false;
			i++;
			continue;
		}
		if (ch === "/" && next === "/") {
			inLineComment = true;
			out.push(" ", " ");
			i += 2;
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlockComment = true;
			out.push(" ", " ");
			i += 2;
			continue;
		}
		if (ch === '"' || ch === "'") {
			inString = ch;
			out.push(ch);
			i++;
			continue;
		}
		if (ch === "`") {
			inTpl = true;
			out.push(ch);
			i++;
			continue;
		}
		out.push(ch);
		i++;
	}

	return out.join("");
}

/** Strip single-line string literal interiors, preserving delimiters and length. */
export function stripStringLiterals(line: string): string {
	return line
		.replace(/"((?:[^"\\]|\\.)*)"/g, (_m, inner: string) => `"${" ".repeat(inner.length)}"`)
		.replace(/'((?:[^'\\]|\\.)*)'/g, (_m, inner: string) => `'${" ".repeat(inner.length)}'`);
}

/**
 * Offset-preserving strip of regex literals. A regex literal is `/…/flags`
 * preceded by a token that cannot end an expression. The body supports
 * escapes (`\.`) AND character classes (`[...]`) which may themselves
 * contain `/` — the previous implementation failed on regexes like
 * `/[\w./-]+/` because the `/` inside `[...]` closed the regex
 * prematurely. The first body character may not be `*` or `/`: JS always
 * lexes `/*` and `//` as comments, never as a regex (a literal `*` must be
 * escaped, `/\*…/`), and without that restriction a `/* block comment *​/` at
 * an expression position was blanked as if it were a regex. Matches are
 * replaced with equal-length spaces so subsequent offsets stay valid.
 */
export function stripRegexLiterals(content: string): string {
	const pattern =
		/((?:^|[=(,![:?;{}&|+\-*^~]|\b(?:return|typeof|in|of|instanceof|new|throw|delete|void)\b)\s*)(\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuyd]*)/g;
	return content.replace(
		pattern,
		(_m, pre: string, regex: string) => pre + " ".repeat(regex.length),
	);
}

/**
 * Convenience: strip templates, regex, comments, and string literals in
 * the order that yields the cleanest code skeleton. All strippers are
 * offset-preserving, so match offsets can be mapped back to the original
 * content.
 */
export function stripAllLiterals(content: string): string {
	const afterTemplates = stripTemplateLiterals(content);
	const afterRegex = stripRegexLiterals(afterTemplates);
	const afterComments = stripComments(afterRegex);
	return afterComments.split("\n").map(stripStringLiterals).join("\n");
}

/**
 * Strip templates, regex, and string-literal interiors while KEEPING comments.
 *
 * For detectors that read COMMENT text (narration-style checks) but must not
 * mistake string / template fixture content for comments: after this strip, a
 * line that still starts with a comment marker is a real comment, while a
 * comment-shaped line inside a template literal or quoted fixture has been
 * blanked to spaces. Offset-preserving like every stripper here. The
 * complement of {@link stripAllLiterals}: use that one to scan CODE with
 * comments removed, this one to scan COMMENTS with code literals removed.
 */
export function stripLiteralsKeepComments(content: string): string {
	const afterTemplates = stripTemplateLiterals(content);
	const afterRegex = stripRegexLiterals(afterTemplates);
	return afterRegex.split("\n").map(stripStringLiterals).join("\n");
}
