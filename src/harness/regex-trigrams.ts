// ===========================================
// Regex → Trigram Decomposition (with alternation support)
// ===========================================
// Parses a regex pattern and extracts the literal substrings that MUST appear
// in any matching text. These literals are then broken into trigrams
// for querying the trigram index.
//
// Approach: Walk the regex character by character, accumulating literal
// runs. When we hit a non-literal construct (wildcard, quantifier,
// character class, etc.), flush the current literal run and extract
// trigrams from it. The result is a set of trigrams that ALL must
// appear in any file that matches the regex.
//
// Conservative: we only extract trigrams from portions of the regex we
// can prove are required literals. This means we may return fewer
// trigrams than optimal (more candidate files), but never miss a file
// that actually matches (no false negatives).

import { nonNull } from "../lib/non-null.js";
import { extractTrigrams, isControlChar, packTrigram } from "./trigram-index.js";

// ===========================================
// Types
// ===========================================

interface DecompositionResult {
	/** Trigrams that MUST all appear in any matching file */
	requiredTrigrams: number[];
	/** The literal segments extracted from the regex */
	literalSegments: string[];
	/** Whether the pattern has any extractable literals */
	hasLiterals: boolean;
	/** Whether the pattern was treated as a plain literal (no regex syntax) */
	isLiteral: boolean;
	/** Ordered trigram sequences from each literal segment (for adjacency checking) */
	trigramSequences: number[][];
}

// ===========================================
// Helpers
// ===========================================

/** Extract packed trigrams in order from a literal segment (for adjacency checking). */
function orderedTrigrams(segment: string): number[] {
	const lower = segment.toLowerCase();
	const result: number[] = [];
	for (let i = 0; i <= lower.length - 3; i++) {
		const c0 = lower.charCodeAt(i);
		const c1 = lower.charCodeAt(i + 1);
		const c2 = lower.charCodeAt(i + 2);
		if (c0 > 0x7f || c1 > 0x7f || c2 > 0x7f) continue;
		if (isControlChar(c0) || isControlChar(c1) || isControlChar(c2)) continue;
		result.push(packTrigram(c0, c1, c2));
	}
	return result;
}

// ===========================================
// Main Entry Point
// ===========================================

/**
 * Decompose a search pattern into required trigrams.
 *
 * @param pattern - The search pattern (literal string or regex)
 * @param isRegex - Whether to parse as regex (default: false = literal)
 * @param caseInsensitive - Whether the search is case-insensitive
 * @returns Trigrams that must appear in any matching file
 */
export function decomposePattern(
	pattern: string,
	isRegex = false,
	caseInsensitive = false,
): DecompositionResult {
	if (!pattern || pattern.length < 3) {
		return {
			requiredTrigrams: [],
			literalSegments: [],
			hasLiterals: false,
			isLiteral: !isRegex,
			trigramSequences: [],
		};
	}

	// For literal strings, extraction is straightforward
	if (!isRegex) {
		const effective = caseInsensitive ? pattern.toLowerCase() : pattern;
		const trigrams = extractTrigrams(effective);
		return {
			requiredTrigrams: [...trigrams],
			literalSegments: [effective],
			hasLiterals: trigrams.size > 0,
			isLiteral: true,
			trigramSequences: [orderedTrigrams(effective)],
		};
	}

	// Check for top-level alternation first — handle at the trigram level
	const topBranches = splitAlternation(pattern);
	if (topBranches.length > 1) {
		// For alternation, intersect trigrams across all branches —
		// only trigrams common to ALL branches are required.
		let commonTrigrams: Set<number> | null = null;
		const allSegments: string[] = [];

		for (const branch of topBranches) {
			const branchResult = decomposePattern(branch, true, caseInsensitive);
			const branchTris = new Set(branchResult.requiredTrigrams);

			if (commonTrigrams === null) {
				commonTrigrams = branchTris;
			} else {
				const filtered = new Set<number>();
				for (const t of commonTrigrams) {
					if (branchTris.has(t)) filtered.add(t);
				}
				commonTrigrams = filtered;
			}
			allSegments.push(...branchResult.literalSegments);

			if (commonTrigrams.size === 0) break; // no intersection possible
		}

		const trigrams = commonTrigrams ?? new Set<number>();
		return {
			requiredTrigrams: [...trigrams],
			literalSegments: allSegments,
			hasLiterals: trigrams.size > 0,
			isLiteral: false,
			trigramSequences: [],
		};
	}

	// No top-level alternation — extract literal segments normally
	const segments = extractLiteralSegments(pattern);

	// Extract trigrams from each segment
	const allTrigrams = new Set<number>();
	const literalSegments: string[] = [];

	for (const seg of segments) {
		// Segments are always lowercased here regardless of `caseInsensitive`:
		// the trigram index is itself lowercase, so a case-sensitive search still
		// queries with lowercase trigrams (then verifies case against real files).
		const effective = seg.toLowerCase();
		if (effective.length >= 3) {
			literalSegments.push(effective);
			for (const tri of extractTrigrams(effective)) {
				allTrigrams.add(tri);
			}
		}
	}

	return {
		requiredTrigrams: [...allTrigrams],
		literalSegments,
		hasLiterals: allTrigrams.size > 0,
		isLiteral: false,
		trigramSequences: literalSegments
			.map((seg) => orderedTrigrams(seg))
			.filter((seq) => seq.length >= 2),
	};
}

// ===========================================
// Regex Literal Extraction
// ===========================================

/**
 * Cursor state threaded through the per-construct handlers below: the literal
 * run accumulated so far (`current`) and the next index to read (`i`).
 * Handlers mutate `segments` in place and return the advanced state.
 */
interface ScanState {
	current: string;
	i: number;
}

/**
 * Handle a `\`-escape at `i`. A literal escape (`\.`, `\n`, …) extends the
 * current run; a non-literal escape (`\d`, `\w`, …) flushes it. A trailing lone
 * `\` is kept as a literal backslash. Advances past the escape.
 */
function handleEscape(pattern: string, i: number, current: string, segments: string[]): ScanState {
	const len = pattern.length;
	if (i + 1 >= len) {
		return { current: current + "\\", i: i + 1 };
	}
	const literal = resolveEscape(nonNull(pattern[i + 1]));
	if (literal !== null) {
		return { current: current + literal, i: i + 2 };
	}
	// Non-literal escape (\d, \w, \s, \b, etc.) — flush.
	flushSegment(current, segments);
	return { current: "", i: i + 2 };
}

/**
 * Handle a `*` / `+` / `?` quantifier at `i`: the preceding character is now
 * variable, so drop it and flush the run before it. Skips a trailing lazy /
 * possessive modifier (`*?`, `+?`, `??`, `*+`).
 */
function handleQuantifier(pattern: string, i: number, current: string, segments: string[]): ScanState {
	if (current.length > 0) {
		flushSegment(current.slice(0, -1), segments);
	}
	let next = i + 1;
	if (next < pattern.length && (pattern[next] === "?" || pattern[next] === "+")) next++;
	return { current: "", i: next };
}

/**
 * Handle a `{…}` repetition at `i`: the preceding element is variable, so drop
 * it and flush the run before it. Skips to past `}` and any trailing lazy `?`.
 */
function handleRepeat(pattern: string, i: number, current: string, segments: string[]): ScanState {
	const len = pattern.length;
	if (current.length > 0) {
		flushSegment(current.slice(0, -1), segments);
	}
	let next = i;
	while (next < len && pattern[next] !== "}") next++;
	if (next < len) next++; // skip '}'
	if (next < len && pattern[next] === "?") next++; // lazy modifier
	return { current: "", i: next };
}

/**
 * Handle a `(` group at `i`. An alternation group is skipped wholesale (the
 * trigram-level intersection for top-level alternation is done by
 * decomposePattern). A non-alternation group either contributes its inner
 * literal segments (capturing / `?:`) or is skipped (lookaround / unknown
 * modifier). Returns the index just past the group.
 */
function handleGroup(pattern: string, i: number, segments: string[]): number {
	const groupEnd = findGroupEnd(pattern, i);
	const groupContent = pattern.slice(i + 1, groupEnd);

	if (groupContent.includes("|")) {
		// Alternation inside a group — cannot extract required literals here.
		return groupEnd + 1;
	}

	const parsed = classifyGroupPrefix(groupContent);
	if (parsed.kind === "skip") {
		return groupEnd + 1;
	}
	segments.push(...extractLiteralSegments(parsed.inner));
	return groupEnd + 1;
}

/**
 * Walk a regex pattern and extract literal segments that must appear
 * in any match. Returns an array of literal strings.
 */
function extractLiteralSegments(pattern: string): string[] {
	const segments: string[] = [];
	let current = "";
	let i = 0;
	const len = pattern.length;

	while (i < len) {
		const ch = pattern[i];

		switch (ch) {
			// Escape sequences — next char is literal (mostly)
			case "\\": {
				const st = handleEscape(pattern, i, current, segments);
				current = st.current;
				i = st.i;
				break;
			}

			// Wildcards — flush current literal
			case ".":
				flushSegment(current, segments);
				current = "";
				i++;
				break;

			// Character classes — not a fixed literal, flush
			case "[":
				flushSegment(current, segments);
				current = "";
				i = skipCharClass(pattern, i); // skip to past closing bracket
				break;

			// Quantifiers — the preceding char/group is variable
			case "*":
			case "+":
			case "?": {
				const st = handleQuantifier(pattern, i, current, segments);
				current = st.current;
				i = st.i;
				break;
			}

			// Repetition — preceding element is variable
			case "{": {
				const st = handleRepeat(pattern, i, current, segments);
				current = st.current;
				i = st.i;
				break;
			}

			// Groups — recurse into capturing / non-capturing bodies; skip
			// alternation groups and lookarounds (see handleGroup).
			case "(":
				flushSegment(current, segments);
				current = "";
				i = handleGroup(pattern, i, segments);
				break;

			// Alternation at top level — handled by decomposePattern, just stop here
			case "|":
				flushSegment(current, segments);
				current = "";
				i = len; // stop parsing (decomposePattern handles branch intersection)
				break;

			// Anchors — don't consume characters, ignore
			case "^":
			case "$":
				i++;
				break;

			// Regular literal character
			default:
				current += ch;
				i++;
				break;
		}
	}

	flushSegment(current, segments);
	return segments;
}

/**
 * Escaped special regex characters whose literal value is the character itself
 * (`\.` → `.`, `\\` → `\`, etc.). Membership-only; the value is `ch`.
 */
const SELF_LITERAL_ESCAPES = new Set([
	".",
	"*",
	"+",
	"?",
	"[",
	"]",
	"(",
	")",
	"{",
	"}",
	"|",
	"^",
	"$",
	"\\",
	"/",
	"-",
]);

/** Named escape sequences that map to a concrete control character. */
const NAMED_LITERAL_ESCAPES = new Map<string, string>([
	["n", "\n"],
	["t", "\t"],
	["r", "\r"],
	["f", "\f"],
	["v", "\v"],
	["0", "\0"],
]);

/**
 * Non-literal escapes (character classes / assertions: `\d`, `\w`, `\s`, `\b`,
 * `\A`, `\Z`, `\z`, and their uppercase negations). These do not contribute a
 * fixed literal, so `resolveEscape` returns null for them.
 */
const NON_LITERAL_ESCAPES = new Set(["d", "D", "w", "W", "s", "S", "b", "B", "A", "Z", "z"]);

/**
 * Resolve a regex escape character to its literal value.
 * Returns null for non-literal escapes (\d, \w, \s, \b, etc.).
 */
function resolveEscape(ch: string): string | null {
	if (SELF_LITERAL_ESCAPES.has(ch)) return ch;
	const named = NAMED_LITERAL_ESCAPES.get(ch);
	if (named !== undefined) return named;
	if (NON_LITERAL_ESCAPES.has(ch)) return null;
	// Unknown escape — treat as literal (rg/pcre behavior)
	return ch;
}

/** Skip past a character class [...], handling nested escapes */
function skipCharClass(pattern: string, start: number): number {
	let i = start + 1; // skip opening '['
	if (i < pattern.length && pattern[i] === "^") i++; // negated class
	if (i < pattern.length && pattern[i] === "]") i++; // literal ] at start

	while (i < pattern.length) {
		if (pattern[i] === "\\") {
			i += 2; // skip escape
		} else if (pattern[i] === "]") {
			return i + 1; // past closing ']'
		} else {
			i++;
		}
	}
	return i; // unterminated class, consume everything
}

/**
 * Classify the prefix of a regex group body:
 *   - `?:` → non-capturing, return the body stripped of `?:`
 *   - `?=`, `?!`, `?<=`, `?<!` → lookaround; contents don't consume input, skip
 *   - any other `?...` → unknown modifier, skip to be safe
 *   - otherwise → normal capturing group, return the body unchanged
 */
function classifyGroupPrefix(body: string): { kind: "inner"; inner: string } | { kind: "skip" } {
	if (body.startsWith("?:")) return { kind: "inner", inner: body.slice(2) };
	if (body.startsWith("?")) return { kind: "skip" };
	return { kind: "inner", inner: body };
}

/** Find the matching closing parenthesis for a group */
function findGroupEnd(pattern: string, start: number): number {
	let depth = 1;
	let i = start + 1;
	while (i < pattern.length && depth > 0) {
		if (pattern[i] === "\\") {
			i += 2;
			continue;
		}
		if (pattern[i] === "(") depth++;
		else if (pattern[i] === ")") depth--;
		if (depth > 0) i++;
	}
	return i;
}

/** Flush a literal segment if it's long enough to contain trigrams */
function flushSegment(segment: string, segments: string[]): void {
	if (segment.length >= 3) {
		segments.push(segment);
	}
}

/**
 * Split a regex string at top-level alternation operators (|).
 * Respects group nesting — | inside (...) is not a split point.
 */
function splitAlternation(pattern: string): string[] {
	const branches: string[] = [];
	let current = "";
	let depth = 0;
	let i = 0;

	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === "\\") {
			current += ch + (pattern[i + 1] || "");
			i += 2;
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")") depth--;
		else if (ch === "|" && depth === 0) {
			branches.push(current);
			current = "";
			i++;
			continue;
		}
		current += ch;
		i++;
	}
	branches.push(current);
	return branches;
}

export type { ParsedGrepCommand } from "./regex-trigrams-grep-parse.js";
// ===========================================
// Ripgrep Command Parsing
// ===========================================
// Moved to ./regex-trigrams-grep-parse.ts (leaf cluster: consumes nothing
// from the decomposition side). Re-exported here to preserve the public API.
export { parseGrepCommand } from "./regex-trigrams-grep-parse.js";
