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
 * Detect function signatures with a positional optional boolean parameter.
 *
 * `function setUser(name: string, force?: boolean)` — callers write
 * `setUser("alice", true)` and a cold reader can't tell what `true` means
 * without jumping to the definition. This is the signature-side twin of
 * `checkBooleanTrap`, which fires at call sites with 2+ literal booleans.
 * The signature-level catch is broader: a single positional optional
 * boolean is still opaque at every call site, even when only one bool is
 * passed.
 *
 * Fires on three shapes:
 *   - `flag?: boolean`              (TS optional marker)
 *   - `flag: boolean = false`       (typed default)
 *   - `flag = false`                (inferred default)
 *
 * Skips:
 *   - Booleans inside an options-object parameter (`opts: { flag?: boolean }`)
 *     — splitTopLevelParams treats the object as one param.
 *   - Required positional booleans (`flag: boolean`) — checkBooleanTrap
 *     catches the multi-arg form at call sites.
 *   - Union types (`flag?: boolean | null`) — kept narrow to avoid FP on
 *     genuinely tri-state configs.
 *   - Test files, non-JS/TS files.
 */
export function checkPositionalOptionalBoolean(
	content: string,
	filePath: string,
): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = strippedLines[i].trim();
		if (!JS_TS_FUNC_PATTERNS.some((pat) => pat.test(trimmed))) continue;

		const sig = collectFunctionSignature(strippedLines, i);
		const paramStr = extractParamStr(sig);
		if (paramStr === null) continue;

		const params = splitTopLevelParams(paramStr);
		for (const raw of params) {
			const offender = findPositionalOptionalBoolean(raw);
			if (offender !== null) {
				matches.push({
					line: i + 1,
					text: `[positional optional boolean: ${offender}] ${originalLines[i].trim().slice(0, 120)}`,
				});
				break; // one match per function is enough
			}
		}
	}

	return matches;
}

/**
 * Detect function signatures with 3+ optional parameters.
 *
 * Each optional param doubles the call-shape surface: N optionals = 2^N
 * call shapes that nobody tests in combination, and a default change is a
 * silent semantic API break. The cure is an options object — one param,
 * named fields, defaults visible at the schema level.
 *
 * "Optional" = `?:` (TS optional marker) OR `=` default value at top level
 * within the param's expression. Rest params (`...args`) are excluded —
 * one rest is a single knob (variadic), not a combinatorial knob.
 *
 * Skips: test files, non-JS/TS files. Distinct from `checkFunctionArity`,
 * which counts total params regardless of optionality.
 */
export function checkManyOptionalParams(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = strippedLines[i].trim();
		if (!JS_TS_FUNC_PATTERNS.some((pat) => pat.test(trimmed))) continue;

		const sig = collectFunctionSignature(strippedLines, i);
		const paramStr = extractParamStr(sig);
		if (paramStr === null) continue;

		const params = splitTopLevelParams(paramStr);
		const optionalCount = params.filter((p) => isOptionalParam(p)).length;
		if (optionalCount >= 3) {
			matches.push({
				line: i + 1,
				text: `[${optionalCount} optional params → consider options object] ${originalLines[i].trim().slice(0, 100)}`,
			});
		}
	}

	return matches;
}

// === Shared helpers: positional_optional_boolean + many_optional_params ===

const JS_TS_FUNC_PATTERNS: RegExp[] = [
	/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/,
	/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\(/,
];

/** Extract the (...) body from a collected function signature. Skips a leading <generic> block. */
function extractParamStr(sig: string): string | null {
	let angleDepth = 0;
	let start = -1;
	for (let i = 0; i < sig.length; i++) {
		const ch = sig[i];
		if (ch === "<") angleDepth++;
		else if (ch === ">") angleDepth--;
		else if (ch === "(" && angleDepth === 0) {
			start = i;
			break;
		}
	}
	if (start === -1) return null;
	let depth = 0;
	for (let i = start; i < sig.length; i++) {
		const ch = sig[i];
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return sig.slice(start + 1, i);
		}
	}
	return null;
}

/** Split a parameter string at top-level commas, respecting <>(){}[]. */
function splitTopLevelParams(paramStr: string): string[] {
	const result: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < paramStr.length; i++) {
		const ch = paramStr[i];
		if (ch === "<" || ch === "(" || ch === "{" || ch === "[") depth++;
		else if (ch === ">" || ch === ")" || ch === "}" || ch === "]") depth--;
		else if (ch === "," && depth === 0) {
			result.push(paramStr.slice(start, i));
			start = i + 1;
		}
	}
	result.push(paramStr.slice(start));
	return result.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Return the param name if this is a positional optional boolean, else null. */
function findPositionalOptionalBoolean(param: string): string | null {
	const stripped = param.replace(/^(public|private|protected|readonly|static)\s+/, "").trim();
	if (stripped.startsWith("{") || stripped.startsWith("[") || stripped.startsWith("...")) {
		return null;
	}
	const idMatch = stripped.match(/^(\w+)([\s\S]*)$/);
	if (!idMatch) return null;
	const name = idMatch[1];
	const rest = idMatch[2].trim();
	// `?: boolean` (no union — narrow to avoid FP on tri-state configs)
	if (/^\?\s*:\s*boolean\s*$/.test(rest)) return name;
	// `: boolean = (true|false)`
	if (/^:\s*boolean\s*=\s*(?:true|false)\s*$/.test(rest)) return name;
	// `= (true|false)` (no annotation — TS infers boolean from literal)
	if (/^=\s*(?:true|false)\s*$/.test(rest)) return name;
	return null;
}

/** True if a param string is optional (TS `?:` marker or top-level `=` default). Rest params excluded. */
function isOptionalParam(param: string): boolean {
	const stripped = param.replace(/^(public|private|protected|readonly|static)\s+/, "").trim();
	if (stripped.startsWith("...")) return false;
	let depth = 0;
	for (let i = 0; i < stripped.length; i++) {
		const ch = stripped[i];
		if (ch === "<" || ch === "(" || ch === "{" || ch === "[") depth++;
		else if (ch === ">" || ch === ")" || ch === "}" || ch === "]") depth--;
		else if (depth === 0) {
			if (ch === "?" && stripped[i + 1] === ":") return true;
			// `=` (default) — but not `=>` (arrow type) or `==` (comparison, shouldn't appear in a param)
			if (ch === "=" && stripped[i + 1] !== ">" && stripped[i + 1] !== "=") return true;
		}
	}
	return false;
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
// God-file thresholds (kept inline so the heuristic is auditable in one place).
const GOD_FILE_MIN_LINES = 300;
const GOD_FILE_MIN_VALUE_EXPORTS = 5;
const GOD_FILE_EXPORTS_X_LINES_THRESHOLD = 3000;
const GOD_FILE_BARREL_REEXPORT_RATIO = 0.8;

export function checkGodFile(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	if (filePath.endsWith(".d.ts")) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const lines = content.split("\n");
	const lineCount = lines.length;
	if (lineCount < GOD_FILE_MIN_LINES) return [];

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

	// Skip barrel files: re-exports dominate the file. `totalExports > 0` guards
	// the division — checked before reaching the ratio comparison.
	const totalExports = valueExportCount + reExportCount;
	if (
		totalExports > 0 &&
		reExportCount / totalExports > GOD_FILE_BARREL_REEXPORT_RATIO
	) {
		return [];
	}

	if (valueExportCount < GOD_FILE_MIN_VALUE_EXPORTS) return [];
	if (valueExportCount * lineCount <= GOD_FILE_EXPORTS_X_LINES_THRESHOLD) return [];

	return [
		{
			line: 1,
			text: `[god file: ${lineCount} lines, ${valueExportCount} value exports → consider splitting into a directory]`,
		},
	];
}
