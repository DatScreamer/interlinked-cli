// ===========================================
// Project Root Resolution
// ===========================================
// Walks up from a file path to find the project root. Extracted from
// quality-checks.ts so the check-engine can reuse the resolution without
// pulling in the full quality-checks module.

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { findProjectRootForLanguage, getProfileForFile } from "../language-profiles.js";

/**
 * Public API — consumed by quality-checks.runQualityChecks.
 *
 * Walk up from a file path to find the project root.
 * Uses language profiles to check for language-specific root markers
 * (Cargo.toml, pyproject.toml, go.mod, etc.) before falling back to
 * tsconfig.json / package.json for TS/JS.
 */
export function findProjectRoot(filePath: string, harnessCwd: string): string | null {
	const absPath = isAbsolute(filePath) ? filePath : resolve(harnessCwd, filePath);
	const profile = getProfileForFile(absPath);
	if (profile) {
		const root = findProjectRootForLanguage(absPath, profile);
		if (root) return root;
	}

	// Fallback: walk up looking for tsconfig.json then package.json
	let dir = dirname(absPath);
	const fsRoot = dirname(dir) === dir ? dir : "/";

	while (dir !== fsRoot && dir.length > 1) {
		if (existsSync(resolve(dir, "tsconfig.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	dir = dirname(absPath);
	while (dir !== fsRoot && dir.length > 1) {
		if (existsSync(resolve(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return null;
}
