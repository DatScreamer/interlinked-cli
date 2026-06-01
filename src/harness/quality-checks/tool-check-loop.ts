// ===========================================
// Tool-Check Loop — config-driven per-check dispatch
// ===========================================
// The main PostToolUse pass: iterate every enabled QualityCheckConfig and run
// its branch (inline content scan, parser-driven file-state check, or a
// subprocess tool via the check engine). Extracted from runQualityChecks so
// the orchestrator stays a thin sequencer. Check order, the per-check
// event-loop yields, and the onCheckBoundary / outToolMetrics instrumentation
// are preserved exactly — this is the PostToolUse pipeline, so behavior must
// not drift.

import { spawnSync } from "node:child_process";
import { extname, isAbsolute, resolve, sep } from "node:path";
import { configNameToToolId, getOrCreateEngine } from "../check-engine/index.js";
import { parseNpmAuditJson, parseOsvScannerJson } from "../check-engine/output-parsers.js";
import { isGeneratedFile, isTestFile } from "../checks/shared.js";
import { getProfileForFile } from "../language-profiles.js";
import type { HarnessEvent, QualityCheckConfig } from "../types.js";
import { resolveDependencyAuditCommand } from "./dependency-audit.js";
import { runInlineLanguageChecks } from "./inline-language-checks.js";
import { checkLockfileDrift, LOCKFILE_MAP } from "./lockfile-drift.js";
import { checkPackageJsonConsistency } from "./package-json.js";
import { findProjectRoot } from "./project-root.js";
import type { QualityCheckResult, ToolBreakdownEntry } from "./result-types.js";
import { containsSecrets } from "./secret-detection.js";
import {
	collectSoftwareVersionReferences,
	detectSoftwareVersionFreshnessConcerns,
	detectSoftwareVersionRegressions,
	formatSoftwareVersionFreshnessDetail,
	formatSoftwareVersionRegressionDetail,
} from "./software-version-regression.js";
import { findAnyTypes } from "./strong-typing.js";
import { isLikelyTestFile } from "./test-classifier.js";
import { TEST_DISPATCHERS } from "./test-dispatchers.js";

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
export function yieldEventLoop(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Context the tool-check loop needs from the orchestrator (mostly the
 *  shared file-content accessors so the loop reuses one disk read). */
export interface ToolCheckLoopContext {
	event: HarnessEvent;
	checks: Record<string, QualityCheckConfig>;
	cwd: string;
	filePath: string;
	/** Absolute path used by the skip_test_files guard. */
	absForTestCheck: string;
	/** Basename (no extension) used by the skip_test_files guard. */
	testCheckBaseName: string;
	/** Shared post-edit content accessor (memoized read). */
	getSharedContent: () => string | null;
	/** Memoized collectSoftwareVersionReferences for the post-edit content. */
	getAfterRefs: (content: string) => ReturnType<typeof collectSoftwareVersionReferences>;
	tscFilterFile: string | undefined;
	baseline: { softwareVersions?: ReturnType<typeof collectSoftwareVersionReferences> } | undefined;
	/** Out-parameter — one entry per subprocess tool invocation. */
	outToolMetrics: ToolBreakdownEntry[] | undefined;
	/** False when the edited file is outside the harness's own project. */
	editedFileInRepo: boolean | undefined;
	/** Diagnostic per-check boundary callback. */
	onCheckBoundary: ((name: string) => void) | undefined;
}

/**
 * Run the config-driven per-check loop and return the findings in push order.
 * Mirrors the original inline loop: same branches, same skip guards, same
 * yields and instrumentation hooks.
 */
export async function runToolCheckLoop(ctx: ToolCheckLoopContext): Promise<QualityCheckResult[]> {
	const results: QualityCheckResult[] = [];
	const {
		event,
		checks,
		cwd,
		filePath,
		absForTestCheck,
		testCheckBaseName,
		getSharedContent,
		getAfterRefs,
		onCheckBoundary,
	} = ctx;

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
		// Diagnostic: close the yield window into a separate bucket so the
		// check body's own time isn't conflated with whatever the event loop
		// serviced during the yield. If `yield_<name>` is large while
		// `inline_<name>` is small, the time was event-loop contention,
		// not the check's regex/AST work.
		onCheckBoundary?.(`yield_${name}`);

		// Skip test files for checks that opt in (e.g., semgrep, gitleaks)
		if (check.skip_test_files && isLikelyTestFile(testCheckBaseName, absForTestCheck)) continue;

		// Skip subprocess / tree-walking `command`-based checks (tsc, biome,
		// semgrep, gitleaks) when the edited file is outside the harness's
		// own project. The `check.command` branch below resolves a project
		// root and runs the check engine project-wide; for a foreign file
		// `findProjectRoot` falls back to `cwd`, which would run THIS
		// project's tooling against an unrelated file (wrong result) and
		// pay the project-tree-walk cost. Inline content checks (secrets,
		// strong_typing, software_version_regression, the inline-checks
		// block) carry no `command` and still run for out-of-tree files.
		if (ctx.editedFileInRepo === false && check.command) continue;

		try {
			if (name === "secrets_in_source") {
				// Skip test files (synthetic fixture secrets) and the harness's
				// own security-pattern definitions (secret-shaped strings as
				// data) — both yield only false positives on a per-edit scan.
				// `isTestFile` bundles both exemptions; its harness-internals
				// block is scoped to interlinked-cli's own package. gitleaks in
				// `interlinked verify` stays the repo-wide backstop.
				if (isTestFile(absForTestCheck)) continue;
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
				// Prefer the PreToolUse baseline (full before-file). When it is
				// absent (e.g. harness restarted between pre/post, or no pre
				// snapshot), reconstruct the full before-file by reverting the
				// edit — replace new_string back with old_string in the post
				// content. Collecting refs from the bare old_string snippet
				// alone is wrong: every pre-existing reference outside the
				// edited region would be absent from beforeRefs and so look
				// "newly introduced", firing freshness warnings on untouched
				// content whose line numbers merely shifted.
				let beforeRefs = ctx.baseline?.softwareVersions;
				if (!beforeRefs) {
					const oldStr = event.tool_input?.old_string;
					const newStr = event.tool_input?.new_string;
					if (typeof oldStr === "string" && typeof newStr === "string") {
						const reverted = postContent.includes(newStr)
							? postContent.replace(newStr, oldStr)
							: postContent;
						beforeRefs = collectSoftwareVersionReferences(reverted, filePath);
					} else if (typeof oldStr === "string") {
						beforeRefs = collectSoftwareVersionReferences(oldStr, filePath);
					} else {
						beforeRefs = [];
					}
				}
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

				const filterToFile = ctx.tscFilterFile ? true : name !== "typescript"; // tsc runs project-wide unless smart-tsc filtering
				const targetFile =
					ctx.tscFilterFile && name === "typescript"
						? resolve(checkCwd, ctx.tscFilterFile)
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

				if (ctx.outToolMetrics) {
					for (const m of engineReport.metrics) {
						ctx.outToolMetrics.push({
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
		onCheckBoundary?.(`inline_${name}`);
	}

	return results;
}
