// ===========================================
// Check Engine — Tool Discovery
// ===========================================
// Detects which external tools are available and reports coverage.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ToolAvailability, ToolId } from "./types.js";

interface ToolBinarySpec {
	versionCmd: string[];
	versionRegex: RegExp;
}

interface ToolSpec extends ToolBinarySpec {
	id: ToolId;
	/** Config files that indicate the tool is relevant for this project. */
	configFiles?: string[];
	/** If true, tool requires a config file to be useful. */
	requiresConfig?: boolean;
	/** Fallback binary to try if the primary is unavailable (e.g. tsc when tsgo is missing). */
	fallback?: ToolBinarySpec;
}

const TOOL_SPECS: ToolSpec[] = [
	{
		id: "tsc",
		// Prefer tsgo (TypeScript 7 native Go compiler) when installed
		versionCmd: ["npx", "tsgo", "--version"],
		versionRegex: /Version\s+(\S+)/,
		configFiles: ["tsconfig.json"],
		requiresConfig: true,
		fallback: {
			versionCmd: ["npx", "tsc", "--version"],
			versionRegex: /Version\s+(\S+)/,
		},
	},
	{
		id: "biome",
		versionCmd: ["npx", "biome", "--version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
		configFiles: ["biome.json", "biome.jsonc"],
		requiresConfig: true,
	},
	{
		id: "eslint",
		versionCmd: ["npx", "eslint", "--version"],
		versionRegex: /v?(\d+\.\d+\.\d+)/,
		configFiles: [
			".eslintrc.json",
			".eslintrc.js",
			".eslintrc.cjs",
			".eslintrc.yml",
			"eslint.config.js",
			"eslint.config.mjs",
			"eslint.config.cjs",
			"eslint.config.ts",
		],
		requiresConfig: true,
	},
	{
		id: "semgrep",
		versionCmd: ["semgrep", "--version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
	},
	{
		id: "gitleaks",
		versionCmd: ["gitleaks", "version"],
		versionRegex: /v?(\d+\.\d+\.\d+)/,
	},
	{
		id: "dep-audit",
		versionCmd: ["npm", "--version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
		configFiles: ["package.json"],
		requiresConfig: true,
	},
	{
		id: "oxlint",
		versionCmd: ["npx", "oxlint", "--version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
	},
	{
		id: "knip",
		versionCmd: ["npx", "knip", "--version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
		configFiles: ["package.json"],
		requiresConfig: true,
	},
	// --- Python ---
	{
		id: "mypy",
		versionCmd: ["mypy", "--version"],
		versionRegex: /mypy\s+(\S+)/,
		configFiles: ["mypy.ini", ".mypy.ini", "pyproject.toml", "setup.cfg"],
		requiresConfig: true,
	},
	{
		id: "ruff",
		versionCmd: ["ruff", "--version"],
		versionRegex: /ruff\s+(\S+)/,
	},
	// --- Rust ---
	{
		id: "cargo-check",
		versionCmd: ["cargo", "--version"],
		versionRegex: /cargo\s+(\S+)/,
		configFiles: ["Cargo.toml"],
		requiresConfig: true,
	},
	{
		id: "cargo-clippy",
		versionCmd: ["cargo", "clippy", "--version"],
		versionRegex: /clippy\s+(\S+)/,
		configFiles: ["Cargo.toml"],
		requiresConfig: true,
	},
	// --- Go ---
	{
		id: "go-build",
		versionCmd: ["go", "version"],
		versionRegex: /go(\d+\.\d+\.\d+)/,
		configFiles: ["go.mod"],
		requiresConfig: true,
	},
	{
		id: "golangci-lint",
		versionCmd: ["golangci-lint", "--version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
		configFiles: [".golangci.yml", ".golangci.yaml", ".golangci.json", ".golangci.toml"],
	},
	// --- C/C++ ---
	{
		id: "c-compile",
		versionCmd: ["gcc", "--version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
		configFiles: ["Makefile", "CMakeLists.txt"],
		requiresConfig: true,
	},
	{
		id: "clang-tidy",
		versionCmd: ["clang-tidy", "--version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
		configFiles: [".clang-tidy"],
		requiresConfig: true,
	},
	// --- Shell ---
	{
		id: "shellcheck",
		versionCmd: ["shellcheck", "--version"],
		versionRegex: /version:\s*(\S+)/,
	},
	// --- GitHub Actions ---
	{
		id: "actionlint",
		versionCmd: ["actionlint", "--version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
		configFiles: [".github/workflows"],
		requiresConfig: true,
	},
	// --- Dockerfile ---
	{
		id: "hadolint",
		versionCmd: ["hadolint", "--version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
	},
	// --- TOML ---
	{
		id: "taplo",
		versionCmd: ["taplo", "--version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
	},
	// --- Swift ---
	{
		id: "swiftlint",
		versionCmd: ["swiftlint", "version"],
		versionRegex: /(\d+\.\d+\.\d+)/,
		configFiles: [".swiftlint.yml", ".swiftlint.yaml"],
	},
	{
		id: "swift-build",
		versionCmd: ["swift", "--version"],
		versionRegex: /Swift version\s+(\S+)/,
		configFiles: ["Package.swift"],
		requiresConfig: true,
	},
];

/** Walk up to 5 levels to find any of the given config files. */
function findConfig(startDir: string, configFiles: string[]): boolean {
	let dir = startDir;
	for (let i = 0; i < 5; i++) {
		for (const name of configFiles) {
			if (existsSync(resolve(dir, name))) return true;
		}
		const parent = dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
	return false;
}

/** Try running a version command and extract the version string. */
function tryBinary(bin: ToolBinarySpec): { available: boolean; version?: string } {
	try {
		const result = spawnSync(bin.versionCmd[0], bin.versionCmd.slice(1), {
			timeout: 5_000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (result.error) return { available: false };
		const output = (result.stdout || "") + (result.stderr || "");
		const match = output.match(bin.versionRegex);
		return { available: true, version: match?.[1] };
	} catch {
		return { available: false };
	}
}

/** Check if a tool binary is available, trying fallback if primary fails. */
function checkBinary(spec: ToolSpec): { available: boolean; version?: string } {
	const primary = tryBinary(spec);
	if (primary.available) return primary;
	if (spec.fallback) return tryBinary(spec.fallback);
	return { available: false };
}

/** Check a single tool spec against the project root. */
function checkTool(spec: ToolSpec, projectRoot: string): ToolAvailability {
	// Check config files first (fast, no subprocess)
	if (spec.requiresConfig && spec.configFiles && !findConfig(projectRoot, spec.configFiles)) {
		return {
			id: spec.id,
			available: false,
			reason: `no config file found (${spec.configFiles.join(", ")})`,
		};
	}

	const binary = checkBinary(spec);
	if (!binary.available) {
		return { id: spec.id, available: false, reason: "not installed" };
	}

	return { id: spec.id, available: true, version: binary.version };
}

/**
 * Discover which tools are available for the given project root.
 * Checks binary availability and config file presence.
 */
export function discoverTools(projectRoot: string): ToolAvailability[] {
	return TOOL_SPECS.map((spec) => checkTool(spec, projectRoot));
}

/**
 * Discover a single tool by ID. Returns cached result if available.
 * Use this instead of discoverTools() when you only need to check a few tools
 * (e.g., getDiagnostics for a single file) to avoid spawning subprocesses for all 20+ tools.
 */
export function discoverSingleTool(id: ToolId, projectRoot: string): ToolAvailability | undefined {
	const spec = TOOL_SPECS.find((s) => s.id === id);
	if (!spec) return undefined;
	return checkTool(spec, projectRoot);
}

/** Format tool availability as a human-readable report. */
export function formatToolReport(tools: ToolAvailability[]): string {
	const lines = ["tool coverage:"];
	for (const t of tools) {
		const version = t.version ? `v${t.version}` : "--";
		const status = t.available ? "\u2713" : "\u2717";
		const reason = t.available ? "" : ` (${t.reason})`;
		lines.push(`  ${t.id.padEnd(14)} ${version.padEnd(10)} ${status}${reason}`);
	}
	return lines.join("\n");
}
