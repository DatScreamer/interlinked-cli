// Language-agnostic checks: binary content, empty file, console/debug.
// Extracted from generic-checks.ts. (The per-file line cap moved to
// harness/large-file-policy.ts — the single source of truth for file size.)

import {
	getExtension,
	type InlineMatch,
	isCliFile,
	isScriptOrCliPath,
	isTestFile,
	scanLinesStripped,
	stripCommentsAndStrings,
} from "./shared.js";

// ===========================================
// Language-Agnostic Checks
// ===========================================

/**
 * Check if content contains null bytes, indicating binary data.
 * Agents should never write binary files through text editing tools.
 */
export function checkBinaryContent(content: string): boolean {
	return content.includes("\x00");
}

/**
 * Check if the file is empty (only whitespace).
 * An empty file is usually a mistake — the agent likely intended to write content.
 */
export function checkEmptyFile(content: string): boolean {
	return content.trim().length === 0;
}

/**
 * Detect debug/logging statements left in code.
 * Language is inferred from file extension. Test files are skipped.
 *
 * Supported languages:
 * - JS/TS: `console.log(`, `console.debug(`, `debugger;`
 * - Python: `print(`, `breakpoint()`, `pdb.set_trace()`
 * - Rust: `dbg!(`
 * - Go: `fmt.Println(` (only if not in `_test.go`)
 * - C/C++: `printf(` (heuristic, skips files named `main.*`)
 */
export function checkConsoleDebug(content: string, filePath: string): InlineMatch[] {
	if (isTestFile(filePath)) return [];
	// Skip CLI entry points and command files — console.log is the correct output method
	if (isCliFile(filePath)) return [];
	// 139-repo audit: also exempt `cli/<deeper>`, `tools/`, and
	// `tutorial[s]/` — `isCliFile`'s heuristics miss `cli/internal/setup/
	// wizard.go` (Supermodel, 13 fmt.Println — interactive wizard) and
	// tutorial fixtures intentionally print example output.
	if (isScriptOrCliPath(filePath)) return [];

	const normalized = filePath.replace(/\\/g, "/");
	// Skip server entry points and scripts — console.log is the correct logging
	// mechanism for Cloudflare Workers (goes to wrangler tail), Node servers,
	// and CLI scripts.
	if (
		/\bservers?\b/i.test(normalized) ||
		/\bscripts?\b/i.test(normalized) ||
		/\bevals?\b/i.test(normalized) ||
		/\/workers?\//i.test(normalized)
	) {
		return [];
	}

	const ext = getExtension(filePath);
	const fileName = filePath.split(/[/\\]/).pop() || "";
	let pattern: RegExp | null = null;

	// JS/TS
	if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
		pattern = /\bconsole\.(log|debug|info)\s*\(|^\s*debugger\s*;/;
	}
	// Python — only flag in app/lib code, skip standalone scripts and sandboxes.
	// Python print() is the standard output mechanism for scripts, CLIs, and notebooks.
	else if (ext === ".py") {
		if (/sandbox|script|cli|main|test|__main__/i.test(fileName)) return [];
		// Only flag breakpoint/pdb — print() is too common and usually intentional
		pattern = /\bbreakpoint\s*\(|\bpdb\.set_trace\s*\(/;
	}
	// Rust
	else if (ext === ".rs") {
		pattern = /\bdbg!\s*\(/;
	}
	// Go — fmt.Println is standard output in Go. Only flag when 3+ occurrences
	// suggest debug sprawl rather than intentional output.
	else if (ext === ".go") {
		const goStripped = stripCommentsAndStrings(content);
		const goCount = (goStripped.match(/\bfmt\.Println\s*\(/g) || []).length;
		if (goCount < 3) return [];
		pattern = /\bfmt\.Println\s*\(/;
	}
	// C/C++ — printf is standard output. Skip main files, example/demo dirs.
	else if ([".c", ".cpp", ".cc", ".cxx", ".h", ".hpp"].includes(ext)) {
		const cFileName = filePath.split(/[/\\]/).pop() || "";
		if (cFileName.startsWith("main.")) return [];
		if (/\b(examples?|samples?|demos?)\b/i.test(normalized)) return [];
		if (/\b(example|demo|sample)/i.test(cFileName)) return [];
		pattern = /\bprintf\s*\(/;
	}

	if (!pattern) return [];

	// Strip comments and strings to avoid false positives from commented-out
	// or string-embedded debug statements
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	return scanLinesStripped(originalLines, strippedLines, pattern, 10);
}
