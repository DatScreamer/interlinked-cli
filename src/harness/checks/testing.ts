// Testing-specific checks (snapshot, test-importing-test, excessive useEffect).
// Extracted from generic-checks.ts.

import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_ALL_EXTS,
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

/** Matches an `import(...)`, side-effect `import "..."`, or `require(...)`
 *  call whose path literal contains `.test.` or `.spec.`. Structural gap
 *  (unchanged from the original detector): does NOT match ES named/default
 *  import syntax (`import { x } from "./x.test.ts"`) because "import" is not
 *  immediately followed by the quote there — only the forms above are
 *  matched. */
const TEST_IMPORT_PATH_RE = /(?:import|require)\s*\(?['"]\S*\.(?:test|spec)\./;

/** A bare `import`/`require` keyword, used against the STRIPPED line to
 *  decide whether a line is live code at all. */
const IMPORT_KEYWORD_RE = /\b(?:import|require)\b/;

/**
 * Detect test files importing from other test files — extract to shared helpers.
 *
 * `stripCommentsAndStrings` blanks the CONTENTS of every string literal (so
 * `"./x.test.ts"` becomes `""`), which erases the `.test.`/`.spec.` token the
 * path regex needs — matching {@link TEST_IMPORT_PATH_RE} against the
 * stripped line can therefore never fire on well-formed code. Instead: check
 * the STRIPPED line only for the presence of the `import`/`require` keyword
 * (comment-stripping blanks whole commented-out lines, so a commented-out
 * import's keyword is gone from the stripped line and never passes this
 * gate — same for a keyword that appears only inside a string literal, since
 * that literal's entire contents are blanked too), then match the actual
 * `.test.`/`.spec.` path against the ORIGINAL line, which is the only place
 * the path substring survives.
 */
export function checkTestImportingTest(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (!JS_TS_ALL_EXTS.includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");

	const matches: InlineMatch[] = [];
	const MAX_MATCHES = 10;
	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= MAX_MATCHES) break;
		const strippedLine = strippedLines[i];
		const originalLine = originalLines[i];
		if (strippedLine === undefined || originalLine === undefined) continue;
		if (!IMPORT_KEYWORD_RE.test(strippedLine)) continue;
		if (TEST_IMPORT_PATH_RE.test(originalLine)) {
			matches.push({ line: i + 1, text: originalLine.trim().slice(0, 150) });
		}
	}
	return matches;
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
