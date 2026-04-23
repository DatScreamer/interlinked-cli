// Function complexity checks.
// Extracted from generic-checks.ts.

import { collectFunctionSignature, getExtension, type InlineMatch, isTestFile } from "./shared.js";

// ===========================================
// Check: Function Complexity
// ===========================================

/**
 * Detect functions with high complexity indicators:
 * - 6+ parameters
 * - Nesting depth 5+ (nested braces inside function body)
 * - 15+ branching statements (if/else if/case/ternary)
 *
 * Supports TypeScript, JavaScript, Python, Go, Rust.
 * Skips test files.
 */
export function checkFunctionComplexity(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];

	const ext = getExtension(filePath);
	const matches: InlineMatch[] = [];
	const lines = content.split("\n");

	if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) {
		checkComplexityBrace(lines, matches);
	} else if (ext === ".py") {
		checkComplexityPython(lines, matches);
	} else if (ext === ".go" || ext === ".rs" || ext === ".swift") {
		checkComplexityBrace(lines, matches);
	}

	return matches;
}

/**
 * Check function complexity for brace-delimited languages (TS/JS/Go/Rust).
 */
function checkComplexityBrace(lines: string[], matches: InlineMatch[]): void {
	// Regex patterns to match function declarations
	const funcPatterns = [
		// function name( or async function name(
		/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/,
		// const name = ( or const name = async (
		/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\(/,
		// Go: func name( or func (receiver) name(
		/func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/,
		// Rust: fn name(
		/(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/,
	];

	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= 15) break;
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

		// Check parameter count: collect the full parameter list
		const paramSig = collectFunctionSignature(lines, i);
		const paramMatch = paramSig.match(/\(([^)]*)\)/);
		if (paramMatch) {
			const paramStr = paramMatch[1].trim();
			if (paramStr.length > 0) {
				const paramCount = countTopLevelCommas(paramStr);
				if (paramCount >= 6) {
					matches.push({
						line: i + 1,
						text: `[${paramCount} parameters] ${trimmed.slice(0, 120)}`,
					});
					continue;
				}
			}
		}

		// Find the opening brace and analyze the function body
		let braceLineIdx = -1;
		for (let k = i; k < Math.min(i + 10, lines.length); k++) {
			if (lines[k].includes("{")) {
				braceLineIdx = k;
				break;
			}
		}
		if (braceLineIdx === -1) continue;

		// Track brace depth through the function body
		let depth = 0;
		let maxDepth = 0;
		let branchCount = 0;
		let bodyStarted = false;

		for (let j = braceLineIdx; j < lines.length; j++) {
			const bodyLine = lines[j];
			for (const ch of bodyLine) {
				if (ch === "{") {
					depth++;
					if (bodyStarted && depth > maxDepth) maxDepth = depth;
					bodyStarted = true;
				}
				if (ch === "}") depth--;
			}
			if (bodyStarted && depth <= 0) break;

			// Count branching statements
			if (/^\s*(if|else\s+if)\s*[\s(]/.test(bodyLine)) branchCount++;
			// Only count case labels when nested (depth >= 3).
			// A flat switch (depth 1-2) with many cases is readable;
			// nested switch/case is genuinely complex.
			if (depth >= 3 && /\bcase\s+/.test(bodyLine.trim())) branchCount++;
			// Ternary operator (rough heuristic)
			const ternaries = bodyLine.match(/[^?]\?[^?:]/g);
			if (ternaries) branchCount += ternaries.length;
		}

		// maxDepth is relative to the function's opening brace depth
		// Subtract 1 because the function's own brace adds 1
		const nestingDepth = maxDepth - 1;

		if (nestingDepth >= 5) {
			matches.push({
				line: i + 1,
				text: `[nesting depth ${nestingDepth}] ${trimmed.slice(0, 120)}`,
			});
		} else if (branchCount >= 15) {
			matches.push({
				line: i + 1,
				text: `[${branchCount} branches — high complexity] ${trimmed.slice(0, 100)}`,
			});
		}
	}
}

/**
 * Check function complexity for Python (indent-delimited).
 */
function checkComplexityPython(lines: string[], matches: InlineMatch[]): void {
	for (let i = 0; i < lines.length; i++) {
		if (matches.length >= 15) break;
		const trimmed = lines[i].trim();
		const defMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(/);
		if (!defMatch) continue;

		// Check parameter count
		let paramLine = trimmed;
		let j = i;
		while (!paramLine.includes(")") && j < Math.min(i + 10, lines.length - 1)) {
			j++;
			paramLine += ` ${lines[j].trim()}`;
		}
		const paramMatch = paramLine.match(/\(([^)]*)\)/);
		if (paramMatch) {
			const params = paramMatch[1]
				.split(",")
				.map((p) => p.trim())
				.filter((p) => p.length > 0 && p !== "self" && p !== "cls");
			if (params.length >= 6) {
				matches.push({
					line: i + 1,
					text: `[${params.length} parameters] ${trimmed.slice(0, 120)}`,
				});
				continue;
			}
		}

		// Analyze function body (indent-delimited)
		const headIndent = lines[i].search(/\S/);
		if (headIndent < 0) continue;

		let branchCount = 0;
		let maxNesting = 0;

		for (let k = i + 1; k < lines.length; k++) {
			const bodyLine = lines[k];
			if (bodyLine.trim() === "") continue;
			const indent = bodyLine.search(/\S/);
			if (indent <= headIndent) break;

			// Nesting depth relative to function body
			const relIndent = indent - headIndent;
			const nestLevel = Math.floor(relIndent / 4);
			if (nestLevel > maxNesting) maxNesting = nestLevel;

			if (/^\s*(if|elif)\s+/.test(bodyLine)) branchCount++;
			if (/^\s*case\s+/.test(bodyLine)) branchCount++;
		}

		if (maxNesting >= 5) {
			matches.push({
				line: i + 1,
				text: `[nesting depth ${maxNesting}] ${trimmed.slice(0, 120)}`,
			});
		} else if (branchCount >= 15) {
			matches.push({
				line: i + 1,
				text: `[${branchCount} branches — high complexity] ${trimmed.slice(0, 100)}`,
			});
		}
	}
}

/**
 * Count top-level parameter items, respecting nested angle brackets, parens, and braces.
 * Returns the number of comma-separated items at the top level.
 */
function countTopLevelCommas(paramStr: string): number {
	let depth = 0;
	let count = 1;
	for (const ch of paramStr) {
		if (ch === "<" || ch === "(" || ch === "{" || ch === "[") depth++;
		else if (ch === ">" || ch === ")" || ch === "}" || ch === "]") depth--;
		else if (ch === "," && depth === 0) count++;
	}
	return count;
}
