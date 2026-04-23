// ===========================================
// Tool Runners — ESLint, Oxlint, Semgrep, Gitleaks, Dependency Audit
// ===========================================

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
	filterResultsToFile,
	parseEslintOutput,
	parseGitleaksJson,
	parseKnipJson,
	parseNpmAuditJson,
	parseOxlintJson,
	parseSemgrepJson,
} from "../output-parsers.js";
import type { AuditResult, CheckResult, ToolRunnerInput } from "../types.js";

// -------------------------------------------
// ESLint
// -------------------------------------------

const ESLINT_CONFIG_FILES = [
	".eslintrc.json",
	".eslintrc.js",
	".eslintrc.cjs",
	".eslintrc.yml",
	".eslintrc.yaml",
	"eslint.config.js",
	"eslint.config.mjs",
	"eslint.config.cjs",
	"eslint.config.ts",
];

function findEslintConfig(startDir: string): boolean {
	let dir = startDir;
	for (let i = 0; i < 5; i++) {
		for (const name of ESLINT_CONFIG_FILES) {
			if (existsSync(resolve(dir, name))) return true;
		}
		const parent = dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
	return false;
}

export function runEslint(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;
	if (!findEslintConfig(scope.projectRoot)) return [];

	try {
		const target = scope.mode === "file" && scope.targetFile ? scope.targetFile : ".";
		const result = spawnSync(
			"npx",
			["eslint", "--no-error-on-unmatched-pattern", "--format", "unix", target],
			{
				cwd: scope.projectRoot,
				timeout: timeoutMs,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);

		if (result.status === 0) return [];
		const output = (result.stdout || "") + (result.stderr || "");
		return parseEslintOutput(output);
	} catch {
		return [];
	}
}

// -------------------------------------------
// Oxlint (Rust-based JS/TS linter, ~100x faster than ESLint)
// -------------------------------------------

export function runOxlint(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		const target = scope.mode === "file" && scope.targetFile ? scope.targetFile : ".";
		const result = spawnSync("npx", ["oxlint", "--format=json", target], {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		// Exit 0 = clean, exit 1 = issues found
		if (result.status === 0) return [];

		const output = (result.stdout || "").trim();
		if (!output) return [];
		return parseOxlintJson(output);
	} catch {
		return [];
	}
}

// -------------------------------------------
// Knip (unused exports, files, dependencies)
// -------------------------------------------

export function runKnip(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		const result = spawnSync("npx", ["knip", "--no-progress", "--reporter", "json"], {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		// Exit 0 = clean, exit 1 = issues found, exit 2 = config error
		if (result.status === 0 || result.status === 2) return [];

		const output = (result.stdout || "").trim();
		if (!output) return [];

		const results = parseKnipJson(output);

		if (scope.mode === "file" && scope.targetFile && scope.filterToFile) {
			return filterResultsToFile(results, scope.targetFile);
		}
		return results;
	} catch {
		return [];
	}
}

// -------------------------------------------
// Semgrep
// -------------------------------------------

export function runSemgrep(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		const target = scope.mode === "file" && scope.targetFile ? scope.targetFile : ".";
		const result = spawnSync(
			"semgrep",
			[
				"scan",
				"--quiet",
				"--no-git-ignore",
				"--metrics",
				"off",
				"--config",
				"p/default",
				"--json",
				target,
			],
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
		// Exit 2 = semgrep config/auth error — skip silently
		if (result.status === 2) return [];

		const output = (result.stdout || "").trim();
		if (!output) return [];
		return parseSemgrepJson(output, scope.projectRoot);
	} catch {
		return [];
	}
}

// -------------------------------------------
// Gitleaks
// -------------------------------------------

export function runGitleaks(input: ToolRunnerInput): CheckResult[] {
	const { scope, timeoutMs } = input;

	try {
		const args = [
			"detect",
			"--no-git",
			"--no-banner",
			"--report-format",
			"json",
			"--report-path",
			"/dev/stdout",
			"--source",
			scope.mode === "file" && scope.targetFile ? scope.targetFile : ".",
		];

		const result = spawnSync("gitleaks", args, {
			cwd: scope.projectRoot,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}

		// Gitleaks: exit 0 = no leaks, exit 1 = leaks found (or fatal error).
		// Distinguish fatal errors by checking for FTL in output.
		if (result.status !== 1) return [];
		const combinedOutput = (result.stderr || "") + (result.stdout || "");
		if (combinedOutput.includes("FTL") || combinedOutput.includes("no such file")) {
			return [];
		}

		const output = (result.stdout || "").trim();
		if (!output) return [];
		return parseGitleaksJson(output);
	} catch {
		return [];
	}
}

// -------------------------------------------
// Dependency Audit (npm audit, pip-audit, cargo audit, govulncheck)
// -------------------------------------------

export function runDepAudit(input: ToolRunnerInput): AuditResult | null {
	const { scope, timeoutMs } = input;

	// npm ecosystem
	if (existsSync(resolve(scope.projectRoot, "package.json"))) {
		return runNpmAudit(scope.projectRoot, timeoutMs);
	}

	// TODO: pip-audit, cargo-audit, govulncheck
	return null;
}

function runNpmAudit(cwd: string, timeoutMs: number): AuditResult | null {
	try {
		const result = spawnSync("npm", ["audit", "--json", "--audit-level=moderate"], {
			cwd,
			timeout: timeoutMs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}

		const output = (result.stdout || "").trim();
		if (!output) return null;
		return parseNpmAuditJson(output);
	} catch {
		return null;
	}
}
