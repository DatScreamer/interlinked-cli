// ===========================================
// Tool Runner — TypeScript (tsc / tsgo)
// ===========================================
// Prefers tsgo (TypeScript 7 native Go compiler) when available.
// Falls back to tsc transparently. Output format is identical.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { filterResultsToFile, parseTscOutput } from "../output-parsers.js";
import type { CheckResult, ToolRunnerInput } from "../types.js";

/** Walk up from startDir to find tsconfig.json (max 5 levels). */
function findTsconfig(startDir: string): string | null {
	let dir = startDir;
	for (let i = 0; i < 5; i++) {
		if (existsSync(resolve(dir, "tsconfig.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

// -------------------------------------------
// tsgo detection (cached per process)
// -------------------------------------------
// Resolves tsgo from the CLI's own dependencies first, so it works in any
// codebase the harness runs in — not just projects that have
// @typescript/native-preview installed locally.

/** Cached result: absolute path to tsgo.js, "npx", or null (not available). */
let _tsgoResolved: { bin: string; viaNode: boolean } | null | undefined;

/**
 * Resolve the tsgo binary. Priority:
 * 1. CLI's own node_modules (via createRequire — works even in foreign projects)
 * 2. Target project's npx (in case they pin a different version)
 * 3. null → fall back to tsc
 */
function resolveTsgo(): { bin: string; viaNode: boolean } | null {
	if (_tsgoResolved !== undefined) return _tsgoResolved;

	// 1. Try resolving from the CLI's own dependency tree
	try {
		const require = createRequire(import.meta.url);
		const pkgPath = require.resolve("@typescript/native-preview/package.json");
		const tsgoBin = resolve(dirname(pkgPath), "bin", "tsgo.js");
		if (existsSync(tsgoBin)) {
			// Verify it actually runs
			const check = spawnSync("node", [tsgoBin, "--version"], {
				timeout: 5_000,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			if (check.status === 0 && !check.error) {
				_tsgoResolved = { bin: tsgoBin, viaNode: true };
				return _tsgoResolved;
			}
		}
	} catch (_err) {
		void 0; /* intentional: not resolvable from CLI deps — fall through to npx fallback */
	}

	// 2. Try npx (target project's own install)
	try {
		const result = spawnSync("npx", ["tsgo", "--version"], {
			timeout: 5_000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (result.status === 0 && !result.error) {
			_tsgoResolved = { bin: "tsgo", viaNode: false };
			return _tsgoResolved;
		}
	} catch (_err) {
		void 0; /* intentional: not available via npx either — return null below */
	}

	_tsgoResolved = null;
	return null;
}

/** Returns the resolved tsgo info, or null to fall back to tsc. */
function tscCommand(): { cmd: string; args: string[]; useTsgo: boolean } {
	const tsgo = resolveTsgo();
	if (tsgo) {
		if (tsgo.viaNode) {
			// Direct invocation: node /abs/path/to/tsgo.js
			return { cmd: "node", args: [tsgo.bin], useTsgo: true };
		}
		// npx invocation
		return { cmd: "npx", args: ["tsgo"], useTsgo: true };
	}
	return { cmd: "npx", args: ["tsc"], useTsgo: false };
}

export function runTsc(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;
	const tscRoot = findTsconfig(scope.projectRoot);
	const { cmd, args: cmdArgs } = tscCommand();

	// If no tsconfig found but we have a specific .ts file, type-check it standalone.
	// This catches standalone scripts (hooks, configs) outside any tsconfig project.
	if (!tscRoot) {
		if (scope.mode === "file" && scope.targetFile?.match(/\.tsx?$/)) {
			return runTscStandalone(scope.targetFile, scope.projectRoot, timeoutMs);
		}
		return [];
	}

	try {
		const result = spawnSync(cmd, [...cmdArgs, "--noEmit", "--pretty", "false"], {
			cwd: tscRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		const output = (result.stdout || "") + (result.stderr || "");
		const parsed = parseTscOutput(output);

		if (scope.mode === "file" && scope.targetFile && scope.filterToFile) {
			const rel = relative(tscRoot, scope.targetFile);
			// Also check if the file is outside the tsconfig's scope (e.g., hooks, scripts)
			const filtered = filterResultsToFile(parsed, rel);
			if (filtered.length === 0 && !isFileInTscScope(scope.targetFile, tscRoot)) {
				return runTscStandalone(scope.targetFile, tscRoot, timeoutMs);
			}
			return filtered;
		}

		return parsed;
	} catch {
		return [];
	}
}

/**
 * Type-check a standalone .ts file that isn't part of any tsconfig project.
 * Uses minimal compiler options to catch obvious errors (missing types, bad imports).
 */
function runTscStandalone(filePath: string, cwd: string, timeoutMs: number): CheckResult[] {
	const { cmd, args: cmdArgs, useTsgo } = tscCommand();
	try {
		const args = [
			...cmdArgs,
			"--noEmit",
			"--pretty",
			"false",
			// tsgo requires --ignoreConfig when passing files on the command line
			// in the presence of a tsconfig.json, otherwise it errors with TS5112.
			...(useTsgo ? ["--ignoreConfig"] : []),
			"--esModuleInterop",
			"--module",
			"nodenext",
			"--moduleResolution",
			"nodenext",
			"--target",
			"es2022",
			"--skipLibCheck",
			filePath,
		];

		const result = spawnSync(cmd, args, {
			cwd,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		const output = (result.stdout || "") + (result.stderr || "");
		return parseTscOutput(output);
	} catch {
		return [];
	}
}

/** Check if a file is included in the tsconfig's compilation scope. */
function isFileInTscScope(filePath: string, tscRoot: string): boolean {
	try {
		// Quick heuristic: check if the file is under a directory referenced by tsconfig
		const rel = relative(tscRoot, filePath);
		// Files outside the tsconfig root (../) are definitely not in scope
		if (rel.startsWith("..")) return false;
		// Files in common non-source directories are likely not in scope
		if (
			rel.startsWith(".claude/") ||
			rel.startsWith(".interlinked/") ||
			rel.startsWith("scripts/")
		)
			return false;
		return true;
	} catch {
		return true;
	}
}
