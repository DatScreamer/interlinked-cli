// ===========================================
// PreToolUse Evaluation (Layer 1 deterministic + lifecycle enforcement)
// ===========================================
//
// Orchestrator for every PreToolUse guard. Composes the extracted modules
// (rule-matching, tool-classifiers, write-content-guards, taint-guards,
// permission-patterns) and inlines the remaining shorter guard blocks —
// protected files, repo confinement, reservations, curl-to-MCP, Bash
// safety, Edit old_string validation, WebFetch, Read-sensitive, structural
// context, project setup, diagnostics, pre-checks, and error memory.
//
// All 81 evaluator.test.ts cases exercise this function.

import { existsSync, readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
import { getOrCreateEngine } from "../check-engine/index.js";
import type { CohortManager } from "../cohort.js";
import { extractScannableContent } from "../content-scanner/extractor.js";
import type { ContentScanRequest } from "../content-scanner/types.js";
import {
	applyRewrite,
	evaluateCompoundCommand,
	inferAgentRole,
	ruleAppliesToRole,
} from "../command-decomposition.js";
import { findClosestSpans, formatNearMisses } from "../edit-diagnostics.js";
import type { ErrorHistory } from "../error-history.js";
import { checkProjectSetup } from "../generic-checks.js";
import { getPatternWarnings } from "../pattern-detector.js";
import {
	checkConcurrentEdit,
	checkDirtyWorkingTree,
	checkEnvLeakToGit,
	checkLargeFileWrite,
	checkSelfKill,
	checkStaleBranch,
	detectBashCodeFileWrite,
} from "../pre-checks.js";
import type { ProjectGraph } from "../project-graph.js";
import { containsSecrets as containsSecretsDetailed, findProjectRoot } from "../quality-checks.js";
import type { ReservationManager } from "../reservations.js";
import type { RouteMap } from "../route-map.js";
import type { SessionTracker } from "../session-state.js";
import { getPreToolUseContext } from "../structural-checks.js";
import type {
	EscalationRequest,
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	QualityCheckConfig,
	SessionTrajectory,
} from "../types.js";
import { evaluateProtectedFiles, evaluateRepoConfinement } from "./filesystem-guards.js";
import { addPermissionToSettings, extractPermissionPattern } from "./permission-patterns.js";
import { formatReason, matchesRule, shouldEvaluateRule } from "./rule-matching.js";
import { evaluateTaintGuards } from "./taint-guards.js";
import { evaluateTddNewFileGateForEvent } from "./tdd-new-file-gate.js";
import {
	estimateEditLine,
	isBash,
	isBrowserNavigate,
	isFileOperation,
	isFileWrite,
	isReadOperation,
} from "./tool-classifiers.js";
import { evaluateWriteContentGuards } from "./write-content-guards.js";

const DIAGNOSTIC_EXTENSIONS = /\.(tsx?|jsx?|mjs|cjs)$/;
const SOFT_BLOCK_KEY_MAX = 120;
const ESCALATION_TAIL_LENGTH = 10;
const SECRETS_MIN_CHARS = 10;
const STALE_BRANCH_CHECK_LIMIT = 3;
const LARGE_READ_SIZE_MB = 10;
const PERMISSION_PATTERN_THRESHOLD = 3;

/** Files that have already had git blame injected this session (dedup per session ID) */
const _blameInjectedFiles = new Map<string, Set<string>>();

let _projectSetupChecked = false;
let _projectSetupWarnings: string[] = [];

function getProjectSetupWarnings(cwd: string): string[] {
	if (_projectSetupChecked) return _projectSetupWarnings;
	_projectSetupChecked = true;
	const issues = checkProjectSetup(cwd);
	if (issues.length === 0) return [];
	_projectSetupWarnings = issues.map((i) => `[interlinked:setup] ${i.message}\n  fix: ${i.fix}`);
	return _projectSetupWarnings;
}

/** Boolean wrapper: delegates to quality-checks.ts signature scanner. */
function containsSecrets(content: string): boolean {
	if (!content || content.length < SECRETS_MIN_CHARS) return false;
	return containsSecretsDetailed(content).length > 0;
}

/** Run tsc and biome against a target file BEFORE an edit, returning existing
 *  errors as context warnings. Delegates to the unified CheckEngine which
 *  handles mtime-based caching internally. */
function getPreToolUseDiagnostics(
	filePath: string,
	cwd: string,
	qualityChecks: Record<string, QualityCheckConfig> | undefined,
): string[] {
	if (!filePath || !DIAGNOSTIC_EXTENSIONS.test(filePath) || !existsSync(filePath)) return [];
	if (!qualityChecks) return [];
	const checkCwd = findProjectRoot(filePath, cwd) || cwd;
	const relPath = relative(checkCwd, filePath) || filePath;
	const engine = getOrCreateEngine(checkCwd);
	const results = engine.getDiagnostics(filePath);
	if (results.length === 0) return [];
	const diagnostics = results.slice(0, 10).map((r) => {
		const prefix = r.tool === "biome" ? "biome: " : "";
		return `${prefix}${r.file}(${r.line}): ${r.message}`;
	});
	return [
		`[interlinked:diagnostics] ${relPath} has ${diagnostics.length} existing issue${diagnostics.length === 1 ? "" : "s"}:`,
		...diagnostics.map((d) => `  ${d}`),
		"→ Fix these while editing this file.",
	];
}

/** Public API — consumed by server.ts via the root evaluator.ts re-export.
 *  This is the main PreToolUse decision entry point; every hook call runs
 *  through here before a tool executes. The nine positional parameters
 *  mirror the long-standing harness contract; refactoring them into an
 *  options object would cascade into every test and caller for no semantic
 *  gain, so they are preserved as-is. */
export function evaluatePreToolUse(
	event: HarnessEvent,
	rules: GuardRulesConfig,
	session: SessionTrajectory | undefined,
	reservations: ReservationManager,
	cohort: CohortManager,
	graph?: ProjectGraph,
	sessions?: SessionTracker,
	routeMap?: RouteMap,
	errorHistory?: ErrorHistory,
): HarnessDecision {
	if (!rules.enabled) return { decision: "allow" }; // early exit when harness disabled

	const warnings: string[] = [];
	const toolName = event.tool_name || "";
	const toolInput = event.tool_input || {};
	let pendingEscalation: EscalationRequest | undefined;
	let pendingContentScan: ContentScanRequest | undefined;
	void _blameInjectedFiles; // reserved for future blame-injection dedup

	// GUARD: Destructive patterns — Bash, Write, Edit, all tools
	{
		const cmd = (toolInput.command as string) || "";
		const agentRole = inferAgentRole(event);

		for (const rule of rules.rules) {
			if (!shouldEvaluateRule(rule, "PreToolUse", toolName)) continue;
			if (!ruleAppliesToRole(rule, agentRole)) continue;
			if (
				!matchesRule({
					command: cmd,
					toolInput,
					rule,
					extraExceptions: rules.extra_exceptions,
				})
			)
				continue;

			if (rule.action === "block") {
				return {
					decision: "block",
					reason: formatReason(rule),
					warnings,
					rule_id: rule.id,
					severity: rule.severity,
					category: (rule as { category?: string }).category,
				};
			}
			if (rule.action === "soft_block") {
				const softKey = `${rule.id}::${cmd.slice(0, SOFT_BLOCK_KEY_MAX)}`;
				if (session?.soft_blocks.has(softKey)) {
					warnings.push(`[interlinked] Warning (retry allowed): ${rule.reason}`);
				} else {
					if (session) session.soft_blocks.add(softKey);
					return {
						decision: "block",
						reason: formatReason(rule),
						warnings,
						rule_id: rule.id,
						severity: rule.severity,
						category: (rule as { category?: string }).category,
					};
				}
			}
			if (rule.action === "rewrite" && rule.rewrite && cmd) {
				const rewritten = applyRewrite(cmd, rule.rewrite);
				if (rewritten !== cmd) {
					warnings.push(`[interlinked:rewrite] Rewrote command per rule ${rule.id}`);
					return {
						decision: "allow",
						warnings,
						updated_input: { ...toolInput, command: rewritten },
						rule_id: rule.id,
					};
				}
			}
			warnings.push(`[interlinked] Warning: ${rule.reason}`);
		}

			// GUARD: Bash-routed code-file writes (bypass content gate)
			if (isBash(toolName) && cmd) {
			const redirectHit = detectBashCodeFileWrite(cmd);
			if (redirectHit) {
				return {
					decision: "block",
					reason:
						`BLOCKED: This Bash command writes to a tracked source file (${redirectHit.target}) ` +
						`via ${redirectHit.mechanism}, which bypasses the content-quality gates that run on ` +
						"the Write and Edit tools (pre_block registry, biome diff-overlay, tsc diff-overlay). " +
						"For single-site edits, use the Write or Edit tool so the content is checked before " +
						"it lands. For coordinated multi-site atomic edits (e.g. adding an import AND using " +
						"it in the same landing — which would trip the diff-overlay if staged as two Edit " +
						"calls), route through `interlinked write` (single-file) or `interlinked write " +
						"--batch <manifest.json>` (multi-file atomic), or use the MultiEdit tool — each of " +
						"these applies the same content-quality gate but treats your whole change as one " +
						"transactional unit.",
					warnings,
					rule_id: "bash-code-file-write-bypass",
					severity: "high",
					category: "harness-integrity",
				};
			}
		}

		// Compound command decomposition: split && / || / ; and check each subcommand
		if (isBash(toolName) && (cmd.includes("&&") || cmd.includes("||") || cmd.includes(";"))) {
			const compoundResult = evaluateCompoundCommand(
				cmd,
				rules.rules,
				rules.extra_exceptions,
				(c, inp, rule, extras) =>
					matchesRule({
						command: c,
						toolInput: inp,
						rule,
						extraExceptions: extras,
					}),
			);
			if (compoundResult.decision === "block") {
				return {
					decision: "block",
					reason: compoundResult.reason,
					warnings: [...warnings, ...compoundResult.warnings],
					rule_id: compoundResult.rule_id,
					severity: compoundResult.severity,
					category: compoundResult.category,
				};
			}
			warnings.push(...compoundResult.warnings);
			if (compoundResult.updated_input) {
				return {
					decision: "allow",
					warnings,
					updated_input: { ...toolInput, ...compoundResult.updated_input },
				};
			}
		}
	}

	// GUARD: Protected files
	if (isFileOperation(toolName)) {
		const filePath = (toolInput.file_path as string) || (toolInput.path as string) || "";
		if (filePath) {
			const content = (toolInput.content as string) || (toolInput.new_string as string) || "";
			const pfDecision = evaluateProtectedFiles({
				toolName,
				filePath,
				content,
				protectedFiles: rules.protected_files,
				containsSecrets,
			});
			if (pfDecision) return { ...pfDecision, warnings };
		}
	}

	// GUARD: Repo confinement — block writes outside CWD
	if (isFileWrite(toolName) && event.cwd) {
		const rawPath = (toolInput.file_path as string) || (toolInput.path as string) || "";
		if (rawPath) {
			const rcDecision = evaluateRepoConfinement({
				rawPath,
				cwd: event.cwd,
				allowlist: rules.repo_confinement_allowlist || [],
			});
			if (rcDecision) return { ...rcDecision, warnings };
		}
	}

	// TDD gate — block new non-test .ts/.tsx without a companion test (enforce mode only).
	if (isFileWrite(toolName)) {
		const d = evaluateTddNewFileGateForEvent(event, rules, session);
		if (d) return { ...d, warnings };
	}

	// RESERVATION: Auto file reservation
	if (isFileWrite(toolName)) {
		const filePath = (toolInput.file_path as string) || (toolInput.path as string) || "";
		if (filePath) {
			const agentName = event.agent_name || session?.agent_name || "unknown";
			const conflict = reservations.checkAndReserve(filePath, agentName, cohort);
			if (conflict) {
				if (conflict.cohort === "remote") {
					return {
						decision: "block",
						reason: `File reserved by ${conflict.agent_name}${conflict.human ? ` (${conflict.human})` : ""}. Expires ${conflict.expires_at || "soon"}. Coordinate via MCP messages.`,
						reservation: {
							action: "conflict",
							file: filePath,
							holder: conflict.agent_name,
							expires_at: conflict.expires_at,
						},
						warnings,
					};
				}
				warnings.push(
					`[interlinked] Note: Your agent "${conflict.agent_name}" also has ${filePath} reserved.`,
				);
			}
		}
	}

	// LIFECYCLE: curl-to-MCP detection
	if (isBash(toolName) && rules.curl_mcp_detection?.enabled && session) {
		const cmd = (toolInput.command as string) || "";
		for (const port of rules.curl_mcp_detection.localhost_ports) {
			// nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
			const pattern = new RegExp(
				`(?:curl|wget|fetch).*(?:localhost|127\\.0\\.0\\.1):${port}`,
				"i",
			);
			if (pattern.test(cmd)) {
				const count = (session.curl_localhost_count[port] || 0) + 1;
				session.curl_localhost_count[port] = count;
				if (count >= rules.curl_mcp_detection.escalate_after) {
					warnings.push(
						`[interlinked:curl-mcp] MCP server may be disconnected. ${count} curl calls to localhost:${port} detected this session. Consider reconnecting your MCP server.`,
					);
				} else {
					warnings.push(
						`[interlinked] ${rules.curl_mcp_detection.message} (${count}/${rules.curl_mcp_detection.escalate_after})`,
					);
				}
			}
		}
	}

	// GUARD: curl to /mcp routes — agent should use MCP directly
	if (isBash(toolName)) {
		const cmd = (toolInput.command as string) || "";
		if (/\b(curl|wget|fetch)\b/.test(cmd) && /\/mcp\b/i.test(cmd)) {
			warnings.push(
				"[interlinked:mcp-direct] You're curling an /mcp endpoint directly. " +
					"MCP servers should be accessed via MCP tools, not HTTP. " +
					"If the MCP server isn't connected, ask the user to re-configure and restart it.",
			);
		}
	}

	// GUARD: Pipe-to-bash / remote code execution
	if (isBash(toolName)) {
		const cmd = (toolInput.command as string) || "";

		if (/\b(curl|wget)\b.*\|\s*(ba)?sh\b/i.test(cmd)) {
			warnings.push(
				"[interlinked] Warning: Piping remote content to shell is a security risk. Download first, inspect, then execute.",
			);
		}
		if (/--no-verify\b/i.test(cmd)) {
			warnings.push(
				"[interlinked] Warning: --no-verify bypasses safety hooks. These hooks exist to prevent broken commits.",
			);
		}
		if (
			/\b(curl|wget)\b/i.test(cmd) &&
			/https?:\/\/(?!localhost|127\.0\.0\.1)/i.test(cmd) &&
			!pendingEscalation
		) {
			pendingEscalation = {
				trigger: "external_url",
				summary: "Bash command contains curl/wget to external URL",
				tool_name: toolName,
				tool_input_redacted: { command: "[REDACTED — contains external URL]" },
				sensitivity_level: session?.sensitivity_level || "Public",
				step_number: session?.tool_call_count || 0,
				recent_tool_sequence: session?.tool_sequence.slice(-ESCALATION_TAIL_LENGTH) || [],
			};
		}
		if (
			/\bcurl\b.*(-d|--data|--data-raw|--data-binary)\b.*https?:\/\/(?!localhost|127\.0\.0\.1)/i.test(
				cmd,
			)
		) {
			warnings.push(
				"[interlinked] Warning: Sending data to an external URL. Verify this is intentional and not exfiltrating sensitive data.",
			);
		}
		if (/\b(env|printenv|set)\b.*\|\s*(curl|wget|nc|netcat)\b/i.test(cmd)) {
			return {
				decision: "block",
				reason: "BLOCKED: Piping environment variables to a network tool is a data exfiltration risk.",
				warnings,
			};
		}
		if (/\b(pip|npm)\s+install\b.*(-i\b|--index-url|--registry)\b/i.test(cmd)) {
			warnings.push(
				"[interlinked] Warning: Installing packages from a custom registry. Verify this is a trusted source (dependency confusion risk).",
			);
		}
		if (session) {
			const tmpWritePattern = /\b(cat|echo|printf|tee)\b[\s\S]*>\s*\/tmp\//i;
			const tmpExecPattern =
				/\b(chmod\s+\+?[0-7]*x|bash|sh|python3?|node|ruby|perl|osascript)\s+\/tmp\//i;
			if (tmpWritePattern.test(cmd) || tmpExecPattern.test(cmd)) {
				warnings.push(
					"[interlinked:supply-chain] Writing/executing scripts in /tmp/ — this matches the dropper staging pattern used in supply chain attacks (ref: axios@1.14.1 wrote AppleScript to /tmp/ then executed via osascript). Prefer writing scripts to the project directory.",
				);
			}
		}
	}

	// GUARD: Edit tool — verify old_string exists
	if (toolName === "Edit" && toolInput.file_path && toolInput.old_string) {
		const filePath = toolInput.file_path as string;
		const oldString = toolInput.old_string as string;
		try {
			if (existsSync(filePath)) {
				const fileContent = readFileSync(filePath, "utf-8");
				if (!fileContent.includes(oldString)) {
					const misses = findClosestSpans(fileContent, oldString, 3);
					const hint = misses.length
						? `\nClosest matches in file:\n${formatNearMisses(misses)}\nRe-read at one of these line ranges, then retry with the exact text.`
						: "";
					return {
						decision: "block",
						reason: `Edit will fail: old_string not found in ${filePath}. The file may have been modified by another agent. Re-read the file first.${hint}`,
						warnings,
					};
				}
			}
		} catch (e) {
			void e;
		}
	}

	// GUARD: Write/Edit content validation (delegated)
	if (isFileWrite(toolName) && (toolInput.content || toolInput.new_string)) {
		const result = evaluateWriteContentGuards({
			toolName,
			toolInput,
			event,
			rules,
			session,
			pendingEscalation,
		});
		if (result.kind === "block") {
			return {
				...result.decision,
				warnings: [...warnings, ...(result.decision.warnings || [])],
			};
		}
		warnings.push(...result.warnings);
		pendingEscalation = result.escalation;
	}

	// GUARD: WebFetch — exfiltration and safety
	if (toolName === "WebFetch" || toolName === "web_fetch" || toolName === "WebSearch") {
		const url = (toolInput.url as string) || "";
		if (url.startsWith("file://")) {
			return {
				decision: "block",
				reason: "BLOCKED: file:// protocol access is not allowed via WebFetch.",
				warnings,
			};
		}
	}

	// GUIDE: Markdown-first web fetching nudges
	if (isBrowserNavigate(toolName)) {
		const url = (toolInput.url as string) || "";
		if (url && /^https?:\/\//i.test(url)) {
			warnings.push(
				"[interlinked:markdown-first] Browser navigation to read web content is token-expensive. " +
					`Try first: curl -sS -H "Accept: text/markdown" '${url}' — ` +
					"Cloudflare Markdown for Agents returns clean markdown (~80% fewer tokens). " +
					"Use the browser only if the page needs JavaScript rendering or interaction.",
			);
		}
	}
	if (isBash(toolName)) {
		const cmd = (toolInput.command as string) || "";
		if (
			/\b(curl|wget)\b/.test(cmd) &&
			/https?:\/\/(?!localhost|127\.0\.0\.1)/i.test(cmd) &&
			!/Accept:\s*text\/markdown/i.test(cmd) &&
			!/-H\s+["']Content-Type:\s*application\/json/i.test(cmd) &&
			!/-X\s+(POST|PUT|PATCH|DELETE)\b/i.test(cmd) &&
			!/--data\b|--data-raw\b|--data-binary\b|-d\s/i.test(cmd) &&
			!/\s-[oO]\s/.test(cmd)
		) {
			warnings.push(
				"[interlinked:markdown-first] curl/wget without Accept: text/markdown header. " +
					'Add: -H "Accept: text/markdown" to get Cloudflare\'s Markdown for Agents format (~80% fewer tokens). ' +
					"Response includes x-markdown-tokens header with estimated token count.",
			);
		}
	}

	// GUARD: Read — block sensitive files, warn on oversized files
	if (isReadOperation(toolName) && toolInput.file_path) {
		const filePath = toolInput.file_path as string;
		const readFileName = filePath.split("/").pop() || "";
		const sensitiveFilePatterns = [
			/^\.env($|\.)/,
			/^credentials\.json$/,
			/^service[_-]account.*\.json$/i,
			/\.pem$/,
			/\.key$/,
			/\.p12$/,
			/\.pfx$/,
			/\.jks$/,
		];
		const sensitiveExceptions = [/\.env\.example$/, /\.env\.sample$/, /\.env\.template$/];
		if (
			sensitiveFilePatterns.some((p) => p.test(readFileName)) &&
			!sensitiveExceptions.some((p) => p.test(readFileName))
		) {
			return {
				decision: "block",
				reason: `BLOCKED: ${readFileName} contains secrets or credentials. Agents should not read sensitive files — use environment variables or ask the user for specific values you need.`,
				warnings,
			};
		}
		try {
			if (existsSync(filePath)) {
				const stat = statSync(filePath);
				const sizeMB = stat.size / (1024 * 1024);
				if (sizeMB > LARGE_READ_SIZE_MB) {
					warnings.push(
						`[interlinked] Warning: ${filePath} is ${sizeMB.toFixed(1)}MB. Reading large files consumes significant context. Consider reading specific line ranges.`,
					);
				}
			}
		} catch (_err) {
			/* intentional: stat failure — let the tool handle the missing-file error */
		}
	}

	// CONTEXT: Structural context injection
	if (graph && sessions && rules.structural_checks?.enabled) {
		const contextWarnings = getPreToolUseContext(
			event,
			rules.structural_checks,
			graph,
			sessions,
			session,
			routeMap,
		);
		warnings.push(...contextWarnings);
	}

	// PROJECT SETUP: One-time validation (first tool call only)
	const setupWarnings = getProjectSetupWarnings(event.cwd || process.cwd());
	if (setupWarnings.length > 0) warnings.push(...setupWarnings);

	// DIAGNOSTICS: PreToolUse file diagnostics (tsc + biome)
	if (isFileWrite(toolName) && rules.quality_checks) {
		const filePath = (toolInput.file_path as string) || (toolInput.path as string) || "";
		if (filePath && DIAGNOSTIC_EXTENSIONS.test(filePath)) {
			const diagWarnings = getPreToolUseDiagnostics(
				filePath,
				event.cwd || process.cwd(),
				rules.quality_checks,
			);
			warnings.push(...diagWarnings);
		}
	}

	// PRE-CHECKS: Additional safety checks (delegated)
	const eventCwd = event.cwd || process.cwd();
	if (isBash(toolName)) {
		const command = (toolInput.command as string) || "";
		if (command) {
			const selfKillResult = checkSelfKill(command);
			if (selfKillResult?.block) {
				return {
					decision: "block",
					reason: selfKillResult.block,
					rule_id: "self-kill-protection",
					severity: "critical",
					category: "process-killing",
				};
			}
		}
	}
	if (isFileWrite(toolName)) {
		const filePath = (toolInput.file_path as string) || (toolInput.path as string) || "";
		const content = (toolInput.content as string) || (toolInput.new_string as string);
		if (filePath) {
			const envResult = checkEnvLeakToGit(filePath, content, eventCwd);
			if (envResult?.block) {
				return {
					decision: "block",
					reason: envResult.block,
					rule_id: "env-leak-to-git",
					severity: "high",
					category: "security",
				};
			}
			if (envResult?.warning) warnings.push(envResult.warning);
		}
	}
	if (session && session.tool_call_count <= STALE_BRANCH_CHECK_LIMIT) {
		const staleResult = checkStaleBranch(eventCwd, event.session_id);
		if (staleResult?.warning) warnings.push(staleResult.warning);
	}
	if (isBash(toolName)) {
		const command = (toolInput.command as string) || "";
		if (command) {
			const dirtyResult = checkDirtyWorkingTree(command, eventCwd);
			if (dirtyResult?.warning) warnings.push(dirtyResult.warning);
		}
	}
	if (isFileWrite(toolName)) {
		const content = (toolInput.content as string) || "";
		const largeResult = checkLargeFileWrite(content);
		if (largeResult?.warning) warnings.push(largeResult.warning);
	}
	if (isFileWrite(toolName) && sessions) {
		const filePath = (toolInput.file_path as string) || (toolInput.path as string) || "";
		if (filePath) {
			const concurrentResult = checkConcurrentEdit(
				filePath,
				event.session_id,
				sessions.getAll(),
			);
			if (concurrentResult?.warning) warnings.push(concurrentResult.warning);
		}
	}

	// Drain pending session warnings (from SessionStart async checks)
	if (session) {
		const pending = (session as SessionTrajectory & { pendingSessionWarnings?: string[] })
			.pendingSessionWarnings;
		if (pending && pending.length > 0) {
			warnings.push(...pending);
			(
				session as SessionTrajectory & { pendingSessionWarnings?: string[] }
			).pendingSessionWarnings = [];
		}
	}

	// TAINT: Sensitivity tracking, network blocking, step budget (delegated)
	if (rules.taint_tracking?.enabled && session) {
		const taintResult = evaluateTaintGuards({
			toolName,
			toolInput,
			rules,
			session,
			pendingEscalation,
		});
		if (taintResult.kind === "block") {
			return {
				...taintResult.decision,
				warnings: [...warnings, ...(taintResult.decision.warnings || [])],
			};
		}
		if (taintResult.kind === "allow-readonly") {
			return {
				...taintResult.decision,
				warnings: [...warnings, ...(taintResult.decision.warnings || [])],
			};
		}
		warnings.push(...taintResult.warnings);
		pendingEscalation = taintResult.escalation;
	}

	// ESCALATION: post_injection_action
	if (
		session &&
		session.injection_detected_steps.length > 0 &&
		(isBash(toolName) || isFileWrite(toolName)) &&
		!pendingEscalation
	) {
		const lastInjectionStep =
			session.injection_detected_steps[session.injection_detected_steps.length - 1];
		const stepsSince = session.tool_call_count - lastInjectionStep;
		const filePath = (toolInput.file_path as string) || "";
		pendingEscalation = {
			trigger: "post_injection_action",
			summary: `State-changing tool (${toolName}) used ${stepsSince} steps after injection was detected at step ${lastInjectionStep}`,
			tool_name: toolName,
			tool_input_redacted: filePath ? { file_path: filePath } : { command: "[REDACTED]" },
			sensitivity_level: session.sensitivity_level,
			step_number: session.tool_call_count,
			recent_tool_sequence: session.tool_sequence.slice(-ESCALATION_TAIL_LENGTH),
		};
	}

	// PERMISSION PATTERN DETECTION
	if (session) {
		const pattern = extractPermissionPattern(toolName, toolInput);
		if (pattern && !session.suggested_permissions.has(pattern)) {
			if (session.consecutive_pattern?.pattern === pattern) {
				session.consecutive_pattern.count++;
			} else {
				session.consecutive_pattern = { pattern, count: 1 };
			}
			if (session.consecutive_pattern.count >= PERMISSION_PATTERN_THRESHOLD) {
				session.suggested_permissions.add(pattern);
				const added = addPermissionToSettings(pattern);
				if (added) {
					warnings.push(
						`[interlinked:permissions] Added "${pattern}" to .claude/settings.json — you won't be prompted for this again.`,
					);
				}
				session.consecutive_pattern = null;
			}
		} else if (pattern === null) {
			session.consecutive_pattern = null;
		}
	}

	// CONTEXT: Error memory — cross-session history
	if (
		errorHistory &&
		rules.error_memory?.enabled &&
		(isFileWrite(toolName) || isReadOperation(toolName))
	) {
		const filePath = (toolInput.file_path as string) || (toolInput.path as string) || "";
		if (filePath && graph) {
			const relPath = graph.toRelative(filePath);
			const historyWarning = errorHistory.getFileHistoryWarning(relPath);
			if (historyWarning) warnings.push(historyWarning);
			if (session) {
				let editLine: number | undefined;
				if (toolName === "Edit" && toolInput.old_string && filePath) {
					editLine = estimateEditLine(filePath, toolInput.old_string as string);
				}
				const patternWarnings = getPatternWarnings(
					errorHistory.getRecords(),
					relPath,
					session,
					editLine,
				);
				warnings.push(...patternWarnings);
			}
		}
	}

	// CONTENT SCAN: collect scannable fragments for PII/secret detection.
	// The scan itself is async and happens in server.ts next to the existing
	// classifier flow; here we only build the request bundle synchronously.
	if (rules.content_scanner?.enabled) {
		pendingContentScan = extractScannableContent(event, rules.content_scanner);
	}

	return {
		decision: "allow",
		warnings: warnings.length > 0 ? warnings : undefined,
		_escalation: pendingEscalation,
		_contentScan: pendingContentScan,
	};
}
