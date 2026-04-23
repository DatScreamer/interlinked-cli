// Focused tests check (committed .only / fdescribe / fit).
// Extracted from generic-checks.ts.

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_ALL_EXTS,
	scanLinesStripped,
	stripCommentsAndStrings,
} from "./shared.js";

// ===========================================
// Focused Tests — committed .only / fdescribe / fit that skip all other tests
// ===========================================

/**
 * Detect committed `.only` / focused-test markers that cause CI to run a
 * subset of the suite and silently skip the rest. These must never land on
 * main — they're the single worst gaming vector for test coverage.
 *
 * Patterns:
 *   it.only(, test.only(, describe.only(, context.only(
 *   fit(, fdescribe(, fcontext(, ftest(
 */
export function checkFocusedTests(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(
		originalLines,
		strippedLines,
		/\b(?:it|test|describe|context)\.only\s*\(|\b(?:fit|fdescribe|fcontext|ftest)\s*\(/,
		15,
	);
}
