// fs-write-safety inline check.
//
// Detects: a `writeFileSync` / `appendFileSync` / `writeFile` /
// `createWriteStream` call whose path argument is a *nested* path (built with
// `join(...)` with ≥2 arguments, or a string literal containing a `/`)
// without a prior `mkdirSync(..., { recursive: true })` or
// `mkdir(..., { recursive: true })` or `existsSync(<dir>)` guard in the
// same function-level scope.
//
// Real example: `writeFileSync(join(cwd, ".interlinked", "metric-caps.json"),
// ...)` threw ENOENT when `.interlinked/` didn't exist.
//
// Design decisions:
//   - Line-based approach: we locate write calls by scanning the stripped
//     (no-strings, no-comments) source for their line numbers, then operate
//     on those line numbers in the other source views (raw, comment-stripped).
//     This avoids offset-mismatch bugs between stripped views that replace
//     content at different byte lengths.
//   - Path argument analysis: we scan raw lines (string content visible) to
//     detect `join(…,…)` with ≥2 args or a string literal with a `/`.
//   - Guard detection: we scan comment-stripped (string-preserving) lines from
//     function start to the write line for `mkdirSync`/`mkdir` + `recursive`
//     or `existsSync`. String content survives so `{ recursive: true }` is
//     visible; comments are gone so commented-out guards don't suppress.
//   - Function boundary: we walk backward from the write line in the comment-
//     stripped source to find the nearest unmatched `{`, using line granularity.
//   - Max 10 findings per file; JS/TS only.

import {
	getExtension,
	type InlineMatch,
	JS_TS_ALL_EXTS,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";

const MAX_MATCHES_PER_FILE = 10;
const REPORT_LINE_TRUNC = 150;

// ─── Regexes ─────────────────────────────────────────────────────────────────

/**
 * Matches the start of any of the four write-family calls in fully-stripped
 * (no-strings, no-comments) source. Used to detect write call sites.
 */
const WRITE_STRIPPED_RE =
	/\b(?:writeFileSync|appendFileSync|writeFile|createWriteStream)\s*\(/g;

/** Detects a `join(` call — we then count commas to see if ≥2 args. */
const JOIN_CALL_RE = /\bjoin\s*\(/;

/**
 * Detects a string literal containing a `/` — e.g. `'logs/out.log'`.
 * Applied to raw line content where strings are not stripped.
 */
const NESTED_LITERAL_RE = /["'`][^"'`]*\/[^"'`]*["'`]/;

/**
 * Detects an `existsSync(` call — a common directory-existence guard.
 */
const EXISTS_SYNC_RE = /\bexistsSync\s*\(/;

/**
 * Detects a `mkdirSync(` or `mkdir(` call opener. We then look ahead for
 * the `recursive` keyword within the call.
 */
const MKDIR_CALL_RE = /\b(?:mkdirSync|mkdir)\s*\(/g;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Count top-level arguments of the call starting at `afterOpenParen` in `text`
 * (depth already 1 on entry). Returns commas-at-depth-1 + 1.
 */
function countTopLevelArgs(text: string, afterOpenParen: number, budget: number): number {
	let depth = 1;
	let commas = 0;
	const end = Math.min(text.length, afterOpenParen + budget);
	for (let i = afterOpenParen; i < end; i++) {
		const ch = text.charAt(i);
		if (ch === "(" || ch === "[" || ch === "{") {
			depth++;
		} else if (ch === ")" || ch === "]" || ch === "}") {
			depth--;
			if (depth === 0) break;
		} else if (ch === "," && depth === 1) {
			commas++;
		}
	}
	return commas + 1;
}

/**
 * Detect a write call on `lineText` (raw or comment-stripped line). Returns
 * true when:
 *   - a `join(` with ≥2 arguments appears as the first argument, OR
 *   - a string literal containing `/` appears as the first argument.
 *
 * We extract the first argument by walking forward from the write call's `(`.
 */
function hasNestedPathArg(lineText: string): boolean {
	// Find the write function call
	const writeMatch = /\b(?:writeFileSync|appendFileSync|writeFile|createWriteStream)\s*\(/.exec(lineText);
	if (writeMatch === null) return false;

	const afterOpen = writeMatch.index + writeMatch[0].length;
	const argWindow = lineText.slice(afterOpen, afterOpen + 300);

	// Check for join(…, …) with ≥2 args
	const joinIdx = argWindow.search(JOIN_CALL_RE);
	if (joinIdx !== -1) {
		const openIdx = argWindow.indexOf("(", joinIdx);
		if (openIdx !== -1 && countTopLevelArgs(argWindow, openIdx + 1, 300) >= 2) {
			return true;
		}
	}

	// Check for string literal containing /
	return NESTED_LITERAL_RE.test(argWindow);
}

/**
 * Walk backward through `lines` from `writeLineIdx` (0-based) to find the
 * 0-based index of the line that opens the enclosing function body.
 * Counts `{` and `}` characters (brace-balance). Returns 0 when the opening
 * brace is not found (treats the whole file prefix as the scope, which is
 * conservative: may suppress some true positives at module scope but never
 * adds false positives).
 */
function findEnclosingFunctionStartLine(lines: string[], writeLineIdx: number): number {
	let depth = 0;
	for (let i = writeLineIdx - 1; i >= 0; i--) {
		const line = lines[i] ?? "";
		for (let j = line.length - 1; j >= 0; j--) {
			const ch = line.charAt(j);
			if (ch === "}") {
				depth++;
			} else if (ch === "{") {
				if (depth === 0) {
					// Opening brace found — function body starts on the next line
					return i + 1;
				}
				depth--;
			}
		}
	}
	return 0;
}

/**
 * Scan `lines[startLineIdx..endLineIdx)` (0-based, exclusive end) for any
 * mkdir/existsSync guard. Uses comment-stripped lines so `{ recursive: true }`
 * is visible but commented-out guards don't count.
 *
 * For `mkdirSync`/`mkdir` calls: we require `recursive` to appear within the
 * same line or in the subsequent ~5 lines (covers multi-line calls).
 */
function hasPriorGuardInLines(
	commentStrippedLines: string[],
	startLineIdx: number,
	endLineIdx: number,
): boolean {
	for (let i = startLineIdx; i < endLineIdx; i++) {
		const line = commentStrippedLines[i] ?? "";

		// existsSync anywhere in the line is a guard
		if (EXISTS_SYNC_RE.test(line)) return true;

		// mkdir/mkdirSync call: look for `recursive` in the call body (same line
		// or up to 5 subsequent lines for multi-line call style)
		MKDIR_CALL_RE.lastIndex = 0;
		if (MKDIR_CALL_RE.test(line)) {
			// Collect up to 5 lines after the opener (inclusive) for `recursive`
			const lookaheadEnd = Math.min(endLineIdx, i + 6);
			for (let k = i; k < lookaheadEnd; k++) {
				if (/\brecursive\b/.test(commentStrippedLines[k] ?? "")) return true;
			}
		}
	}
	return false;
}

// ─── Exported detector ───────────────────────────────────────────────────────

/**
 * Detect `writeFileSync` / `appendFileSync` / `writeFile` / `createWriteStream`
 * calls that operate on a detectably nested path without a prior mkdir guard in
 * the same function scope.
 *
 * Returns an array of `InlineMatch` objects with fields `line` (1-based) and
 * `text` (raw line content, trimmed, truncated to 150 chars).
 *
 * check id: `write_without_mkdir`
 */
export function detectWriteWithoutMkdir(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	// Fully stripped source — used to locate write call line numbers without
	// triggering on write calls mentioned inside strings or comments.
	const stripped = stripCommentsAndStrings(content);
	// Comment-stripped (strings preserved) — used for path analysis and guard
	// detection where string literal content must be visible.
	const commentStrippedLines = stripComments(content).split("\n");
	const rawLines = content.split("\n");
	const matches: InlineMatch[] = [];
	const seen = new Set<number>();

	WRITE_STRIPPED_RE.lastIndex = 0;
	let m: RegExpExecArray | null;

	while ((m = WRITE_STRIPPED_RE.exec(stripped)) !== null) {
		// Compute 0-based line index from character offset in stripped source
		const lineIdx = stripped.slice(0, m.index).split("\n").length - 1;
		const lineNo = lineIdx + 1; // 1-based for output

		if (seen.has(lineNo)) continue;

		// Analyse the raw line for the path argument (strings visible)
		const rawLine = rawLines[lineIdx] ?? "";
		if (!hasNestedPathArg(rawLine)) continue;

		// Find enclosing function start in comment-stripped lines (brace balance)
		const fnStartLineIdx = findEnclosingFunctionStartLine(commentStrippedLines, lineIdx);

		// Check for a guard between function start and this write line
		if (hasPriorGuardInLines(commentStrippedLines, fnStartLineIdx, lineIdx)) continue;

		seen.add(lineNo);
		matches.push({
			line: lineNo,
			text: rawLine.trim().slice(0, REPORT_LINE_TRUNC),
		});

		if (matches.length >= MAX_MATCHES_PER_FILE) break;
	}

	return matches;
}
