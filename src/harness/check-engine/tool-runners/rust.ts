// ===========================================
// Tool Runners — Rust (cargo check, cargo clippy)
// ===========================================

import { spawnSync } from "node:child_process";
import { filterResultsToFile, parseCargoJson } from "../output-parsers.js";
import type { CheckResult, ToolRunnerInput } from "../types.js";

// -------------------------------------------
// cargo check
// -------------------------------------------

export function runCargoCheck(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		// cargo check is always project-wide
		const result = spawnSync("cargo", ["check", "--message-format=json"], {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		// Exit 0 = clean, exit 101 = compilation errors
		if (result.status === 0) return [];

		const output = (result.stdout || "") + (result.stderr || "");
		const results = parseCargoJson(output, "cargo-check");

		// In file mode, filter to the target file
		if (scope.mode === "file" && scope.targetFile && scope.filterToFile) {
			return filterResultsToFile(results, scope.targetFile);
		}
		return results;
	} catch {
		return [];
	}
}

// -------------------------------------------
// cargo clippy
// -------------------------------------------

export function runCargoClippy(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		const result = spawnSync(
			"cargo",
			["clippy", "--message-format=json", "--", "-W", "clippy::all"],
			{
				cwd: scope.projectRoot,
				timeout: timeoutMs,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);

		if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		if (result.status === 0) return [];

		const output = (result.stdout || "") + (result.stderr || "");
		const results = parseCargoJson(output, "cargo-clippy");

		if (scope.mode === "file" && scope.targetFile && scope.filterToFile) {
			return filterResultsToFile(results, scope.targetFile);
		}
		return results;
	} catch {
		return [];
	}
}
