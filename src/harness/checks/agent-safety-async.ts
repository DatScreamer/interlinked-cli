// Agent Safety Checks — Async / Promise safety.
// Deterministic regex/heuristic checks targeting common AI agent mistakes.
// Extracted from agent-safety.ts to stay under the per-file line ceiling.

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_EXTS,
	scanLinesStripped,
	stripCommentsAndStrings,
} from "./shared.js";

// --- 1. Async/Promise Safety ---

/**
 * Detect no-misused-promises: passing an async function where a synchronous
 * callback is expected (e.g., Array.forEach, Array.map with async but no await on result).
 */
export function checkMisusedPromises(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = strippedLines[i].trim();
		// .forEach(async, .map(async without assignment, .filter(async, .some(async, .every(async
		if (/\.(forEach|reduce)\s*\(\s*async\b/.test(trimmed)) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}
	}
	return matches;
}

/**
 * Detect floating promises: calls to async-declared functions (or known promise-
 * returning globals like fetch) at statement position without await, return,
 * void, yield, throw, assignment, or a trailing .catch()/.finally() handler.
 *
 * Unhandled rejections from floating promises produce silent failures and
 * `unhandledRejection` warnings in Node. For cold agents reading the code, a
 * bare `foo()` statement gives no signal that `foo` is async — missing the
 * await is an extremely common mistake.
 *
 * Strategy (regex, no type info):
 *   1. Collect identifiers declared `async` in this file — functions, arrow
 *      assignments, class methods, object shorthand.
 *   2. Scan statement-position lines for bare calls to those identifiers (or
 *      to the built-in `fetch`) that lack a handling prefix and don't end with
 *      `.catch(…)`/`.finally(…)` on the same line.
 *   3. Skip lines that are inside an argument list / array literal (previous
 *      non-blank line ends with `(`, `[`, `{`, or `,`) and lines that belong to
 *      a multi-line chain (next non-blank line starts with `.`). Under-detect
 *      rather than FP.
 *
 * Only flags calls we KNOW return a promise (async-declared in-file + small
 * built-in allowlist). Unknown third-party calls are skipped — that's a
 * type-info problem, not a regex problem.
 */
export function checkFloatingPromises(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");

	// Pass 1: collect async identifiers declared in this file.
	const asyncIds = new Set<string>();
	for (const line of strippedLines) {
		// `async function foo(` / `async function *foo(`
		let m = line.match(/\basync\s+function\s*\*?\s+([A-Za-z_$][\w$]*)\s*\(/);
		if (m) asyncIds.add(m[1]);
		// `const foo = async (`, `let foo: Type = async <T>(`, etc.
		m = line.match(
			/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?\s*=\s*async\s*[(<]/,
		);
		if (m) asyncIds.add(m[1]);
		// Class method: `  async foo(` with optional access modifiers / static.
		m = line.match(
			/^\s+(?:(?:public|private|protected|static|readonly|override|abstract)\s+)*async\s+([A-Za-z_$][\w$]*)\s*[(<]/,
		);
		if (m && m[1] !== "function") asyncIds.add(m[1]);
		// Object shorthand property: `foo: async (`.
		m = line.match(/\b([A-Za-z_$][\w$]*)\s*:\s*async\s*[(<]/);
		if (m) asyncIds.add(m[1]);
	}

	// Always-async built-ins commonly forgotten at statement position.
	const BUILTIN_ASYNC_IDS = new Set(["fetch"]);

	// Keywords that, when they lead a statement, consume or redirect the value
	// so the promise cannot be floating.
	const STATEMENT_PREFIX_KEYWORDS =
		/^(?:await|return|yield|void|throw|if|else|for|while|switch|case|default|try|catch|finally|do|break|continue|class|function|const|let|var|export|import|type|interface|enum|new|typeof|delete|async)\b/;

	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];
		const trimmed = line.trim();
		if (!trimmed) continue;

		// Must start with an identifier; rules out `})`, `.then(...)` chain
		// continuation, `}` block closes, etc.
		if (!/^[A-Za-z_$]/.test(trimmed)) continue;
		if (STATEMENT_PREFIX_KEYWORDS.test(trimmed)) continue;

		// Skip if previous non-blank line indicates we're inside an argument
		// list or array literal — then our "statement-position" assumption is
		// wrong. We deliberately DO NOT include `{` here: a trailing `{` is
		// much more often a block opener (function/class/if/etc.) than a
		// multi-line object literal, and treating blocks as arg lists would
		// swallow every statement that follows a brace.
		let prev = i - 1;
		while (prev >= 0 && strippedLines[prev].trim() === "") prev--;
		if (prev >= 0 && /[([,]\s*$/.test(strippedLines[prev])) continue;

		// Skip arrow-function concise-body return values. When the previous
		// non-blank line ends with `=>`, this line is the single-expression
		// body of an arrow function — its value is *returned*, not dropped.
		// Example false-positive: `discovered.map((d) =>\n    probeHealth(d))`
		if (prev >= 0 && /=>\s*$/.test(strippedLines[prev])) continue;

		// Skip TypeScript interface / type method signatures. A line like
		// `drain(timeoutMs?: number): Promise<void>;` inside an `interface`
		// body syntactically looks like a call but is a DECLARATION — it
		// doesn't execute at runtime. Giveaway: trailing `: Promise<…>;` or
		// `: AsyncIterable<…>;`, AND either a `?:` parameter marker or a
		// trailing semicolon after the type annotation.
		if (
			/\)\s*:\s*(?:Promise|AsyncIterable|AsyncGenerator|AsyncIterator)\s*<[^>]*>\s*;\s*$/.test(
				trimmed,
			)
		)
			continue;

		// Skip multi-line chain bodies: if next non-blank line starts with `.`,
		// the chain's handler (if any) lives on a later line and we can't tell
		// with regex. Under-detect by skipping.
		let next = i + 1;
		while (next < strippedLines.length && strippedLines[next].trim() === "") next++;
		if (next < strippedLines.length && strippedLines[next].trim().startsWith(".")) continue;

		// Capture the leading call path: identifier, dotted, optional-chain,
		// or bracketed, up to the opening paren.
		const callMatch = trimmed.match(/^([\w$?.[\]]+)\s*\(/);
		if (!callMatch) continue;
		const callPath = callMatch[1];

		// Leaf identifier for async-id lookup.
		const leafId = callPath
			.replace(/\?\./g, ".")
			.split(".")
			.pop()
			?.replace(/\[.*\]/g, "");
		if (!leafId) continue;

		const isKnownAsync = asyncIds.has(leafId) || BUILTIN_ASYNC_IDS.has(leafId);
		if (!isKnownAsync) continue;

		// Already-handled chain: `.catch(` or `.finally(` anywhere on this line.
		if (/\.catch\s*\(/.test(trimmed)) continue;
		if (/\.finally\s*\(/.test(trimmed)) continue;

		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}

	return matches;
}

/**
 * Detect no-async-promise-executor: new Promise(async (resolve, reject) => { ... })
 * This is always a bug — the executor should not be async.
 */
export function checkAsyncPromiseExecutor(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /new\s+Promise\s*\(\s*async\b/, 10);
}

/**
 * Detect `.catch(...)` handlers whose body is empty or returns a literal nothing
 * — the async cousin of `checkSilentCatch`. Swallowed rejections silently
 * mask bugs and break optimistic-grant rollback patterns (see the recent
 * ServerBridge.reserveFile fix).
 *
 * Patterns flagged (single-line):
 *   .catch arrow or .catch(function) with an EMPTY body. A handler that
 *   returns an explicit value (`() => null` / `() => undefined` / a fallback)
 *   is deliberate graceful degradation — the rejection becomes a sentinel the
 *   caller handles — not a silent swallow, so it is exempt. Inline body
 *   comments mark intent and exempt the line too, matching checkSilentCatch.
 */
export function checkSilentPromiseSwallow(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");

	// Empty-body only. A handler returning an explicit value (null / undefined /
	// void 0 / any fallback) is deliberate graceful degradation, not a silent
	// swallow — see the docstring. Empty `{}` discards everything (the
	// optimistic-grant-rollback bug class this check guards).
	const arrowPattern =
		/\.catch\s*\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{\s*\}\s*\)/;
	const functionPattern =
		/\.catch\s*\(\s*function\s*[A-Za-z_$\w]*\s*\([^)]*\)\s*\{\s*\}\s*\)/;
	const intentCommentRe = /\.catch\s*\(.*(?:\/\/|\/\*)/;

	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];
		if (!arrowPattern.test(line) && !functionPattern.test(line)) continue;
		if (intentCommentRe.test(originalLines[i] ?? "")) continue;
		matches.push({ line: i + 1, text: (originalLines[i] ?? "").trim().slice(0, 150) });
	}
	return matches;
}
