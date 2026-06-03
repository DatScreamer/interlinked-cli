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

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { SharedConfig } from "../../lib/config.js";
import type { CohortManager } from "../cohort.js";
import {
	applyRewrite,
	evaluateCompoundCommand,
	inferAgentRole,
	ruleAppliesToRole,
} from "../command-decomposition.js";
import { extractScannableContent } from "../content-scanner/extractor.js";
import type { ContentScanRequest } from "../content-scanner/types.js";
import { findClosestSpans, formatNearMisses } from "../edit-diagnostics.js";
import type { ErrorHistory } from "../error-history.js";
import { recordDeliveryForShadow } from "../event-dedup.js";
import { driveGraphPrediction } from "../graph-prediction-pre-tool.js";
import {
	DEFAULT_LOCKDOWN_CONFIG,
	evaluateLockdown,
} from "../lockdown-policy.js";
import { getPatternWarnings } from "../pattern-detector.js";
import {
	formatSequenceFinding,
	runSequenceDetectorsForPhase,
} from "../sequence-checks/index.js";
import {
	checkConcurrentEdit,
	checkDirtyWorkingTree,
	checkEnvLeakToGit,
	checkLargeFileLineCountWrite,
	checkLargeFileWrite,
	checkSelfKill,
	checkStaleBranch,
	detectBashCodeFileWrite,
} from "../pre-checks.js";
import type { ProjectGraph } from "../project-graph.js";
import type { ReservationManager } from "../reservations.js";
import type { RouteMap } from "../route-map.js";
import { extractAllEditedFilePaths } from "../server-tool-helpers.js";
import type { SessionTracker } from "../session-state.js";
import { getPreToolUseContext } from "../structural-checks.js";
import { checkSupermodelShardWrite } from "../supermodel-shard-write-guard.js";
import type {
	EscalationRequest,
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import { evaluateActiveWhen } from "./active-when.js";
import { evaluateConfigLooseningForEvent } from "./config-loosening-gate.js";
import { evaluateFileDumpGuard } from "./file-dump-guard.js";
import { evaluateProtectedFiles, evaluateRepoConfinement } from "./filesystem-guards.js";
import { loadAllowlist } from "../package-allowlist.js";
import { parseInstallCommands } from "../package-install-parser.js";
import { evaluateManifestEdit } from "./manifest-edit-guard.js";
import { evaluateGitScopeGateSync } from "./git-session-scope-gate.js";
import { evaluatePackageInstall } from "./package-install-guard.js";
import { commandKeywordTokens, shouldEvaluateByKeywords } from "./keyword-quick-reject.js";
import { addPermissionToSettings, extractPermissionPattern } from "./permission-patterns.js";
import { formatAskReason, formatAskSystemMessage, formatReason, matchesRule, shouldEvaluateRule } from "./rule-matching.js";
import { extractScannableText } from "./spans.js";
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
import {
	collectDirtyDependentWarning,
	computeFullNewContent,
	containsSecrets,
	evaluateCurlMcpGuards,
	evaluateExfilGuards,
	evaluateMarkdownFirstCurlGuard,
	evaluateReadGuards,
	getPreToolUseDiagnostics,
	getProjectSetupWarnings,
	getSupermodelCallContext,
	getSupermodelGraphWarning,
	readGraphPredictionMode,
	runTrajectoryDetector,
} from "./pre-tool-helpers.js";

// `resetProjectSetupWarningsCache` lives in pre-tool-helpers.ts (next to the
// cache it invalidates) but is re-exported here because server.ts and
// lifecycle-events.ts import it from this module — preserve that entry point.
export { resetProjectSetupWarningsCache } from "./pre-tool-helpers.js";

const DIAGNOSTIC_EXTENSIONS = /\.(tsx?|jsx?|mjs|cjs)$/;
const SOFT_BLOCK_KEY_MAX = 120;
const ESCALATION_TAIL_LENGTH = 10;
const STALE_BRANCH_CHECK_LIMIT = 3;
const PERMISSION_PATTERN_THRESHOLD = 3;

/** Files that have already had git blame injected this session (dedup per session ID) */
const _blameInjectedFiles = new Map<string, Set<string>>();

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
	sharedConfig?: SharedConfig | null,
): HarnessDecision {
	if (!rules.enabled) return { decision: "allow" }; // early exit when harness disabled

	// Shadow-mode delivery de-dup: detect redundant hook deliveries of
	// this tool call (logged to dedup-shadow.jsonl). Detect-only, never skips.
	recordDeliveryForShadow(event);

	const warnings: string[] = [];
	const toolName = event.tool_name || "";
	const toolInput = event.tool_input || {};

	// Meta-test wrapper short-circuit: `interlinked harness test "..."` is the
	// CLI's own command for evaluating a synthetic tool call against the rule
	// set. Re-evaluating the outer wrapper would double-fire — the inner
	// quoted-string content matches rule regexes literally, surfacing warnings
	// on the wrapper that belong to the inner event the wrapper will dispatch
	// over the socket. Returning allow here skips the wrapper; the inner
	// synthetic event still runs through the full pipeline normally.
	if (toolName === "Bash" || toolName === "Shell" || toolName === "run_command") {
		const command = typeof toolInput.command === "string" ? toolInput.command : "";
		if (/^\s*interlinked\s+harness\s+test\b/.test(command)) {
			return { decision: "allow" };
		}
	}

	let pendingEscalation: EscalationRequest | undefined;
	let pendingContentScan: ContentScanRequest | undefined;
	let graphPredAdditionalContext: string | undefined;
	void _blameInjectedFiles; // reserved for future blame-injection dedup

	// Phase D.2 trajectory detector — feeds the per-session ring buffer and
	// surfaces any anti-pattern findings as warnings. Lazy: only instantiated
	// when at least one `harness.trajectory.*` flag is enabled (default off,
	// so this is a no-op until the flags flip via SharedConfig override).
	if (session) {
		const trajectoryWarnings = runTrajectoryDetector(event, session, sharedConfig ?? null);
		if (trajectoryWarnings.length > 0) warnings.push(...trajectoryWarnings);
	}

	// Sequence detectors — local-tier trajectory checks (security, cross-agent,
	// injection, quality). pre_block findings short-circuit with a block
	// decision; pre_warn findings append to warnings. Stop runs in
	// `lifecycle-events.ts::buildStopWarnings`. No-op until detectors register
	// with `default_enabled: true`. Lockdown policy (PR-N1) runs after the
	// dispatcher and may upgrade pre_warn → pre_block when active.
	if (session) {
		const preBlockFindings = runSequenceDetectorsForPhase({
			phase: "pre_block",
			trajectory: session,
			candidate: event,
		});
		const preWarnFindings = runSequenceDetectorsForPhase({
			phase: "pre_warn",
			trajectory: session,
			candidate: event,
		});
		// Lockdown evaluation: may upgrade some pre_warn findings to pre_block,
		// and may emit new findings (2-of-3-legs trifecta) the structural
		// detector wouldn't catch. Disabled by default; activate via config or
		// trajectory state. TODO(config-plumb): once `GuardRulesConfig` carries
		// a `lockdown` field, replace DEFAULT_LOCKDOWN_CONFIG with the resolved
		// value. For now the default config keeps lockdown off.
		const lockdownResult = evaluateLockdown({
			trajectory: session,
			candidate: event,
			sequenceFindings: [...preBlockFindings, ...preWarnFindings],
			config: DEFAULT_LOCKDOWN_CONFIG,
		});
		// Suppress the original pre_warn entry for any finding that got
		// upgraded — avoid double-rendering the same detector at both tiers.
		const upgradedIds = new Set(lockdownResult.upgradedFindings.map((f) => f.detector_id));
		const remainingPreWarn = preWarnFindings.filter((f) => !upgradedIds.has(f.detector_id));
		const finalPreBlock = [
			...preBlockFindings,
			...lockdownResult.upgradedFindings,
			...lockdownResult.emittedFindings,
		];
		const blockFinding = finalPreBlock[0];
		if (blockFinding) {
			return {
				decision: "block",
				reason: `[interlinked:sequence] ${blockFinding.detector_id}: ${blockFinding.match.message}`,
				warnings: warnings.length > 0 ? warnings : undefined,
			};
		}
		for (const f of remainingPreWarn) warnings.push(formatSequenceFinding(f));
	}

	// GUARD: Supermodel `.graph.*` shard write protection — apply_patch layer.
	// `builtin-supermodel-graph-write-blocked` covers tools that surface the
	// path under `tool_input.file_path`, but `apply_patch` embeds destinations
	// in the patch body. Run before the main rule loop so the block reason is
	// consistent regardless of which path the agent took to reach the shard.
	{
		const shardBlock = checkSupermodelShardWrite(event);
		if (shardBlock) {
			return {
				decision: "block",
				reason: shardBlock.reason,
				rule_id: shardBlock.rule_id,
				severity: shardBlock.severity,
				category: shardBlock.category,
			};
		}
	}

	// GUARD: Supply-chain — block package-install shell commands whose
	// packages are not on the per-ecosystem allowlist. Runs before the main
	// rule loop because the existing `builtin-npm-no-ignore-scripts` rule
	// only warns; this gate fails closed. Bypass via INTERLINKED_DISABLE_PACKAGE_GUARD=1
	// (logged; intended for documented bootstrap flows only).
	if (
		process.env.INTERLINKED_DISABLE_PACKAGE_GUARD !== "1" &&
		isBash(toolName)
	) {
		const cmd = (toolInput.command as string) || "";
		if (cmd) {
			const installCommands = parseInstallCommands(cmd);
			if (installCommands.length > 0) {
				const evalCwd = event.cwd || process.cwd();
				const allowlist = loadAllowlist(evalCwd);
				const supplyDecision = evaluatePackageInstall(installCommands, evalCwd, allowlist);
				if (supplyDecision && supplyDecision.decision === "block") {
					return supplyDecision;
				}
			}
		}
	}

	// GUARD: Git session-scope gate (PB&J Free-CLI item #7) — asks before
	// `git add` / `git commit` / `git push` includes files this session didn't
	// write. Off by default until validated on real sessions; force-push is
	// intentionally deferred to the existing force-push rule.
	if (isBash(toolName) && session) {
		const gateConfig = rules.git_session_scope_gate;
		if (gateConfig?.enabled && gateConfig.mode !== "off") {
			const cmd = (toolInput.command as string) || "";
			if (cmd) {
				const evalCwd = event.cwd || process.cwd();
				const verdict = evaluateGitScopeGateSync(cmd, session, evalCwd);
				if (verdict && verdict.decision === "ask") {
					const mappedDecision: "ask" | "block" =
						gateConfig.mode === "block" ? "block" : "ask";
					return {
						decision: mappedDecision,
						reason: verdict.reason ?? "git operation scope ambiguous",
						rule_id: "git-session-scope-gate",
						severity: "medium",
						category: "git-scope",
						warnings,
					};
				}
			}
		}
	}

	// GUARD: Destructive patterns — Bash, Write, Edit, all tools
	{
		const cmd = (toolInput.command as string) || "";
		// Plan 01 §1.3 keyword-quick-reject — pre-filter rules against the
		// command's tokenized words so platform-specific rules (`kubectl`,
		// `terraform`, etc.) don't run their regex on every Bash call. Rules
		// with no `keywords` field are always evaluated (preserves legacy
		// behavior for existing rules until they're backfilled).
		//
		// Wrapper-normalization (Plan 01 §1.1) and span-classification
		// (§1.2) are intentionally NOT globally applied in this matching
		// path. The existing rule corpus contains:
		//   • sudo-specific patterns (`\bsudo\s+rm\b`) that depend on
		//     seeing the raw `sudo` prefix.
		//   • SQL/argument-payload rules (`\bDROP\s+TABLE\b`) that need to
		//     match the quoted argument of `psql -c "DROP TABLE x"`.
		//   • Process-kill rules that NEGATE on quoted argument shape
		//     (`pkill -f 'wrangler dev'` should allow but `pkill node`
		//     should block).
		// Globally projecting wrapper-stripped + scannable text breaks all
		// three. The two modules remain available for explicit opt-in by
		// new rules / Plan 02-03 entries that prefer the cleaner semantics.
		const cmdTokens = cmd ? commandKeywordTokens(cmd) : new Set<string>();
		const agentRole = inferAgentRole(event);
		// Synthesize a richer match-input that exposes tool_name and
		// agent_source as top-level fields so guard-rule patterns can
		// match against them via `field: "tool_name"` / "agent_source"
		// without callers having to mutate the agent's actual tool_input.
		// Required by MCP destructive guards (mcp__*__delete*) and the
		// Railway MCP family that pattern-match on tool name rather than
		// command text.
		const matchInput = {
			...toolInput,
			tool_name: toolName,
			agent_source: event.agent_source,
		};

		for (const rule of rules.rules) {
			if (!shouldEvaluateRule(rule, "PreToolUse", toolName)) continue;
			if (!ruleAppliesToRole(rule, agentRole)) continue;
			if (!evaluateActiveWhen(rule, session, event)) continue;
			if (cmd && !shouldEvaluateByKeywords(rule, cmdTokens)) continue;
			if (
				!matchesRule({
					command: cmd,
					toolInput: matchInput,
					rule,
					extraExceptions: rules.extra_exceptions,
					toolName,
					session,
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
			if (rule.action === "ask") {
				// "ask" surfaces a per-call user prompt on agents that support
				// it (Claude Code, Cursor). On agents that lack an ask primitive
				// (Copilot, Codex, Gemini) the per-client encoders downgrade
				// ask → deny so the user still sees the reason: the .mjs path
				// goes through formatCopilotResponse / formatCodexResponse in
				// hook-template-chunks/provider-responses.ts, and the adapter
				// path goes through copilot-cli.encodeDecision /
				// codex.encodeDecision / gemini-cli.encodeDecision. Both must
				// stay in sync — if you add a new runner without an ask
				// primitive, mirror the deny mapping in BOTH places or
				// destructive rules will silently proceed on that runner.
				return {
					decision: "ask",
					reason: formatAskReason(rule),
					system_message: formatAskSystemMessage(rule, event),
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
						toolName,
						session,
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
				linkedProjects: rules.linked_projects || [],
			});
			if (rcDecision) return { ...rcDecision, warnings };
		}
	}

	// TDD gate — block new non-test .ts/.tsx without a companion test (enforce mode only).
	if (isFileWrite(toolName)) {
		const d = evaluateTddNewFileGateForEvent(event, rules, session);
		if (d) return { ...d, warnings };
	}

	// Config-loosening gate — ask before strict-flag relaxations on
	// tsconfig.json / package.json / known config files.
	if (isFileWrite(toolName)) {
		const d = evaluateConfigLooseningForEvent(event);
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
	// Only treat repeated localhost curls as an "MCP server may be disconnected"
	// signal when the request targets an MCP-shaped path (/mcp, /sse, /messages).
	// Port presence alone is NOT an MCP signal: :8787 is the wrangler dev port
	// (our own cloud governor), :3000/:5173/:4321 are generic dev servers. Curling
	// `/health` or `/governor/evaluate` on those is normal dev work, not a
	// dropped MCP connection. The precise /mcp-route guard below complements this.
	//
	// Both curl-to-MCP checks classify the command's EXECUTED spans only. A
	// `curl .../mcp` that lives inside a heredoc body or a quoted string — e.g.
	// a `git commit` message describing this very guard — is not an executed
	// request and must not fire. extractScannableText blanks quoted / comment /
	// heredoc spans, leaving executed text intact, so command-position is what
	// we test. (FP class: a commit message that merely mentions curl + /mcp.)
	const mcpScanCommand = isBash(toolName)
		? extractScannableText((toolInput.command as string) || "")
		: "";
	const targetsMcpPath = /\/(?:mcp|sse|messages?)\b/i.test(mcpScanCommand);
	if (isBash(toolName)) {
		warnings.push(
			...evaluateCurlMcpGuards({
				mcpScanCommand,
				targetsMcpPath,
				curlMcpDetection: rules.curl_mcp_detection,
				session,
			}),
		);
	}

	// GUARD: tail/head/cat output-budget enforcement (file-dump-guard).
	// Blocks foreground `tail -f` and unfiltered dumps of large files or
	// large line counts; warns on overlarge slices even when filtered.
	if (isBash(toolName)) {
		const cmd = (toolInput.command as string) || "";
		const result = evaluateFileDumpGuard({ command: cmd, cwd: process.cwd() });
		if (result.kind === "block") {
			return { ...result.decision, warnings };
		}
		if (result.kind === "warn") {
			warnings.push(result.message);
		}
	}

	// GUARD: Pipe-to-bash / remote code execution + curl-data exfiltration +
	// dirty-dependent pre-commit + /tmp dropper-staging (delegated).
	if (isBash(toolName)) {
		const cmd = (toolInput.command as string) || "";
		const exfilResult = evaluateExfilGuards({
			cmd,
			toolName,
			session,
			graph,
			cwd: event.cwd,
			pendingEscalation,
		});
		warnings.push(...exfilResult.warnings);
		pendingEscalation = exfilResult.escalation;
		if (exfilResult.block) {
			return { ...exfilResult.block, warnings };
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
		warnings.push(...evaluateMarkdownFirstCurlGuard(cmd));
	}

	// GUARD: Read — block sensitive files, warn on oversized files
	if (isReadOperation(toolName) && toolInput.file_path) {
		const filePath = toolInput.file_path as string;
		const readResult = evaluateReadGuards(filePath);
		if (readResult.block) {
			return { ...readResult.block, warnings };
		}
		warnings.push(...readResult.warnings);
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

	// CONTEXT: Supermodel graph awareness — surface blast radius and the
	// function-level call graph from Supermodel-emitted .graph.* shards if
	// the user is running their daemon. Read-only consumer; silent when no
	// shard exists. Loops over every edited path so multi-file Codex
	// apply_patch payloads each get their own warning(s). `isFileWrite()`
	// already includes "apply_patch" (tool-classifiers.ts:75), so the gate
	// covers Codex too. The [calls] context line (plan 08 §3a) is gated
	// behind a firing [impact] line — see docs/plans/08-supermodel-graph-provider.md.
	if (isFileWrite(toolName)) {
		for (const editedPath of extractAllEditedFilePaths(event)) {
			const graphWarning = getSupermodelGraphWarning(editedPath, event.cwd);
			if (!graphWarning) continue;
			warnings.push(graphWarning);
			const callContext = getSupermodelCallContext(editedPath, event.cwd);
			if (callContext) warnings.push(callContext);
		}
	}

	// CONTEXT: Graph-prediction protocol — predict/reveal/reconcile on top
	// of the existing impact-warning surface. Only Case E-fresh activates
	// the challenge; other cases are observation-only. Default mode is
	// `shadow` (telemetry-only) so the cache fills without disrupting users
	// before Phase 4 enables enforcement. See
	// `docs/design/graph-prediction-protocol.md`.
	{
		const mode = readGraphPredictionMode(sharedConfig ?? null);
		const cwd = event.cwd || process.cwd();
		const result = driveGraphPrediction({ event, cwd, mode, graph });
		if (result?.decision === "block") {
			return {
				decision: "block",
				reason: result.reason ?? "graph_prediction required",
				rule_id: "graph-prediction-protocol",
				severity: "medium",
				category: "graph-prediction",
			};
		}
		if (result?.additional_context) {
			// Belt-and-suspenders: warnings → stderr (visible in terminal +
			// activity.jsonl); additional_context → adapter routes to
			// hookSpecificOutput.additionalContext (model-only context
			// injection that Claude Code injects regardless of stderr
			// display state). Without the dedicated field, the comparison
			// can be missed if the runner doesn't surface PreToolUse stderr.
			warnings.push(result.additional_context);
			graphPredAdditionalContext = result.additional_context;
		}
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

	// GUARD: Supply-chain — block Write/Edit of a package manifest that
	// would introduce a new, unapproved dependency. Catches the vector
	// where an agent skips the install command and adds an entry directly
	// to package.json / requirements.txt / pyproject.toml / Cargo.toml /
	// Gemfile / go.mod.
	if (process.env.INTERLINKED_DISABLE_PACKAGE_GUARD !== "1" && isFileWrite(toolName)) {
		const mfPath = (toolInput.file_path as string) || (toolInput.path as string) || "";
		if (mfPath) {
			const mfCwd = event.cwd || process.cwd();
			const absPath = isAbsolute(mfPath) ? mfPath : resolve(mfCwd, mfPath);
			const fullNewContent = computeFullNewContent(absPath, toolInput);
			if (fullNewContent !== null) {
				const manifestBlock = evaluateManifestEdit({
					filePath: absPath,
					newContent: fullNewContent,
					allowlist: loadAllowlist(mfCwd),
					cwd: mfCwd,
				});
				if (manifestBlock) return manifestBlock;
			}
		}
	}

	// GUARD: per-file line cap — block a Write/Edit that would grow a
	// hand-written code file past the cap (see large-file-policy.ts).
	if (isFileWrite(toolName)) {
		const sizeBlock = checkLargeFileLineCountWrite(toolInput, eventCwd);
		if (sizeBlock?.block) {
			return {
				decision: "block",
				reason: sizeBlock.block,
				rule_id: "large-file-cap",
				severity: "medium",
				category: "file-size",
			};
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
		if (taintResult.kind === "ask") {
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
		additional_context: graphPredAdditionalContext,
		_escalation: pendingEscalation,
		_contentScan: pendingContentScan,
	};
}
