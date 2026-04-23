// ===========================================
// Inline-suppression detection (verify-scope)
// ===========================================
// Flags bare suppression directives that lack a rationale. A suppression
// comment with an explanatory reason is considered reviewed; a silent
// suppression is debt that the agent should either fix or justify.
//
// Note: this module is specific to verify's *scan* step — the persistent
// suppression-file loader (`loadFileSuppressions`, `addSuppressions`, etc.)
// lives in `../../harness/suppressions.ts`.

import { stripStringLiterals } from "../../harness/strip-helpers.js";
import type { CodeQualityIssue } from "./tool-results-types.js";

/** Public API — consumed by verify submodules and tests. */
export type SuppressionHit = { label: string };

/** Public API — consumed by verify submodules and tests. */
export type SuppressionMatch = SuppressionHit | null;

/** Build a suppression comment regex. Uses RegExp constructor so the lint
 *  rules don't flag the literal directive strings. */
function sup(prefix: string, directive: string): { pattern: RegExp; label: string } {
	// Reason: `prefix` and `directive` are hardcoded literals from the
	// suppression table below — not attacker-controllable.
	// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
	return { pattern: new RegExp(`${prefix}\\s*${directive}\\b`), label: directive };
}

const MIN_RATIONALE_LENGTH = 8;

/**
 * True when a suppression directive line carries a human-readable
 * rationale — either `: explanation`, `— explanation`, or a trailing
 * prose substring that isn't just the rule identifier.
 *
 * The `label` (e.g. an expect-error directive) tells us what prefix to look
 * past when deciding whether the remaining text constitutes rationale.
 */
function hasSuppressionRationale(trimmedLine: string, label: string): boolean {
	// Find where the directive's own text ends. For namespaced-ignore style
	// directives, the rule identifier follows the directive — find the next
	// colon, em-dash, or hyphen+space that introduces the reason.
	const idx = trimmedLine.toLowerCase().indexOf(label.toLowerCase());
	if (idx === -1) return false;
	const after = trimmedLine.slice(idx + label.length);
	// `: reason` / `— reason` / `- reason` — classic rationale separators.
	const rationaleMatch = after.match(/[:—–-]\s*([^\s].*)$/);
	if (rationaleMatch) {
		// Require at least 8 characters of reason so a single-word
		// rationale isn't a full pass — meaningful rationale should
		// explain WHY.
		return rationaleMatch[1].trim().length >= MIN_RATIONALE_LENGTH;
	}
	// Namespaced rule spec (e.g., `foo/bar`) is substantive enough on its
	// own. Same for eslint plugins.
	if (/\b[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/.test(after)) return true;
	return false;
}

const SUPPRESSION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
	sup("\\/\\/", ["@ts", "ignore"].join("-")),
	sup("\\/\\/", ["@ts", "expect", "error"].join("-")),
	sup("\\/\\/", ["@ts", "nocheck"].join("-")),
	sup("\\/\\/", ["eslint", "disable", "next", "line"].join("-")),
	sup("\\/\\*", ["eslint", "disable"].join("-")),
	sup("\\/\\/", ["biome", "ignore"].join("-")),
	sup("\\/\\/", ["prettier", "ignore"].join("-")),
	sup("\\/\\/", "noinspection"),
	sup("\\/\\/", "noqa"),
	sup("#", "type:\\s*ignore"),
	sup("#", "nosec"),
	sup("#", "nolint"),
	sup("\\/\\/", "nolint"),
];

/**
 * Public API — consumed by `tool-results.ts`.
 *
 * Return the first suppression pattern that matches `rawLine` AND lacks a
 * rationale on `trimmedLine`. Returns null when no bare suppression is present.
 */
export function findSuppressionMatch(rawLine: string, trimmedLine: string): SuppressionMatch {
	const searchableLine = stripStringLiterals(rawLine);
	for (const { pattern, label } of SUPPRESSION_PATTERNS) {
		if (!pattern.test(searchableLine)) continue;
		if (hasSuppressionRationale(trimmedLine, label)) return null;
		return { label };
	}
	return null;
}

const MAX_SUPPRESSION_MESSAGE_LENGTH = 120;

/**
 * Public API — consumed by `tool-results.ts`.
 *
 * Walk a file's lines looking for suppression directives. Records a finding
 * ONLY when the directive lacks a rationale — directives with an explanatory
 * comment are considered reviewed. Extracted to keep the caller's
 * loop-nesting depth shallow.
 */
export function collectSuppressionFindings(
	content: string,
	relPath: string,
	out: CodeQualityIssue[],
): void {
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (trimmed.startsWith("*") || trimmed.startsWith("/**")) continue;
		const hit = findSuppressionMatch(lines[i], trimmed);
		if (!hit) continue;
		out.push({
			check: "suppressions",
			file: relPath,
			line: i + 1,
			message: `${hit.label}: ${trimmed.slice(0, MAX_SUPPRESSION_MESSAGE_LENGTH)}`,
		});
	}
}
