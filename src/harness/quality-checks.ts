// ===========================================
// Quality Checks — PostToolUse static analysis
// ===========================================
// Runs configurable checks after file Edit/Write operations.
// Results are returned as warnings (written to stderr by the hook script, visible to agent).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, resolve, sep } from "node:path";
import { configNameToToolId, getOrCreateEngine } from "./check-engine/index.js";
import { buildAgentSafetyChecks, buildCheckInstructions } from "./check-registry/index.js";
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
import { TOOL_CHECK_INSTRUCTIONS } from "./quality-checks/instructions.js";
import { checkLockfileDrift, LOCKFILE_MAP } from "./quality-checks/lockfile-drift.js";
import { checkPackageJsonConsistency } from "./quality-checks/package-json.js";
import { findProjectRoot } from "./quality-checks/project-root.js";
import {
	countAsAnyCasts,
	countNonNullAssertions,
	countSuppressionDirectives,
} from "./quality-checks/ratchet-metrics.js";
import { containsSecrets } from "./quality-checks/secret-detection.js";
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
} from "./quality-checks/project-wide.js";
export {
	countAsAnyCasts,
	countNonNullAssertions,
	countSuppressionDirectives,
} from "./quality-checks/ratchet-metrics.js";
export { containsSecrets } from "./quality-checks/secret-detection.js";
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

/** Options for filtering quality check output. */
export interface QualityCheckOptions {
	/** When set, filter tsc output to only errors mentioning this file path */
	tscFilterFile?: string;
	/** Pre-edit baseline for diff-aware filtering (suppresses pre-existing findings) */
	baseline?: PreEditBaseline;
	/** Diff-aware config from guard rules */
	diffAware?: DiffAwareConfig;
}

/**
 * Run quality checks for a PostToolUse event on a file.
 * Returns an array of warnings/errors found.
 */
export function runQualityChecks(
	event: HarnessEvent,
	checks: Record<string, QualityCheckConfig>,
	cwd: string = process.cwd(),
	options?: QualityCheckOptions,
): QualityCheckResult[] {
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

	for (const [name, check] of Object.entries(checks)) {
		if (!check.enabled) continue;
		if (!check.file_types.some((t) => filePath.endsWith(t))) continue;

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

				// Inline check — read the ENTIRE file from disk and scan for `any`/`unknown` usage.
				// This catches all edits including Bash-based (sed, etc.).
				const absPath = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
				if (existsSync(absPath)) {
					try {
						const content = readFileSync(absPath, "utf-8");
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
					} catch (_e) {
						/* intentional: file unreadable — skip strong-typing inspection silently */
					}
				}
			} else if (name === "dependency_audit") {
				// SCA: run dependency audit when package/lock files are edited.
				// Detects known CVEs in project dependencies.
				const checkCwd = findProjectRoot(filePath, cwd) || cwd;
				const fileName = filePath.split("/").pop() || "";
				const auditCmd = resolveDependencyAuditCommand(fileName);
				if (!auditCmd) continue;

				const auditResult = spawnSync(auditCmd[0], auditCmd.slice(1), {
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

				// npm audit exits 1 when vulnerabilities found
				if (auditResult.status !== 0 && auditResult.status !== null) {
					const output = (auditResult.stdout || "").trim();
					let detail = "";
					try {
						const parsed = JSON.parse(output);
						// npm audit JSON format
						if (parsed.metadata?.vulnerabilities) {
							const v = parsed.metadata.vulnerabilities;
							const counts = [];
							if (v.critical) counts.push(`${v.critical} critical`);
							if (v.high) counts.push(`${v.high} high`);
							if (v.moderate) counts.push(`${v.moderate} moderate`);
							if (v.low) counts.push(`${v.low} low`);
							detail = counts.join(", ");
						}
					} catch {
						// Non-JSON output — use raw stderr
						detail =
							(auditResult.stderr || "").split("\n").slice(0, 5).join("\n") ||
							"vulnerabilities found";
					}

					results.push({
						name,
						severity: check.severity,
						message: `Dependency vulnerabilities found after editing ${filePath}`,
						file: filePath,
						detail: detail || "Run `npm audit` for details",
					});
				}
			} else if (name === "inline_language_checks") {
				// Data-driven per-language inline pattern checks. Reads the
				// inline_checks array declared in the file's LanguageProfile
				// and runs each regex after a language-aware comment + string
				// stripping pass. Replaces what was previously dead config.
				const profile = getProfileForFile(filePath);
				if (!profile || profile.inline_checks.length === 0) continue;
				const absPath2 = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
				if (!existsSync(absPath2)) continue;
				let content: string;
				try {
					content = readFileSync(absPath2, "utf-8");
				} catch {
					continue;
				}
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
				const absPath = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
				if (existsSync(absPath)) {
					try {
						const content = readFileSync(absPath, "utf-8");
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
					} catch (_e) {
						/* intentional: file unreadable — skip package-json consistency check */
					}
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

				const engineReport = engine.runChecks(
					{
						projectRoot: checkCwd,
						mode: "file",
						targetFile,
						filterToFile,
					},
					{ tools: [toolId], timeoutMs: check.timeout_ms },
				);

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
	}

	// ===========================================
	// Inline Checks — generic + language-specific (no subprocess, <10ms total)
	// ===========================================
	// These run AFTER subprocess checks (tsc, lint, etc.) for additional signal.
	// Read the file from disk once and reuse for all inline checks.

	const absFilePath = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
	if (existsSync(absFilePath)) {
		try {
			const fileContent = readFileSync(absFilePath, "utf-8");

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
					const noTestFile = checkTestFileExists(absFilePath);
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
				const agentSafetyChecks = buildAgentSafetyChecks(fileContent, absFilePath, "post");

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

				// Non-deterministic regex heuristics (generic_inline, silent_catch, sync_io_in_async,
				// perf_*, language-specific) have been moved to the scored suggestion pipeline
				// in server.ts. They're now scored, ranked, and only the top 1-3 above a
				// threshold are shown. See suggestion-scorer.ts.
			}
		} catch (_e) {
			/* intentional: file unreadable — skip inline checks silently */
		}
	}

	// ===========================================
	// Ratchet comparison — warn when countable quality metrics regress
	// ===========================================
	// Active when diff-aware is OFF (default): the agent is expected to improve
	// all issues in files it touches, not just avoid introducing new ones.
	// Metrics must not go up (more suppressions, more `as any`).
	if (options?.diffAware?.enabled === false && options?.baseline) {
		try {
			const absPath = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
			const postContent = existsSync(absPath) ? readFileSync(absPath, "utf-8") : "";
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

/**
 * Format quality check results as stderr warning strings.
 * Includes per-check instructions so agents know how to fix properly
 * (no suppressions, no shortcuts — fix the actual code).
 */
export function formatQualityWarnings(results: QualityCheckResult[]): string[] {
	return results.map((r) => {
		let msg = `[interlinked:${r.name}] ${r.message}`;
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
