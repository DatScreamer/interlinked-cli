// Agent Safety Checks — Import hygiene / dependency safety.
// Deterministic regex/heuristic checks targeting common AI agent mistakes.
// Extracted from agent-safety.ts to stay under the per-file line ceiling.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";
import { nonNull } from "../../lib/non-null.js";
import {
	getExtension,
	type InlineMatch,
	isTestFile,
	JS_TS_EXTS,
	stripCommentsAndStrings,
} from "./shared.js";

// --- 2. Import Hygiene ---

/**
 * Detect self-imports: a module importing from itself (causes infinite loops or empty values).
 */
export function checkSelfImport(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	// Get the base filename without extension for matching
	const base = basename(filePath).replace(/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/, "");

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 5) break;
		const trimmed = nonNull(strippedLines[i]).trim();
		if (!/^import\s/.test(trimmed)) continue;
		// Match: from "./same-file" or from "./same-file.js"
		const fromMatch = trimmed.match(/from\s+['"]([^'"]+)['"]/);
		if (!fromMatch) continue;
		const specifier = fromMatch[1];
		if (!nonNull(specifier).startsWith(".")) continue;
		const importBase = nonNull(specifier)
			.split("/")
			.pop()
			?.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
		if (importBase === base) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
		}
	}
	return matches;
}

/**
 * Detect extraneous dependencies: bare-specifier imports not found in package.json.
 * Requires reading package.json once (cached per filePath directory).
 */
const _pkgDepsCache = new Map<string, Set<string>>();

export function checkExtraneousDependencies(content: string, filePath: string): InlineMatch[] {
	if (!JS_TS_EXTS.has(getExtension(filePath))) return [];
	if (isTestFile(filePath)) return [];

	// Find nearest package.json
	let pkgDir = dirname(filePath);
	let pkgDeps: Set<string> | undefined;
	for (let i = 0; i < 5; i++) {
		const cached = _pkgDepsCache.get(pkgDir);
		if (cached) {
			pkgDeps = cached;
			break;
		}
		const pkgPath = join(pkgDir, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
				const deps = new Set<string>([
					...Object.keys(pkg.dependencies || {}),
					...Object.keys(pkg.devDependencies || {}),
					...Object.keys(pkg.peerDependencies || {}),
					...Object.keys(pkg.optionalDependencies || {}),
				]);
				// Add Node.js built-in modules
				for (const mod of [
					"fs",
					"path",
					"os",
					"url",
					"http",
					"https",
					"crypto",
					"util",
					"stream",
					"events",
					"child_process",
					"net",
					"tls",
					"dns",
					"assert",
					"buffer",
					"querystring",
					"zlib",
					"readline",
					"cluster",
					"worker_threads",
					"perf_hooks",
					"async_hooks",
					"v8",
					"vm",
					"tty",
					"dgram",
					"inspector",
					"trace_events",
					"string_decoder",
					"module",
					"process",
					"timers",
					"console",
				]) {
					deps.add(mod);
					deps.add(`node:${mod}`);
				}
				_pkgDepsCache.set(pkgDir, deps);
				pkgDeps = deps;
				break;
			} catch {
				break;
			}
		}
		const parent = dirname(pkgDir);
		if (parent === pkgDir) break;
		pkgDir = parent;
	}
	if (!pkgDeps) return [];

	const stripped = stripCommentsAndStrings(content);
	const originalLines = content.split("\n");
	const strippedLines = stripped.split("\n");
	const matches: InlineMatch[] = [];

	for (let i = 0; i < strippedLines.length; i++) {
		if (matches.length >= 10) break;
		const trimmed = nonNull(strippedLines[i]).trim();
		if (!/^import\s/.test(trimmed) && !/\brequire\s*\(/.test(trimmed)) continue;

		const fromMatch = trimmed.match(/(?:from\s+|require\s*\(\s*)['"]([^'"]+)['"]/);
		if (!fromMatch) continue;
		const specifier = nonNull(fromMatch[1]);

		// Skip relative imports, aliases (@/), and runtime protocol imports
		if (specifier.startsWith(".") || specifier.startsWith("@/") || specifier.startsWith("#"))
			continue;
		// node:, cloudflare:, bun:, deno: are runtime built-in protocols — never in package.json
		if (/^(node|cloudflare|bun|deno):/.test(specifier)) continue;

		// Extract package name (handle scoped packages @org/pkg)
		const pkgName = specifier.startsWith("@")
			? specifier.split("/").slice(0, 2).join("/")
			: nonNull(specifier.split("/")[0]);

		if (!pkgDeps.has(pkgName)) {
			matches.push({ line: i + 1, text: nonNull(originalLines[i]).trim().slice(0, 150) });
		}
	}
	return matches;
}

// --- 2b. Phantom Dependency Detection (Supply Chain) ---

/**
 * Detect phantom dependencies: packages listed in `dependencies` but never
 * imported/required by any source file in the project. A key indicator of
 * supply chain attacks — e.g., the axios@1.14.1 compromise added
 * 'plain-crypto-js' as a phantom dependency whose sole purpose was running
 * a malicious postinstall script.
 *
 * Only checks `dependencies` (not devDependencies, which are often CLI tools).
 * Skips @types/* packages and known non-imported patterns.
 */
export function checkPhantomDependencies(pkgJsonPath: string): InlineMatch[] {
	if (!existsSync(pkgJsonPath)) return [];

	let content: string;
	let pkg: JsonObject;
	try {
		content = readFileSync(pkgJsonPath, "utf-8");
		pkg = JSON.parse(content);
	} catch {
		return [];
	}

	const deps = pkg.dependencies as Record<string, string> | undefined;
	if (!deps || typeof deps !== "object") return [];

	const depNames = Object.keys(deps);
	if (depNames.length === 0) return [];

	// Workspace-aware search root: in a monorepo, deps declared in
	// `packages/foo/package.json` may be imported from `packages/bar/`.
	// Scoping the grep to the immediate package dir produces false-positive
	// "phantom dep" warnings on every monorepo, training agents to ignore
	// the warning by the time a real supply-chain phantom shows up.
	const searchRoot = findWorkspaceRootFor(pkgJsonPath);
	const matches: InlineMatch[] = [];
	const lines = content.split("\n");

	for (const dep of depNames) {
		if (matches.length >= 10) break;

		// Skip @types/* (type-only, never imported at runtime)
		if (dep.startsWith("@types/")) continue;

		if (!_isDepReferencedInProject(dep, searchRoot)) {
			const lineIdx = lines.findIndex((l) => l.includes(`"${dep}"`));
			matches.push({
				line: lineIdx >= 0 ? lineIdx + 1 : 1,
				text: `Phantom dependency: "${dep}" is in dependencies but never referenced in project source. Supply chain risk — dependencies should be imported somewhere.`,
			});
		}
	}

	return matches;
}

/**
 * Walk upward from a `package.json` looking for a workspace marker:
 * `pnpm-workspace.yaml`, or a parent `package.json` with a `workspaces`
 * field. Returns the workspace root if found, otherwise the immediate
 * package directory. Capped at 8 levels so we don't escape into the user's
 * home directory on a stray invocation.
 *
 * Matters for phantom-dep / cross-package import checks: in a monorepo,
 * scoping the source-search to a single package is the failure mode.
 */
export function findWorkspaceRootFor(pkgJsonPath: string): string {
	const startDir = dirname(pkgJsonPath);
	let dir = startDir;
	for (let i = 0; i < 8; i++) {
		const parent = dirname(dir);
		if (parent === dir) break;
		if (existsSync(join(parent, "pnpm-workspace.yaml"))) {
			return parent;
		}
		const parentPkg = join(parent, "package.json");
		if (existsSync(parentPkg)) {
			try {
				const raw = readFileSync(parentPkg, "utf-8");
				const json = JSON.parse(raw) as JsonObject;
				if (json.workspaces !== undefined) return parent;
			} catch {
				// Best-effort — unreadable parent package.json doesn't decide the question.
			}
		}
		dir = parent;
	}
	return startDir;
}

/**
 * Check if a dependency name appears anywhere in the project's source files
 * (excluding node_modules, lock files, and package.json itself).
 * Uses grep -rqI for fast short-circuit search.
 */
function _isDepReferencedInProject(depName: string, projectDir: string): boolean {
	try {
		execFileSync(
			"grep",
			[
				"-rqI",
				"--exclude-dir=node_modules",
				"--exclude-dir=.git",
				"--exclude-dir=dist",
				"--exclude-dir=build",
				"--exclude-dir=.next",
				"--exclude-dir=coverage",
				"--exclude=package.json",
				"--exclude=package-lock.json",
				"--exclude=yarn.lock",
				"--exclude=pnpm-lock.yaml",
				"--exclude=bun.lockb",
				depName,
				projectDir,
			],
			{ timeout: 5000, stdio: "pipe" },
		);
		return true; // exit 0 = found
	} catch {
		return false; // exit 1 = not found, or timeout
	}
}
