// Missing return type annotations check.
// Extracted from generic-checks.ts.

import { nonNull } from "../../lib/non-null.js";
import {
	collectFunctionSignature,
	getExtension,
	type InlineMatch,
	isTestFile,
	stripComments,
} from "./shared.js";

// ===========================================
// Check: Missing Return Type Annotations
// ===========================================

/**
 * Detect exported functions without explicit return type annotations in TypeScript.
 * Flags:
 * - `export function name(params)` without `: ReturnType` before `{`
 * - `export const name = (params) =>` without `: ReturnType =>`
 * - `export async function name(params)` without `: ReturnType`
 *
 * Skips test files, .d.ts files, and non-exported functions.
 */
export function checkMissingReturnTypes(content: string, filePath: string): InlineMatch[] {
	const ext = getExtension(filePath);
	if (ext !== ".ts" && ext !== ".tsx") return [];
	if (filePath.endsWith(".d.ts")) return [];
	if (isTestFile(filePath)) return [];

	const stripped = stripComments(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (const [i, line] of strippedLines.entries()) {
		if (matches.length >= 20) break;
		const trimmed = line.trim();

		if (checkExportFunctionPattern(trimmed, strippedLines, originalLines, i, matches)) continue;
		if (checkExportConstArrowPattern(trimmed, strippedLines, originalLines, i, matches)) continue;
		checkExportConstFunctionPattern(trimmed, strippedLines, originalLines, i, matches);
	}

	return matches;
}

/**
 * `)  ...  {` with no `: Type` (or a bare `:`) between them means the
 * signature closed without a return-type annotation.
 */
function hasMissingReturnAnnotation(funcSig: string): boolean {
	const afterParen = funcSig.match(/\)\s*(:.*?)?\s*\{/s);
	if (!afterParen) return false;
	const returnAnnotation = afterParen[1];
	return !returnAnnotation || returnAnnotation.trim() === ":";
}

/** Pattern 1: `export [async] function name(...)`. Returns true if this line was this pattern (flagged or not). */
function checkExportFunctionPattern(
	trimmed: string,
	strippedLines: string[],
	originalLines: string[],
	i: number,
	matches: InlineMatch[],
): boolean {
	const fnMatch = trimmed.match(/^export\s+(?:async\s+)?function\s+\w+\s*(?:<[^>]*>)?\s*\(/);
	if (!fnMatch) return false;

	// Walk from current line to find the closing paren and check for return type
	const funcSig = collectFunctionSignature(strippedLines, i);
	if (hasMissingReturnAnnotation(funcSig)) {
		matches.push({
			line: i + 1,
			text: nonNull(originalLines[i]).trim().slice(0, 150),
		});
	}
	return true;
}

/** Pattern 2: `export const name = [async] (...) => ` (arrow function). Returns true if this line was this pattern. */
function checkExportConstArrowPattern(
	trimmed: string,
	strippedLines: string[],
	originalLines: string[],
	i: number,
	matches: InlineMatch[],
): boolean {
	if (!/^export\s+const\s+\w+\s*=/.test(trimmed)) return false;
	const sig = collectFunctionSignature(strippedLines, i);
	if (!/=>\s*/.test(sig)) return false;

	// Arrow function — check if there's a type annotation on the const itself
	// e.g., export const foo: () => string = () => "hello"
	const constTypeMatch = trimmed.match(/^export\s+const\s+\w+\s*:\s*[^=]+\s*=/);
	if (constTypeMatch) return true; // Has type annotation on the const binding

	// Check for return type annotation after params: (params): ReturnType =>
	const paramReturnMatch = sig.match(/\)\s*:\s*\S+.*=>/);
	if (paramReturnMatch) return true; // Has return type after parens

	matches.push({
		line: i + 1,
		text: nonNull(originalLines[i]).trim().slice(0, 150),
	});
	return true;
}

/** Pattern 3: `export const name = [async] function name(`. Returns true if this line was this pattern. */
function checkExportConstFunctionPattern(
	trimmed: string,
	strippedLines: string[],
	originalLines: string[],
	i: number,
	matches: InlineMatch[],
): boolean {
	const constFnMatch = trimmed.match(
		/^export\s+const\s+\w+\s*=\s*(?:async\s+)?function\s*\w*\s*\(/,
	);
	if (!constFnMatch) return false;

	// Check if const has type annotation
	const constTypeMatch = trimmed.match(/^export\s+const\s+\w+\s*:\s*[^=]+\s*=/);
	if (constTypeMatch) return true;

	const funcSig = collectFunctionSignature(strippedLines, i);
	if (hasMissingReturnAnnotation(funcSig)) {
		matches.push({
			line: i + 1,
			text: nonNull(originalLines[i]).trim().slice(0, 150),
		});
	}
	return true;
}

/**
 * Collect a function signature across multiple lines until the opening `{` or `=>`.
 * Starts at the given line index and concatenates lines.
 */
