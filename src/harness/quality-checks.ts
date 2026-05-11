// ===========================================
// Quality Checks — PostToolUse static analysis
// ===========================================
// Runs configurable checks after file Edit/Write operations.
// Results are returned as warnings (written to stderr by the hook script, visible to agent).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, resolve, sep } from "node:path";
import { configNameToToolId, getOrCreateEngine } from "./check-engine/index.js";
import { parseNpmAuditJson, parseOsvScannerJson } from "./check-engine/output-parsers.js";
import {
	buildAgentSafetyChecks,
	buildCheckInstructions,
	buildGenericCheckMeta,
} from "./check-registry/index.js";
import { findEnclosingScope, isGeneratedFile } from "./checks/shared.js";
import { capturePrimitiveViolations } from "./discovered-primitives.js";
import { type FilePriority, shouldRunAdvisoryChecks } from "./file-priority.js";
import { loadDisabledLibraries, runFootgunChecks } from "./library-footguns/registry.js";
import {
	checkBinaryContent,
	checkEmptyFile,
	checkFunctionComplexity,
	checkLargeFile,
	checkMissingReturnTypes,
	checkTestFileExists,
	LARGE_FILE_DEFAULT_MAX_LINES,
} from "./generic-checks.js";
import { getProfileForFile } from "./language-profiles.js";
import { resolveDependencyAuditCommand } from "./quality-checks/dependency-audit.js";
import { runInlineLanguageChecks } from "./quality-checks/inline-language-checks.js";
import { PROVEN_TOOL_CHECKS, TOOL_CHECK_INSTRUCTIONS } from "./quality-checks/instructions.js";
import { checkLockfileDrift, LOCKFILE_MAP } from "./quality-checks/lockfile-drift.js";
import { checkPackageJsonConsistency } from "./quality-checks/package-json.js";
import { findProjectRoot } from "./quality-checks/project-root.js";
import {
	countAsAnyCasts,
	countConsoleStatements,
	countNonNullAssertions,
	countPublicApiSurface,
	countSuppressionDirectives,
	countTodoMarkers,
	countTypeDensity,
} from "./quality-checks/ratchet-metrics.js";
import { containsSecrets } from "./quality-checks/secret-detection.js";
import {
	detectSoftwareVersionFreshnessConcerns,
	collectSoftwareVersionReferences,
	detectSoftwareVersionRegressions,
	formatSoftwareVersionFreshnessDetail,
	formatSoftwareVersionRegressionDetail,
} from "./quality-checks/software-version-regression.js";
import { findAnyTypes } from "./quality-checks/strong-typing.js";
import { isLikelyTestFile } from "./quality-checks/test-classifier.js";
import { TEST_DISPATCHERS } from "./quality-checks/test-dispatchers.js";
import type {
	DiffAwareConfig,
	HarnessEvent,
	PreEditBaseline,
	QualityCheckConfig,
} from "./types.js";

export { checkLockfileDrift } from "./quality-checks/lockfile-drift.js";
export { checkPackageJsonConsistency } from "./quality-checks/package-json.js";
export { findProjectRoot } from "./quality-checks/project-root.js";
export type { ProjectWideSweepResult } from "./quality-checks/project-wide.js";
// Re-export helpers moved to sibling files so existing importers keep working.
export {
	ProjectWideSweepState,
	runProjectWideChecks,
	runProjectWideChecksAsync,
} from "./quality-checks/project-wide.js";
export {
	countAsAnyCasts,
	countConsoleStatements,
	countNonNullAssertions,
	countPublicApiSurface,
	countSuppressionDirectives,
	countTodoMarkers,
	countTypeDensity,
	type TypeDensityCounts,
} from "./quality-checks/ratchet-metrics.js";
export { containsSecrets } from "./quality-checks/secret-detection.js";
export {
	collectSoftwareVersionReferences,
	detectSoftwareVersionFreshnessConcerns,
	detectSoftwareVersionRegressions,
	formatSoftwareVersionFreshnessDetail,
	formatSoftwareVersionRegressionDetail,
	type SoftwareVersionFreshnessConcern,
	type SoftwareVersionReference,
	type SoftwareVersionRegression,
} from "./quality-checks/software-version-regression.js";
export { findAnyTypes, stripStringLiterals } from "./quality-checks/strong-typing.js";

// ===========================================
// Check Runner
// ===========================================

interface QualityCheckResult {
	name: string;
	severity: "error" | "warning";
	message: string;
	file?: string;
	detail?: string;
}

interface InlineFinding {
	line: number;
	text: string;
}

/**
 * Format a list of inline findings as the `detail` block surfaced to the
 * agent. Each line is annotated with its enclosing function/class/method
 * name when one can be detected — that single annotation routinely saves
 * the agent a 20-line `Read` to triage *which scope* the finding belongs
 * to. Trims at 5 findings with a "+N more" overflow line so noisy checks
 * stay scannable.
 */
function formatFindingDetail(
	shown: readonly InlineFinding[],
	total: number,
	fileContent: string,
): string {
	const lines = shown.map((m) => {
		const scope = findEnclosingScope(fileContent, m.line);
		return scope ? `  L${m.line} (in ${scope}): ${m.text}` : `  L${m.line}: ${m.text}`;
	});
	const overflow = total > shown.length ? `\n  ... and ${total - shown.length} more` : "";
	return lines.join("\n") + overflow;
}

/** Per-tool execution metrics surfaced from the engine into latency telemetry.
 *  Mirror of `ToolMetrics` in `check-engine/types.ts` but flattened into the
 *  shape `latency-log.ts` consumes (snake_case keys) and stripped to the three
 *  fields the latency CLI actually aggregates. */
export interface ToolBreakdownEntry {
	tool: string;
	ms: number;
	finding_count: number;
}

/** Options for filtering quality check output. */
export interface QualityCheckOptions {
	/** When set, filter tsc output to only errors mentioning this file path */
	tscFilterFile?: string;
	/** Pre-edit baseline for diff-aware filtering (suppresses pre-existing findings) */
	baseline?: PreEditBaseline;
	/** Diff-aware config from guard rules */
	diffAware?: DiffAwareConfig;
	/** Phase A.7: out-parameter — when present, runQualityChecks pushes one
	 *  entry per subprocess tool invocation so the daemon can write a
	 *  per-tool breakdown into latency.jsonl. The caller owns the array
	 *  (passes it pre-allocated, reads it after the await). */
	outToolMetrics?: ToolBreakdownEntry[];
	/** Mythos Phase 4 — per-file priority map populated at
	 *  SessionStart in the daemon. When provided, advisory inline
	 *  detectors skip files whose tier is "cold" (>180 days since
	 *  last git-tracked modification). Untracked / fresh files
	 *  always run the full pipeline (fail-OPEN per
	 *  `shouldRunAdvisoryChecks`). Optional — direct test callers
	 *  that pass nothing run all checks (legacy behavior). */
	filePriority?: Map<string, FilePriority>;
	/** Diagnostic: called after each inline check iteration with the check's
	 *  name. Lets the daemon record per-check elapsed ms into `phase_breakdown`
	 *  so an inline residual spike can be pinned to a specific check name. */
	onCheckBoundary?: (name: string) => void;
}

/**
 * Yield the Node event loop so other socket connections in the daemon can
 * be serviced between heavy synchronous check phases. Without this, a
 * single PostToolUse evaluation that spends 20s in pure-JS regex passes
 * starves every concurrent connection — Node only services one request
 * at a time while the main thread is busy. Adding `await yieldEventLoop()`
 * at each loop boundary lets interleaved requests make progress and is
 * what closes the ~23s queue gap measured between
 * `guard_harness_ms` (hook-observed RTT) and `checks_timing_ms` (daemon
 * pipeline wall).
 */
function yieldEventLoop(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Run quality checks for a PostToolUse event on a file.
 * Returns an array of warnings/errors found.
 *
 * Async since Phase A.2 of the Free CLI Phase-2 roadmap. The async signature
 * is what lets the daemon's PostToolUse path call `engine.runChecksAsync(...)`
 * and benefit from the 14 async runner conversions that landed in Phase A.1.
 * The function still returns *the same shape* — no behavioral change for
 * callers other than the await. `interlinked verify` and `diff-aware-checks`
 * tests cascade through one extra await each.
 */
export async function runQualityChecks(
	event: HarnessEvent,
	checks: Record<string, QualityCheckConfig>,
	cwd: string = process.cwd(),
	options?: QualityCheckOptions,
): Promise<QualityCheckResult[]> {
	const filePath = (event.tool_input?.file_path as string) || (event.tool_input?.path as string);
	if (!filePath) return [];

	// Skip third-party code — agents can't fix issues in node_modules, dist, or vendor
	const normalized = filePath.replace(/\\/g, "/");
	if (
		normalized.includes("/node_modules/") ||
		normalized.includes("/dist/") ||
		normalized.includes("/vendor/") ||
		normalized.includes("/.next/") ||
		normalized.includes("/build/")
	)
		return [];

	const results: QualityCheckResult[] = [];

	// Pre-compute for skip_test_files guard
	const absForTestCheck = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
	const extForTestCheck = extname(absForTestCheck);
	const testCheckBaseName = absForTestCheck.slice(
		absForTestCheck.lastIndexOf(sep) + 1,
		-extForTestCheck.length || undefined,
	);

	// Snapshot file content once for the whole call: every inline check that
	// inspects on-disk content (strong_typing, software_version_regression,
	// freshness_sensitive_reference, package_json_consistency, the inline-checks
	// section below, and the ratchet block) reads the same file. Hoisting the
	// read eliminates 5+ identical readFileSync calls per PostToolUse Edit.
	const sharedAbsPath = absForTestCheck;
	let sharedFileContent: string | null = null;
	let sharedFileReadAttempted = false;
	const getSharedContent = (): string | null => {
		if (!sharedFileReadAttempted) {
			sharedFileReadAttempted = true;
			if (existsSync(sharedAbsPath)) {
				try {
					sharedFileContent = readFileSync(sharedAbsPath, "utf-8");
				} catch {
					sharedFileContent = null;
				}
			}
		}
		return sharedFileContent;
	};

	// Memoize collectSoftwareVersionReferences for the post-edit content:
	// software_version_regression and freshness_sensitive_reference both call
	// it on the same content, so without memoization we run the full regex
	// sweep twice per Edit.
	let cachedAfterRefs:
		| ReturnType<typeof collectSoftwareVersionReferences>
		| undefined;
	const getAfterRefs = (content: string) => {
		if (cachedAfterRefs === undefined) {
			cachedAfterRefs = collectSoftwareVersionReferences(content, filePath);
		}
		return cachedAfterRefs;
	};

	for (const [name, check] of Object.entries(checks)) {
		if (!check.enabled) continue;
		if (!check.file_types.some((t) => filePath.endsWith(t))) continue;

		// Yield to the event loop between checks so concurrent socket
		// connections can be serviced. The cost is one microtask boundary
		// per check; the saving is that an in-flight 20s pipeline no
		// longer starves other connections (closing the ~23s
		// `guard_harness_ms` vs `checks_timing_ms` gap measured in 24h
		// of production telemetry).
		await yieldEventLoop();

		// Skip test files for checks that opt in (e.g., semgrep, gitleaks)
		if (check.skip_test_files && isLikelyTestFile(testCheckBaseName, absForTestCheck)) continue;

		try {
			if (name === "secrets_in_source") {
				// Inline check — examine file content from the event
				const content =
					(event.tool_input?.content as string) ||
					(event.tool_input?.new_string as string) ||
					"";
				if (content) {
					const found = containsSecrets(content);
					if (found.length > 0) {
						results.push({
							name,
							severity: check.severity,
							message: `Secrets detected in ${filePath}: ${found.length} pattern(s) matched`,
							file: filePath,
						});
					}
				}
			} else if (name === "strong_typing") {
				// Skip test files — tests legitimately use casts for edge case testing
				const fileBase = filePath.replace(/\.[^.]+$/, "");
				if (fileBase.endsWith(".test") || fileBase.endsWith(".spec")) continue;

				// Inline check — scan the ENTIRE file content for `any`/`unknown`.
				// Uses the shared content snapshot to avoid re-reading the file.
				const content = getSharedContent();
				if (content !== null) {
					// 139-repo audit: generator output (OpenAPI, protoc,
					// @generated) routinely uses `any` extensively by
					// design. Supermodel's sdk/DefaultApi.ts produced 290
					// FPs in one file. The fix is to change generator
					// config, not the file.
					if (isGeneratedFile(content)) continue;
					const anyMatches = findAnyTypes(content);
					if (anyMatches.length > 0) {
						const anyCount = anyMatches.filter((m) => m.kind === "any").length;
						const unknownCount = anyMatches.filter(
							(m) => m.kind === "unknown",
						).length;
						const parts: string[] = [];
						if (anyCount > 0) parts.push(`${anyCount} \`any\``);
						if (unknownCount > 0) parts.push(`${unknownCount} \`unknown\``);
						const shown = anyMatches.slice(0, 8);
						const detail = shown.map((m) => `  L${m.line}: ${m.text}`).join("\n");
						const overflow =
							anyMatches.length > 8
								? `\n  ... and ${anyMatches.length - 8} more`
								: "";
						results.push({
							name,
							severity: check.severity,
							message: `${parts.join(" + ")} type(s) in ${filePath} — prefer strong types (interfaces, generics, branded types)`,
							file: filePath,
							detail: detail + overflow,
						});
					}
				}
			} else if (name === "dependency_audit") {
				// SCA: run dependency audit when package/lock files are edited.
				// Detects known CVEs in project dependencies.
				const checkCwd = findProjectRoot(filePath, cwd) || cwd;
				const fileName = filePath.split("/").pop() || "";
				const resolved = resolveDependencyAuditCommand(fileName, {
					useOsvScanner: check.use_osv_scanner,
					offline: check.offline,
				});
				if (!resolved) continue;

				const auditResult = spawnSync(resolved.cmd[0], resolved.cmd.slice(1), {
					shell: false,
					timeout: check.timeout_ms,
					cwd: checkCwd,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
				});

				if (
					auditResult.error &&
					(auditResult.error as NodeJS.ErrnoException).code === "ENOENT"
				) {
					continue; // Audit tool not installed — skip silently
				}

				// Every supported tool exits non-zero when vulnerabilities are found.
				// status=0 means clean; status=null means timeout (treat as skip).
				if (auditResult.status === 0 || auditResult.status === null) continue;

				const stdout = (auditResult.stdout || "").trim();
				let detail = "";
				if (resolved.parser === "osv-scanner") {
					const summary = parseOsvScannerJson(stdout);
					if (!summary) continue; // non-zero exit but no parsable vulns — skip
					detail = summary.detail;
				} else if (resolved.parser === "npm-audit") {
					const summary = parseNpmAuditJson(stdout);
					detail = summary?.detail ?? "";
				} else {
					// pip-audit / cargo-audit / govulncheck: surface raw stderr tail.
					// Structured parsing for these lives behind osv-scanner — if a
					// user opts out of it, we degrade gracefully rather than parse
					// four more bespoke JSON shapes here.
					detail =
						(auditResult.stderr || "").split("\n").slice(0, 5).join("\n") ||
						"vulnerabilities found";
				}

				results.push({
					name,
					severity: check.severity,
					message: `Dependency vulnerabilities found after editing ${filePath}`,
					file: filePath,
					detail:
						detail ||
						`Run \`${resolved.cmd[0]}\` for details (parser: ${resolved.parser})`,
				});
			} else if (name === "inline_language_checks") {
				// Data-driven per-language inline pattern checks. Reads the
				// inline_checks array declared in the file's LanguageProfile
				// and runs each regex after a language-aware comment + string
				// stripping pass. Replaces what was previously dead config.
				const profile = getProfileForFile(filePath);
				if (!profile || profile.inline_checks.length === 0) continue;
				const content = getSharedContent();
				if (content === null) continue;
				const findings = runInlineLanguageChecks(filePath, content, profile);
				for (const f of findings) {
					results.push({
						name: f.name,
						severity: f.severity,
						message: f.message,
						file: f.file,
						detail: f.detail,
					});
				}
			} else if (name === "affected_tests") {
				// Dispatch per-language test invocation. Dispatchers own their own
				// runner shape and scoping (file-level, package-level, or
				// project-wide).
				const absPath = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
				const extForTests = extname(absPath);
				const baseForTests = absPath.slice(
					absPath.lastIndexOf(sep) + 1,
					-extForTests.length || undefined,
				);
				const profile = getProfileForFile(filePath);
				if (!profile) continue;
				if (isLikelyTestFile(baseForTests, absPath)) continue;

				const dispatcher = TEST_DISPATCHERS[profile.id];
				if (!dispatcher) continue;

				const checkCwd = findProjectRoot(filePath, cwd) || cwd;
				const dispatched = dispatcher({
					filePath,
					absPath,
					profile,
					checkCwd,
					timeoutMs: check.timeout_ms,
					severity: check.severity,
					checkName: name,
				});
				for (const r of dispatched) {
					results.push({
						name: r.name,
						severity: r.severity,
						message: r.message,
						file: r.file,
						detail: r.detail,
					});
				}
			} else if (name === "lockfile_drift") {
				// Inline check — detect stale or missing lockfile after manifest edit
				const absPath = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
				const drift = checkLockfileDrift(absPath);
				if (drift.drifted) {
					const msg =
						drift.reason === "missing"
							? `No lockfile found for ${drift.manifest}. Run the package manager's install command to generate one.`
							: `${drift.lockfile} is stale — ${drift.manifest} was modified but the lockfile was not regenerated.`;
					results.push({
						name,
						severity: check.severity,
						message: msg,
						file: filePath,
						detail:
							drift.reason === "stale"
								? `Run \`npm install\`, \`yarn install\`, \`cargo generate-lockfile\`, or the appropriate lock command to update ${drift.lockfile}.`
								: `Expected one of: ${(LOCKFILE_MAP[drift.manifest] || []).join(", ")}`,
					});
				}
			} else if (name === "package_json_consistency") {
				// Inline check — detect duplicate deps and invalid semver
				const content = getSharedContent();
				if (content !== null) {
					const issues = checkPackageJsonConsistency(content);
					if (issues.length > 0) {
						const dupes = issues.filter((i) => i.kind === "duplicate");
						const badVer = issues.filter((i) => i.kind === "invalid_semver");
						const parts: string[] = [];
						if (dupes.length > 0) parts.push(`${dupes.length} duplicate(s)`);
						if (badVer.length > 0)
							parts.push(`${badVer.length} invalid version(s)`);
						const detail = issues
							.slice(0, 10)
							.map((i) => `  ${i.detail}`)
							.join("\n");
						const overflow =
							issues.length > 10 ? `\n  ... and ${issues.length - 10} more` : "";
						results.push({
							name,
							severity: check.severity,
							message: `package.json consistency: ${parts.join(", ")} in ${filePath}`,
							file: filePath,
							detail: detail + overflow,
						});
					}
				}
			} else if (
				name === "software_version_regression" ||
				name === "freshness_sensitive_reference"
			) {
				const postContent = getSharedContent();
				if (postContent === null) continue;
				const beforeRefs =
					options?.baseline?.softwareVersions ??
					(event.tool_input?.old_string
						? collectSoftwareVersionReferences(
								event.tool_input.old_string as string,
								filePath,
							)
						: []);
				// getAfterRefs memoizes — the second check on the same Edit
				// reuses the first check's full-file regex sweep.
				const afterRefs = getAfterRefs(postContent);
				const regressions = detectSoftwareVersionRegressions(beforeRefs, afterRefs);
				const regressionAfterKeys = new Set(
					regressions.map((r) => `${r.after.anchor}\0${r.after.version}`),
				);
				const freshnessConcerns = detectSoftwareVersionFreshnessConcerns(
					beforeRefs,
					afterRefs,
				).filter((c) => !regressionAfterKeys.has(`${c.ref.anchor}\0${c.ref.version}`));
				if (name === "software_version_regression" && regressions.length > 0) {
					results.push({
						name,
						severity: check.severity,
						message:
							`PostToolUse attention required in ${filePath}: ` +
							`${regressions.length} possible software version regression(s). ` +
							"This often means the agent may be relying on stale remembered software names or versions instead of the current or intended source of truth.",
						file: filePath,
						detail: formatSoftwareVersionRegressionDetail(regressions),
					});
				}
				if (name === "freshness_sensitive_reference" && freshnessConcerns.length > 0) {
					results.push({
						name,
						severity: check.severity,
						message:
							`${freshnessConcerns.length} freshness-sensitive software reference(s) introduced in ${filePath}. ` +
							"Verify against official source material before relying on remembered model/API/version names.",
						file: filePath,
						detail: formatSoftwareVersionFreshnessDetail(freshnessConcerns),
					});
				}
			} else if (check.command) {
				// Delegate to the unified check engine for subprocess-based tools.
				const toolId = configNameToToolId(name);
				if (!toolId || toolId === "dep-audit") continue;

				const checkCwd = findProjectRoot(filePath, cwd) || cwd;
				const engine = getOrCreateEngine(checkCwd);

				const filterToFile = options?.tscFilterFile ? true : name !== "typescript"; // tsc runs project-wide unless smart-tsc filtering
				const targetFile =
					options?.tscFilterFile && name === "typescript"
						? resolve(checkCwd, options.tscFilterFile)
						: filePath;

				const engineReport = await engine.runChecksAsync(
					{
						projectRoot: checkCwd,
						mode: "file",
						targetFile,
						filterToFile,
					},
					{ tools: [toolId], timeoutMs: check.timeout_ms },
				);

				if (options?.outToolMetrics) {
					for (const m of engineReport.metrics) {
						options.outToolMetrics.push({
							tool: m.tool,
							ms: m.elapsedMs,
							finding_count: m.findingCount,
						});
					}
				}

				if (engineReport.results.length > 0) {
					const output = engineReport.results
						.slice(0, 15)
						.map((r) => `${r.file}(${r.line}): ${r.message}`)
						.join("\n");
					const overflow =
						engineReport.results.length > 15
							? `\n... (${engineReport.results.length - 15} more)`
							: "";

					results.push({
						name,
						severity: check.severity,
						message: `${name} found issues in ${filePath}`,
						file: filePath,
						detail: output + overflow,
					});
				}
			}
		} catch (err) {
			// Timeout or crash — skip this check, don't block agent
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("ETIMEDOUT") || msg.includes("timed out")) {
				// Timeout is expected for slow checks — silently skip
			}
			// Other errors: log but don't propagate
		}
		// Per-check phase boundary for diagnostic instrumentation. Fires
		// even when the check was a no-op or timed out — the boundary
		// captures wall time spent on this iteration's branch regardless.
		options?.onCheckBoundary?.(`inline_${name}`);
	}

	// Yield between the subprocess-check loop and the inline-check block —
	// each is a distinct synchronous CPU phase, so giving the event loop
	// a turn here lets other connections progress between them.
	await yieldEventLoop();

	// ===========================================
	// Inline Checks — generic + language-specific (no subprocess, <10ms total)
	// ===========================================
	// These run AFTER subprocess checks (tsc, lint, etc.) for additional signal.
	// Read the file from disk once and reuse for all inline checks.

	const absFilePath = sharedAbsPath;
	const sharedForInline = getSharedContent();
	if (sharedForInline !== null) {
		try {
			const fileContent = sharedForInline;

			// 1. Binary content — error, skip all other inline checks
			if (checkBinaryContent(fileContent)) {
				results.push({
					name: "binary_content",
					severity: "error",
					message: `Binary content detected in ${filePath} — text editing tools should not write binary files`,
					file: filePath,
				});
			} else {
				// 2. Empty file — warning
				if (checkEmptyFile(fileContent)) {
					results.push({
						name: "empty_file",
						severity: "warning",
						message: `File is empty: ${filePath} — was content intended?`,
						file: filePath,
					});
				}

				// 3. Large file check
				const sizeCheck = checkLargeFile(fileContent);
				if (sizeCheck.exceeded) {
					results.push({
						name: "large_file",
						severity: "warning",
						message: `File has ${sizeCheck.lines} lines (>${LARGE_FILE_DEFAULT_MAX_LINES}): ${filePath} — consider decomposing`,
						file: filePath,
					});
				}

				// 4. Missing return type annotations (TS/TSX only)
				// Diff-aware: only report findings not in the pre-edit baseline
				let missingReturnTypes = checkMissingReturnTypes(fileContent, absFilePath);
				if (
					options?.diffAware?.enabled !== false &&
					options?.diffAware?.missing_return_types !== "off" &&
					options?.baseline?.missingReturnTypes
				) {
					const baseline = options.baseline?.missingReturnTypes;
					if (baseline) {
						missingReturnTypes = missingReturnTypes.filter(
							(m) => !baseline.has(m.text),
						);
					}
				}
				if (missingReturnTypes.length > 0) {
					const shown = missingReturnTypes.slice(0, 5);
					const detail = shown.map((m) => `  L${m.line}: ${m.text}`).join("\n");
					const overflow =
						missingReturnTypes.length > 5
							? `\n  ... and ${missingReturnTypes.length - 5} more`
							: "";
					results.push({
						name: "missing_return_types",
						severity: "warning",
						message: `${missingReturnTypes.length} exported function(s) without return type annotations in ${filePath}`,
						file: filePath,
						detail: detail + overflow,
					});
				}

				// 5. Test file existence
				// Diff-aware: only fire on new file creation (Write tool), not edits to existing files
				const isNewFile =
					options?.diffAware?.enabled !== false &&
					options?.diffAware?.no_test_file !== "off" &&
					event.tool_name != null &&
					!["Write", "WriteFile", "write_file"].includes(event.tool_name);
				if (!isNewFile) {
					// Pass file content so the check can short-circuit on
					// generator-emitted files (OpenAPI, protoc, @generated)
					// that never have test siblings by design.
					const noTestFile = checkTestFileExists(absFilePath, fileContent);
					if (noTestFile.length > 0) {
						results.push({
							name: "no_test_file",
							severity: "warning",
							message: `No test file found for ${filePath}`,
							file: filePath,
							detail: noTestFile[0].text,
						});
					}
				}

				// 6. Function complexity
				// Diff-aware: only report complex functions introduced by this edit
				let complexFns = checkFunctionComplexity(fileContent, absFilePath);
				if (
					options?.diffAware?.enabled !== false &&
					options?.diffAware?.complexity !== "off"
				) {
					let filtered = false;

					// Strategy 1: Edit-region intersection (Edit tool with old_string/new_string)
					if (event.tool_input?.old_string) {
						const newStr = (event.tool_input.new_string as string) || "";
						const oldStr = event.tool_input.old_string as string;
						// Post-edit file has new_string, not old_string — use new_string for lookup
						const lookupStr = newStr || oldStr;
						const idx = fileContent.indexOf(lookupStr);
						if (idx >= 0) {
							const editStartLine = fileContent.slice(0, idx).split("\n").length;
							const oldLines = oldStr.split("\n").length;
							const newLines = newStr.split("\n").length;
							const editEndLine = editStartLine + Math.max(oldLines, newLines);
							complexFns = complexFns.filter(
								(m) => m.line >= editStartLine - 5 && m.line <= editEndLine + 50,
							);
							filtered = true;
						}
					}

					// Strategy 2: Baseline subtraction (fallback, or Bash edits without old_string)
					const complexBaseline = options?.baseline?.complexFunctions;
					if (!filtered && complexBaseline) {
						complexFns = complexFns.filter((m) => !complexBaseline.has(m.text));
					}
				}
				if (complexFns.length > 0) {
					const shown = complexFns.slice(0, 5);
					const detail = shown.map((m) => `  L${m.line}: ${m.text}`).join("\n");
					const overflow =
						complexFns.length > 5 ? `\n  ... and ${complexFns.length - 5} more` : "";
					results.push({
						name: "complexity",
						severity: "warning",
						message: `${complexFns.length} complex function(s) in ${filePath}`,
						file: filePath,
						detail: detail + overflow,
					});
				}

				// 7. Export ripple — now handled by impact-analysis.ts PostToolUse hook.

				// 8. Agent safety checks (async, imports, types, security, correctness)
				// Derived from the declarative CHECK_REGISTRY — see check-registry/.
				// Only run phase="post" here; pre_block/pre_warn entries fire in
				// evaluator.ts at PreToolUse and are authoritative for their phase.
				//
				// Mythos Phase 4 recency gate: when filePriority is provided AND
				// this file is "cold" (>180 days unchanged in git), drop the
				// heuristic detectors and keep only fully-deterministic ones.
				// New/untracked files always pass the gate (fail-OPEN).
				const coldFileMode =
					options?.filePriority !== undefined &&
					!shouldRunAdvisoryChecks(filePath, options.filePriority);
				const agentSafetyChecks = buildAgentSafetyChecks(
					fileContent,
					absFilePath,
					"post",
					undefined,
					coldFileMode,
				);

				for (const check of agentSafetyChecks) {
					const matches = check.fn();
					if (matches.length > 0) {
						const shown = matches.slice(0, 5);
						const detail = shown.map((m) => `  L${m.line}: ${m.text}`).join("\n");
						const overflow =
							matches.length > 5 ? `\n  ... and ${matches.length - 5} more` : "";
						results.push({
							name: check.name,
							severity: check.severity,
							message: `${matches.length} ${check.name.replace(/_/g, " ")} issue(s) in ${filePath}`,
							file: filePath,
							detail: detail + overflow,
						});
					}
				}

				// 8b. Library-footgun registry (Mythos Phase 5). Deterministic
				// per-library checks that detect known API anti-patterns
				// (e.g. fetch() without timeout). Findings group by check id
				// — the fix instruction comes from the registry entry so
				// the agent sees both WHAT fired and HOW to fix it. Per-
				// library opt-out via `.interlinked/disabled-libraries.json`.
				const disabledLibs = loadDisabledLibraries(cwd);
				const footgunFindings = runFootgunChecks(fileContent, filePath, disabledLibs);
				if (footgunFindings.length > 0) {
					const byId = new Map<string, typeof footgunFindings>();
					for (const f of footgunFindings) {
						const bucket = byId.get(f.id) || [];
						bucket.push(f);
						byId.set(f.id, bucket);
					}
					for (const [id, bucket] of byId) {
						const first = bucket[0];
						const shown = bucket.slice(0, 5);
						const detail = `${shown
							.map((f) => `  L${f.match.line}: ${f.match.text}`)
							.join("\n")}\n→ ${first.fixInstruction}`;
						const overflow =
							bucket.length > 5 ? `\n  ... and ${bucket.length - 5} more` : "";
						results.push({
							name: id,
							severity: "warning",
							message: `${bucket.length} ${first.name} issue(s) in ${filePath} [${first.library}]`,
							file: filePath,
							detail: detail + overflow,
						});
					}
				}

				// Non-deterministic regex heuristics (generic_inline, silent_catch, sync_io_in_async,
				// perf_*, language-specific) have been moved to the scored suggestion pipeline
				// in server.ts. They're now scored, ranked, and only the top 1-3 above a
				// threshold are shown. See suggestion-scorer.ts.
			}
		} catch (_e) {
			/* intentional: file unreadable — skip inline checks silently */
		}
	}

	// Yield once more before the ratchet phase — it runs several full-file
	// count passes (countSuppressionDirectives, countAsAnyCasts, etc.) that
	// are each O(file size) regex sweeps.
	await yieldEventLoop();

	// ===========================================
	// Ratchet comparison — warn when countable quality metrics regress
	// ===========================================
	// Active when diff-aware is OFF (default): the agent is expected to improve
	// all issues in files it touches, not just avoid introducing new ones.
	// Metrics must not go up (more suppressions, more `as any`).
	if (options?.diffAware?.enabled === false && options?.baseline) {
		try {
			const absPath = sharedAbsPath;
			const postContent = getSharedContent() ?? "";
			const pre = options.baseline;
			const postSuppressions = countSuppressionDirectives(postContent);
			const postAsAny = countAsAnyCasts(postContent);
			const postNonNull = countNonNullAssertions(postContent);

			if (postSuppressions > pre.suppressionCount) {
				results.push({
					name: "suppression_ratchet",
					severity: "warning",
					message: `Suppression directives increased (${pre.suppressionCount} → ${postSuppressions}). Fix the underlying issue instead of adding @ts-ignore / eslint-disable.`,
					file: absPath,
				});
			}
			if (postAsAny > pre.asAnyCastCount) {
				results.push({
					name: "as_any_ratchet",
					severity: "warning",
					message: `'as any' casts increased (${pre.asAnyCastCount} → ${postAsAny}). Fix the types instead of casting to any.`,
					file: absPath,
				});
			}
			if (postNonNull > pre.nonNullAssertionCount) {
				results.push({
					name: "non_null_assertion_ratchet",
					severity: "warning",
					message: `Non-null assertions increased (${pre.nonNullAssertionCount} → ${postNonNull}). Replace \`foo!.bar\` with an explicit null check, optional chaining (\`foo?.bar\`), or narrow the type so the assertion is unnecessary.`,
					file: absPath,
				});
			}

			// Defensive-primitive coverage ratchet — adapted from curl's
			// curlx_str_number lesson (Mythos blog, 2026-05). Once the
			// project has adopted a wrapper around an unsafe builtin
			// (e.g. safeParseInt wrapping parseInt), each new bare call
			// to the underlying builtin is a missed coverage opportunity.
			if (pre.discoveredPrimitiveViolations) {
				const postViolations = capturePrimitiveViolations(cwd, postContent);
				if (postViolations) {
					for (const [wrapperName, postCount] of Object.entries(postViolations)) {
						const preCount = pre.discoveredPrimitiveViolations[wrapperName] ?? 0;
						if (postCount > preCount) {
							results.push({
								name: "discovered_primitive_ratchet",
								severity: "warning",
								message: `Bare unsafe-builtin calls increased for \`${wrapperName}\` (${preCount} → ${postCount}). This project has adopted \`${wrapperName}\` as its safe wrapper — use it instead of the raw builtin. Disable via .interlinked/discovered-primitives.json \`disabled\` list.`,
								file: absPath,
							});
						}
					}
				}
			}

			// === Batch 7 ratchets ===
			if (pre.todoMarkerCount !== undefined) {
				const postTodo = countTodoMarkers(postContent);
				if (postTodo > pre.todoMarkerCount) {
					results.push({
						name: "todo_marker_ratchet",
						severity: "warning",
						message: `TODO/FIXME/HACK/XXX markers increased (${pre.todoMarkerCount} → ${postTodo}). Resolve the marker before committing or replace it with a tracked-issue reference (\`// TODO(TICKET-123): ...\`).`,
						file: absPath,
					});
				}
			}
			if (pre.consoleStatementCount !== undefined) {
				const postConsole = countConsoleStatements(postContent);
				if (postConsole > pre.consoleStatementCount) {
					results.push({
						name: "console_statement_ratchet",
						severity: "warning",
						message: `console.* statements increased (${pre.consoleStatementCount} → ${postConsole}). Use a structured logger or remove the debug print before committing.`,
						file: absPath,
					});
				}
			}
			if (pre.publicApiSurfaceCount !== undefined) {
				const postSurface = countPublicApiSurface(postContent);
				if (postSurface > pre.publicApiSurfaceCount) {
					results.push({
						name: "public_api_surface_ratchet",
						severity: "warning",
						message: `Public API surface grew (${pre.publicApiSurfaceCount} → ${postSurface} exported symbols). Every new export expands the contract callers can rely on; confirm the symbol is genuinely meant for external use.`,
						file: absPath,
					});
				}
			}
			// Composite type-density ratchet: bare `: any` / `: unknown` /
			// `: Function` / `: {}` annotations + untyped exported params +
			// missing exported return types. One ratchet, six counters,
			// single warning that lists every dimension that regressed.
			if (pre.typeDensity) {
				const post = countTypeDensity(postContent);
				const dims: Array<[keyof typeof post, string]> = [
					["anyAnnotations", "`: any`"],
					["unknownAnnotations", "`: unknown`"],
					["functionType", "`: Function`"],
					["emptyObjectType", "`: {}`"],
					["untypedExportedParams", "untyped exported params"],
					["missingExportedReturnType", "missing exported return type"],
				];
				const regressions: string[] = [];
				for (const [key, label] of dims) {
					const before = pre.typeDensity[key];
					const after = post[key];
					if (after > before) regressions.push(`${label} (${before}→${after})`);
				}
				if (regressions.length > 0) {
					results.push({
						name: "type_density_ratchet",
						severity: "warning",
						message: `Type density regressed: ${regressions.join(", ")}. Replace bare \`: any\` / \`: unknown\` / \`: Function\` / \`: {}\` with named shapes, and add explicit types to exported function signatures so cold readers know the contract.`,
						file: absPath,
					});
				}
			}
		} catch (_e) {
			/* intentional: non-fatal — file may have been deleted between edits */
		}
	}

	return results;
}

// ===========================================
// Warning Formatting
// ===========================================

// Merge tool-based instructions with registry-derived inline check instructions.
// Registry entries (from check-registry/) take precedence for any overlapping keys.
const CHECK_INSTRUCTIONS: Record<string, string> = {
	...TOOL_CHECK_INSTRUCTIONS,
	...buildCheckInstructions(),
};

// Registry checks self-classify via their own `determinism` field. Cache the
// id→determinism map at module init so the formatter can look up without
// rebuilding on every warning.
const REGISTRY_DETERMINISM: Record<
	string,
	"fully_deterministic" | "partially_deterministic" | "heuristic"
> = Object.fromEntries(
	Object.entries(buildGenericCheckMeta()).map(([id, meta]) => [id, meta.determinism]),
);

/**
 * Lopopolo's "proven vs heuristic" framing surfaced to the agent. Returns
 * the tag to inline into the warning message, or `null` when we don't know
 * the check's determinism (no tag rather than guess wrong).
 *
 * Resolution order:
 * 1. Registry check (CHECK_REGISTRY) → use the entry's `determinism` field.
 *    `fully_deterministic` → "proven"; everything else → "heuristic".
 * 2. Tool check explicitly listed in PROVEN_TOOL_CHECKS → "proven".
 * 3. Tool check present in TOOL_CHECK_INSTRUCTIONS but not in the proven
 *    set → "heuristic" (default for non-tool checks: pattern-matched, not
 *    behavior-verified).
 * 4. Anything else (id not registered anywhere we know of) → null (no tag).
 */
function classifyDeterminism(checkId: string): "proven" | "heuristic" | null {
	const registry = REGISTRY_DETERMINISM[checkId];
	if (registry) return registry === "fully_deterministic" ? "proven" : "heuristic";
	if (PROVEN_TOOL_CHECKS.has(checkId)) return "proven";
	if (checkId in TOOL_CHECK_INSTRUCTIONS) return "heuristic";
	return null;
}

/**
 * Format quality check results as stderr warning strings.
 * Includes per-check instructions so agents know how to fix properly
 * (no suppressions, no shortcuts — fix the actual code).
 *
 * Each warning is prefixed with a `[proven]` or `[heuristic]` tag derived
 * from the check's determinism so the agent can tell which findings are
 * authoritative (compiler / linter / scanner / parser said so) versus
 * pattern-matched suggestions (regex/AST shape — could be a false positive).
 * Lopopolo's framing: *"forbid speculative bug reports."* The tag forces
 * us to be explicit about what kind of evidence we're presenting.
 */
export function formatQualityWarnings(results: QualityCheckResult[]): string[] {
	return results.map((r) => {
		const tag = classifyDeterminism(r.name);
		const prefix = tag ? `[interlinked:${r.name}] [${tag}]` : `[interlinked:${r.name}]`;
		let msg = `${prefix} ${r.message}`;
		if (r.detail) {
			msg += `\n${r.detail}`;
		}
		const instruction = CHECK_INSTRUCTIONS[r.name];
		if (instruction) {
			msg += `\n→ ${instruction}`;
		}
		return msg;
	});
}
