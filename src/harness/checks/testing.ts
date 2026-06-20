// Testing-specific checks (snapshot, test-importing-test, excessive useEffect).
// Extracted from generic-checks.ts.

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_ALL_EXTS,
	scanLinesStripped,
	stripCommentsAndStrings,
} from "./shared.js";

// ===========================================
// Testing Checks
// ===========================================

/** Detect excessive snapshot assertions (5+) — use explicit assertions instead. */
export function checkSnapshotOveruse(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const lines = content.split("\n");
	const allMatches: InlineMatch[] = [];
	const THRESHOLD = 5;

	for (const [i, line] of lines.entries()) {
		if (
			/\btoMatchSnapshot\s*\(/.test(line) ||
			/\btoMatchInlineSnapshot\s*\(/.test(line)
		) {
			allMatches.push({
				line: i + 1,
				text: line.trim().slice(0, 150),
			});
		}
	}

	if (allMatches.length < THRESHOLD) return [];

	const first = nonNull(allMatches[0]);
	return [
		{
			line: first.line,
			text: `[${allMatches.length} snapshot assertions — snapshots test nothing meaningful. Use explicit assertions] ${first.text}`,
		},
	];
}

/** Detect test files importing from other test files — extract to shared helpers. */
export function checkTestImportingTest(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(
		originalLines,
		strippedLines,
		/(?:import|require)\s*\(?['"]\S*\.(?:test|spec)\./,
		10,
	);
}

/**
 * Detect components with too many useEffect hooks — a sign the effects
 * should be consolidated into custom hooks or the component should be split.
 *
 * Threshold: 6+ useEffect calls triggers a warning.
 * Only fires on .tsx/.jsx files (React components). Skips test files.
 */
export function checkExcessiveUseEffect(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];

	const ext = getExtension(filePath);
	if (ext !== ".tsx" && ext !== ".jsx") return [];

	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	let count = 0;
	const WARNING_THRESHOLD = 6;

	for (const line of lines) {
		const trimmed = line.trim();
		if (/\buseEffect\s*\(/.test(trimmed)) {
			count++;
		}
	}

	if (count >= WARNING_THRESHOLD) {
		// Report the first useEffect line as the anchor with the total count
		for (const [i, line] of lines.entries()) {
			if (/\buseEffect\s*\(/.test(line.trim())) {
				matches.push({
					line: i + 1,
					text: `[${count} useEffect hooks — consider custom hooks or consolidating] ${line.trim().slice(0, 100)}`,
				});
				break;
			}
		}
	}

	return matches;
}
