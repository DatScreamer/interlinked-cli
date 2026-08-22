// Tag-reflection type check where `typeof` suffices.
//
// `instanceof String` / `instanceof Number` / `instanceof Boolean` and
// `Object.prototype.toString.call(x) === "[object String]"` (and the Number
// / Boolean variants) test for the WRAPPER-OBJECT tag of a primitive, not the
// primitive value itself. Two problems:
//   1. `typeof x === "string"` already answers the question `instanceof
//      String` is usually reached for, and does it correctly for the
//      overwhelming common case (a bare primitive, not a `new String(...)`
//      wrapper) — the wrapper form is legacy and rare in agent-written code.
//   2. The `[object Tag]` string is spoofable via `Symbol.toStringTag` and
//      does not survive a cross-realm value (an array/object from another
//      iframe/vm context reports its OWN realm's tag string), so tag
//      reflection is a strictly worse test than `typeof` for these three
//      primitive types.
//
// Explicitly NOT flagged: `Object.prototype.toString.call(x)` compared
// against `[object Date]` / `[object Array]` / `[object RegExp]` /
// `[object Map]` / etc. — `typeof` cannot distinguish these (they're all
// `"object"`), so tag reflection is the correct tool there, not a smell.
//
// Only fires on JS/TS source files; test files are skipped (mirrors
// nan-coercion.ts's convention — the checks/ family generally treats test
// fixtures as out of scope for this class of taste check).

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_ALL_EXTS,
	stripComments,
} from "./shared.js";
import { offsetToLine } from "./shared-text-utils.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const REPORT_LINE_TRUNC = 150;
const MAX_MATCHES_PER_FILE = 10;

// ─── Patterns ─────────────────────────────────────────────────────────────────

/** `instanceof String` / `Number` / `Boolean`, word-bounded so `StringDecoder`
 *  and similar longer identifiers never match. */
const INSTANCEOF_WRAPPER_RE = /\binstanceof\s+(String|Number|Boolean)\b/g;

/** `=== "[object String]"` / `!== '[object Number]'` etc. — single or double
 *  quotes, either equality operator. Only the three primitive tags; Date /
 *  Array / RegExp / Map / etc. are deliberately excluded (typeof can't answer
 *  those, so tag reflection there is correct, not a smell). */
const TAG_REFLECTION_RE =
	/(?:===|!==)\s*(["'])\[object (String|Number|Boolean)\]\1/g;

const MESSAGE =
	'tag_reflection_type_check: tag-reflection type check where `typeof` suffices — prefer `typeof x === "string"` (or "number"/"boolean"); tag reflection (instanceof/[object Tag]) is spoofable via Symbol.toStringTag and breaks cross-realm';

// ─── Match recording ──────────────────────────────────────────────────────────

function recordMatch(
	stripped: string,
	rawLines: string[],
	offset: number,
	matches: InlineMatch[],
	seen: Set<number>,
): void {
	if (matches.length >= MAX_MATCHES_PER_FILE) return;
	const lineNo = offsetToLine(stripped, offset);
	if (seen.has(lineNo)) return;
	seen.add(lineNo);
	const rawText = (rawLines[lineNo - 1] ?? "").trim().slice(0, REPORT_LINE_TRUNC);
	matches.push({ line: lineNo, text: `${MESSAGE} — ${rawText}` });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect tag-reflection type checks (`instanceof String/Number/Boolean` or
 * `=== "[object String/Number/Boolean]"`) where `typeof` suffices.
 *
 * Check id: `tag_reflection_type_check`
 *
 * Returns up to 10 `InlineMatch` findings per file. Only fires on JS/TS
 * source files; test files are skipped.
 */
export function detectTagReflectionTypeCheck(
	content: string,
	filePath: string,
): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];
	if (isTestFile(filePath)) return [];

	// Strip comments only (not string literals) — a match INSIDE a string
	// literal in product code is still fine to fire on per spec; stripping
	// comments prevents a documentation example (`// e.g. x instanceof String`)
	// from being flagged.
	const stripped = stripComments(content);
	const rawLines = content.split("\n");
	const matches: InlineMatch[] = [];
	const seen = new Set<number>();

	const instanceofRe = new RegExp(INSTANCEOF_WRAPPER_RE.source, "g");
	let hit: RegExpExecArray | null;
	while ((hit = instanceofRe.exec(stripped)) !== null) {
		recordMatch(stripped, rawLines, hit.index, matches, seen);
		if (matches.length >= MAX_MATCHES_PER_FILE) return matches;
	}

	const tagRe = new RegExp(TAG_REFLECTION_RE.source, "g");
	while ((hit = tagRe.exec(stripped)) !== null) {
		recordMatch(stripped, rawLines, hit.index, matches, seen);
		if (matches.length >= MAX_MATCHES_PER_FILE) return matches;
	}

	return matches;
}
