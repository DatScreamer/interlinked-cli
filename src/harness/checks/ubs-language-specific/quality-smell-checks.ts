// UBS language-specific detectors — generic quality / code-smell checks.
// Extracted from ubs-language-specific.ts during the 1500-line decomposition.
// Each function returns InlineMatch[]. Multi-language; ext-gated per check.

import {
	getExtension,
	type InlineMatch,
	isScriptOrCliPath,
	isTestFile,
	stripCommentsAndStrings,
} from "../shared.js";
import { isJsTsFile, isPyFile, MATCH_LIMIT } from "./_shared.js";

/**
 * `ubs_string_concat_in_loop` — `result += chunk` inside a loop is O(n²) in
 * languages with immutable strings (Java, JS-pre-rope). post / warning.
 *
 * Heuristic: scan for `+=` on an identifier inside a `for`/`while` body.
 * Gates Java + JS/TS only — Python and Go are already covered by the older,
 * indent-aware `checks/performance.ts:checkStringConcatInLoop` (which uses
 * `getLoopBodies()`). Without this language gate, both detectors fire on
 * the same line with different `(name, message)` pairs and the post-event
 * dedup (which keys on `(file, line, normalizedMessage)`) won't collapse
 * them — agents see two warnings for one issue.
 */
/**
 * Names initialized to a numeric literal anywhere in the file. `n += expr` on
 * such a name is integer addition, not string building — skip it. Kills the FP
 * on byte/count accumulators (e.g. `let total = 0; total += len`). Internal.
 */
function collectNumericVars(strippedLines: string[]): Set<string> {
	const numericVars = new Set<string>();
	for (const sl of strippedLines) {
		for (const nm of sl.matchAll(/\b([A-Za-z_$]\w*)\s*=\s*-?\d/g)) {
			numericVars.add(nm[1]);
		}
	}
	return numericVars;
}

// Loop-carried state for the brace-tracked (JS/TS/Java) concat scan.
interface BraceLoopState {
	loopDepth: number;
}

/**
 * Brace-tracked arm of `checkUbsStringConcatInLoop`: advances `state.loopDepth`
 * for the current line and pushes a match when a string-building `+=` fires
 * inside a loop. Internal helper; mutates `state` and `matches`.
 */
function scanBraceConcatLine(
	line: string,
	idx: number,
	originalLines: string[],
	numericVars: Set<string>,
	state: BraceLoopState,
	matches: InlineMatch[],
): void {
	const openCount = (line.match(/\{/g) || []).length;
	const closeCount = (line.match(/\}/g) || []).length;

	if (/\b(?:for|while)\b[^{]*\{/.test(line)) {
		state.loopDepth++;
	}
	const concat =
		state.loopDepth > 0 ? line.match(/\b([A-Za-z_$]\w*)\s*\+=\s*[A-Za-z_$"'`]/) : null;
	if (concat && !numericVars.has(concat[1])) {
		matches.push({ line: idx + 1, text: originalLines[idx].trim().slice(0, 150) });
	}
	// Roughly pop loop depth when braces close — heuristic only.
	if (state.loopDepth > 0 && closeCount > openCount) {
		state.loopDepth = Math.max(0, state.loopDepth - (closeCount - openCount));
	}
}

export function checkUbsStringConcatInLoop(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const supported = ext === ".java" || isJsTsFile(ext);
	if (!supported) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	const numericVars = collectNumericVars(strippedLines);
	const state: BraceLoopState = { loopDepth: 0 };

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		scanBraceConcatLine(strippedLines[i], i, originalLines, numericVars, state, matches);
	}
	return matches;
}

/**
 * `ubs_numeric_comparison_chain` — Java `instanceof` chain or `compareTo`
 * cascade — typically a sign of missing polymorphism. Flags 3+ consecutive
 * `instanceof` lines or `compareTo` lines in the same scope. post / warning.
 */
export function checkNumericComparisonChain(content: string, filePath: string): InlineMatch[] {
	if (getExtension(filePath) !== ".java") return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// Run-length scan: if 3+ consecutive lines (allowing closing braces between)
	// contain `instanceof` or `compareTo`, flag the first line of the run.
	let runStart = -1;
	let runLen = 0;
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const has =
			/\binstanceof\b/.test(strippedLines[i]) ||
			/\bcompareTo\s*\(/.test(strippedLines[i]);
		if (has) {
			if (runStart === -1) runStart = i;
			runLen++;
		} else if (/^\s*[}\s]*$/.test(strippedLines[i])) {
			// blank or brace-only line: tolerate inside a run
		} else {
			if (runLen >= 3 && runStart !== -1) {
				matches.push({
					line: runStart + 1,
					text: originalLines[runStart].trim().slice(0, 150),
				});
			}
			runStart = -1;
			runLen = 0;
		}
	}
	if (runLen >= 3 && runStart !== -1 && matches.length < MATCH_LIMIT) {
		matches.push({
			line: runStart + 1,
			text: originalLines[runStart].trim().slice(0, 150),
		});
	}
	return matches;
}

/**
 * `ubs_print_debug_leak` — `console.log` / Python `print(...)` / Go
 * `fmt.Println` left in non-test code. Often a debug breadcrumb forgotten
 * before commit. post / warning.
 *
 * Skips test files, CLI/command files (where stdout is the product), and
 * files where the call is wrapped in `if (process.env.DEBUG)` style guards.
 */
export function checkPrintDebugLeak(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const supported =
		isJsTsFile(ext) || isPyFile(ext) || ext === ".go";
	if (!supported) return [];
	if (isTestFile(filePath)) return [];
	// CLI/commands: stdout is the product; consoleStatements check covers them.
	if (filePath.includes("/commands/") || filePath.includes("/cmd/") || filePath.includes("/bin/")) {
		return [];
	}
	// 139-repo audit: mcpbr's `scripts/sync_version.py` had 194 print()
	// hits — all CLI output. Supermodel's `cli/internal/setup/wizard.go`
	// had 13 fmt.Println — interactive setup wizard. Path-segment gate
	// covers `scripts/`, `script/`, `cli/`, `tools/`, `tool/`,
	// `tutorial[s]/` — all places where stdout IS the product.
	if (isScriptOrCliPath(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	const re = /\b(?:console\.log|print|fmt\.Println)\s*\(/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!re.test(strippedLines[i])) continue;
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

/**
 * `ubs_magic_number_no_const` — numeric literals (other than 0/1/-1/2 and
 * obvious unit conversions) used in expressions without being assigned to a
 * named constant first. post / warning.
 *
 * Heuristic: detect `<numeric-literal-3+digits>` or `<numeric>.<numeric>`
 * appearing in an expression context (not a var/const initializer). Skips
 * test files. Significant FP rate; advisory.
 */
export function checkMagicNumberNoConst(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const supported =
		isJsTsFile(ext) ||
		isPyFile(ext) ||
		ext === ".go" ||
		ext === ".java" ||
		ext === ".swift";
	if (!supported) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// 3+ digit integer or fractional numeric literal — flag if NOT preceded by
	// `const`/`let`/`var`/`final` (the assignment-to-constant case).
	// Swift uses `let`/`var` like JS; `static let` is the named-constant idiom.
	const re = /\b(?:const|let|var|final)\b\s*\w+\s*=\s*\d+/;
	const magicRe = /(?<![\w.])\d{3,}(?:\.\d+)?\b/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const line = strippedLines[i];
		if (!magicRe.test(line)) continue;
		if (re.test(line)) continue; // declaration with literal — fine
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}

// Shared body-line threshold for `ubs_large_function` (Python + C-family).
const LARGE_FUNCTION_LINE_LIMIT = 80;

/**
 * Python arm of `checkLargeFunction`: scan for `def NAME(...)`, then count
 * contiguous body lines at strictly greater indent. Internal helper.
 */
function scanPyLargeFunctions(
	strippedLines: string[],
	originalLines: string[],
): InlineMatch[] {
	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const m = strippedLines[i].match(/^(\s*)def\s+\w+\s*\(/);
		if (!m) continue;
		const headerIndent = m[1].length;
		const bodyLines = countPyBodyLines(strippedLines, i, headerIndent);
		if (bodyLines >= LARGE_FUNCTION_LINE_LIMIT) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}
	}
	return matches;
}

/**
 * Count contiguous Python body lines following a `def` at `startIdx`, counting
 * blank lines and lines indented strictly deeper than `headerIndent`. Internal.
 */
function countPyBodyLines(
	strippedLines: string[],
	startIdx: number,
	headerIndent: number,
): number {
	let bodyLines = 0;
	for (let j = startIdx + 1; j < strippedLines.length; j++) {
		const inner = strippedLines[j];
		if (inner.trim() === "") {
			bodyLines++;
			continue;
		}
		const indent = inner.search(/\S/);
		if (indent <= headerIndent) break;
		bodyLines++;
	}
	return bodyLines;
}

/**
 * C-family arm of `checkLargeFunction`: scan for function headers, then count
 * lines until the matching `}`. Heuristic; no full parser. Internal helper.
 */
function scanCFamilyLargeFunctions(
	strippedLines: string[],
	originalLines: string[],
): InlineMatch[] {
	const headerRe = /\b(?:function\s+\w+|fn\s+\w+|func\s+\w+|\w+\s*=\s*\([^)]*\)\s*=>)/;
	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		if (!headerRe.test(strippedLines[i])) continue;
		const openIdx = findOpeningBrace(strippedLines, i);
		if (openIdx === -1) continue;
		const endIdx = findBraceBalanceEnd(strippedLines, openIdx);
		if (endIdx === -1) continue;
		const bodyLines = endIdx - openIdx;
		if (bodyLines >= LARGE_FUNCTION_LINE_LIMIT) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}
	}
	return matches;
}

/**
 * Find the first line index containing `{` from `startIdx` within a 5-line
 * lookahead window. Returns -1 if none. Internal helper.
 */
function findOpeningBrace(strippedLines: string[], startIdx: number): number {
	for (let k = startIdx; k < Math.min(startIdx + 5, strippedLines.length); k++) {
		if (strippedLines[k].includes("{")) return k;
	}
	return -1;
}

/**
 * Walk forward from `openIdx`, counting braces until depth balances. Returns
 * the line index that closes the block, or -1 if unbalanced. Internal helper.
 */
function findBraceBalanceEnd(strippedLines: string[], openIdx: number): number {
	let depth = 0;
	for (let k = openIdx; k < strippedLines.length; k++) {
		const opens = (strippedLines[k].match(/\{/g) || []).length;
		const closes = (strippedLines[k].match(/\}/g) || []).length;
		depth += opens - closes;
		if (depth === 0 && k > openIdx) return k;
	}
	return -1;
}

/**
 * `ubs_large_function` — function whose body spans 80+ lines. Heuristic; uses
 * brace-counting for C-family / `def` indent for Python. post / warning.
 */
export function checkLargeFunction(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const supported =
		isJsTsFile(ext) ||
		isPyFile(ext) ||
		ext === ".go" ||
		ext === ".java" ||
		ext === ".rs" ||
		ext === ".c" ||
		ext === ".cpp" ||
		ext === ".swift";
	if (!supported) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");

	// Python uses indent-based scanning; everything else uses brace balancing.
	return isPyFile(ext)
		? scanPyLargeFunctions(strippedLines, originalLines)
		: scanCFamilyLargeFunctions(strippedLines, originalLines);
}

/**
 * `ubs_deeply_nested_callback` — JS/TS file with a callback nested 4+ levels
 * deep. Sign of callback hell that's hard to read and test. post / warning.
 *
 * Heuristic: track `function`/`=>` opener lines and count how many are open
 * at the same time using brace depth.
 */
export function checkDeeplyNestedCallback(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (!isJsTsFile(ext)) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	const NESTING_LIMIT = 4;
	let funcDepth = 0;
	let braceDepth = 0;
	const funcOpenStack: number[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const line = strippedLines[i];

		// Count function-opener occurrences on this line. We treat `function`,
		// `function (`, and `=>` as candidates.
		const funcOpens = ((line.match(/\bfunction\b|=>/g) || [])).length;
		const opens = (line.match(/\{/g) || []).length;
		const closes = (line.match(/\}/g) || []).length;

		// If this line introduces a function and opens a brace, push.
		if (funcOpens > 0 && opens > 0) {
			for (let k = 0; k < Math.min(funcOpens, opens); k++) {
				funcOpenStack.push(braceDepth);
				funcDepth++;
			}
		}

		braceDepth += opens - closes;

		// Pop funcs whose entry depth is now ≥ current.
		while (funcOpenStack.length > 0 && funcOpenStack[funcOpenStack.length - 1] >= braceDepth) {
			funcOpenStack.pop();
			funcDepth = funcOpenStack.length;
		}

		if (funcDepth >= NESTING_LIMIT) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}
	}
	return matches;
}

/**
 * `ubs_time_format_locale_dep` — `Date.toLocaleString()` (JS) /
 * `DateTimeFormatter.ofLocalizedXxx` (Java) without an explicit locale.
 * Locale-dependent formatting drifts by environment. post / warning.
 */
export function checkTimeFormatLocaleDep(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	const supported = isJsTsFile(ext) || ext === ".java";
	if (!supported) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// JS: toLocaleString / toLocaleDateString / toLocaleTimeString called with no args.
	const jsRe = /\.toLocale(?:String|DateString|TimeString)\s*\(\s*\)/;
	// Java: DateTimeFormatter.ofLocalizedDate(...) without `.withLocale(`.
	const javaRe = /\bDateTimeFormatter\.ofLocalized\w+\s*\([^)]*\)(?!\s*\.withLocale)/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= MATCH_LIMIT) break;
		const line = strippedLines[i];
		if (ext === ".java" ? !javaRe.test(line) : !jsRe.test(line)) continue;
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}
	return matches;
}
