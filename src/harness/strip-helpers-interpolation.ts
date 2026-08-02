// interlinked-tdd: exempt
// ===========================================
// Template-interpolation extraction (sibling of strip-helpers.ts)
// ===========================================
// Extracts executable `${...}` bodies from JS/TS template literals while
// ignoring backticks inside comments and quoted strings. A self-contained
// leaf cluster carved out of strip-helpers.ts to keep that module under the
// per-file line cap. Public entry: extractTemplateInterpolationExpressions.

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
	// Same comment/string skip logic `readBalancedTemplateExpression` uses below —
	// shared via `stepPastCommentOrString` instead of re-inlined, which is also
	// what keeps this loop flat (no nested if-inside-if per lexer state).
	const state: CommentStringLexerState = {
		inLineComment: false,
		inBlockComment: false,
		inString: null,
	};

	while (i < content.length) {
		const stepped = stepPastCommentOrString(content, i, state);
		if (stepped !== null) {
			i = stepped;
			continue;
		}
		const ch = content[i];
		const next = content[i + 1];

		if (ch === "/" && next === "/") {
			state.inLineComment = true;
			i += 2;
			continue;
		}
		if (ch === "/" && next === "*") {
			state.inBlockComment = true;
			i += 2;
			continue;
		}
		if (ch === '"' || ch === "'") {
			state.inString = ch;
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

type CommentStringLexerState = {
	inLineComment: boolean;
	inBlockComment: boolean;
	inString: '"' | "'" | null;
};

/**
 * Advance one step while `i` sits inside a line comment, a block comment, or
 * a quoted string (mutating `state` to match). Returns the next index, or
 * `null` when `i` is not inside any of those states — the caller then falls
 * through to normal-mode dispatch (comment/string start, backtick, brace).
 */
function stepPastCommentOrString(
	content: string,
	i: number,
	state: CommentStringLexerState,
): number | null {
	const ch = content[i];
	const next = content[i + 1];

	if (state.inLineComment) {
		if (ch === "\n") state.inLineComment = false;
		return i + 1;
	}
	if (state.inBlockComment) {
		if (ch === "*" && next === "/") {
			state.inBlockComment = false;
			return i + 2;
		}
		return i + 1;
	}
	if (state.inString) {
		if (ch === "\\" && i + 1 < content.length) return i + 2;
		if (ch === state.inString) state.inString = null;
		return i + 1;
	}
	return null;
}

function readBalancedTemplateExpression(
	content: string,
	start: number,
): { body: string; end: number } | null {
	let depth = 1;
	let i = start;
	const state: CommentStringLexerState = {
		inLineComment: false,
		inBlockComment: false,
		inString: null,
	};

	while (i < content.length) {
		const stepped = stepPastCommentOrString(content, i, state);
		if (stepped !== null) {
			i = stepped;
			continue;
		}
		const ch = content[i];
		const next = content[i + 1];

		if (ch === "/" && next === "/") {
			state.inLineComment = true;
			i += 2;
			continue;
		}
		if (ch === "/" && next === "*") {
			state.inBlockComment = true;
			i += 2;
			continue;
		}
		if (ch === '"' || ch === "'") {
			state.inString = ch;
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
