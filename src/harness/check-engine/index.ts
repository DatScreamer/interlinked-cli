// ===========================================
// Check Engine — Unified check orchestrator
// ===========================================
// Single source of truth for running external checks.
// Two modes: "project" (batch scan) and "file" (incremental).

import { statSync } from "node:fs";
import { cpus } from "node:os";
import { extname } from "node:path";
import { discoverSingleTool, discoverTools, formatToolReport } from "./discovery.js";
import { createLimiter } from "./pool.js";
import { runActionlint, runActionlintAsync } from "./tool-runners/actionlint.js";
import { runBiome, runBiomeAsync, runBiomeOverlay } from "./tool-runners/biome.js";
import { runCCompile, runClangTidy } from "./tool-runners/c-cpp.js";
import {
	runDepAudit,
	runEslint,
	runGitleaks,
	runKnip,
	runOxlint,
	runSemgrep,
	runEslintAsync,
	runGitleaksAsync,
	runKnipAsync,
	runOxlintAsync,
	runSemgrepAsync,
} from "./tool-runners/generic.js";
import { runGoBuild, runGolangciLint } from "./tool-runners/go.js";
import { runHadolint, runHadolintAsync } from "./tool-runners/hadolint.js";
import { runMypy, runMypyAsync, runRuff, runRuffAsync } from "./tool-runners/python.js";
import { runCargoCheck, runCargoClippy } from "./tool-runners/rust.js";
import { runShellcheck, runShellcheckAsync } from "./tool-runners/shellcheck.js";
import { runSwiftBuild, runSwiftLint, runSwiftLintAsync } from "./tool-runners/swift.js";
import { runTaplo, runTaploAsync } from "./tool-runners/taplo.js";
import { runTsc, runTscAsync } from "./tool-runners/tsc.js";
import { clearTscOverlayCache, runTscOverlay } from "./tool-runners/tsc-overlay.js";
import type {
	AuditResult,
	CheckOptions,
	CheckReport,
	CheckResult,
	CheckScope,
	ToolAvailability,
	ToolId,
	ToolMetrics,
	ToolRunner,
	ToolRunnerMeta,
} from "./types.js";

// Re-export types and utilities for consumers
export { formatToolReport } from "./discovery.js";
export type {
	CheckReport,
	CheckResult,
	SkipEntry,
	ToolId,
	ToolMetrics,
} from "./types.js";

// -------------------------------------------
// Config name mapping (harness ↔ engine)
// -------------------------------------------

const CONFIG_TO_TOOL: Record<string, ToolId> = {
	typescript: "tsc",
	biome_lint: "biome",
	biome: "biome",
	eslint: "eslint",
	semgrep: "semgrep",
	gitleaks: "gitleaks",
	dependency_audit: "dep-audit",
	oxlint: "oxlint",
	knip: "knip",
	python_typecheck: "mypy",
	ruff_lint: "ruff",
	cargo_check: "cargo-check",
	cargo_clippy: "cargo-clippy",
	go_build: "go-build",
	golangci_lint: "golangci-lint",
	c_compile: "c-compile",
	clang_tidy: "clang-tidy",
	shellcheck: "shellcheck",
	actionlint: "actionlint",
	hadolint: "hadolint",
	taplo: "taplo",
	swiftlint: "swiftlint",
	swift_build: "swift-build",
};

export function configNameToToolId(name: string): ToolId | undefined {
	return CONFIG_TO_TOOL[name];
}

// -------------------------------------------
// Tool runner registry
// -------------------------------------------
// concurrencySafe: true means the tool only reads files and doesn't mutate
// project state, so it can run in parallel with other safe tools.
// Tools that write lock files, caches, or use shared build artifacts
// (e.g. cargo-check and cargo-clippy share the target/ dir) are unsafe.

const TOOL_REGISTRY: Record<string, ToolRunnerMeta> = {
	tsc: { runner: runTsc, runnerAsync: runTscAsync, concurrencySafe: true },
	biome: { runner: runBiome, runnerAsync: runBiomeAsync, concurrencySafe: true },
	eslint: { runner: runEslint, runnerAsync: runEslintAsync, concurrencySafe: true },
	semgrep: { runner: runSemgrep, runnerAsync: runSemgrepAsync, concurrencySafe: true },
	gitleaks: { runner: runGitleaks, runnerAsync: runGitleaksAsync, concurrencySafe: true },
	oxlint: { runner: runOxlint, runnerAsync: runOxlintAsync, concurrencySafe: true },
	knip: { runner: runKnip, runnerAsync: runKnipAsync, concurrencySafe: true },
	// Python
	mypy: { runner: runMypy, runnerAsync: runMypyAsync, concurrencySafe: true },
	ruff: { runner: runRuff, runnerAsync: runRuffAsync, concurrencySafe: true },
	// Rust — share target/ directory, must run sequentially
	"cargo-check": { runner: runCargoCheck, concurrencySafe: false },
	"cargo-clippy": { runner: runCargoClippy, concurrencySafe: false },
	// Go — share build cache, must run sequentially
	"go-build": { runner: runGoBuild, concurrencySafe: false },
	"golangci-lint": { runner: runGolangciLint, concurrencySafe: false },
	// C/C++ — share object files, must run sequentially
	"c-compile": { runner: runCCompile, concurrencySafe: false },
	"clang-tidy": { runner: runClangTidy, concurrencySafe: false },
	// Shell
	shellcheck: { runner: runShellcheck, runnerAsync: runShellcheckAsync, concurrencySafe: true },
	// GitHub Actions
	actionlint: { runner: runActionlint, runnerAsync: runActionlintAsync, concurrencySafe: true },
	// Dockerfile
	hadolint: { runner: runHadolint, runnerAsync: runHadolintAsync, concurrencySafe: true },
	// TOML
	taplo: { runner: runTaplo, runnerAsync: runTaploAsync, concurrencySafe: true },
	// Swift — swift build shares build dir, must run sequentially
	swiftlint: {
		runner: runSwiftLint,
		runnerAsync: runSwiftLintAsync,
		concurrencySafe: true,
	},
	"swift-build": { runner: runSwiftBuild, concurrencySafe: false },
};

/** Backward-compat lookup: get the runner function for a tool ID. */
const TOOL_RUNNERS: Record<string, ToolRunner> = Object.fromEntries(
	Object.entries(TOOL_REGISTRY).map(([id, meta]) => [id, meta.runner]),
);

// Default timeouts per mode
const DEFAULT_TIMEOUT_PROJECT = 30_000;
const DEFAULT_TIMEOUT_FILE = 5_000;

// -------------------------------------------
// Diagnostic cache (mtime-based)
// -------------------------------------------

interface DiagnosticCacheEntry {
	mtimeMs: number;
	results: CheckResult[];
}

const diagnosticCache = new Map<string, DiagnosticCacheEntry>();

// -------------------------------------------
// Extension → tool dispatch
// -------------------------------------------

function getToolsForExtension(ext: string): ToolId[] {
	switch (ext) {
		case ".ts":
		case ".tsx":
			return ["tsc", "biome", "oxlint"];
		case ".js":
		case ".jsx":
		case ".mjs":
		case ".cjs":
			return ["biome", "oxlint"];
		case ".py":
		case ".pyi":
			return ["mypy", "ruff"];
		case ".rs":
			return ["cargo-check", "cargo-clippy"];
		case ".go":
			return ["go-build", "golangci-lint"];
		case ".c":
		case ".cpp":
		case ".cc":
		case ".cxx":
		case ".h":
		case ".hpp":
		case ".hxx":
			return ["c-compile", "clang-tidy"];
		case ".sh":
		case ".bash":
		case ".zsh":
		case ".ksh":
			return ["shellcheck"];
		case ".toml":
			return ["taplo"];
		case ".swift":
			return ["swiftlint", "swift-build"];
		default:
			return [];
	}
}

// -------------------------------------------
// Deduplication
// -------------------------------------------

/**
 * Normalize a diagnostic message for dedup comparison.
 * Strips tool-specific prefixes, rule IDs, and whitespace variations
 * so that "unused variable 'x'" from biome and eslint collapse to one.
 */
function normalizeMessage(msg: string): string {
	return msg
		.replace(/^[\w/-]+:\s*/, "") // strip leading rule id like "lint/suspicious/noDoubleEquals: "
		.replace(/\s+/g, " ") // collapse whitespace
		.trim()
		.toLowerCase();
}

/**
 * Build a dedup key from a check result.
 * Two results are duplicates if they point to the same file+line and say
 * essentially the same thing (after normalization).
 */
function dedupKey(r: CheckResult): string {
	return `${r.file}:${r.line}:${normalizeMessage(r.message)}`;
}

/** Result of deduplicating check findings. */
export interface DeduplicationResult {
	deduplicated: CheckResult[];
	removedCount: number;
}

/**
 * Remove duplicate findings across tools.
 * When duplicates exist, keeps the one from the higher-priority tool
 * (first in TOOL_RUNNERS order) and the higher severity.
 */
export function deduplicateResults(results: CheckResult[]): DeduplicationResult {
	const seen = new Map<string, CheckResult>();
	const severityRank: Record<string, number> = { error: 3, warning: 2, info: 1 };

	for (const r of results) {
		const key = dedupKey(r);
		const existing = seen.get(key);
		if (!existing) {
			seen.set(key, r);
		} else {
			// Keep the higher severity; on tie, keep the first (earlier tool = higher priority)
			if ((severityRank[r.severity] ?? 0) > (severityRank[existing.severity] ?? 0)) {
				seen.set(key, r);
			}
		}
	}

	const deduplicated = [...seen.values()];
	return {
		deduplicated,
		removedCount: results.length - deduplicated.length,
	};
}

// -------------------------------------------
// CheckEngine
// -------------------------------------------

export class CheckEngine {
	readonly projectRoot: string;
	private toolsCache: ToolAvailability[] | null = null;
	private singleToolCache = new Map<ToolId, ToolAvailability>();

	constructor(projectRoot: string) {
		this.projectRoot = projectRoot;
	}

	/** Discover which tools are available. Cached per engine instance. */
	discoverTools(): ToolAvailability[] {
		if (!this.toolsCache) {
			this.toolsCache = discoverTools(this.projectRoot);
			// Also populate the single-tool cache from the full discovery
			for (const t of this.toolsCache) {
				this.singleToolCache.set(t.id, t);
			}
		}
		return this.toolsCache;
	}

	/**
	 * Check if a single tool is available. Uses per-tool cache to avoid
	 * discovering all 20+ tools when only a few are needed (e.g., getDiagnostics).
	 */
	isToolAvailable(id: ToolId): boolean {
		// Check full cache first (populated by discoverTools)
		if (this.toolsCache) {
			return !!this.toolsCache.find((t) => t.id === id)?.available;
		}
		// Check per-tool cache
		const cached = this.singleToolCache.get(id);
		if (cached) return cached.available;
		// Discover just this one tool
		const result = discoverSingleTool(id, this.projectRoot);
		if (result) {
			this.singleToolCache.set(id, result);
			return result.available;
		}
		return false;
	}

	/** Format tool availability as a human-readable report. */
	formatToolReport(): string {
		return formatToolReport(this.discoverTools());
	}

	/**
	 * Run all applicable checks.
	 * - mode "project": scan everything, default 30s timeout per tool
	 * - mode "file": check a single file, default 5s timeout per tool
	 *
	 * Tools run in parallel when safe (most linters). Results are
	 * deduplicated by (file, line, normalizedMessage) so overlapping
	 * tools (e.g. biome + eslint, cargo-check + cargo-clippy) don't
	 * produce duplicate findings.
	 */
	runChecks(scope: CheckScope, options?: CheckOptions): CheckReport {
		const start = Date.now();
		const available = this.discoverTools();
		const timeout =
			options?.timeoutMs ??
			(scope.mode === "project" ? DEFAULT_TIMEOUT_PROJECT : DEFAULT_TIMEOUT_FILE);

		// Determine which tools to run
		const toolsToRun = available.filter((t) => {
			if (!t.available) return false;
			if (options?.tools && !options.tools.includes(t.id)) return false;
			if (options?.skipTools?.includes(t.id)) return false;
			return true;
		});

		const toolsSkipped = available.filter((t) => !toolsToRun.some((r) => r.id === t.id));
		const allResults: CheckResult[] = [];
		const metrics: ToolMetrics[] = [];

		for (const tool of toolsToRun) {
			const runner = TOOL_RUNNERS[tool.id];
			if (!runner) continue;

			const toolStart = Date.now();
			const results = runner({ scope, timeoutMs: timeout });
			metrics.push({
				tool: tool.id,
				elapsedMs: Date.now() - toolStart,
				findingCount: results.length,
				cacheHit: false,
			});
			allResults.push(...results);
		}

		const { deduplicated, removedCount } = deduplicateResults(allResults);

		const skipped: import("./types.js").SkipEntry[] = toolsSkipped.map((t) => ({
			check: t.id,
			reason: t.reason || (t.available ? "skipped by options" : "not installed"),
			category: t.available ? ("config_disabled" as const) : ("tool_missing" as const),
		}));

		return {
			results: deduplicated,
			toolsRun: toolsToRun,
			toolsSkipped,
			skipped,
			elapsedMs: Date.now() - start,
			metrics,
			deduplicatedCount: removedCount,
		};
	}

	/**
	 * Async variant of runChecks that runs concurrency-safe tools in parallel.
	 * Sequential-only tools (e.g. cargo-check/clippy that share target/) run
	 * after the parallel batch completes.
	 *
	 * Phase A.1 (Free CLI Phase-2): if a tool's meta has a `runnerAsync`
	 * field, this path uses it for true non-blocking parallelism via
	 * `child_process.spawn`. Tools that only expose the legacy sync `runner`
	 * still work — they're wrapped in `Promise.resolve` so the call signature
	 * is uniform — but they remain event-loop-blocking until they're
	 * migrated. Concurrency is capped via `createLimiter(cpus - 1)` so a
	 * 4-core machine doesn't spawn 8 subprocesses at once.
	 */
	async runChecksAsync(scope: CheckScope, options?: CheckOptions): Promise<CheckReport> {
		const start = Date.now();
		const available = this.discoverTools();
		const timeout =
			options?.timeoutMs ??
			(scope.mode === "project" ? DEFAULT_TIMEOUT_PROJECT : DEFAULT_TIMEOUT_FILE);

		const toolsToRun = available.filter((t) => {
			if (!t.available) return false;
			if (options?.tools && !options.tools.includes(t.id)) return false;
			if (options?.skipTools?.includes(t.id)) return false;
			return true;
		});

		const toolsSkipped = available.filter((t) => !toolsToRun.some((r) => r.id === t.id));

		// Partition into parallel-safe and sequential groups
		const parallel: ToolAvailability[] = [];
		const sequential: ToolAvailability[] = [];
		for (const tool of toolsToRun) {
			const meta = TOOL_REGISTRY[tool.id];
			if (meta?.concurrencySafe) {
				parallel.push(tool);
			} else {
				sequential.push(tool);
			}
		}

		const runOne = async (
			tool: ToolAvailability,
		): Promise<{ results: CheckResult[]; metric: ToolMetrics }> => {
			const meta = TOOL_REGISTRY[tool.id];
			if (!meta) {
				return {
					results: [],
					metric: {
						tool: tool.id,
						elapsedMs: 0,
						findingCount: 0,
						cacheHit: false,
					},
				};
			}
			const toolStart = Date.now();
			let results: CheckResult[] = [];
			try {
				// Prefer the async runner when present (Phase A.1 migration);
				// otherwise wrap the sync runner in Promise.resolve so the call
				// shape is uniform. When async runners are present, the limiter
				// caps actual concurrent subprocess count.
				results = meta.runnerAsync
					? await meta.runnerAsync({ scope, timeoutMs: timeout })
					: await Promise.resolve(meta.runner({ scope, timeoutMs: timeout }));
			} catch (e) {
				// One runner crash must not abort the batch (Plan A.4 — error
				// isolation). Metric records 0 findings; caller decides whether
				// to surface the failure.
				void e;
				results = [];
			}
			return {
				results,
				metric: {
					tool: tool.id,
					elapsedMs: Date.now() - toolStart,
					findingCount: results.length,
					cacheHit: false,
				},
			};
		};

		// Run concurrency-safe tools in parallel under the limiter. Cap at
		// `cpus - 1` so the daemon's own work + OS scheduler get one core.
		// `Promise.allSettled` keeps a single runner crash from aborting
		// the batch.
		const parallelLimit = createLimiter(Math.max(1, cpus().length - 1));
		const parallelSettled = await Promise.allSettled(
			parallel.map((tool) => parallelLimit(() => runOne(tool))),
		);
		const parallelResults: Awaited<ReturnType<typeof runOne>>[] = [];
		for (const r of parallelSettled) {
			if (r.status === "fulfilled") parallelResults.push(r.value);
		}

		// Run sequential tools one at a time
		const sequentialResults: Awaited<ReturnType<typeof runOne>>[] = [];
		for (const tool of sequential) {
			sequentialResults.push(await runOne(tool));
		}

		const allRuns = [...parallelResults, ...sequentialResults];
		const allResults = allRuns.flatMap((r) => r.results);
		const metrics = allRuns.map((r) => r.metric);

		const { deduplicated, removedCount } = deduplicateResults(allResults);

		const skipped: import("./types.js").SkipEntry[] = toolsSkipped.map((t) => ({
			check: t.id,
			reason: t.reason || (t.available ? "skipped by options" : "not installed"),
			category: t.available ? ("config_disabled" as const) : ("tool_missing" as const),
		}));

		return {
			results: deduplicated,
			toolsRun: toolsToRun,
			toolsSkipped,
			skipped,
			elapsedMs: Date.now() - start,
			metrics,
			deduplicatedCount: removedCount,
		};
	}

	/**
	 * Run dependency audit (separate because it returns AuditResult, not CheckResult[]).
	 */
	runDepAudit(timeoutMs?: number): AuditResult | null {
		const available = this.discoverTools();
		const depTool = available.find((t) => t.id === "dep-audit");
		if (!depTool?.available) return null;

		return runDepAudit({
			scope: { projectRoot: this.projectRoot, mode: "project" },
			timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_PROJECT,
		});
	}

	/**
	 * Get cached diagnostics for a single file.
	 * Used by PreToolUse to inject existing errors before an edit.
	 * Dispatches to language-appropriate tools based on file extension.
	 */
	getDiagnostics(filePath: string): CheckResult[] {
		// Mtime cache: skip if file hasn't changed
		try {
			const mtime = statSync(filePath).mtimeMs;
			const cached = diagnosticCache.get(filePath);
			if (cached && cached.mtimeMs === mtime) return cached.results;
		} catch (_err) {
			// stat failed (file missing/unreadable) — no diagnostics available
			return [];
		}

		const scope: CheckScope = {
			projectRoot: this.projectRoot,
			mode: "file",
			targetFile: filePath,
			filterToFile: true,
		};

		const results: CheckResult[] = [];
		const toolsForFile = getToolsForExtension(extname(filePath));

		// Lazy per-tool discovery: only check tools relevant to this file extension.
		// This avoids spawning subprocesses for all 20+ tools when only 2-3 are needed.
		for (const toolId of toolsForFile) {
			const availability = this.isToolAvailable(toolId);
			if (!availability) continue;
			const runner = TOOL_RUNNERS[toolId];
			if (!runner) continue;
			const toolResults = runner({ scope, timeoutMs: 5_000 });
			results.push(...toolResults);
		}

		// Update cache
		try {
			const mtime = statSync(filePath).mtimeMs;
			diagnosticCache.set(filePath, { mtimeMs: mtime, results });
		} catch (_err) {
			void 0; /* intentional: stat failed — don't cache */
		}

		return results;
	}

	/** Clear the diagnostic cache (e.g. on session start). */
	clearCache(): void {
		diagnosticCache.clear();
	}

	/**
	 * Run biome against in-memory overlay content for a file path.
	 * Used by the PreToolUse diff-overlay pre-block to determine whether a
	 * proposed edit introduces NEW biome findings.
	 *
	 * Does NOT cache — overlay content is transient per-edit. Caller is
	 * responsible for budget (timeout).
	 *
	 * Returns only biome results for the target file path.
	 */
	getBiomeDiagnosticsForOverlay(
		filePath: string,
		content: string,
		timeoutMs = 500,
	): CheckResult[] {
		if (!this.isToolAvailable("biome")) return [];
		const results = runBiomeOverlay({
			projectRoot: this.projectRoot,
			timeoutMs,
			filePath,
			content,
		});
		// parseBiomeOutput emits relative paths. Filter to the overlaid file
		// (biome can incidentally emit cross-file findings from the same run).
		const rel = filePath.startsWith(this.projectRoot)
			? filePath.slice(this.projectRoot.length).replace(/^\/+/, "")
			: filePath;
		return results.filter((r) => r.file === rel || r.file === filePath);
	}

	/**
	 * Run the TypeScript LanguageService against in-memory overlay content
	 * for a file path. Returns syntactic + semantic diagnostics for THAT
	 * file (cross-file regressions are left to PostToolUse).
	 *
	 * First call per project is ~1-3s (LS warmup); subsequent calls are
	 * ~20-100ms on incremental analysis. The LS is cached on a
	 * module-level registry keyed by project root.
	 */
	getTscDiagnosticsForOverlay(filePath: string, content: string): CheckResult[] {
		return runTscOverlay({
			projectRoot: this.projectRoot,
			filePath,
			content,
		});
	}

	/** Clear both the diagnostic cache and the tsc LS cache (session reset). */
	clearAllCaches(): void {
		this.clearCache();
		clearTscOverlayCache(this.projectRoot);
	}
}

// -------------------------------------------
// Singleton helper for the harness server
// -------------------------------------------

let _engineInstance: CheckEngine | null = null;

/** Get or create a CheckEngine singleton for the given project root. */
export function getOrCreateEngine(projectRoot: string): CheckEngine {
	if (!_engineInstance || _engineInstance.projectRoot !== projectRoot) {
		_engineInstance = new CheckEngine(projectRoot);
	}
	return _engineInstance;
}
