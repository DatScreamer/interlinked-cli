// ===========================================
// Project Root Resolution
// ===========================================
// Walks up from a file path to find the project root. Extracted from
// quality-checks.ts so the check-engine can reuse the resolution without
// pulling in the full quality-checks module.

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { findProjectRootForLanguage, getProfileForFile } from "../language-profiles.js";

/**
 * Returns `candidate` only when it is `harnessCwd` itself or a descendant of
 * `harnessCwd`; otherwise returns `null`.
 *
 * Incident: a file edited OUTSIDE the harness project caused the upward
 * marker walk to escape to `$HOME` (the user had a stray `~/package.json`),
 * after which the harness crawled an enormous foreign tree (11-19s per tool
 * call). Clamping every project-root return to within `harnessCwd` makes
 * that escape impossible — callers already treat `null` as "no root".
 */
function clampToCwd(candidate: string | null, harnessCwd: string): string | null {
	if (!candidate) return null;
	const resolvedCandidate = resolve(candidate);
	const resolvedCwd = resolve(harnessCwd);
	if (resolvedCandidate === resolvedCwd || resolvedCandidate.startsWith(resolvedCwd + sep)) {
		return resolvedCandidate;
	}
	return null;
}

/**
 * Public API — consumed by quality-checks.runQualityChecks.
 *
 * Walk up from a file path to find the project root.
 * Uses language profiles to check for language-specific root markers
 * (Cargo.toml, pyproject.toml, go.mod, etc.) before falling back to
 * tsconfig.json / package.json for TS/JS.
 *
 * The returned root is guaranteed to be `harnessCwd` or a descendant of it
 * (see `clampToCwd`); a marker found above `harnessCwd` yields `null`.
 */
export function findProjectRoot(filePath: string, harnessCwd: string): string | null {
	const absPath = isAbsolute(filePath) ? filePath : resolve(harnessCwd, filePath);
	const resolvedCwd = resolve(harnessCwd);
	const profile = getProfileForFile(absPath);
	if (profile) {
		const root = findProjectRootForLanguage(absPath, profile);
		if (root) {
			const clamped = clampToCwd(root, resolvedCwd);
			if (clamped) return clamped;
		}
	}

	// Fallback: walk up looking for tsconfig.json then package.json.
	// The loop stops once `dir` leaves `harnessCwd` — both for correctness
	// (never adopt a foreign root) and for perf (no walk to `$HOME`).
	const withinCwd = (dir: string): boolean =>
		dir === resolvedCwd || dir.startsWith(resolvedCwd + sep);

	let dir = dirname(absPath);
	const fsRoot = dirname(dir) === dir ? dir : "/";

	while (dir !== fsRoot && dir.length > 1 && withinCwd(dir)) {
		if (existsSync(resolve(dir, "tsconfig.json"))) return clampToCwd(dir, resolvedCwd);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	dir = dirname(absPath);
	while (dir !== fsRoot && dir.length > 1 && withinCwd(dir)) {
		if (existsSync(resolve(dir, "package.json"))) return clampToCwd(dir, resolvedCwd);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return null;
}
