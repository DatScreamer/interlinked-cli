// ===========================================
// Pre-existing Test Failure Detection + Test-file Helpers
// ===========================================
// Prevents misattribution of config/resolution errors to agent edits.
// When tests fail due to missing path aliases, uninstalled deps, or broken
// module resolution, the failure predates the edit. Without this detection,
// agents silently revert files they didn't actually break.

import { dirname, resolve, sep } from "node:path";
import type { LanguageProfile } from "../types.js";

const MODULE_RESOLUTION_PATTERNS = [
	/Cannot find (?:package|module)/i,
	/Module not found/i,
	/ERR_MODULE_NOT_FOUND/,
	/Failed to resolve import/i,
	/Cannot resolve/i,
	/Could not resolve/i,
	/ENOENT.*node_modules/,
	/Cannot find name '[^']+'\. Do you need to install/,
];

/**
 * Check if test failure output indicates a pre-existing configuration issue
 * (module resolution, missing deps) rather than an edit-caused regression.
 */
function isPreExistingTestFailure(output: string): boolean {
	const errorLines = output
		.split("\n")
		.filter((l) => /error|fail|cannot|ERR_/i.test(l) && l.trim().length > 0);
	if (errorLines.length === 0) return false;

	// If every error line matches a module resolution pattern, it's pre-existing
	return errorLines.every((line) => MODULE_RESOLUTION_PATTERNS.some((p) => p.test(line)));
}

/**
 * Baseline cache: test files that have already been seen failing.
 * Maps test file path → truncated error output hash.
 * If a test fails with the same error on a subsequent edit, it's pre-existing.
 * Cleared on session start (not persisted across sessions).
 */
const failedTestBaseline = new Map<string, string>();

function hashTestError(output: string): string {
	// Simple hash: first error line (stable across re-runs for config issues)
	const errorLine = output.split("\n").find((l) => /error|fail|cannot/i.test(l));
	return errorLine?.trim().slice(0, 100) || output.slice(0, 100);
}

/**
 * Public API — consumed by quality-checks.runQualityChecks.
 *
 * Returns "pre-existing" if failure is not caused by the edit, null otherwise.
 */
export function classifyTestFailure(testId: string, output: string): "pre-existing" | null {
	// Check 1: module resolution errors → definitely pre-existing
	if (isPreExistingTestFailure(output)) return "pre-existing";

	// Check 2: baseline cache — same test failed with same error before
	const errorHash = hashTestError(output);
	const previous = failedTestBaseline.get(testId);
	if (previous === errorHash) return "pre-existing";

	// Record this failure for future baseline comparison
	failedTestBaseline.set(testId, errorHash);
	return null;
}

/**
 * Public API — consumed by quality-checks.runQualityChecks.
 *
 * Check if a file looks like a test file across languages.
 */
export function isLikelyTestFile(baseName: string, filePath: string): boolean {
	// TS/JS: foo.test.ts, foo.spec.ts
	if (baseName.endsWith(".test") || baseName.endsWith(".spec")) return true;
	// Python: test_foo.py, foo_test.py
	if (baseName.startsWith("test_") || baseName.endsWith("_test")) return true;
	// Go: foo_test.go
	if (filePath.endsWith("_test.go")) return true;
	// Java: FooTest.java
	if (baseName.endsWith("Test") || baseName.endsWith("Tests")) return true;
	// Directory-based: __tests__/, tests/, test/
	if (/[/\\](?:__tests__|tests?)[/\\]/i.test(filePath)) return true;
	return false;
}

interface TestCandidateCtx {
	absPath: string;
	ext: string;
	base: string;
	dir: string;
	baseName: string;
}

/** Per-language test-candidate emitters keyed by profile id. */
const LANG_TEST_CANDIDATE_EMITTERS: Record<
	string,
	(candidates: string[], ctx: TestCandidateCtx) => void
> = {
	python: (candidates, { ext, dir, baseName }) => {
		// Python conventions: test_foo.py, tests/test_foo.py, foo_test.py
		candidates.push(resolve(dir, `test_${baseName}${ext}`));
		candidates.push(resolve(dir, `${baseName}_test${ext}`));
		candidates.push(resolve(dir, "tests", `test_${baseName}${ext}`));
		candidates.push(resolve(dirname(dir), "tests", `test_${baseName}${ext}`));
	},
	go: (candidates, { ext, base }) => {
		// Go convention: foo_test.go in same directory
		candidates.push(`${base}_test${ext}`);
	},
	rust: () => {
		// Rust: tests in same file (#[test]) or tests/ directory — no separate
		// file to run. cargo test runs all tests project-wide.
	},
	java: (candidates, { absPath, ext, dir, baseName }) => {
		// Java: FooTest.java in src/test/java mirroring src/main/java
		const mainIdx = absPath.indexOf(`${sep}src${sep}main${sep}`);
		if (mainIdx !== -1) {
			const testPath =
				absPath.slice(0, mainIdx) +
				absPath
					.slice(mainIdx)
					.replace(`${sep}src${sep}main${sep}`, `${sep}src${sep}test${sep}`);
			const testBase = testPath.slice(0, -ext.length);
			candidates.push(`${testBase}Test${ext}`);
		}
		candidates.push(resolve(dir, `${baseName}Test${ext}`));
	},
};

function appendLanguageSpecificTestCandidates(
	candidates: string[],
	langId: string | undefined,
	ctx: TestCandidateCtx,
): void {
	if (!langId) return;
	const emitter = LANG_TEST_CANDIDATE_EMITTERS[langId];
	if (emitter) emitter(candidates, ctx);
}

/**
 * Public API — consumed by quality-checks.runQualityChecks.
 *
 * Build language-aware test file candidates for a given source file.
 */
export function buildTestCandidates(
	absPath: string,
	ext: string,
	base: string,
	dir: string,
	baseName: string,
	profile: LanguageProfile | null,
): string[] {
	const candidates: string[] = [];
	const langId = profile?.id;
	appendLanguageSpecificTestCandidates(candidates, langId, {
		absPath,
		ext,
		base,
		dir,
		baseName,
	});

	// TS/JS fallback (always included)
	candidates.push(`${base}.test${ext}`);
	candidates.push(`${base}.spec${ext}`);
	candidates.push(resolve(dir, "__tests__", `${baseName}.test${ext}`));
	candidates.push(resolve(dir, "__tests__", `${baseName}.spec${ext}`));

	return candidates;
}
