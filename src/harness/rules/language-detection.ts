// ===========================================
// Rules — Project-Language Detection + Quality-Check Auto-Tune
// ===========================================
// Inspects the project root for language markers (tsconfig.json,
// pyproject.toml, Cargo.toml, etc.) and disables language-specific
// quality checks that don't apply — so a Rust-only repo doesn't get
// ruff/mypy/clippy errors on every PostToolUse.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LanguageId, QualityCheckConfig } from "../types.js";

/**
 * Maps quality check names to the language(s) they apply to.
 * Checks not listed here are language-agnostic (always run).
 */
const CHECK_LANGUAGE_MAP: Record<string, LanguageId[]> = {
	typescript: ["typescript"],
	biome_lint: ["typescript"],
	eslint: ["typescript"],
	strong_typing: ["typescript"],
	affected_tests: ["typescript", "python", "rust", "go", "c_cpp", "java"],
	inline_language_checks: ["python", "rust", "go", "c_cpp", "java", "swift"],
	python_typecheck: ["python"],
	ruff_lint: ["python"],
	cargo_check: ["rust"],
	cargo_clippy: ["rust"],
	go_build: ["go"],
	golangci_lint: ["go"],
	c_compile: ["c_cpp"],
	clang_tidy: ["c_cpp"],
};

/**
 * Public API — consumed by `rules/loader.ts` during `loadRules()` and
 * exported for tests that need to simulate a known project type.
 *
 * Detects which languages are present in a project by checking for
 * root markers. Falls back to `typescript` when no markers are found
 * (most JS/TS projects without tsconfig still benefit from biome).
 */
export function detectProjectLanguages(cwd: string): Set<LanguageId> {
	const detected = new Set<LanguageId>();

	const markers: Array<{ files: string[]; lang: LanguageId }> = [
		{ files: ["tsconfig.json", "package.json", "deno.json"], lang: "typescript" },
		{
			files: ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile", "setup.cfg"],
			lang: "python",
		},
		{ files: ["Cargo.toml"], lang: "rust" },
		{ files: ["go.mod"], lang: "go" },
		{ files: ["Makefile", "CMakeLists.txt"], lang: "c_cpp" },
		{ files: ["pom.xml", "build.gradle", "build.gradle.kts"], lang: "java" },
	];

	for (const { files, lang } of markers) {
		for (const f of files) {
			if (existsSync(join(cwd, f))) {
				detected.add(lang);
				break;
			}
		}
	}

	// If nothing detected, assume typescript (most common for JS/TS projects without tsconfig)
	if (detected.size === 0) {
		detected.add("typescript");
	}

	return detected;
}

/**
 * Public API — consumed by `rules/loader.ts` after defaults are cloned.
 *
 * Disables quality checks that don't apply to the detected languages.
 * Mutates `checks` in place. Language-agnostic checks (not in
 * `CHECK_LANGUAGE_MAP`) are left alone.
 */
export function autoTuneQualityChecks(
	checks: Record<string, QualityCheckConfig>,
	languages: Set<LanguageId>,
): void {
	for (const [name, check] of Object.entries(checks)) {
		const applicableLangs = CHECK_LANGUAGE_MAP[name];
		if (!applicableLangs) continue; // Language-agnostic check — keep enabled
		const applies = applicableLangs.some((lang) => languages.has(lang));
		if (!applies) {
			check.enabled = false;
		}
	}
}
