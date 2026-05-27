// Import policy checks — module-graph hygiene.
// Effect-TS lessons port (docs/design/effect-ts-harness-additions.md §2.3).

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";

const BARREL_LOCAL_SPECIFIERS = new Set([
	".",
	"./",
	"./index",
	"./index.js",
	"./index.ts",
	"./index.mjs",
	"./index.cjs",
	"./index.jsx",
	"./index.tsx",
]);

const _pkgNameCache = new Map<string, string | null>();

/** Resolve the `name` field of the nearest package.json walking up from `startDir`. */
function nearestPackageName(startDir: string): string | null {
	let dir = startDir;
	for (let i = 0; i < 6; i++) {
		const cached = _pkgNameCache.get(dir);
		if (cached !== undefined) return cached;
		const pkgPath = join(dir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: unknown };
				const name = typeof pkg.name === "string" && pkg.name.length > 0 ? pkg.name : null;
				_pkgNameCache.set(dir, name);
				return name;
			} catch {
				_pkgNameCache.set(dir, null);
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * Detect imports from the file's own package barrel.
 *
 * Two patterns flagged, both forming latent module-init-order hazards:
 *   1. Local barrel re-import — file at `<dir>/<x>.ts` imports from `./index`,
 *      `./`, etc. The barrel re-exports `<x>` itself, so loading order
 *      depends on file-resolution and breaks tree-shaking.
 *   2. Own-package re-import — file inside a published package whose
 *      package.json declares `"name": "foo"` imports from `"foo"`. Same
 *      bug class, surfaces as a cycle through the published entrypoint.
 *
 * Effect's `@effect/no-import-from-barrel-package` rule catches the second
 * shape; the first generalizes to any project structure.
 *
 * Skips: test files, non-JS/TS files, and the barrel file itself
 * (`<dir>/index.ts` legitimately re-exports its siblings).
 */
export function checkImportFromOwnBarrel(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	// Skip the barrel itself — index.ts is allowed to re-export from siblings.
	const base = basename(filePath, extname(filePath));
	if (base === "index") return [];

	// Strings get stripped to empty `""` for comment-filtering, so the line
	// presence/leading-keyword check runs on stripped lines while specifier
	// extraction reads from the original.
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	const ownPackageName = nearestPackageName(dirname(filePath));

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 5) break;
		const strippedTrimmed = strippedLines[i].trim();
		if (!/^(?:import|export)\b/.test(strippedTrimmed)) continue;
		// Confirm it's actually an `import ... from <spec>` or `export ... from <spec>`
		// shape, not e.g. `export function ...`. The original line carries the spec.
		const originalLine = originalLines[i] ?? "";
		const fromMatch = originalLine.match(/\bfrom\s+['"]([^'"]+)['"]/);
		if (!fromMatch) continue;
		const specifier = fromMatch[1];

		if (BARREL_LOCAL_SPECIFIERS.has(specifier)) {
			matches.push({
				line: i + 1,
				text: `imports from own-directory barrel '${specifier}' — import from the sibling submodule directly: ${(originalLines[i] ?? "").trim().slice(0, 120)}`,
			});
			continue;
		}

		if (ownPackageName !== null && specifier === ownPackageName) {
			matches.push({
				line: i + 1,
				text: `imports from own package '${ownPackageName}' — use a deep submodule path instead: ${(originalLines[i] ?? "").trim().slice(0, 120)}`,
			});
			continue;
		}
	}

	return matches;
}

/** Exported for tests so the package-name cache can be cleared between runs. */
export function _resetPackageNameCacheForTests(): void {
	_pkgNameCache.clear();
}
