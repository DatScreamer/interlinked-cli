// Project setup validation checks.
// Extracted from generic-checks.ts.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { JsonObject } from "../../lib/json-types.js";

/**
 * Read every dependency name from a package.json into a flat record.
 * Best-effort: returns {} on any read or parse error. Includes peer- and
 * optional-dependencies because a `types: ["X"]` entry is satisfied by any
 * declared install relationship — peer deps are still installed by consumers.
 */
function readAllDeps(pkgJsonPath: string): Record<string, string> {
	try {
		const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as JsonObject;
		return {
			...((pkg.dependencies as Record<string, string>) || {}),
			...((pkg.devDependencies as Record<string, string>) || {}),
			...((pkg.peerDependencies as Record<string, string>) || {}),
			...((pkg.optionalDependencies as Record<string, string>) || {}),
		};
	} catch {
		return {};
	}
}

// ===========================================
// Project Setup Validation
// ===========================================

export interface ProjectSetupIssue {
	check: string;
	file: string;
	line: number;
	message: string;
	fix: string;
}

/**
 * Cross-check `compilerOptions.types: ["X"]` against installed deps. tsc
 * fails with cryptic global-name errors when an entry isn't installed. The
 * universal shape — applies to "@cloudflare/workers-types", "vitest",
 * "bun-types", "@types/node", anything in types[].
 *
 * Resolution rule: scoped names (`@org/pkg`) only match the exact package;
 * unscoped names (`vitest`, `node`) match either the package itself or
 * `@types/<name>` (DefinitelyTyped fallback).
 */
export function checkTsConfigTypesAgainstDeps(
	compilerOptions: JsonObject,
	tsconfigDir: string,
): ProjectSetupIssue[] {
	const types = compilerOptions.types;
	if (!Array.isArray(types) || types.length === 0) return [];
	const allDeps = readAllDeps(resolve(tsconfigDir, "package.json"));
	const issues: ProjectSetupIssue[] = [];
	for (const entry of types) {
		if (typeof entry !== "string" || !entry) continue;
		const isScoped = entry.startsWith("@");
		const installed = isScoped
			? entry in allDeps
			: entry in allDeps || `@types/${entry}` in allDeps;
		if (installed) continue;
		const candidate = isScoped ? entry : `@types/${entry}`;
		const detail = isScoped
			? `"${entry}" is not in package.json`
			: `neither "${entry}" nor "@types/${entry}" is in package.json`;
		issues.push({
			check: "project_setup",
			file: "tsconfig.json",
			line: 0,
			message: `tsconfig.json includes types: ["${entry}"] but ${detail}. tsc will fail to resolve these globals.`,
			fix: `Run \`npm i --save-dev ${candidate}\``,
		});
	}
	return issues;
}

/**
 * Detect common project setup issues that cause confusing compiler errors.
 * Runs once per project (not per-file). Returns actionable fix instructions.
 */
export function checkProjectSetup(cwd: string): ProjectSetupIssue[] {
	const issues: ProjectSetupIssue[] = [];

	// Find tsconfig.json (walk up)
	let tsconfigDir: string | null = null;
	let searchDir = cwd;
	for (let i = 0; i < 5; i++) {
		if (existsSync(resolve(searchDir, "tsconfig.json"))) {
			tsconfigDir = searchDir;
			break;
		}
		const parent = dirname(searchDir);
		if (parent === searchDir) break;
		searchDir = parent;
	}

	// Check if this is a TypeScript project (has .ts files in src/ or root)
	const hasTypeScriptFiles = (() => {
		const dirs = [resolve(cwd, "src"), cwd];
		for (const d of dirs) {
			try {
				const files = readdirSync(d, { recursive: true });
				if (
					files.some(
						(f) => typeof f === "string" && (f.endsWith(".ts") || f.endsWith(".tsx")),
					)
				)
					return true;
			} catch {
				// intentional: best-effort TypeScript-presence probe; an
				// unreadable candidate directory shouldn't block the scan.
			}
		}
		return false;
	})();

	if (!hasTypeScriptFiles) return issues;

	// Issue: No tsconfig.json
	if (!tsconfigDir) {
		issues.push({
			check: "project_setup",
			file: "tsconfig.json",
			line: 0,
			message: "TypeScript files found but no tsconfig.json exists",
			fix: "Run `npx tsc --init` to create a tsconfig.json",
		});
		return issues;
	}

	// Read and parse tsconfig
	let tsconfig: JsonObject = {};
	try {
		const raw = readFileSync(resolve(tsconfigDir, "tsconfig.json"), "utf-8");
		tsconfig = JSON.parse(raw);
	} catch {
		issues.push({
			check: "project_setup",
			file: "tsconfig.json",
			line: 0,
			message: "tsconfig.json exists but cannot be parsed (invalid JSON)",
			fix: "Fix the JSON syntax in tsconfig.json",
		});
		return issues;
	}

	const compilerOptions = (tsconfig.compilerOptions || {}) as JsonObject;

	// Check for node:* protocol imports in source files
	const hasNodeProtocolImports = (() => {
		const srcDirs = [resolve(cwd, "src"), cwd];
		for (const srcDir of srcDirs) {
			try {
				const files = readdirSync(srcDir, { recursive: true });
				for (const f of files) {
					if (typeof f !== "string" || !f.endsWith(".ts")) continue;
					try {
						const content = readFileSync(resolve(srcDir, f), "utf-8");
						if (/from\s+["']node:/.test(content)) return true;
					} catch {
						// intentional: best-effort read; an unreadable file
						// just means we fail the node-imports probe for this entry.
					}
				}
			} catch {
				// intentional: best-effort directory walk; skip to the next entry.
			}
		}
		return false;
	})();

	// Issue: Uses node: imports but @types/node not installed
	if (hasNodeProtocolImports) {
		const pkgPath = resolve(tsconfigDir, "package.json");
		let hasTypesNode = false;
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
			const allDeps = {
				...(pkg.dependencies || {}),
				...(pkg.devDependencies || {}),
			};
			hasTypesNode = "@types/node" in allDeps;
		} catch {
			// intentional: best-effort package.json probe — absence or parse
			// failure just means we can't confirm @types/node is installed.
		}

		if (!hasTypesNode) {
			issues.push({
				check: "project_setup",
				file: "package.json",
				line: 0,
				message:
					"Code uses node: protocol imports (node:fs, node:path, etc.) but @types/node is not in devDependencies",
				fix: "Run `npm i --save-dev @types/node`",
			});
		}

		// Check tsconfig types field includes "node"
		const typesForNode = compilerOptions.types as string[] | undefined;
		if (typesForNode && !typesForNode.includes("node")) {
			issues.push({
				check: "project_setup",
				file: "tsconfig.json",
				line: 0,
				message:
					'tsconfig.json has a "types" field but "node" is not included — node: imports will fail',
				fix: 'Add "node" to the "types" array in compilerOptions',
			});
		}
	}

	issues.push(...checkTsConfigTypesAgainstDeps(compilerOptions, tsconfigDir));

	// Issue: Wrong moduleResolution for node: imports
	const moduleResolution = compilerOptions.moduleResolution as string | undefined;
	if (
		hasNodeProtocolImports &&
		moduleResolution &&
		!["node16", "nodenext", "bundler"].includes(moduleResolution.toLowerCase())
	) {
		issues.push({
			check: "project_setup",
			file: "tsconfig.json",
			line: 0,
			message: `moduleResolution "${moduleResolution}" may not resolve node: protocol imports`,
			fix: 'Set "moduleResolution": "node16" or "bundler" in compilerOptions',
		});
	}

	// Issue: strict mode disabled
	if (compilerOptions.strict !== true) {
		issues.push({
			check: "project_setup",
			file: "tsconfig.json",
			line: 0,
			message:
				"TypeScript strict mode is not enabled — agents produce safer code with strict checks",
			fix: 'Add "strict": true to compilerOptions',
		});
	}

	return issues;
}
