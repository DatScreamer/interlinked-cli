// ===========================================================================
// Policy-constant drift detector
// ===========================================================================
// Catches the bug class where a file declares a named policy constant
// (e.g. `const MAX_RETRIES = 7`) and then ALSO hard-codes the bare numeric
// literal on another line instead of referencing the constant.  When the
// constant's value is later updated the bare literal silently diverges.
//
// Real example: a commit-time gate hard-coded `25` while the per-edit path
// resolved a configurable cap — lowering the cap was silently ignored at
// commit time.
//
// Check id: duplicated_policy_constant
// Phase:    advisory (post-tool)  — heuristic, intentionally conservative

import { type InlineMatch, isTestFile } from "./shared.js";
import { stripCommentsAndStrings } from "./shared-text-utils.js";

// ---------------------------------------------------------------------------
// Trivial-number exclusion list
// Numbers so commonly used in non-policy contexts that a match would be
// extremely noisy (loop bounds, boolean-like flags, percentages, common
// byte/time denominators).
// ---------------------------------------------------------------------------
const TRIVIAL_NUMBERS = new Set([0, 1, -1, 2, 100, 1000, 24, 60, 1024]);

// ---------------------------------------------------------------------------
// Pattern: constant NAMES that indicate a policy/config value.
// Matches if the name starts with DEFAULT_, MAX_, or MIN_, OR ends with
// _CAP, _THRESHOLD, _LIMIT, _MAX, or _MIN (case-insensitive on the suffix).
// ---------------------------------------------------------------------------
const POLICY_NAME_RE =
	/^(?:(?:DEFAULT|MAX|MIN)_[A-Z0-9_]+|[A-Z][A-Z0-9_]*_(?:CAP|THRESHOLD|LIMIT|MAX|MIN))$/i;

// Regex to find `const NAME = <integer|float>;` (export optional, type
// annotations skipped).  We only capture integer/float literals — strings,
// arrays, objects, and calls are not in scope.
const CONST_DECL_RE =
	/^[ \t]*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*(-?\d+(?:\.\d+)?)\s*;/;

interface PolicyConstant {
	/** Constant name exactly as declared. */
	name: string;
	/** Numeric value parsed from the declaration. */
	value: number;
	/** 1-based line number of the declaration. */
	definitionLine: number;
}

/**
 * Scan a single file's lines for `const NAME = <number>;` declarations
 * where NAME matches the policy-ish pattern and the value is non-trivial.
 * Runs on the STRIPPED source so it skips commented-out declarations.
 */
function collectPolicyConstants(strippedLines: string[]): PolicyConstant[] {
	const out: PolicyConstant[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		const line = strippedLines[i] ?? "";
		const m = CONST_DECL_RE.exec(line);
		if (!m) continue;
		const name = m[1] ?? "";
		const rawValue = m[2] ?? "";
		if (!POLICY_NAME_RE.test(name)) continue;
		const value = parseFloat(rawValue);
		if (!Number.isFinite(value)) continue;
		if (TRIVIAL_NUMBERS.has(value)) continue;
		out.push({ name, value, definitionLine: i + 1 });
	}
	return out;
}

/**
 * Build a regex that matches the bare literal V used as a standalone
 * numeric token.  We require a word-boundary on BOTH sides so that e.g.
 * the literal `7` does not match inside `57`, `70`, or `7px`.
 *
 * We also require the literal NOT to be immediately preceded or followed
 * by digits (covering floats like `0.7` not matching for `7`).
 */
function buildLiteralRe(value: number): RegExp {
	// Escape the value string — integers are fine, floats need the `.` escaped.
	const escaped = String(value).replace(".", "\\.");
	// `\b` in JS regex treats `.` as a boundary, so `\b7\b` matches in `3.7`.
	// Use negative lookbehind/lookahead for digits to be stricter.
	return new RegExp(`(?<![\\d.])\\b${escaped}\\b(?![\\d])`, "g");
}

/**
 * Return true when `lineText` (already stripped of comments + strings)
 * contains a bare numeric token that equals `value` somewhere OTHER than
 * a constant declaration.
 */
function lineDuplicatesLiteral(strippedLine: string, value: number): boolean {
	const re = buildLiteralRe(value);
	// Strip any remaining const declaration on this very line (shouldn't
	// happen after we skip the definition line, but be safe).
	const withoutDecl = strippedLine.replace(CONST_DECL_RE, "");
	return re.test(withoutDecl);
}

/**
 * For each policy constant found, scan the remaining lines for bare
 * occurrences of its literal value.  Returns one InlineMatch per
 * occurrence line.
 */
function findDuplicateLiterals(
	constants: PolicyConstant[],
	strippedLines: string[],
	originalLines: string[],
): InlineMatch[] {
	const out: InlineMatch[] = [];

	for (const pc of constants) {
		for (let i = 0; i < strippedLines.length; i++) {
			// Skip the constant's own definition line.
			if (i + 1 === pc.definitionLine) continue;
			const stripped = strippedLines[i] ?? "";
			if (!lineDuplicatesLiteral(stripped, pc.value)) continue;
			const originalLine = originalLines[i] ?? "";
			out.push({
				line: i + 1,
				text:
					`literal ${pc.value} duplicates the policy constant ${pc.name} ` +
					`(line ${pc.definitionLine}) — reference the constant so they can't drift. ` +
					`Context: ${originalLine.trim().slice(0, 80)}`,
			});
		}
	}

	return out;
}

/**
 * Detect bare numeric literals that duplicate a named policy constant
 * defined in the same file.
 *
 * Only fires when:
 * - The same file has a `const NAME = V` where NAME is policy-ish and
 *   V is non-trivial.
 * - A different line uses the bare literal V as a standalone numeric token
 *   (not inside a comment, not inside a string, not part of a larger number).
 *
 * @param content  - Raw file contents (will be stripped internally)
 * @param filePath - Absolute or relative path (used for skip decisions)
 * @returns Array of InlineMatch findings (empty when nothing suspicious found)
 */
export function detectPolicyConstantDrift(
	content: string,
	filePath: string,
): InlineMatch[] {
	// Skip test files — test fixtures intentionally repeat raw numbers.
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const strippedLines = stripped.split("\n");
	const originalLines = content.split("\n");

	const constants = collectPolicyConstants(strippedLines);
	if (constants.length === 0) return [];

	return findDuplicateLiterals(constants, strippedLines, originalLines);
}
