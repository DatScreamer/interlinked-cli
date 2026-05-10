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

/** Detect dangerouslySetInnerHTML usage — XSS risk.
 *
 * 139-repo audit (2026-05): Flexpa's `flexpa-link-react-native-example/
 * app/+html.tsx:30` was the canonical FP — `<style dangerouslySetInner
 * HTML={{ __html: responsiveBackground }} />` where `responsiveBackground`
 * is a same-file `const responsiveBackground = `body { ... }`;` literal
 * (Expo Router boilerplate). Static-CSS pattern with zero user input.
 *
 * Refinement: when the JSX expression value is a bare identifier (not a
 * member access, function call, or interpolation), check the same file
 * for a `const <id> = "..."` / `const <id> = `...`` declaration. If the
 * literal is template/string with no `${var}` interpolation, treat as
 * static — don't fire.
 */
const DSIH_INLINE_RE = /\bdangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*([A-Za-z_$][\w$]*)\s*\}\s*\}/;
const DSIH_NAKED_RE = /\bdangerouslySetInnerHTML\b/;

export function checkDangerouslySetInnerHTML(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (ext !== ".tsx" && ext !== ".jsx") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");

	const matches: InlineMatch[] = [];
	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= 10) break;
		// Use the original line for identifier extraction (we need to see
		// the variable name post-strip), but we still look at the
		// original for context. Both forms are inspected via
		// strippedLines for content-stable matching.
		if (!DSIH_NAKED_RE.test(strippedLines[i])) continue;

		// Try to extract the identifier from the `__html: <id>` shape.
		// If we find a same-file static-string declaration, suppress.
		const inline = DSIH_INLINE_RE.exec(originalLines[i]);
		if (inline?.[1] && isStaticStringConstant(content, inline[1])) {
			continue;
		}

		matches.push({
			line: i + 1,
			text: originalLines[i].trim().slice(0, 150),
		});
	}
	return matches;
}

/**
 * Return true when `name` is declared in `content` as a `const` bound
 * to a string or template literal that contains NO `${...}` (i.e. no
 * runtime interpolation). Conservative — any unclear case returns
 * false (the check fires). Only `const` is considered (not `let` /
 * `var`) because those can be reassigned.
 *
 * 139-repo audit: Expo Router boilerplate — `const responsiveBackground
 * = `body { background-color: #fff; ... }`;` is the canonical static
 * CSS template-literal pattern.
 */
function isStaticStringConstant(content: string, name: string): boolean {
	// Match `const <name> = ` followed by either a quoted string or a
	// template literal. The template literal must contain NO `${`.
	// Both forms are matched; whichever wins, decide.
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// `const NAME = "...";` / `const NAME = '...';`
	const stringRe = new RegExp(`\\bconst\\s+${escaped}\\s*=\\s*(['"])((?:\\\\.|(?!\\1).)*)\\1`);
	if (stringRe.test(content)) return true;
	// `const NAME = \`...\`;` — template literal with no interpolation.
	// Find the opening backtick after the name, then walk to the closing
	// one and verify no `${` appears in between.
	const tplOpen = new RegExp(`\\bconst\\s+${escaped}\\s*=\\s*\``);
	const m = tplOpen.exec(content);
	if (m) {
		// Find the matching backtick. Naive: walk forward from after the
		// opening backtick, ignoring escaped backticks.
		const start = m.index + m[0].length; // position immediately after the opening backtick
		let i = start;
		let depth = 0; // ${...} brace depth
		while (i < content.length) {
			const c = content[i];
			if (c === "\\") {
				i += 2;
				continue;
			}
			if (depth === 0 && c === "`") {
				// Closing backtick; success only if no `${` was seen.
				return !content.slice(start, i).includes("${");
			}
			if (c === "$" && content[i + 1] === "{") {
				depth++;
				i += 2;
				continue;
			}
			if (depth > 0 && c === "{") depth++;
			if (depth > 0 && c === "}") depth--;
			i++;
		}
	}
	return false;
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
