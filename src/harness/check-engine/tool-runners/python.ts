// ===========================================
// Tool Runners — Python (mypy, ruff)
// ===========================================

import { spawnSync } from "node:child_process";
import { parseMypyOutput, parseRuffJson } from "../output-parsers.js";
import { runProcessAsync } from "../spawn-async.js";
import type { CheckResult, ToolRunnerInput } from "../types.js";

// -------------------------------------------
// mypy
// -------------------------------------------

export function runMypy(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		const args = ["--no-error-summary", "--no-color-output"];
		if (scope.mode === "file" && scope.targetFile) {
			args.push(scope.targetFile);
		} else {
			args.push(".");
		}

		const result = spawnSync("mypy", args, {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		// Exit 0 = success, exit 1 = type errors found
		if (result.status === 0) return [];

		const output = (result.stdout || "") + (result.stderr || "");
		return parseMypyOutput(output);
	} catch {
		return [];
	}
}

// -------------------------------------------
// ruff
// -------------------------------------------

export function runRuff(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		const args = ["check", "--output-format=json"];
		if (scope.mode === "file" && scope.targetFile) {
			args.push(scope.targetFile);
		} else {
			args.push(".");
		}

		const result = spawnSync("ruff", args, {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		// Exit 0 = clean, exit 1 = violations found
		if (result.status === 0) return [];

		const output = (result.stdout || "").trim();
		if (!output) return [];
		return parseRuffJson(output);
	} catch {
		return [];
	}
}

// -------------------------------------------
// Async variants — Phase A.1
// -------------------------------------------

export async function runMypyAsync(input: ToolRunnerInput): Promise<CheckResult[]> {
	const { scope, timeoutMs } = input;
	const args = ["--no-error-summary", "--no-color-output"];
	args.push(scope.mode === "file" && scope.targetFile ? scope.targetFile : ".");
	const result = await runProcessAsync("mypy", args, {
		cwd: scope.projectRoot,
		timeout: timeoutMs,
	});
	if (result.code === null || result.code === 0) return [];
	return parseMypyOutput(`${result.stdout}${result.stderr}`);
}

export async function runRuffAsync(input: ToolRunnerInput): Promise<CheckResult[]> {
	const { scope, timeoutMs } = input;
	const args = ["check", "--output-format=json"];
	args.push(scope.mode === "file" && scope.targetFile ? scope.targetFile : ".");
	const result = await runProcessAsync("ruff", args, {
		cwd: scope.projectRoot,
		timeout: timeoutMs,
	});
	if (result.code === null || result.code === 0) return [];
	const output = result.stdout.trim();
	if (!output) return [];
	return parseRuffJson(output);
}
