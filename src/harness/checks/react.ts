// React / frontend checks.
// Extracted from generic-checks.ts.

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	scanLinesStripped,
	stripCommentsAndStrings,
} from "./shared.js";

// ===========================================
// React/Frontend Checks
// ===========================================

const _JS_TS_ALL_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts"];

/** Detect excessive useState hooks (8+) — consider useReducer or splitting. */
export function checkExcessiveUseState(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];

	const ext = getExtension(filePath);
	if (ext !== ".tsx" && ext !== ".jsx") return [];

	const lines = content.split("\n");
	const matches: InlineMatch[] = [];
	let count = 0;
	const WARNING_THRESHOLD = 8;

	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (/\buseState\s*[<(]/.test(trimmed)) {
			count++;
		}
	}

	if (count >= WARNING_THRESHOLD) {
		for (let i = 0; i < lines.length; i++) {
			if (/\buseState\s*[<(]/.test(lines[i].trim())) {
				matches.push({
					line: i + 1,
					text: `[${count} useState hooks — consider useReducer or splitting component] ${lines[i].trim().slice(0, 100)}`,
				});
				break;
			}
		}
	}

	return matches;
}

/** Detect dangerouslySetInnerHTML usage — XSS risk. */
export function checkDangerouslySetInnerHTML(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (ext !== ".tsx" && ext !== ".jsx") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /\bdangerouslySetInnerHTML\b/, 10);
}

/** Detect direct DOM access in React components — use useRef instead. */
export function checkDirectDomAccess(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (ext !== ".tsx" && ext !== ".jsx") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(
		originalLines,
		strippedLines,
		/\bdocument\.(getElementById|querySelector|querySelectorAll|getElementsBy)\s*\(/,
		10,
	);
}

/** Detect excessive inline object props causing unnecessary re-renders (3+). */
export function checkInlineObjectProps(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (ext !== ".tsx" && ext !== ".jsx") return [];

	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const allMatches: InlineMatch[] = [];

	const inlineObjPattern = /\w+=\{\{/;
	let count = 0;

	for (let i = 0; i < strippedLines.length; i++) {
		if (inlineObjPattern.test(strippedLines[i])) {
			count++;
			if (allMatches.length < 10) {
				allMatches.push({
					line: i + 1,
					text: lines[i].trim().slice(0, 150),
				});
			}
		}
	}

	if (count < 3) return [];

	return [
		{
			line: allMatches[0].line,
			text: `[${count} inline object props — creates new references every render, causing unnecessary re-renders. Extract to constants or useMemo] ${allMatches[0].text}`,
		},
	];
}

/** Detect async event handlers — errors silently swallowed without try/catch. */
export function checkAsyncEventHandler(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (ext !== ".tsx" && ext !== ".jsx") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /on[A-Z]\w+=\{async\s/, 10);
}
