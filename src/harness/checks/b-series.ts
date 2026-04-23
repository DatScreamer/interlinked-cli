// B-Series PostToolUse inline checks.
// Extracted from generic-checks.ts.

import {
	getExtension,
	type InlineMatch,
	isTestFile,
	scanLinesStripped,
	stripComments,
	stripCommentsAndStrings,
} from "./shared.js";

// ===========================================
// B-Series PostToolUse Inline Checks
// ===========================================

/**
 * Detect unreachable code after return/throw/break/continue.
 * Non-empty lines at the same or deeper indent level after a control flow statement.
 * Returns up to 10 matches.
 */
export function checkUnreachableCode(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];
	// Skip .d.ts files — property names like `return?:` are not control flow
	if (filePath.endsWith(".d.ts")) return [];

	const stripped = stripCommentsAndStrings(content);
	const lines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length - 1; i++) {
		if (matches.length >= 10) break;
		const trimmed = strippedLines[i].trim();
		// Match return/throw/break/continue that end a statement
		if (!/^(return\b|throw\b|break\s*;|continue\s*;)/.test(trimmed)) continue;

		// Skip property declarations in interfaces/objects (e.g., `return?: Handler`)
		if (/^return\s*[?:]/.test(trimmed)) continue;

		// Skip multi-line statements — a return/throw that doesn't end with ; or
		// that ends with ( , { [ + is a continuation, not a completed statement.
		// Only flag when the statement clearly terminates on this line.
		if (/^return\b/.test(trimmed) || /^throw\b/.test(trimmed)) {
			// "return;" or "return value;" — must end with ;
			// Skip if line ends with open paren/bracket/brace/comma/operator (multi-line)
			if (/[([{,+\-|&?:]$/.test(trimmed)) continue;
			// Skip if line doesn't end with ; (statement continues on next line)
			if (!trimmed.endsWith(";")) continue;
		}

		// Get indent level of current line
		const indent = strippedLines[i].search(/\S/);
		if (indent < 0) continue;
		// Check next non-empty line
		for (let j = i + 1; j < strippedLines.length && j <= i + 3; j++) {
			const nextTrimmed = strippedLines[j].trim();
			if (!nextTrimmed) continue;
			// Closing brace is fine
			if (nextTrimmed === "}" || nextTrimmed === "};") break;
			// Case/default labels are fine
			if (/^(case\s|default\s*:)/.test(nextTrimmed)) break;
			const nextIndent = strippedLines[j].search(/\S/);
			if (nextIndent >= indent) {
				matches.push({
					line: j + 1,
					text: lines[j].trim().slice(0, 150),
				});
			}
			break;
		}
	}

	return matches;
}

/**
 * Detect empty catch blocks that silently swallow errors.
 * `catch (e) {}` or `catch {}` with no content.
 */
export function checkSilentCatch(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const pattern = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/;
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		if (!pattern.test(strippedLines[i])) continue;
		// Check the original (pre-strip) line: if the catch block has a comment
		// between the braces, it's an intentional empty catch — don't flag it.
		// e.g. catch (e) { /* expected */ } or catch { // optional }
		const original = originalLines[i];
		if (/\bcatch\s*(?:\([^)]*\))?\s*\{[^}]*(?:\/\/|\/\*)/.test(original)) continue;
		// Also check the next line for a comment inside the catch block
		if (i + 1 < originalLines.length && /^\s*(\/\/|\/\*)/.test(originalLines[i + 1])) {
			// Multi-line catch with comment body: catch (e) {\n  // reason\n}
			if (/\bcatch\s*(?:\([^)]*\))?\s*\{\s*$/.test(originalLines[i])) continue;
		}
		matches.push({ line: i + 1, text: originalLines[i].trim().slice(0, 150) });
	}

	return matches;
}

/**
 * Detect test blocks without assertions.
 * `it(` or `test(` blocks without `expect(`, `assert(`, or `.should.`.
 * Only runs on test files.
 */
export function checkAssertionFreeTests(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];

	const matches: InlineMatch[] = [];
	const lines = content.split("\n");
	let inTestBlock = false;
	let testStartLine = 0;
	let braceDepth = 0;
	let hasAssertion = false;
	let testName = "";

	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();

		if (!inTestBlock) {
			const testMatch = trimmed.match(/^(?:it|test)\s*\(/);
			if (testMatch) {
				inTestBlock = true;
				testStartLine = i;
				braceDepth = 0;
				hasAssertion = false;
				testName = trimmed.slice(0, 80);
				// Count braces on the opening line (arrow function body brace)
				for (const ch of lines[i]) {
					if (ch === "{") braceDepth++;
					if (ch === "}") braceDepth--;
				}
			}
			continue;
		}

		// Count braces
		for (const ch of lines[i]) {
			if (ch === "{") braceDepth++;
			if (ch === "}") braceDepth--;
		}

		// Check for assertions
		if (
			/\b(expect|assert)\s*\(/.test(trimmed) ||
			/\.should\./.test(trimmed) ||
			/\bthrows\s*\(/.test(trimmed)
		) {
			hasAssertion = true;
		}

		// End of test block
		if (braceDepth <= 0 && inTestBlock && i > testStartLine) {
			if (!hasAssertion && matches.length < 10) {
				matches.push({
					line: testStartLine + 1,
					text: testName,
				});
			}
			inTestBlock = false;
		}
	}

	return matches;
}

/**
 * Detect trivial/tautological assertions that pass without testing anything meaningful.
 * Examples: expect(true).toBe(true), expect(1).toBe(1), expect("a").toEqual("a")
 * These are a gaming vector — the test has assertions but asserts nothing about the code.
 */
export function checkTrivialAssertions(content: string, filePath: string): InlineMatch[] {
	if (!isTestFile(filePath)) return [];

	const matches: InlineMatch[] = [];
	const lines = content.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();

		// Match expect(LITERAL).toBe(LITERAL) or .toEqual(LITERAL) where both literals are identical
		const m = trimmed.match(
			/expect\(\s*(true|false|null|undefined|\d+|'[^']*'|"[^"]*")\s*\)\s*\.(?:toBe|toEqual|toStrictEqual)\(\s*(true|false|null|undefined|\d+|'[^']*'|"[^"]*")\s*\)/,
		);
		if (m) {
			const left = m[1].replace(/['"]/g, "");
			const right = m[2].replace(/['"]/g, "");
			if (left === right) {
				matches.push({
					line: i + 1,
					text: `Tautological assertion: expect(${m[1]}).toBe(${m[2]}) always passes. Assert on actual code behavior instead.`,
				});
			}
		}

		// Match expect(true), expect(false) with .toBeTruthy/.toBeFalsy
		if (/expect\(\s*true\s*\)\.toBeTruthy\(\)/.test(trimmed)) {
			matches.push({
				line: i + 1,
				text: "Tautological assertion: expect(true).toBeTruthy() always passes.",
			});
		}
		if (/expect\(\s*false\s*\)\.toBeFalsy\(\)/.test(trimmed)) {
			matches.push({
				line: i + 1,
				text: "Tautological assertion: expect(false).toBeFalsy() always passes.",
			});
		}

		// Match assert(true), assert.ok(true)
		if (
			/\bassert\s*\(\s*true\s*\)/.test(trimmed) ||
			/\bassert\.ok\s*\(\s*true\s*\)/.test(trimmed)
		) {
			matches.push({
				line: i + 1,
				text: "Tautological assertion: assert(true) always passes.",
			});
		}
	}

	return matches;
}

/**
 * Detect files with high suppression directive density.
 * A file where >2% of lines are @ts-expect-error / eslint-disable / biome-ignore
 * indicates systematic suppression rather than targeted exception handling.
 */
export function checkSuppressionDensity(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];

	const lines = content.split("\n");
	if (lines.length < 20) return []; // Too small to judge density

	const pattern = /@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable|biome-ignore/;
	let count = 0;
	for (const line of lines) {
		if (pattern.test(line)) count++;
	}

	const density = count / lines.length;
	if (density > 0.02 && count >= 3) {
		return [
			{
				line: 1,
				text: `High suppression density: ${count} directives in ${lines.length} lines (${(density * 100).toFixed(1)}%). Fix the underlying issues instead of suppressing them.`,
			},
		];
	}

	return [];
}

/**
 * Detect hardcoded credentials in source code.
 * Patterns like `password = "..."`, `apiKey = "..."` with literal string values.
 */
/** Prefixes/values that indicate placeholder/demo data, not real secrets */
const SAFE_VALUE_PREFIXES = [
	"example",
	"test",
	"mock",
	"demo",
	"placeholder",
	"changeme",
	"your-",
	"your_",
	"xxx",
	"dummy",
	"fake",
	"sample",
	"replace",
	"insert",
	"todo",
	"fixme",
];
const SAFE_VALUE_EXACT = new Set([
	"disabled",
	"none",
	"null",
	"undefined",
	"empty",
	"redacted",
	"change_me",
	"change-me",
	"password",
	"secret",
]);

/** Variable name suffixes that indicate the variable describes a credential, not holds one */
const DESCRIPTIVE_SUFFIX_RE =
	/(?:Pattern|Regex|Format|Validator|Schema|Label|Field|Name|Header|Hint|Placeholder|Rule|Length|Min|Max|Type|Key|Column|Prop|Attr)$/i;

/** Values that are type annotations / schema definitions, not secret values */
const TYPE_ANNOTATION_RE =
	/^(?:z\.|string|String|number|Number|boolean|Boolean|Buffer|Uint8Array|any|unknown|object)/;

export function checkHardcodedCredentials(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java"].includes(ext))
		return [];

	const stripped = stripComments(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");

	const credPattern =
		/\b(password|passwd|secret|api_?key|api_?secret|auth_?token|access_?token|private_?key)(\w*)\s*[:=]\s*["']([^"']{4,})["']/i;

	const matches: InlineMatch[] = [];
	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const m = strippedLines[i].match(credPattern);
		if (!m) continue;

		const varSuffix = m[2]; // e.g., "Validator" from "passwordValidator"
		const value = m[3]; // the string value between quotes
		const valueLower = value.toLowerCase();

		// Skip if variable name has a descriptive suffix (passwordPattern, secretName, etc.)
		if (varSuffix && DESCRIPTIVE_SUFFIX_RE.test(varSuffix)) continue;

		// Skip known placeholder/demo values
		if (SAFE_VALUE_EXACT.has(valueLower)) continue;
		if (SAFE_VALUE_PREFIXES.some((p) => valueLower.startsWith(p))) continue;

		// Skip type annotations and schema definitions (z.string(), string, etc.)
		if (TYPE_ANNOTATION_RE.test(value)) continue;

		matches.push({
			line: i + 1,
			text: originalLines[i].trim().slice(0, 150),
		});
	}
	return matches;
}

/**
 * Detect parseInt() calls without the radix parameter.
 * `parseInt(x)` without second argument can produce unexpected results.
 */
export function checkParseIntRadix(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, /\bparseInt\s*\(\s*[^,)]+\s*\)/, 10);
}

/**
 * Detect floating point equality comparisons.
 * `=== 0.1` or `!== 3.14` — floating point comparisons are unreliable.
 * Skips values exactly representable in IEEE 754 binary64 (e.g., 0.0, 0.5, 1.0).
 */
const SAFE_FLOAT_VALUES = new Set([
	"0.0",
	"0.5",
	"1.0",
	"1.5",
	"2.0",
	"3.0",
	"4.0",
	"5.0",
	"0.25",
	"0.75",
	"0.125",
	"0.375",
	"0.625",
	"0.875",
]);

export function checkFloatEquality(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");

	const floatCompare = /[!=]==?\s*(\d+\.\d+)\b|\b(\d+\.\d+)\s*[!=]==?/;
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const m = strippedLines[i].match(floatCompare);
		if (!m) continue;

		const floatValue = m[1] || m[2];
		if (SAFE_FLOAT_VALUES.has(floatValue)) continue;

		matches.push({
			line: i + 1,
			text: originalLines[i].trim().slice(0, 150),
		});
	}
	return matches;
}

/**
 * Detect functions that call themselves without a visible base case guard.
 * Heuristic: function definition followed by a self-call without an if/switch/return guard.
 * Uses stripped content for self-call detection to avoid matching function names in comments/strings.
 */
export function checkInfiniteRecursion(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const matches: InlineMatch[] = [];
	const originalLines = content.split("\n");
	const stripped = stripCommentsAndStrings(content);
	const strippedLines = stripped.split("\n");
	const funcNameRegex =
		/(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=])*=>)/;

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 5) break;
		const funcMatch = strippedLines[i].match(funcNameRegex);
		if (!funcMatch) continue;
		const funcName = funcMatch[1] || funcMatch[2];
		if (!funcName) continue;

		// Track brace depth to ensure self-call is inside the function body
		let fnBraceDepth = 0;
		for (const ch of strippedLines[i]) {
			if (ch === "{") fnBraceDepth++;
			if (ch === "}") fnBraceDepth--;
		}
		// If braces already balanced on the definition line, it's a one-liner — skip
		if (fnBraceDepth <= 0) continue;

		// Build a self-call test that doesn't use dynamic RegExp (avoid ReDoS risk)
		const selfCallNeedle = `${funcName}(`;
		const selfCallNeedleSpace = `${funcName} (`;

		// Look ahead up to 15 lines for a self-call without a guard
		let hasGuard = false;
		for (let j = i + 1; j < Math.min(i + 15, strippedLines.length); j++) {
			const line = strippedLines[j].trim();
			// Track brace depth — stop when we leave the function body
			for (const ch of strippedLines[j]) {
				if (ch === "{") fnBraceDepth++;
				if (ch === "}") fnBraceDepth--;
			}
			if (fnBraceDepth <= 0) break; // Exited the function body

			// Detect guards: explicit control flow + logical operators + comparisons
			if (
				/^(if|switch|return|while|for)\b/.test(line) ||
				/\?\s*\S/.test(line) ||
				/\b(&&|\|\|)\b/.test(line) ||
				/\.(length|size)\b/.test(line) ||
				/[!=]==?/.test(line) ||
				/[<>]=?/.test(line)
			) {
				hasGuard = true;
			}
			// Check for self-call using string matching (no dynamic RegExp)
			if (line.includes(selfCallNeedle) || line.includes(selfCallNeedleSpace)) {
				if (!hasGuard) {
					matches.push({
						line: j + 1,
						text: originalLines[j].trim().slice(0, 150),
					});
				}
				break;
			}
		}
	}

	return matches;
}

/**
 * Detect synchronous filesystem calls inside async functions.
 * `readFileSync`, `writeFileSync`, etc. inside async functions.
 */
export function checkSyncIoInAsync(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return [];

	const matches: InlineMatch[] = [];
	const lines = content.split("\n");
	let inAsyncFn = false;
	let braceDepth = 0;

	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= 10) break;
		const line = lines[i];

		// Track async function entry
		if (/\basync\s+(function|\()/.test(line) || /=\s*async\s*(\(|[^=])/.test(line)) {
			inAsyncFn = true;
			braceDepth = 0;
		}

		if (inAsyncFn) {
			for (const ch of line) {
				if (ch === "{") braceDepth++;
				if (ch === "}") braceDepth--;
			}
			if (braceDepth <= 0 && i > 0) {
				inAsyncFn = false;
			}
		}

		if (
			inAsyncFn &&
			/\b(readFileSync|writeFileSync|appendFileSync|mkdirSync|readdirSync|statSync|existsSync|unlinkSync|rmdirSync|renameSync|copyFileSync)\s*\(/.test(
				line,
			)
		) {
			matches.push({
				line: i + 1,
				text: lines[i].trim().slice(0, 150),
			});
		}
	}

	return matches;
}
