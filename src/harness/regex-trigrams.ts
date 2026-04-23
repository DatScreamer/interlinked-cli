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
		const effective = caseInsensitive ? seg.toLowerCase() : seg.toLowerCase();
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
			case "\\":
				if (i + 1 < len) {
					const next = pattern[i + 1];
					const literal = resolveEscape(next);
					if (literal !== null) {
						current += literal;
						i += 2;
					} else {
						// Non-literal escape (\d, \w, \s, \b, etc.) — flush
						flushSegment(current, segments);
						current = "";
						i += 2;
					}
				} else {
					current += "\\";
					i++;
				}
				break;

			// Wildcards — flush current literal
			case ".":
				flushSegment(current, segments);
				current = "";
				i++;
				break;

			// Character classes — not a fixed literal, flush
			case "[": {
				flushSegment(current, segments);
				current = "";
				// Skip to closing bracket
				i = skipCharClass(pattern, i);
				break;
			}

			// Quantifiers — the preceding char/group is variable
			case "*":
			case "+":
			case "?":
				// Remove the last char from current (it's now variable)
				if (current.length > 0) {
					const beforeQuantifier = current.slice(0, -1);
					flushSegment(beforeQuantifier, segments);
					current = "";
				}
				i++;
				// Skip lazy/possessive modifier
				if (i < len && (pattern[i] === "?" || pattern[i] === "+")) i++;
				break;

			// Repetition — preceding element is variable
			case "{":
				if (current.length > 0) {
					const beforeRepeat = current.slice(0, -1);
					flushSegment(beforeRepeat, segments);
					current = "";
				}
				// Skip to closing brace
				while (i < len && pattern[i] !== "}") i++;
				if (i < len) i++; // skip '}'
				// Skip lazy modifier
				if (i < len && pattern[i] === "?") i++;
				break;

			// Groups — for simplicity, treat as a break in the literal chain
			// (proper handling would recurse into the group, but alternation
			// within groups makes it complex)
			case "(": {
				flushSegment(current, segments);
				current = "";
				// Check if this group contains alternation
				const groupEnd = findGroupEnd(pattern, i);
				const groupContent = pattern.slice(i + 1, groupEnd);

				if (groupContent.includes("|")) {
					// Alternation inside a group — skip the group's contents.
					// The trigram-level intersection for alternation is handled
					// by decomposePattern at the top level. Here we just can't
					// extract required literals from an alternation group.
					i = groupEnd + 1;
				} else {
					// Non-alternation group — strip group markers and recurse.
					// For zero-width assertions (lookahead/lookbehind) and any
					// unknown group modifier, skip the group entirely — its
					// contents do not contribute to the trigram literal set.
					const parsed = classifyGroupPrefix(groupContent);
					if (parsed.kind === "skip") {
						i = groupEnd + 1;
						break;
					}
					const inner = parsed.inner;

					const innerSegments = extractLiteralSegments(inner);
					segments.push(...innerSegments);
					i = groupEnd + 1;
				}
				break;
			}

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
 * Resolve a regex escape character to its literal value.
 * Returns null for non-literal escapes (\d, \w, \s, \b, etc.).
 */
function resolveEscape(ch: string): string | null {
	switch (ch) {
		// Literal escapes of special regex characters
		case ".":
		case "*":
		case "+":
		case "?":
		case "[":
		case "]":
		case "(":
		case ")":
		case "{":
		case "}":
		case "|":
		case "^":
		case "$":
		case "\\":
		case "/":
		case "-":
			return ch;

		// Common escape sequences with literal values
		case "n":
			return "\n";
		case "t":
			return "\t";
		case "r":
			return "\r";
		case "f":
			return "\f";
		case "v":
			return "\v";
		case "0":
			return "\0";

		// Non-literal escapes (character classes, assertions)
		case "d":
		case "D":
		case "w":
		case "W":
		case "s":
		case "S":
		case "b":
		case "B":
		case "A":
		case "Z":
		case "z":
			return null;

		// Unknown escape — treat as literal (rg/pcre behavior)
		default:
			return ch;
	}
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

// ===========================================
// Ripgrep Command Parsing
// ===========================================

export interface ParsedGrepCommand {
	pattern: string;
	isRegex: boolean;
	caseInsensitive: boolean;
	path?: string;
	glob?: string;
}

interface FlagAdvance {
	consumedExtra?: number;
	expectGlob?: boolean;
	patternFound?: boolean;
}

/**
 * Apply a single ripgrep/grep-style flag token to the accumulating result and
 * report any side effects the caller needs to propagate (extra tokens consumed,
 * the next arg expected to be a glob, a pattern that terminates flag parsing).
 */
function applyRipgrepFlag(
	tok: string,
	tokens: string[],
	i: number,
	result: ParsedGrepCommand,
): FlagAdvance {
	if (tok === "-i" || tok === "--ignore-case") {
		result.caseInsensitive = true;
		return {};
	}
	if (tok === "-F" || tok === "--fixed-strings") {
		result.isRegex = false;
		return {};
	}
	if (tok === "-g" || tok === "--glob") {
		return { expectGlob: true };
	}
	if (tok.startsWith("-g") && tok.length > 2) {
		result.glob = tok.slice(2);
		return {};
	}
	if (tok === "-t" || tok === "--type") {
		return { consumedExtra: 1 };
	}
	if (tok === "-e" || tok === "--regexp") {
		if (i + 1 < tokens.length) {
			result.pattern = tokens[i + 1];
			return { consumedExtra: 1, patternFound: true };
		}
	}
	return {};
}

/**
 * Parse a Bash command to detect ripgrep/grep invocations and extract
 * the search pattern. Returns null if the command isn't a grep-like search.
 */
export function parseGrepCommand(command: string): ParsedGrepCommand | null {
	const trimmed = command.trim();

	// Match ripgrep: rg [flags] 'pattern' [path]
	// Match grep: grep [flags] 'pattern' [path]
	const rgMatch = trimmed.match(/^(?:rg|ripgrep|grep|egrep|fgrep)\s+(.*)/s);
	if (!rgMatch) return null;

	const argsStr = rgMatch[1];
	const result: ParsedGrepCommand = {
		pattern: "",
		isRegex: true,
		caseInsensitive: false,
	};

	// Parse flags and arguments
	const tokens = tokenizeShellArgs(argsStr);
	let expectGlob = false;
	let patternFound = false;

	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];

		if (expectGlob) {
			result.glob = tok;
			expectGlob = false;
			continue;
		}

		// Flag handling
		if (tok.startsWith("-") && !patternFound) {
			const advance = applyRipgrepFlag(tok, tokens, i, result);
			if (advance.consumedExtra) i += advance.consumedExtra;
			if (advance.expectGlob) expectGlob = true;
			if (advance.patternFound) patternFound = true;
			// Skip other flags (-n, -l, --color, etc.)
			continue;
		}

		// First non-flag token is the pattern
		if (!patternFound) {
			result.pattern = tok;
			patternFound = true;
		} else {
			// Subsequent non-flag token is the path
			result.path = tok;
		}
	}

	if (!result.pattern) return null;
	return result;
}

/**
 * Basic shell argument tokenizer.
 * Handles single quotes, double quotes, and backslash escapes.
 */
function tokenizeShellArgs(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let i = 0;
	let inSingle = false;
	let inDouble = false;

	while (i < input.length) {
		const ch = input[i];

		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
			} else {
				current += ch;
			}
			i++;
			continue;
		}

		if (inDouble) {
			if (ch === '"') {
				inDouble = false;
			} else if (ch === "\\" && i + 1 < input.length) {
				current += input[i + 1];
				i++;
			} else {
				current += ch;
			}
			i++;
			continue;
		}

		switch (ch) {
			case "'":
				inSingle = true;
				i++;
				continue;
			case '"':
				inDouble = true;
				i++;
				continue;
			case "\\":
				if (i + 1 < input.length) {
					current += input[i + 1];
					i += 2;
				} else {
					i++;
				}
				continue;
			case " ":
			case "\t":
				if (current.length > 0) {
					tokens.push(current);
					current = "";
				}
				i++;
				continue;
			case "|":
			case ";":
			case "&":
			case ">":
			case "<":
				// Stop at shell operators
				i = input.length;
				continue;
			default:
				current += ch;
				i++;
		}
	}

	if (current.length > 0) {
		tokens.push(current);
	}

	return tokens;
}
