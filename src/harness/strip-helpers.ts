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
	const out: string[] = [];
	let i = 0;
	let inTpl = false;
	let interpDepth = 0;
	let inLineComment = false;
	let inBlockComment = false;
	let inString: '"' | "'" | null = null;

	while (i < content.length) {
		const ch = content[i];
		const next = content[i + 1];

		if (inLineComment) {
			out.push(ch);
			if (ch === "\n") inLineComment = false;
			i++;
			continue;
		}
		if (inBlockComment) {
			out.push(ch);
			if (ch === "*" && next === "/") {
				out.push(next);
				inBlockComment = false;
				i += 2;
				continue;
			}
			i++;
			continue;
		}
		if (inString) {
			// Pass string content through untouched so comment/template
			// markers inside strings (e.g. "@types/*", "foo`bar") don't
			// corrupt state tracking for later lines.
			if (ch === "\\" && i + 1 < content.length) {
				out.push(ch, next);
				i += 2;
				continue;
			}
			out.push(ch);
			if (ch === inString) inString = null;
			i++;
			continue;
		}

		if (inTpl && interpDepth === 0 && ch === "\\" && i + 1 < content.length) {
			// Escape inside template body — blank both chars.
			out.push(" ", " ");
			i += 2;
			continue;
		}

		if (!inTpl) {
			if (ch === "/" && next === "/") {
				inLineComment = true;
				out.push(ch, next);
				i += 2;
				continue;
			}
			if (ch === "/" && next === "*") {
				inBlockComment = true;
				out.push(ch, next);
				i += 2;
				continue;
			}
			if (ch === '"' || ch === "'") {
				inString = ch;
				out.push(ch);
				i++;
				continue;
			}
			out.push(ch);
			if (ch === "`") inTpl = true;
			i++;
			continue;
		}

		if (interpDepth === 0) {
			if (ch === "`") {
				out.push("`");
				inTpl = false;
			} else if (ch === "$" && next === "{") {
				// Enter interpolation — blank the `${` itself
				out.push(" ", " ");
				interpDepth = 1;
				i++;
			} else {
				out.push(ch === "\n" ? "\n" : " ");
			}
			i++;
			continue;
		}

		// Inside `${...}` — track brace depth to know when interpolation
		// ends, but blank the content (and the braces themselves) so
		// downstream brace-counting sees the interpolation as opaque.
		if (ch === "{") interpDepth++;
		else if (ch === "}") {
			interpDepth--;
			if (interpDepth === 0) {
				out.push(" ");
				i++;
				continue;
			}
		}
		out.push(ch === "\n" ? "\n" : " ");
		i++;
	}

	return out.join("");
}

/**
 * Extract executable `${...}` bodies from JS/TS template literals while
 * ignoring backticks inside comments and quoted strings. Plain template text
 * is intentionally not returned; it is string data, not code.
 */
export function extractTemplateInterpolationExpressions(content: string): string[] {
	const expressions: string[] = [];
	scanTemplateLiterals(content, expressions, 0);
	return expressions;
}

function scanTemplateLiterals(
	content: string,
	expressions: string[],
	recursionDepth: number,
): void {
	let i = 0;
	let inLineComment = false;
	let inBlockComment = false;
	let inString: '"' | "'" | null = null;

	while (i < content.length) {
		const ch = content[i];
		const next = content[i + 1];

		if (inLineComment) {
			if (ch === "\n") inLineComment = false;
			i++;
			continue;
		}
		if (inBlockComment) {
			if (ch === "*" && next === "/") {
				inBlockComment = false;
				i += 2;
				continue;
			}
			i++;
			continue;
		}
		if (inString) {
			if (ch === "\\" && i + 1 < content.length) {
				i += 2;
				continue;
			}
			if (ch === inString) inString = null;
			i++;
			continue;
		}

		if (ch === "/" && next === "/") {
			inLineComment = true;
			i += 2;
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlockComment = true;
			i += 2;
			continue;
		}
		if (ch === '"' || ch === "'") {
			inString = ch;
			i++;
			continue;
		}
		if (ch === "`") {
			const end = collectTemplateExpressions(content, i + 1, expressions, recursionDepth);
			i = end === null ? content.length : end + 1;
			continue;
		}
		i++;
	}
}

function collectTemplateExpressions(
	content: string,
	start: number,
	expressions: string[],
	recursionDepth: number,
): number | null {
	let i = start;
	while (i < content.length) {
		const ch = content[i];
		const next = content[i + 1];

		if (ch === "\\" && i + 1 < content.length) {
			i += 2;
			continue;
		}
		if (ch === "`") return i;
		if (ch === "$" && next === "{") {
			const expr = readBalancedTemplateExpression(content, i + 2);
			if (expr === null) return null;
			expressions.push(expr.body);
			if (recursionDepth < 3) {
				scanTemplateLiterals(expr.body, expressions, recursionDepth + 1);
			}
			i = expr.end + 1;
			continue;
		}
		i++;
	}
	return null;
}

function readBalancedTemplateExpression(
	content: string,
	start: number,
): { body: string; end: number } | null {
	let depth = 1;
	let i = start;
	let inLineComment = false;
	let inBlockComment = false;
	let inString: '"' | "'" | null = null;

	while (i < content.length) {
		const ch = content[i];
		const next = content[i + 1];

		if (inLineComment) {
			if (ch === "\n") inLineComment = false;
			i++;
			continue;
		}
		if (inBlockComment) {
			if (ch === "*" && next === "/") {
				inBlockComment = false;
				i += 2;
				continue;
			}
			i++;
			continue;
		}
		if (inString) {
			if (ch === "\\" && i + 1 < content.length) {
				i += 2;
				continue;
			}
			if (ch === inString) inString = null;
			i++;
			continue;
		}

		if (ch === "/" && next === "/") {
			inLineComment = true;
			i += 2;
			continue;
		}
		if (ch === "/" && next === "*") {
			inBlockComment = true;
			i += 2;
			continue;
		}
		if (ch === '"' || ch === "'") {
			inString = ch;
			i++;
			continue;
		}
		if (ch === "`") {
			const end = findTemplateLiteralEnd(content, i + 1);
			if (end === null) return null;
			i = end + 1;
			continue;
		}
		if (ch === "{") {
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0) {
				return { body: content.slice(start, i), end: i };
			}
		}
		i++;
	}

	return null;
}

function findTemplateLiteralEnd(content: string, start: number): number | null {
	let i = start;
	while (i < content.length) {
		const ch = content[i];
		const next = content[i + 1];
		if (ch === "\\" && i + 1 < content.length) {
			i += 2;
			continue;
		}
		if (ch === "`") return i;
		if (ch === "$" && next === "{") {
			const expr = readBalancedTemplateExpression(content, i + 2);
			if (expr === null) return null;
			i = expr.end + 1;
			continue;
		}
		i++;
	}
	return null;
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
		const ch = content[i];
		const next = content[i + 1];

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
 * prematurely. Matches are replaced with equal-length spaces so
 * subsequent offsets stay valid.
 */
export function stripRegexLiterals(content: string): string {
	const pattern =
		/((?:^|[=(,![:?;{}&|+\-*^~]|\b(?:return|typeof|in|of|instanceof|new|throw|delete|void)\b)\s*)(\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[gimsuyd]*)/g;
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
