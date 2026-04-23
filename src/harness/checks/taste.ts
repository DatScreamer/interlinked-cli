// Taste checks — opinionated code quality (naming, complexity, design smells).
// Extracted from generic-checks.ts.

import {
	collectFunctionSignature,
	countTopLevelCommas,
	getExtension,
	type InlineMatch,
	isTestFile,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";

// ===========================================
// Taste Checks — Opinionated Code Quality
// ===========================================
// These checks encode design opinions, not correctness rules.
// Each flags a pattern that makes code harder to understand, maintain,
// or extend — even when technically correct. They run as PostToolUse
// suggestions and should produce actionable guidance.

/**
 * Detect function calls with 2+ boolean literal arguments at the top level.
 * `createUser("alice", true, false)` forces readers to jump to the definition
 * to understand what those booleans mean.
 *
 * Suggests using an options object instead:
 *   `createUser("alice", { admin: true, verified: false })`
 *
 * Only runs on JS/TS files. Skips test files.
 */
export function checkBooleanTrap(content: string, filePath: string): InlineMatch[] {
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

		// Must have a function call on this line
		if (!/\w\s*\(/.test(line)) continue;

		// Count boolean literals at top-level argument positions
		if (countTopLevelBooleanArgs(line) < 2) continue;

		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}

	return matches;
}

/** Count boolean literal arguments at the top level of any function call on a line */
function countTopLevelBooleanArgs(line: string): number {
	let maxBoolCount = 0;
	const callPattern = /\w\s*\(/g;

	for (
		let callMatch = callPattern.exec(line);
		callMatch !== null;
		callMatch = callPattern.exec(line)
	) {
		const start = callMatch.index + callMatch[0].length;
		let depth = 0;
		let boolCount = 0;
		let argStart = start;

		for (let j = start; j < line.length; j++) {
			const ch = line[j];
			if (ch === "(" || ch === "[" || ch === "{") {
				depth++;
			} else if (ch === ")" || ch === "]" || ch === "}") {
				if (depth === 0) {
					const arg = line.slice(argStart, j).trim();
					if (arg === "true" || arg === "false") boolCount++;
					break;
				}
				depth--;
			} else if (ch === "," && depth === 0) {
				const arg = line.slice(argStart, j).trim();
				if (arg === "true" || arg === "false") boolCount++;
				argStart = j + 1;
			}
		}

		maxBoolCount = Math.max(maxBoolCount, boolCount);
	}

	return maxBoolCount;
}

/**
 * Detect functions with more than 4 parameters (taste threshold).
 * Long parameter lists indicate the function either does too much
 * or needs an options object.
 *
 * Distinct from checkFunctionComplexity (which flags >=6 as complexity).
 * This is a lower threshold for design taste.
 *
 * Skips: test files, destructured single-param functions, Go (threshold 6).
 */
export function checkFunctionArity(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	const matches: InlineMatch[] = [];
	const lines = content.split("\n");

	const isGo = ext === ".go";
	const threshold = isGo ? 6 : 5; // Go idiomatically uses more params

	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".go", ".rs"].includes(ext))
		return [];

	const funcPatterns = [
		/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/,
		/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\(/,
		/func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/,
		/(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/,
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

		const paramSig = collectFunctionSignature(lines, i);
		const paramMatch = paramSig.match(/\(([^)]*)\)/);
		if (!paramMatch) continue;

		const paramStr = paramMatch[1].trim();
		if (paramStr.length === 0) continue;

		// Skip destructured single-param: function f({ a, b, c, d, e })
		if (/^\s*\{/.test(paramStr) && countTopLevelCommas(paramStr) === 1) continue;
		// Also skip if only param is an object pattern (no top-level commas outside braces)
		if (/^\s*\{[^}]*\}\s*$/.test(paramStr)) continue;

		const paramCount = countTopLevelCommas(paramStr);
		if (paramCount >= threshold) {
			matches.push({
				line: i + 1,
				text: `[${paramCount} params → consider options object] ${trimmed.slice(0, 100)}`,
			});
		}
	}

	return matches;
}

/**
 * Detect variable declarations with semantically empty names.
 * Names like `data`, `result`, `temp`, `val` carry no information about
 * what they hold — the reader must infer from context.
 *
 * Only flags const/let/var declarations (not parameters or properties).
 * Skips: test files, short functions (<=5 lines), variables with type annotations,
 * immediately-returned variables.
 */
export function checkNarrativeNaming(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	const BLOCKLIST = /^(data|result|temp|tmp|val|value|obj|item|stuff|thing|info|ret|output)$/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const line = strippedLines[i];

		// Match: const/let/var <name> = (without type annotation providing context)
		const declMatch = line.match(/\b(?:const|let|var)\s+(\w+)\s*(?::\s*(\S+))?\s*=/);
		if (!declMatch) continue;

		const varName = declMatch[1];
		const typeAnnotation = declMatch[2];

		if (!BLOCKLIST.test(varName)) continue;

		// Skip if there's a meaningful type annotation (the type provides context)
		if (typeAnnotation && !/^(any|unknown|string|number|boolean|object)$/.test(typeAnnotation))
			continue;

		// Skip if the variable is immediately returned on the next line
		if (
			i + 1 < strippedLines.length &&
			strippedLines[i + 1].trim().startsWith(`return ${varName}`)
		)
			continue;

		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}

	return matches;
}

/**
 * Detect vague or tautological test descriptions.
 * `it("works")` or `test("should work correctly")` tells you nothing
 * when the test fails at 2am.
 *
 * Flags descriptions that are:
 * - Too short (<10 characters)
 * - Composed entirely of noise words
 * - Tautological ("test the function", "it works")
 *
 * Only runs on test files. Skips it.skip, it.todo, xit, xtest.
 */
export function checkTestDescriptionQuality(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const originalLines = content.split("\n");
	const matches: InlineMatch[] = [];

	const NOISE_WORDS = new Set([
		"work",
		"works",
		"working",
		"correct",
		"correctly",
		"proper",
		"properly",
		"right",
		"good",
		"fine",
		"ok",
		"okay",
		"handle",
		"handles",
		"test",
		"tests",
		"testing",
		"it",
		"should",
		"does",
		"the",
		"a",
		"an",
		"is",
		"be",
		"do",
		"can",
		"will",
		"basic",
		"simple",
		"stuff",
		"things",
		"function",
		"method",
		"check",
		"verify",
	]);

	// Match it("..."), test("..."), describe("...")
	const testPattern = /\b(?:it|test|describe)\s*\(\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/;
	// Skip skipped/todo tests
	const skipPattern = /\b(?:it|test|describe)\s*\.\s*(?:skip|todo|only)\s*\(/;
	const xPattern = /\b(?:xit|xtest|xdescribe)\s*\(/;

	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= 10) break;
		const line = originalLines[i];
		const trimmed = line.trim();

		if (skipPattern.test(trimmed) || xPattern.test(trimmed)) continue;

		const m = trimmed.match(testPattern);
		if (!m) continue;

		const desc = (m[1] || m[2] || m[3]).trim();

		// Too short
		if (desc.length < 10) {
			matches.push({
				line: i + 1,
				text: `[vague test name: "${desc}"] ${trimmed.slice(0, 120)}`,
			});
			continue;
		}

		// All noise words
		const words = desc
			.toLowerCase()
			.replace(/[^a-z\s]/g, "")
			.split(/\s+/)
			.filter((w) => w.length > 0);
		if (words.length > 0 && words.every((w) => NOISE_WORDS.has(w))) {
			matches.push({
				line: i + 1,
				text: `[vague test name: "${desc}"] ${trimmed.slice(0, 120)}`,
			});
		}
	}

	return matches;
}

/**
 * Detect catch blocks that silently swallow errors by returning a default value.
 * Extends checkSilentCatch — that flags empty catch blocks, this catches the
 * more insidious pattern where the error is discarded via a default return.
 *
 * `catch(e) { return null }` pretends everything is fine.
 * At minimum, log the error or rethrow.
 *
 * Skips: catch blocks with logging/rethrow, catch blocks with explanatory comments.
 */
export function checkCatchAndIgnore(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const originalLines = content.split("\n");
	const strippedLines = stripComments(content).split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;

		// Find catch blocks
		if (!/\bcatch\s*(?:\([^)]*\))?\s*\{/.test(strippedLines[i])) continue;

		// Find the catch block's opening brace (skip the } from try block)
		const catchLine = strippedLines[i];
		const catchIdx = catchLine.search(/\bcatch\b/);
		const catchOpenBrace = catchLine.indexOf("{", catchIdx);

		// Collect the catch body (up to 8 lines)
		const bodyLines: string[] = [];
		const originalBodyLines: string[] = [];
		let braceDepth = 0;
		let started = false;

		for (let j = i; j < Math.min(i + 8, strippedLines.length); j++) {
			const line = strippedLines[j];
			const startCol = j === i ? catchOpenBrace : 0;
			for (let k = startCol; k < line.length; k++) {
				if (line[k] === "{") {
					started = true;
					braceDepth++;
				}
				if (line[k] === "}") braceDepth--;
			}
			if (started) {
				bodyLines.push(j === i ? line.slice(catchOpenBrace) : line);
				originalBodyLines.push(
					j === i ? originalLines[j].slice(catchOpenBrace) : originalLines[j],
				);
			}
			if (started && braceDepth === 0) break;
		}

		const bodyText = bodyLines.join("\n");
		const originalBodyText = originalBodyLines.join("\n");

		// Skip if body has logging, rethrowing, or emitting
		// Use loose prefix matching so reportError, logWarning, etc. are caught
		if (
			/\b(console\.\w+|log\w*|logger|throw|emit|warn\w*|error|report\w*|notify)\b/i.test(
				bodyText,
			)
		)
			continue;

		// Skip if original body has explanatory comments
		if (/\/\/|\/\*/.test(originalBodyText)) continue;

		// Check if body is just a return of a default value
		const returnMatch = bodyText.match(
			/\breturn\s+(null|undefined|false|true|''|""|``|\[\]|\{\}|0|-1|void\s+0)\s*;?\s*\}?\s*$/,
		);
		if (!returnMatch) continue;

		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}

	return matches;
}

/**
 * Detect files that export too many symbols relative to their size (god files).
 * A file that's long AND exports many symbols is trying to be a library in a file.
 *
 * Heuristic: exportCount >= 5 AND lineCount >= 300 AND exportCount * lineCount > 3000
 *
 * Skips: barrel/index files (mostly re-exports), .d.ts, test files, generated files.
 * Only counts value exports (functions, classes, consts) — type-only exports don't count.
 */
export function checkGodFile(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (filePath.endsWith(".d.ts")) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const lines = content.split("\n");
	const lineCount = lines.length;
	if (lineCount < 300) return [];

	// Skip generated files
	const header = lines.slice(0, 5).join("\n");
	if (/@generated|auto-generated|DO NOT EDIT/i.test(header)) return [];

	// Count value exports (not type/interface exports)
	let valueExportCount = 0;
	let reExportCount = 0;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("export")) continue;

		// Re-exports: export { ... } from or export * from
		if (/^export\s+(\{[^}]*\}\s+from|type\s+\{[^}]*\}\s+from|\*\s+from)/.test(trimmed)) {
			reExportCount++;
			continue;
		}

		// Type-only exports: export type/interface/enum
		if (/^export\s+(type|interface)\s/.test(trimmed)) continue;

		// Value exports
		if (
			/^export\s+(function|async\s+function|const|let|var|class|default|enum)\b/.test(trimmed)
		) {
			valueExportCount++;
		}
	}

	// Skip barrel files (>80% re-exports)
	const totalExports = valueExportCount + reExportCount;
	if (totalExports > 0 && reExportCount / totalExports > 0.8) return [];

	if (valueExportCount < 5) return [];
	if (valueExportCount * lineCount <= 3000) return [];

	return [
		{
			line: 1,
			text: `[god file: ${lineCount} lines, ${valueExportCount} value exports → consider splitting into a directory]`,
		},
	];
}
