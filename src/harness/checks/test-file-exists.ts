// Test file existence check.
// Extracted from generic-checks.ts.

import { existsSync } from "node:fs";
import { type InlineMatch, isGeneratedFile, isTestFile } from "./shared.js";

// ===========================================
// Check: Test File Existence
// ===========================================

/**
 * Detect source files that have no corresponding test file.
 * Checks common test file naming conventions:
 * - {dir}/{base}.test{ext} / {base}.spec{ext}
 * - {dir}/__tests__/{base}.test{ext} / {base}.spec{ext}
 *
 * Skips: test files, index.ts, .d.ts, config files, files in dist/node_modules/etc.
 * If `content` is provided and looks generator-emitted (OpenAPI, protoc,
 * `@generated`, etc.), the check short-circuits — generator output never
 * has unit-test siblings by design (139-repo audit, 2026-05).
 *
 * Returns a single InlineMatch at line 0 if no test file exists.
 *
 * NOTE: This is a standalone file-existence check (no session/event context).
 * For session-aware test proximity, see checkTestProximity in structural-checks.ts.
 */
export function checkTestFileExists(filePath: string, content?: string): InlineMatch[] {
	// Skip test files themselves
	if (isTestFile(filePath)) return [];
	// 139-repo audit: generator output (OpenAPI Generator, protoc, etc.)
	// emits source files without unit-test siblings by design. Flagging
	// them produces 67 FPs in one Supermodel sdk/. Content-marker gate
	// only applies when content is provided.
	if (content !== undefined && isGeneratedFile(content)) return [];

	const normalized = filePath.replace(/\\/g, "/");

	// Skip .d.ts files
	if (normalized.endsWith(".d.ts")) return [];

	// Skip files in non-source directories
	if (
		normalized.includes("/dist/") ||
		normalized.includes("/node_modules/") ||
		normalized.includes("/.interlinked/") ||
		normalized.includes("/build/") ||
		normalized.includes("/coverage/")
	) {
		return [];
	}

	// Get basename and extension
	const lastSlash = normalized.lastIndexOf("/");
	const fileName = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
	const dotIdx = fileName.lastIndexOf(".");
	if (dotIdx <= 0) return []; // No extension or hidden file

	const ext = fileName.slice(dotIdx);
	const base = fileName.slice(0, dotIdx);

	// Skip index files (barrel exports)
	if (base === "index") return [];

	// Skip config files
	if (
		/^(tsconfig|package|biome|eslint|prettier|vitest|vite|webpack|rollup|jest|babel)/.test(base)
	) {
		return [];
	}
	if (ext === ".json" || ext === ".yaml" || ext === ".yml" || ext === ".toml") return [];

	// Only check code files
	const codeExts = new Set([
		".ts",
		".tsx",
		".js",
		".jsx",
		".mjs",
		".cjs",
		".mts",
		".cts",
		".py",
		".go",
		".rs",
		".java",
	]);
	if (!codeExts.has(ext.toLowerCase())) return [];

	const dir = lastSlash >= 0 ? filePath.slice(0, lastSlash) : ".";

	// Build list of candidate test files
	const candidates = [
		`${dir}/${base}.test${ext}`,
		`${dir}/${base}.spec${ext}`,
		`${dir}/__tests__/${base}.test${ext}`,
		`${dir}/__tests__/${base}.spec${ext}`,
	];

	// Python conventions
	if (ext === ".py") {
		candidates.push(`${dir}/test_${base}${ext}`);
		candidates.push(`${dir}/${base}_test${ext}`);
	}

	// Go convention
	if (ext === ".go") {
		candidates.push(`${dir}/${base}_test${ext}`);
	}

	for (const candidate of candidates) {
		if (existsSync(candidate)) return [];
	}

	return [
		{
			line: 0,
			text: `no test file found (checked: ${base}.test${ext}, ${base}.spec${ext}, __tests__/)`,
		},
	];
}
