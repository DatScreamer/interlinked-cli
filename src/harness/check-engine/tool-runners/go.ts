// ===========================================
// Tool Runners — Go (go build, golangci-lint)
// ===========================================

import { spawnSync } from "node:child_process";
import {
	filterResultsToFile,
	parseGoBuildOutput,
	parseGolangciLintJson,
} from "../output-parsers.js";
import type { CheckResult, ToolRunnerInput } from "../types.js";

// -------------------------------------------
// go build
// -------------------------------------------

export function runGoBuild(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		// go build is always project-wide (./...)
		const result = spawnSync("go", ["build", "./..."], {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		if (result.status === 0) return [];

		// go build errors go to stderr
		const output = (result.stderr || "") + (result.stdout || "");
		const results = parseGoBuildOutput(output);

		if (scope.mode === "file" && scope.targetFile && scope.filterToFile) {
			return filterResultsToFile(results, scope.targetFile);
		}
		return results;
	} catch {
		return [];
	}
}

// -------------------------------------------
// golangci-lint
// -------------------------------------------

export function runGolangciLint(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		// golangci-lint always runs project-wide; filter for file mode
		const result = spawnSync("golangci-lint", ["run", "--out-format=json", "./..."], {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		// Exit 0 = clean, exit 1 = issues found
		// Exit 3 = analysis failure, exit 4 = timeout — skip silently
		if (result.status === 0 || result.status === 3 || result.status === 4) return [];

		const output = (result.stdout || "").trim();
		if (!output) return [];
		const results = parseGolangciLintJson(output);

		if (scope.mode === "file" && scope.targetFile && scope.filterToFile) {
			return filterResultsToFile(results, scope.targetFile);
		}
		return results;
	} catch {
		return [];
	}
}
