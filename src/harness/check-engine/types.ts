// ===========================================
// Check Engine — Unified types
// ===========================================

/** Canonical tool identifiers across the check engine. */
export type ToolId =
	| "tsc"
	| "biome"
	| "eslint"
	| "semgrep"
	| "gitleaks"
	| "dep-audit"
	| "mypy"
	| "ruff"
	| "cargo-check"
	| "cargo-clippy"
	| "go-build"
	| "golangci-lint"
	| "c-compile"
	| "clang-tidy"
	| "oxlint"
	| "knip"
	| "shellcheck"
	| "actionlint"
	| "hadolint"
	| "taplo"
	| "swiftlint"
	| "swift-build";

/** A single finding from any check tool. */
export interface CheckResult {
	tool: ToolId;
	severity: "error" | "warning" | "info";
	file: string; // relative path from projectRoot
	line: number; // 0 if unknown
	column?: number;
	message: string;
	ruleId?: string; // e.g. "TS2345", "lint/suspicious/noDoubleEquals"
}

/** Controls WHAT gets checked. */
export interface CheckScope {
	/** Project root (where tsconfig.json, package.json etc live). */
	projectRoot: string;
	/** "project" = scan all files; "file" = scope to targetFile. */
	mode: "project" | "file";
	/** When mode="file", the absolute path to the file to check. */
	targetFile?: string;
	/** When mode="file", filter project-wide tool output to only this file's results. */
	filterToFile?: boolean;
}

/** Controls HOW checks run. */
export interface CheckOptions {
	/** Maximum time per tool in ms. */
	timeoutMs?: number;
	/** Which tools to run (undefined = all available). */
	tools?: ToolId[];
	/** Which tools to skip. */
	skipTools?: ToolId[];
}

/** Result of tool availability detection. */
export interface ToolAvailability {
	id: ToolId;
	available: boolean;
	version?: string;
	reason?: string; // why unavailable (e.g. "not installed", "no config file")
}

/** Full report from a check run. */
export interface CheckReport {
	results: CheckResult[];
	toolsRun: ToolAvailability[];
	toolsSkipped: ToolAvailability[];
	/** Structured skip reasons for CI visibility. */
	skipped: SkipEntry[];
	elapsedMs: number;
	/** Per-tool execution metrics (timing, cache hits, finding counts). */
	metrics: ToolMetrics[];
	/** Number of duplicate results removed during deduplication. */
	deduplicatedCount: number;
}

/** SCA audit result (structured vulnerability counts). */
export interface AuditResult {
	tool: string;
	total: number;
	critical: number;
	high: number;
	moderate: number;
	low: number;
	detail: string;
}

/** Input for a tool runner function. */
export interface ToolRunnerInput {
	scope: CheckScope;
	timeoutMs: number;
}

/** A tool runner function: spawn tool, parse output, return results. */
export type ToolRunner = (input: ToolRunnerInput) => CheckResult[];

/** Metadata about a tool runner for scheduling decisions. */
export interface ToolRunnerMeta {
	runner: ToolRunner;
	/** True if this tool can safely run in parallel with other tools. */
	concurrencySafe: boolean;
}

/** Per-tool execution metrics collected during a check run. */
export interface ToolMetrics {
	tool: ToolId;
	elapsedMs: number;
	findingCount: number;
	cacheHit: boolean;
}

/** A check that was skipped with a structured reason. */
export interface SkipEntry {
	check: string;
	reason: string;
	category: "tool_missing" | "config_disabled" | "file_type_mismatch" | "timeout" | "error";
}
