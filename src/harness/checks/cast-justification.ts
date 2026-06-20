// Unjustified type-assertion detector.
//
// The TS coding standard requires every non-`as const` cast to carry a
// `// SAFETY:` comment explaining why the assertion is sound (the assertion
// silences the checker, so the reviewer needs the invariant spelled out).
// This mirrors the harness's existing `suppressions` / `suppressions-unjustified`
// split: a cast WITH a nearby justification is soft/silent; a cast WITHOUT one
// is loud and line-numbered.
//
// It ships as a ratchet metric (`countUnjustifiedCasts`) alongside the `as any`
// and non-null-assertion ratchets — bare `as` is common, so only a *net new*
// unjustified cast is flagged per edit; the escape is one `// SAFETY:` line.
//
// Heuristic (regex over comment/string-stripped content), so findings are
// tagged `[heuristic]`. Angle-bracket casts (`<T>x`) are deliberately NOT
// detected — they are indistinguishable from generics/JSX without full parsing.

import type { InlineMatch } from "./shared.js";
import { stripCommentsAndStrings } from "./shared.js";

/** `as <Type>` assertion, excluding the always-safe `as const`. */
const CAST_RE = /\bas\s+(?!const\b)[A-Za-z_$][\w$]*/;

/** True iff a `// SAFETY:` (or `/* SAFETY`) justification sits on line `idx`
 *  or up to two lines above it. */
function hasSafetyJustification(rawLines: readonly string[], idx: number): boolean {
	// A same-line trailing `// SAFETY:` justifies this cast only.
	if (/\bSAFETY\b/.test(rawLines[idx] ?? "")) return true;
	// Otherwise a SAFETY note in the contiguous comment block directly above the
	// cast counts; a code line (e.g. a prior cast with its own trailing note)
	// breaks the block so it can't bleed down onto the next statement.
	for (let j = idx - 1; j >= Math.max(0, idx - 2); j--) {
		const line = (rawLines[j] ?? "").trim();
		if (!(line.startsWith("//") || line.startsWith("*") || line.startsWith("/*"))) break;
		if (/\bSAFETY\b/.test(line)) return true;
	}
	return false;
}

/** True for `import`/`export {…}`/re-export-`from` lines, whose `as` is a
 *  module-rename, not a type assertion. */
function isModuleAliasLine(raw: string): boolean {
	if (/^\s*import\b/.test(raw)) return true;
	if (/^\s*export\s*(?:type\s+)?\{/.test(raw)) return true;
	if (/^\s*export\b/.test(raw) && /\bfrom\s*['"]/.test(raw) && !raw.includes("=")) return true;
	return false;
}

/**
 * Find type-assertion casts that lack a `// SAFETY:` justification.
 *
 * @param content - The source text to scan.
 * @param _filePath - The file path (unused; kept for the check-registry signature).
 * @returns One match per line carrying an unjustified cast.
 */
export function findUnjustifiedCasts(content: string, _filePath: string): InlineMatch[] {
	const rawLines = content.split("\n");
	const strippedLines = stripCommentsAndStrings(content).split("\n");
	const out: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		const stripped = strippedLines[i] ?? "";
		const raw = rawLines[i] ?? "";
		if (isModuleAliasLine(raw)) continue;
		if (!CAST_RE.test(stripped)) continue;
		if (hasSafetyJustification(rawLines, i)) continue;
		out.push({ line: i + 1, text: raw.trim().slice(0, 150) });
	}
	return out;
}

/**
 * Count lines carrying an unjustified cast — the ratchet metric.
 *
 * @param content - The source text to scan.
 * @returns The number of lines with at least one unjustified cast.
 */
export function countUnjustifiedCasts(content: string): number {
	return findUnjustifiedCasts(content, "").length;
}
