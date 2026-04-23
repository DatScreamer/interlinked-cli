// Shared helpers used by all check modules.
// Extracted from generic-checks.ts. These are internal to the checks/ package.

/** A single match found by an inline check. Public API — re-exported by generic-checks.ts. */
export interface InlineMatch {
	/** 1-based line number */
	line: number;
	/** Trimmed text of the matching line (truncated to 150 chars) */
	text: string;
}

/**
 * JS/TS extension set (includes .mts/.cts). Used across many checks.
 * Prefer JS_TS_ALL_EXTS (array) when you need `Array.includes`.
 */
export const JS_TS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

/** JS/TS extension array — same values as JS_TS_EXTS but ordered for `.includes()`. */
export const JS_TS_ALL_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts"];

/**
 * Collect a full function signature starting at the given line index.
 * Reads up to 20 lines or until we see `{` or `=>`, whichever comes first.
 * Used by missing-return-type, complexity, and taste-level checks.
 */
export function collectFunctionSignature(lines: string[], startIdx: number): string {
	let sig = "";
	for (let i = startIdx; i < Math.min(startIdx + 20, lines.length); i++) {
		sig += ` ${lines[i]}`;
		if (lines[i].includes("{") || lines[i].includes("=>")) break;
	}
	return sig;
}

/**
 * Count top-level parameter items, respecting nested angle brackets, parens,
 * brackets, and braces. Returns the number of comma-separated items at the
 * top level. (Despite the name, this returns the COUNT of items, not the
 * count of commas — an empty string still returns 1. Kept as-is for
 * backwards-compatibility with callers like `checkFunctionArity`.)
 */
export function countTopLevelCommas(paramStr: string): number {
	let depth = 0;
	let count = 1;
	for (const ch of paramStr) {
		if (ch === "<" || ch === "(" || ch === "{" || ch === "[") depth++;
		else if (ch === ">" || ch === ")" || ch === "}" || ch === "]") depth--;
		else if (ch === "," && depth === 0) count++;
	}
	return count;
}

// ===========================================
// Helper: Test File Detection
// ===========================================

/**
 * Check if a file path looks like a test file.
 * Matches common conventions across languages:
 * - Python: `test_*.py`, `*_test.py`
 * - Go: `*_test.go`
 * - JS/TS: `*.test.ts`, `*.spec.ts`, `*.test.js`, `*.spec.js`
 * - Directories: `__tests__/`, `tests/`, `src/test/`
 */
export function isTestFile(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");

	// Directory-based detection
	if (
		normalized.includes("/__tests__/") ||
		normalized.includes("/tests/") ||
		normalized.includes("/src/test/")
	) {
		return true;
	}

	// Filename-based detection
	const fileName = normalized.split("/").pop() || "";

	// Python: test_*.py or *_test.py
	if (fileName.startsWith("test_") && fileName.endsWith(".py")) return true;
	if (fileName.endsWith("_test.py")) return true;

	// Go: *_test.go
	if (fileName.endsWith("_test.go")) return true;

	// JS/TS: *.test.ts, *.spec.ts, *.test.js, *.spec.js, *.test.tsx, *.spec.tsx, etc.
	if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(fileName)) return true;

	// Java: *Test.java, *Tests.java
	if (/Tests?\.java$/.test(fileName)) return true;

	// Swift: *Tests.swift, *Test.swift, test_*.swift
	if (/Tests?\.swift$/.test(fileName)) return true;
	if (fileName.startsWith("test_") && fileName.endsWith(".swift")) return true;

	return false;
}

/**
 * Check if a file is a CLI entry point or command file.
 * These files use console.log as their primary output method.
 * Path-agnostic: works for any project structure.
 */
export function isCliFile(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	// CLI command directories (convention across many frameworks)
	if (normalized.includes("/commands/")) return true;
	if (normalized.includes("/cmd/")) return true;
	// Bin directories
	if (normalized.includes("/bin/")) return true;
	// Entry points named index/main/cli in typical CLI locations
	const basename = normalized.split("/").pop() || "";
	if (/^(main|cli|index)\.(ts|js|mjs|py|go|rs)$/.test(basename)) {
		// Only skip if it's in a recognizable CLI/bin/src root — not deeply nested library code
		if (
			normalized.includes("/cli/") ||
			normalized.includes("/bin/") ||
			normalized.includes("/cmd/") ||
			// Top-level entry points (e.g., src/main.ts, src/index.ts)
			/\/src\/[^/]+$/.test(normalized)
		) {
			return true;
		}
	}
	return false;
}

// ===========================================
// Internal Helpers
// ===========================================

/** Extract file extension (lowercase, with dot) */
export function getExtension(filePath: string): string {
	const dot = filePath.lastIndexOf(".");
	if (dot === -1) return "";
	return filePath.slice(dot).toLowerCase();
}

// ===========================================
// Comment & String Stripping Helpers
// ===========================================

/**
 * Strip comments from content, preserving line count and positions.
 * Replaces comment content with spaces so that line numbers remain stable.
 *
 * Handles:
 * - Single-line comments: `// ...` (JS/TS/Rust/Go/C/Java) and `# ...` (Python)
 * - Multi-line comments: `/* ... *​/` (JS/TS/Rust/Go/C/Java)
 * - Python docstrings on a single line: `""" ... """` and `''' ... '''`
 */
export function stripComments(content: string): string {
	const lines = content.split("\n");
	let inBlockComment = false;

	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];

		if (inBlockComment) {
			const endIdx = line.indexOf("*/");
			if (endIdx === -1) {
				// Entire line is inside a block comment — blank it
				lines[i] = " ".repeat(line.length);
				continue;
			}
			// Blank up to and including the closing */
			const blanked = " ".repeat(endIdx + 2) + line.slice(endIdx + 2);
			lines[i] = blanked;
			line = blanked;
			inBlockComment = false;
		}

		// Python single-line docstrings: """ ... """ or ''' ... '''
		line = line.replace(/"""[^"]*"""/g, (m) => " ".repeat(m.length));
		line = line.replace(/'''[^']*'''/g, (m) => " ".repeat(m.length));

		// Handle /* ... */ that open and close on the same line (possibly multiple)
		let searchFrom = 0;
		while (searchFrom < line.length) {
			const openIdx = line.indexOf("/*", searchFrom);
			if (openIdx === -1) break;
			const closeIdx = line.indexOf("*/", openIdx + 2);
			if (closeIdx === -1) {
				// Block comment opens and continues to next line(s)
				line = line.slice(0, openIdx) + " ".repeat(line.length - openIdx);
				inBlockComment = true;
				break;
			}
			// Same-line block comment
			const before = line.slice(0, openIdx);
			const blanked = " ".repeat(closeIdx + 2 - openIdx);
			const after = line.slice(closeIdx + 2);
			line = before + blanked + after;
			searchFrom = openIdx + blanked.length;
		}

		// Single-line comments: // (JS/TS/Rust/Go/C/Java) and # (Python)
		// Find earliest unquoted // or #
		const slashIdx = line.indexOf("//");
		const hashIdx = line.indexOf("#");
		let commentStart = -1;
		if (slashIdx !== -1 && hashIdx !== -1) {
			commentStart = Math.min(slashIdx, hashIdx);
		} else if (slashIdx !== -1) {
			commentStart = slashIdx;
		} else if (hashIdx !== -1) {
			commentStart = hashIdx;
		}

		if (commentStart !== -1) {
			line = line.slice(0, commentStart) + " ".repeat(line.length - commentStart);
		}

		lines[i] = line;
	}

	return lines.join("\n");
}

/**
 * Strip string literal content from content, preserving line count.
 * Replaces the interior of string literals with empty content so that
 * patterns inside strings do not trigger false positive matches.
 *
 * Handles: `"..."`, `'...'`, and `` `...` `` (single-line only).
 */
export function stripStrings(content: string): string {
	const lines = content.split("\n");
	let templateDepth = 0; // Track nested template literal depth
	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];

		// Inside a multi-line template literal: blank the line, track backticks
		if (templateDepth > 0) {
			for (let j = 0; j < line.length; j++) {
				if (line[j] === "\\" && j + 1 < line.length) {
					j++; // skip escaped char
				} else if (line[j] === "`") {
					templateDepth--;
					if (templateDepth === 0) break;
				}
			}
			lines[i] = "";
			continue;
		}

		// Replace content inside double-quoted strings
		line = line.replace(/"(?:[^"\\]|\\.)*"/g, '""');
		// Replace content inside single-quoted strings
		line = line.replace(/'(?:[^'\\]|\\.)*'/g, "''");
		// Replace content inside backtick template strings (single-line only)
		line = line.replace(/`(?:[^`\\]|\\.)*`/g, "``");

		// Check for unclosed backticks (multi-line template literal opening).
		// Count unescaped backticks remaining — odd count means one is unclosed.
		const remaining = (line.match(/(?<!\\)`/g) || []).length;
		if (remaining % 2 === 1) {
			templateDepth = 1;
		}

		lines[i] = line;
	}
	return lines.join("\n");
}

/**
 * Strip both comments and strings from content.
 * Comments are stripped first (so string-like content in comments is removed),
 * then strings are stripped.
 */
export function stripCommentsAndStrings(content: string): string {
	return stripStrings(stripComments(content));
}

/**
 * Scan original lines but match against pre-stripped lines.
 * Returns matches from the original content for display, but only
 * where the stripped content matches the pattern.
 */
export function scanLinesStripped(
	originalLines: string[],
	strippedLines: string[],
	pattern: RegExp,
	maxMatches: number,
): InlineMatch[] {
	const matches: InlineMatch[] = [];
	for (let i = 0; i < originalLines.length; i++) {
		if (matches.length >= maxMatches) break;
		if (pattern.test(strippedLines[i])) {
			matches.push({
				line: i + 1,
				text: originalLines[i].trim().slice(0, 150),
			});
		}
	}
	return matches;
}
