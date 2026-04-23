// Taste checks — part 2 of 2 (magic numbers, ternaries, flag args, commented-out code).
// Extracted from taste.ts to stay under the 800-line module ceiling.

import {
	collectFunctionSignature,
	getExtension,
	type InlineMatch,
	isTestFile,
	stripCommentsAndStrings,
} from "./shared.js";

/**
 * Detect magic numbers in logic — numeric literals without named constants.
 * `if (retries > 3)` — why 3? `setTimeout(fn, 86400000)` — what is that?
 *
 * Only flags numbers in conditionals and expressions, not declarations.
 * Skips: 0, 1, -1, 2, common HTTP status codes, powers of 2, test files,
 * array indices, and numbers in const/enum declarations.
 */
export function checkMagicNumbers(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// Numbers that are universally acceptable without a name
	const ALLOWED = new Set([
		"0",
		"1",
		"2",
		"-1",
		"-2",
		"10",
		"16",
		"100",
		"1000",
		// HTTP status codes
		"200",
		"201",
		"204",
		"301",
		"302",
		"304",
		"400",
		"401",
		"403",
		"404",
		"405",
		"409",
		"422",
		"429",
		"500",
		"502",
		"503",
		"504",
		// Powers of 2
		"8",
		"32",
		"64",
		"128",
		"256",
		"512",
		"1024",
		"2048",
		"4096",
	]);

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];
		const trimmed = line.trim();

		// Skip declarations — the number IS the named constant
		if (/^\s*(const|let|var|enum|static\s+(readonly\s+)?)\b/.test(trimmed)) continue;

		// Skip return statements returning bare numbers (often intentional)
		if (/^\s*return\s+-?\d/.test(trimmed)) continue;

		// Skip case labels
		if (/^\s*case\s+-?\d/.test(trimmed)) continue;

		// Must be in a conditional, expression, or function call context
		// (not just any line with a number)
		if (
			!/\b(if|else|while|for|switch|&&|\|\||[<>=!]+|[+\-*/%])\b/.test(trimmed) &&
			!/\w+\s*\(/.test(trimmed)
		)
			continue;

		// Find bare numeric literals
		const numPattern = /(?<![.\w])(-?\d+(?:\.\d+)?)\b/g;
		const numHits = line.matchAll(numPattern);
		let flaggedLine = false;
		for (const numMatch of numHits) {
			if (flaggedLine) break;
			const num = numMatch[1];
			if (ALLOWED.has(num)) continue;

			// Skip if it's an array index: [123]
			const before = line.slice(Math.max(0, numMatch.index! - 1), numMatch.index);
			if (before === "[") continue;

			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
			flaggedLine = true;
		}
	}

	return matches;
}

/**
 * Detect `if (!condition) { ... } else { ... }` — negated condition with else.
 * The reader must mentally double-negate. Just flip the branches.
 *
 * Only flags simple negation of a single identifier (not complex expressions).
 * Skips: if blocks without else, complex negated expressions like !(a && b).
 */
export function checkNegatedConditionWithElse(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];

		// Match: if (!identifier) or if (!identifier.property)
		if (!/\bif\s*\(\s*!\s*\w+[\w.]*\s*\)/.test(line)) continue;

		// Must have a corresponding else — scan ahead for } else
		let braceDepth = 0;
		let foundElse = false;
		let scanDone = false;
		for (let j = i; j < Math.min(i + 50, strippedLines.length) && !scanDone; j++) {
			const scanLine = strippedLines[j];
			for (let k = 0; k < scanLine.length; k++) {
				if (scanLine[k] === "{") braceDepth++;
				if (scanLine[k] === "}") {
					braceDepth--;
					// The moment the if-block closes, check for else
					if (braceDepth === 0 && (j > i || k > 0)) {
						const remaining = scanLine.slice(k + 1);
						if (/\belse\b/.test(remaining)) {
							foundElse = true;
						} else if (
							j + 1 < strippedLines.length &&
							/^\s*else\b/.test(strippedLines[j + 1])
						) {
							foundElse = true;
						}
						scanDone = true;
						break;
					}
				}
			}
		}

		if (!foundElse) continue;

		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}

	return matches;
}

/**
 * Detect nested ternary expressions.
 * `a ? b ? c : d : e` is a puzzle, not code.
 * Use if/else or extract into a function.
 */
export function checkNestedTernary(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];

		// Quick check: line must have at least 2 question marks
		const qCount = (line.match(/\?/g) || []).length;
		if (qCount < 2) continue;

		// Verify nesting: walk through and track ternary depth
		// Skip ?. (optional chaining) and generic type params <T>
		let ternaryDepth = 0;
		let maxTernaryDepth = 0;
		let inGeneric = 0;

		for (let j = 0; j < line.length; j++) {
			const ch = line[j];
			if (ch === "<") inGeneric++;
			if (ch === ">") inGeneric = Math.max(0, inGeneric - 1);
			if (inGeneric > 0) continue;

			// Skip optional chaining ?.
			if (ch === "?" && j + 1 < line.length && line[j + 1] === ".") continue;
			// Skip nullish coalescing ??
			if (ch === "?" && j + 1 < line.length && line[j + 1] === "?") {
				j++; // skip next ?
				continue;
			}

			if (ch === "?") {
				ternaryDepth++;
				maxTernaryDepth = Math.max(maxTernaryDepth, ternaryDepth);
			}
			if (ch === ":") {
				if (ternaryDepth > 0) ternaryDepth--;
			}
		}

		if (maxTernaryDepth >= 2) {
			matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
		}
	}

	return matches;
}

/**
 * Detect function signatures with 2+ boolean parameters.
 * Definition-side companion to checkBooleanTrap (which catches call sites).
 *
 * When a function has multiple boolean params, callers will always pass
 * unlabeled `true`/`false`. Use an options object instead.
 *
 * Only runs on TypeScript (requires type annotations to detect boolean params).
 * Skips test files.
 */
export function checkFlagArguments(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	// Only TS — need type annotations to detect boolean params reliably
	if (![".ts", ".tsx", ".mts", ".cts"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const lines = stripped.split("\n");
	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const funcPatterns = [
		/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/,
		/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\(/,
	];

	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = lines[i].trim();

		let funcName: string | null = null;
		for (const pat of funcPatterns) {
			const m = trimmed.match(pat);
			if (m) {
				funcName = m[1];
				break;
			}
		}
		if (!funcName) continue;

		// Collect the full signature
		const sig = collectFunctionSignature(lines, i);
		const paramMatch = sig.match(/\(([^)]*)\)/);
		if (!paramMatch) continue;

		// Count params with `: boolean` type annotation
		const params = paramMatch[1].split(",");
		let boolParamCount = 0;
		for (const p of params) {
			// Match: paramName: boolean or paramName?: boolean
			if (/:\s*boolean\s*(?:[,=)]|$)/.test(p)) {
				boolParamCount++;
			}
		}

		if (boolParamCount >= 2) {
			matches.push({
				line: i + 1,
				text: `[${boolParamCount} boolean params → use options object] ${originalLines[i].trim().slice(0, 100)}`,
			});
		}
	}

	return matches;
}

/**
 * Detect blocks of commented-out code (3+ consecutive lines).
 * Commented-out code rots, confuses grep, and makes the real code harder to scan.
 * Use version control instead of comment-preservation.
 *
 * Only flags comment blocks where >60% of lines look like code
 * (contain semicolons, braces, arrows, keywords).
 * Skips: JSDoc blocks, license headers, ASCII art, prose comments.
 */
export function checkCommentedOutCode(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".py"].includes(ext))
		return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	// Code-like tokens that indicate commented-out code rather than prose
	const codeTokens =
		/[;{}=]|=>|^\s*\/\/\s*(const|let|var|function|class|import|export|return|if|for|while|switch|try|catch)\b/;
	// JSDoc/documentation patterns to skip
	const docPattern =
		/^\s*\/\/\s*(@\w+|@param|@returns|@throws|@example|@see|@todo|TODO|FIXME|NOTE|HACK|XXX)\b/i;
	// License/header patterns
	const licensePattern = /^\s*\/\/\s*(copyright|license|MIT|Apache|BSD|GPL|all rights reserved)/i;

	const isPython = ext === ".py";
	const commentPrefix = isPython ? /^\s*#\s?/ : /^\s*\/\/\s?/;

	let blockStart = -1;
	let codeLineCount = 0;
	let totalLineCount = 0;

	for (let i = 0; i <= originalLines.length; i++) {
		if (matches.length >= 5) break;

		const line = i < originalLines.length ? originalLines[i] : "";
		const isComment = commentPrefix.test(line);

		if (isComment && !docPattern.test(line) && !licensePattern.test(line)) {
			if (blockStart === -1) {
				blockStart = i;
				codeLineCount = 0;
				totalLineCount = 0;
			}
			totalLineCount++;
			// Strip the comment prefix and check if it looks like code
			const uncommented = line.replace(commentPrefix, "");
			if (codeTokens.test(line) || /[;{}()]/.test(uncommented)) {
				codeLineCount++;
			}
		} else {
			// End of comment block — check if it was a code block
			if (blockStart !== -1 && totalLineCount >= 3) {
				const codeRatio = codeLineCount / totalLineCount;
				if (codeRatio > 0.6) {
					matches.push({
						line: blockStart + 1,
						text: `[${totalLineCount} lines of commented-out code → use version control instead]`,
					});
				}
			}
			blockStart = -1;
		}
	}

	return matches;
}
