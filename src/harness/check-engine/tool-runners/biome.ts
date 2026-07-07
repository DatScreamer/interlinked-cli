// ===========================================
// Tool Runner — Biome
// ===========================================

import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { parseBiomeOutput } from "../output-parsers.js";
import { runProcessAsync } from "../spawn-async.js";
import type { CheckResult, ToolRunnerInput } from "../types.js";

/** Walk up to 5 levels to find biome.json or biome.jsonc. */
function findBiomeConfig(startDir: string): boolean {
	let dir = startDir;
	for (let i = 0; i < 5; i++) {
		if (existsSync(resolve(dir, "biome.json")) || existsSync(resolve(dir, "biome.jsonc")))
			return true;
		const parent = dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
	return false;
}

/** A non-zero biome exit whose output yielded NO parsed diagnostics is a tool
 *  failure (or a diagnostic-format drift), not a clean pass — silence here
 *  read as green (finding 2026-06, round 6; same class as the rustfmt
 *  parse-error suppression). */
function biomeFailureResult(status: number | null): CheckResult {
	return {
		tool: "biome",
		severity: "warning",
		file: ".",
		line: 1,
		message: `biome exited ${status ?? "without status"} but no diagnostics were parsed — lint/format NOT validated for this change`,
	};
}

/** `.claude/` tooling files (workflow scripts with top-level await/return that
 *  biome's parser rejects — "file does not parse") are never shipped source, so
 *  file-mode biome skips them, mirroring tsc's isFileInTscScope exclusion. */
function isClaudeToolingFile(scope: ToolRunnerInput["scope"]): boolean {
	return (
		scope.mode === "file" &&
		!!scope.targetFile &&
		/(^|\/)\.claude\//.test(scope.targetFile.replace(/\\/g, "/"))
	);
}

export function runBiome(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;
	if (!findBiomeConfig(scope.projectRoot)) return [];
	if (isClaudeToolingFile(scope)) return [];

	try {
		// In file mode, check the single file; in project mode, check everything.
		const target = scope.mode === "file" && scope.targetFile ? scope.targetFile : ".";
		const result = spawnSync("npx", ["biome", "check", "--no-errors-on-unmatched", target], {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (result.status === 0) return [];
		const output = (result.stdout || "") + (result.stderr || "");
		const findings = parseBiomeOutput(output);
		return findings.length > 0 ? findings : [biomeFailureResult(result.status)];
	} catch {
		return [];
	}
}

/**
 * Async variant of `runBiome`. Phase A.1 — non-blocking subprocess spawn so
 * `runChecksAsync` can run biome concurrently with tsc/eslint/etc. without
 * any of them blocking the event loop. Behaviorally identical to `runBiome`
 * (same output parser, same exit-code handling).
 */
export async function runBiomeAsync(input: ToolRunnerInput): Promise<CheckResult[]> {
	const { scope, timeoutMs } = input;
	if (!findBiomeConfig(scope.projectRoot)) return [];
	const target = scope.mode === "file" && scope.targetFile ? scope.targetFile : ".";
	const result = await runProcessAsync(
		"npx",
		["biome", "check", "--no-errors-on-unmatched", target],
		{ cwd: scope.projectRoot, timeout: timeoutMs },
	);
	if (result.code === 0) return [];
	const findings = parseBiomeOutput(`${result.stdout}${result.stderr}`);
	return findings.length > 0 ? findings : [biomeFailureResult(result.code)];
}

/**
 * Run biome against in-memory content, as if the content were the file at
 * `filePath`. Used by the PreToolUse diff-overlay pre-block to detect
 * whether a proposed edit introduces new biome findings before it lands.
 *
 * Implementation note: biome's `--stdin-file-path` mode is format-oriented
 * and suppresses diagnostic output (only prints "contents aren't fixed").
 * To get full diagnostics, we write the overlay content to a sibling
 * temp file in the same directory, run `biome check` on it, then delete.
 * Same-directory placement ensures biome resolves the same config and
 * path-scoped overrides (e.g. `src/ui/**`) as the real file.
 *
 * Temp file naming: `<base>.overlay-<pid>-<ts>.<ext>`. No dotfile prefix,
 * so biome/gitignore default rules don't skip it.
 *
 * Cleanup is in a finally block — best-effort. A stray overlay file
 * would fail subsequent edits only if biome flags something new, which
 * the next overlay run would re-expose.
 */
export function runBiomeOverlay(input: {
	projectRoot: string;
	timeoutMs: number;
	filePath: string;
	content: string;
}): CheckResult[] {
	const { projectRoot, timeoutMs, filePath, content } = input;
	if (!findBiomeConfig(projectRoot)) return [];

	const dir = dirname(filePath);
	const ext = extname(filePath);
	const base = basename(filePath, ext);
	const tmpPath = join(dir, `${base}.overlay-${process.pid}-${Date.now()}${ext}`);

	try {
		writeFileSync(tmpPath, content);
		const result = spawnSync("npx", ["biome", "check", "--no-errors-on-unmatched", tmpPath], {
			cwd: projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (result.status === 0) return [];
		const output = (result.stdout || "") + (result.stderr || "");
		const findings = parseBiomeOutput(output);
		// Rewrite tmp-file paths back to the target file path so downstream
		// diffing (by file + ruleId) sees the same path as the cached
		// pre-edit diagnostics.
		const tmpRel = relative(projectRoot, tmpPath);
		const targetRel = relative(projectRoot, filePath);
		return findings.map((f) =>
			f.file === tmpRel || f.file === tmpPath ? { ...f, file: targetRel } : f,
		);
	} catch {
		return [];
	} finally {
		try {
			unlinkSync(tmpPath);
		} catch {
			/* intentional: best-effort cleanup of overlay temp file */
		}
	}
}
