// ===========================================
// Tool Runner — actionlint
// ===========================================
// GitHub Actions workflow file validator. Detects syntax errors,
// invalid expressions, unknown action versions, and type mismatches.
// Output format: "file:line:col: message [rule-name]"

import { spawnSync } from "node:child_process";
import { relative } from "node:path";
import { parseActionlintOutput } from "../output-parsers.js";
import type { CheckResult, ToolRunnerInput } from "../types.js";

export function runActionlint(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		const args = scope.mode === "file" && scope.targetFile ? [scope.targetFile] : ["-oneline"];

		const result = spawnSync("actionlint", args, {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (result.status === 0) return [];
		if (result.error) return [];

		const output = (result.stdout || "") + (result.stderr || "");
		const results = parseActionlintOutput(output);

		return results.map((r) => ({
			...r,
			file: r.file.startsWith("/") ? relative(scope.projectRoot, r.file) : r.file,
		}));
	} catch {
		return [];
	}
}
