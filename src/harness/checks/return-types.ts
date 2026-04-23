// Missing return type annotations check.
// Extracted from generic-checks.ts.

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

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 20) break;
		const line = strippedLines[i];
		const trimmed = line.trim();

		// Pattern 1: export [async] function name(...)
		const fnMatch = trimmed.match(/^export\s+(?:async\s+)?function\s+\w+\s*(?:<[^>]*>)?\s*\(/);
		if (fnMatch) {
			// Walk from current line to find the closing paren and check for return type
			const funcSig = collectFunctionSignature(strippedLines, i);
			// After the closing `)`, check for `: Type` before `{`
			const afterParen = funcSig.match(/\)\s*(:.*?)?\s*\{/s);
			if (afterParen) {
				const returnAnnotation = afterParen[1];
				if (!returnAnnotation || returnAnnotation.trim() === ":") {
					matches.push({
						line: i + 1,
						text: originalLines[i].trim().slice(0, 150),
					});
				}
			}
			continue;
		}

		// Pattern 2: export const name = [async] (...) => (arrow function)
		if (
			/^export\s+const\s+\w+\s*=/.test(trimmed) &&
			/=>\s*/.test(collectFunctionSignature(strippedLines, i))
		) {
			// Arrow function — check if there's a type annotation on the const itself
			// e.g., export const foo: () => string = () => "hello"
			const constTypeMatch = trimmed.match(/^export\s+const\s+\w+\s*:\s*[^=]+\s*=/);
			if (constTypeMatch) continue; // Has type annotation on the const binding

			// Check for return type annotation after params: (params): ReturnType =>
			const sig = collectFunctionSignature(strippedLines, i);
			const paramReturnMatch = sig.match(/\)\s*:\s*\S+.*=>/);
			if (paramReturnMatch) continue; // Has return type after parens

			matches.push({
				line: i + 1,
				text: originalLines[i].trim().slice(0, 150),
			});
			continue;
		}

		// Pattern 3: export const name = [async] function name(
		const constFnMatch = trimmed.match(
			/^export\s+const\s+\w+\s*=\s*(?:async\s+)?function\s*\w*\s*\(/,
		);
		if (constFnMatch) {
			// Check if const has type annotation
			const constTypeMatch = trimmed.match(/^export\s+const\s+\w+\s*:\s*[^=]+\s*=/);
			if (constTypeMatch) continue;

			const funcSig = collectFunctionSignature(strippedLines, i);
			const afterParen = funcSig.match(/\)\s*(:.*?)?\s*\{/s);
			if (afterParen) {
				const returnAnnotation = afterParen[1];
				if (!returnAnnotation || returnAnnotation.trim() === ":") {
					matches.push({
						line: i + 1,
						text: originalLines[i].trim().slice(0, 150),
					});
				}
			}
		}
	}

	return matches;
}

/**
 * Collect a function signature across multiple lines until the opening `{` or `=>`.
 * Starts at the given line index and concatenates lines.
 */
