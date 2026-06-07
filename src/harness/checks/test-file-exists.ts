// Test file existence check.
// Extracted from generic-checks.ts.

import { existsSync } from "node:fs";
import { type InlineMatch, isGeneratedFile, isTestFile, isTypeOnlyModule } from "./shared.js";

// ===========================================
// Check: Test File Existence
// ===========================================

/** Directory fragments that mark a path as non-source (built/vendored output). */
const NON_SOURCE_DIR_FRAGMENTS = [
	"/dist/",
	"/node_modules/",
	"/.interlinked/",
	"/build/",
	"/coverage/",
] as const;

/** Non-code extensions that are never unit-tested as source. */
const NON_CODE_EXTS = new Set([".json", ".yaml", ".yml", ".toml"]);

/** Code extensions the check applies to. */
const CODE_EXTS = new Set([
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

/**
 * Decide whether `normalized` (a forward-slash path) sits in a non-source
 * directory the check must ignore (dist / node_modules / build / etc.).
 */
function isInNonSourceDir(normalized: string): boolean {
	return NON_SOURCE_DIR_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/**
 * Decide whether a `base`/`ext` pair belongs to a config file the check skips
 * (tsconfig, package, biome, …) or a non-code extension (json/yaml/…).
 */
function isConfigOrNonCode(base: string, ext: string): boolean {
	if (/^(tsconfig|package|biome|eslint|prettier|vitest|vite|webpack|rollup|jest|babel)/.test(base)) {
		return true;
	}
	return NON_CODE_EXTS.has(ext);
}

/** Parsed filename pieces used by the existence check. */
interface ParsedName {
	base: string;
	ext: string;
}

/**
 * Split a normalized path into `{ base, ext }`, returning null when the file
 * has no usable extension (hidden file / no dot) — callers treat null as
 * "nothing to check".
 */
function parseFileName(normalized: string): ParsedName | null {
	const lastSlash = normalized.lastIndexOf("/");
	const fileName = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
	const dotIdx = fileName.lastIndexOf(".");
	if (dotIdx <= 0) return null; // No extension or hidden file
	return { base: fileName.slice(0, dotIdx), ext: fileName.slice(dotIdx) };
}

/**
 * Apply every path/extension-based skip gate that does not depend on file
 * content. Returns true when the file should be exempted from the test-file
 * check (.d.ts, non-source dir, index/config/non-code, unknown extension).
 * Content-based gates (generator marker, type-only module) stay in the
 * orchestrator because they need the optional `content` argument.
 */
function shouldSkipPath(normalized: string, parsed: ParsedName): boolean {
	if (normalized.endsWith(".d.ts")) return true;
	if (isInNonSourceDir(normalized)) return true;
	if (parsed.base === "index") return true; // barrel exports
	if (isConfigOrNonCode(parsed.base, parsed.ext)) return true;
	if (!CODE_EXTS.has(parsed.ext.toLowerCase())) return true;
	return false;
}

/**
 * Build the list of candidate test-file paths for a source file, covering the
 * shared `*.test`/`*.spec` (+ `__tests__/`) conventions plus the Python
 * (`test_x` / `x_test`) and Go (`x_test`) idioms.
 */
function buildTestCandidates(dir: string, base: string, ext: string): string[] {
	const candidates = [
		`${dir}/${base}.test${ext}`,
		`${dir}/${base}.spec${ext}`,
		`${dir}/__tests__/${base}.test${ext}`,
		`${dir}/__tests__/${base}.spec${ext}`,
	];
	if (ext === ".py") {
		candidates.push(`${dir}/test_${base}${ext}`);
		candidates.push(`${dir}/${base}_test${ext}`);
	}
	if (ext === ".go") {
		candidates.push(`${dir}/${base}_test${ext}`);
	}
	return candidates;
}

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

	// Path/extension skip gates (.d.ts, non-source dirs, index/config/non-code).
	const parsed = parseFileName(normalized);
	if (parsed === null) return []; // No extension or hidden file
	if (shouldSkipPath(normalized, parsed)) return [];

	const { base, ext } = parsed;

	// Pure type-definition modules (only interface/type declarations, no
	// runtime code) have nothing to unit-test — tsc already validates them.
	// Flagging them was a recurring FP on type-only `*.ts` files.
	if (content !== undefined && isTypeOnlyModule(filePath, content)) return [];

	// `dir` is sliced from the original (un-normalized) path; `normalized` only
	// swaps `\` for `/` so the slash index is positionally identical.
	const lastSlash = normalized.lastIndexOf("/");
	const dir = lastSlash >= 0 ? filePath.slice(0, lastSlash) : ".";

	const candidates = buildTestCandidates(dir, base, ext);
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
