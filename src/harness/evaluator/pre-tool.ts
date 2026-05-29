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

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { isFeatureEnabled, type SharedConfig } from "../../lib/config.js";
import { getOrCreateEngine } from "../check-engine/index.js";
import {
	findDirtyDependents,
	formatDirtyDependentWarning,
	looksCoordinated,
} from "../checks/dirty-dependent.js";
import { isTestFile } from "../checks/shared.js";
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
import { checkProjectSetup } from "../generic-checks.js";
import {
	driveGraphPrediction,
	type GraphPredictionMode,
} from "../graph-prediction-pre-tool.js";
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
import { containsSecrets as containsSecretsDetailed, findProjectRoot } from "../quality-checks.js";
import type { ReservationManager } from "../reservations.js";
import type { RouteMap } from "../route-map.js";
import { extractAllEditedFilePaths } from "../server-tool-helpers.js";
import type { SessionTracker } from "../session-state.js";
import { getPreToolUseContext } from "../structural-checks.js";
import { loadGraphForFile } from "../supermodel-graph.js";
import { checkSupermodelShardWrite } from "../supermodel-shard-write-guard.js";
import { createTrajectoryDetector, type TrajectoryEvent } from "../trajectory.js";
import type {
	EscalationRequest,
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	QualityCheckConfig,
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

/** Public — invalidate the project-setup-warning cache. Called by the
 *  SessionStart auto-strip after rewriting `.claude/settings*.json`, so
 *  the next PreToolUse re-reads the file and stops emitting warnings
 *  for entries that have just been stripped. Without this, the daemon
 *  would keep serving the stale warning text for the remainder of its
 *  process lifetime. */
export function resetProjectSetupWarningsCache(): void {
	_projectSetupChecked = false;
	_projectSetupWarnings = [];
}

/** Boolean wrapper: delegates to quality-checks.ts signature scanner. */
function containsSecrets(content: string): boolean {
	if (!content || content.length < SECRETS_MIN_CHARS) return false;
	return containsSecretsDetailed(content).length > 0;
}

/** Phase D.2 trajectory detector entry point. Per session: lazy-instantiates
 *  the detector when any trajectory feature flag is on, then calls observe()
 *  for the current event and filters findings to only the enabled patterns.
 *
 *  Returns the warning strings to push onto the PreToolUse decision's
 *  warnings array. Empty array when the detector is disabled, the event
 *  isn't a recognized hook, or no findings fired. */
function runTrajectoryDetector(
	event: HarnessEvent,
	session: SessionTrajectory,
	sharedConfig: SharedConfig | null,
): string[] {
	const enabledPatterns = new Set<import("../trajectory.js").TrajectoryFinding["pattern"]>();
	if (isFeatureEnabled("harness.trajectory.tool_loop", sharedConfig)) {
		enabledPatterns.add("tool_loop");
	}
	if (isFeatureEnabled("harness.trajectory.destructive_sequence", sharedConfig)) {
		enabledPatterns.add("destructive_sequence");
	}
	if (isFeatureEnabled("harness.trajectory.unbackedoff_retry", sharedConfig)) {
		enabledPatterns.add("unbackedoff_retry");
	}
	if (isFeatureEnabled("harness.trajectory.silent_stall", sharedConfig)) {
		enabledPatterns.add("silent_stall");
	}
	if (enabledPatterns.size === 0) return [];

	if (!session.trajectoryDetector) {
		session.trajectoryDetector = createTrajectoryDetector();
	}

	const tsString = event.timestamp;
	const tsMs = tsString ? Date.parse(tsString) : Number.NaN;
	const trajectoryEvent: TrajectoryEvent = {
		ts_ms: Number.isFinite(tsMs) ? tsMs : Date.now(),
		hook_event:
			event.hook_event === "PostToolUse" || event.hook_event === "PostToolUseFailure"
				? event.hook_event
				: "PreToolUse",
		tool_name: event.tool_name || "",
		tool_input: event.tool_input,
	};

	const findings = session.trajectoryDetector.observe(trajectoryEvent);
	if (findings.length === 0) return [];

	return findings
		.filter((f) => enabledPatterns.has(f.pattern))
		.map((f) => f.message);
}

/** Read the graph-prediction protocol mode from shared config. Defaults
 *  to "shadow" — telemetry-only, no challenge fires. Phase 4 of the
 *  rollout flips the default to "soft_gate" or "enforced". */
function readGraphPredictionMode(config: SharedConfig | null): GraphPredictionMode {
	const harness = config?.harness as Record<string, unknown> | undefined;
	const block = harness?.graph_prediction as Record<string, unknown> | undefined;
	const mode = block?.mode;
	if (mode === "shadow" || mode === "soft_gate" || mode === "enforced") return mode;
	return "shadow";
}

/** Read-only consumer of Supermodel-emitted `.graph.*` shards. Returns one
 *  warning string when a HIGH or MEDIUM impact section is present for the
 *  edited file; returns null on LOW, missing shards, parse failures, or any
 *  I/O error. The shard file IS the API — we never call Supermodel's service
 *  or generate shards ourselves. See `docs/integrations/supermodel.md`. */
function getSupermodelGraphWarning(filePath: string, cwd?: string): string | null {
	const graph = loadGraphForFile(filePath, cwd);
	if (!graph || !graph.impact) return null;
	const { risk, domains, direct, transitive, affects } = graph.impact;
	if (risk === "LOW") return null;

	const relPath = cwd
		? relative(cwd, graph.sourcePath) || graph.sourcePath
		: graph.sourcePath;

	if (risk === "HIGH") {
		const domainsClause =
			domains.length > 0 ? ` across domains ${domains.join(" · ")}` : "";
		const affectsClause =
			affects.length > 0
				? ` Affects: ${affects.slice(0, 5).join(" · ")}${affects.length > 5 ? " · …" : ""}.`
				: "";
		return (
			`[interlinked:supermodel-graph] ${relPath}: ` +
			`HIGH-risk edit per .graph shard: ${direct} dependent file(s), ${transitive} transitive${domainsClause}.` +
			`${affectsClause} Confirm this is intentional.`
		);
	}

	const domainsClause =
		domains.length > 0 ? ` across ${domains.join(" · ")}` : "";
	const affectsClause =
		affects.length > 0
			? ` Affects: ${affects.slice(0, 3).join(" · ")}${affects.length > 3 ? " · …" : ""}.`
			: "";
	return (
		`[interlinked:supermodel-graph] ${relPath}: ` +
		`${direct} dependent file(s)${domainsClause}.${affectsClause}`
	);
}

/** Minimum external caller sites before the call-graph context line fires.
 *  A function with a single caller is under the noise floor — not a
 *  blast-radius signal worth a PreToolUse line. Tunable from telemetry; see
 *  `docs/plans/08-supermodel-graph-provider.md` §3a. */
const SUPERMODEL_CALL_MIN_CALLERS = 2;
/** Cap on functions listed in the call-graph context line. */
const SUPERMODEL_CALL_FN_CAP = 5;

/** Plan 08 §3a — read-only consumer of the `[calls]` section of a Supermodel
 *  `.graph.*` shard. Returns a function-level context line naming which
 *  functions defined in the edited file have external callers, ranked by
 *  caller count; null when the shard carries no `[calls]` section or has
 *  fewer than `SUPERMODEL_CALL_MIN_CALLERS` caller sites. The caller gates
 *  this behind a firing `[impact]` line, so plan 07's "LOW edits are silent"
 *  guarantee holds — no new noise surface on routine edits. */
function getSupermodelCallContext(filePath: string, cwd?: string): string | null {
	const graph = loadGraphForFile(filePath, cwd);
	if (!graph?.calls) return null;
	const { callers } = graph.calls;
	if (callers.length < SUPERMODEL_CALL_MIN_CALLERS) return null;

	// Group caller sites by the function they target — callers[].fn is
	// defined in THIS file; a function with more caller sites is the
	// higher-risk edit, so rank by count.
	const byFn = new Map<string, number>();
	for (const c of callers) {
		byFn.set(c.fn, (byFn.get(c.fn) ?? 0) + 1);
	}
	const ranked = [...byFn.entries()].sort((a, b) => b[1] - a[1]);
	const shown = ranked
		.slice(0, SUPERMODEL_CALL_FN_CAP)
		.map(([fn, n]) => `${fn} (${n} caller${n === 1 ? "" : "s"})`)
		.join(", ");
	const more =
		ranked.length > SUPERMODEL_CALL_FN_CAP
			? ` (+${ranked.length - SUPERMODEL_CALL_FN_CAP} more)`
			: "";

	const relPath = cwd
		? relative(cwd, graph.sourcePath) || graph.sourcePath
		: graph.sourcePath;
	return (
		`[interlinked:supermodel-graph] ${relPath}: call graph per .graph shard — ` +
		`${callers.length} caller site(s) into ${byFn.size} function(s): ${shown}${more}. ` +
		"Changing these signatures ripples to every caller."
	);
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
	const targetsMcpPath = /\/(?:mcp|sse|messages?)\b/i.test((toolInput.command as string) || "");
	if (isBash(toolName) && rules.curl_mcp_detection?.enabled && session && targetsMcpPath) {
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

		// GUARD: dirty-dependent pre-commit check. When the agent runs
		// `git commit`, walk staged files' transitive importers through the
		// project graph; flag any importer that is dirty-but-unstaged. This
		// catches the failure class that produced commit 7219b48 → red CI:
		// production code committed alone while its consumer test stayed
		// in the working tree, so tests passed locally and broke on the
		// committed snapshot in CI.
		if (/\bgit\s+commit\b/.test(cmd) && graph && event.cwd) {
			const dd = collectDirtyDependentWarning(event.cwd, graph);
			if (dd) warnings.push(dd);
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
		const result = driveGraphPrediction({ event, cwd, mode });
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

/** List `git diff` paths (relative to `cwd`) for either the index
 *  (`--cached`) or the working tree (no flag). Returns [] on any error
 *  (not a git repo, git not installed, etc.) so the dirty-dependent
 *  check fails open. */
function listGitDiffPaths(cwd: string, cached: boolean): string[] {
	try {
		const args = ["diff", "--name-only"];
		if (cached) args.push("--cached");
		const out = execFileSync("git", args, {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: GIT_TIMEOUT_MS,
		});
		return out
			.split("\n")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	} catch {
		return [];
	}
}

/** Shared timeout for the short-lived `git` invocations below. */
const GIT_TIMEOUT_MS = 3000;

/** Run `git diff <extraArgs>` in `cwd` and return its stdout. Returns ""
 *  on any failure so the dirty-dependent precision filter fails open. */
function runGitDiff(cwd: string, extraArgs: readonly string[]): string {
	try {
		return execFileSync("git", ["diff", ...extraArgs], {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: GIT_TIMEOUT_MS,
		});
	} catch {
		return "";
	}
}

/** Dirty-dependent pre-commit warning entry point. Returns a formatted
 *  warning string when a staged file is import-graph related to an
 *  unstaged-dirty file (a dirty importer or a dirty dependency); null
 *  when the commit is self-contained or git/graph data is missing.
 *
 *  Path normalization: git emits paths relative to the repo root, but
 *  `ProjectGraph` operates on absolute paths. Convert everything to
 *  absolute up front so the BFS walk's visited set and `dirtySet`
 *  membership compare on the same basis; the output then relativizes
 *  for display. */
function collectDirtyDependentWarning(cwd: string, graph: ProjectGraph): string | null {
	const stagedRel = listGitDiffPaths(cwd, true);
	if (stagedRel.length === 0) return null;
	const dirtyRel = listGitDiffPaths(cwd, false);
	if (dirtyRel.length === 0) return null;

	const toAbs = (p: string): string => (isAbsolute(p) ? p : resolve(cwd, p));
	const toRel = (p: string): string => relative(cwd, p) || p;
	const stagedAbs = stagedRel.map(toAbs);
	const dirtyAbs = dirtyRel.map(toAbs);

	// Memoized `git diff` fetch, feeding the `isRelevant` precision filter.
	// Keyed on the argv so the staged (`--cached`) and working-tree diffs
	// of the same file stay distinct.
	const diffCache = new Map<string, string>();
	const diffOf = (gitArgs: readonly string[]): string => {
		const key = gitArgs.join(" ");
		const hit = diffCache.get(key);
		if (hit !== undefined) return hit;
		const text = runGitDiff(cwd, gitArgs);
		diffCache.set(key, text);
		return text;
	};

	const matches = findDirtyDependents({
		stagedFiles: stagedAbs,
		unstagedDirtyFiles: dirtyAbs,
		getImporters: (file) => graph.getDependents(file),
		getDependencies: (file) => graph.getDependencies(file).map((e) => e.toFile),
		isTestFile: (file) => isTestFile(toRel(file)),
		// Precision: drop a candidate when the dirty file's change and the
		// staged change are not coordinated — the dirty file is dirty for an
		// unrelated reason. `looksCoordinated` fails open, so an
		// indeterminate diff keeps the warning.
		isRelevant: (m) =>
			looksCoordinated([
				diffOf(["--cached", "--", toRel(m.staged)]),
				diffOf(["--", toRel(m.dirtyFile)]),
			]),
	});
	if (matches.length === 0) return null;

	// Convert absolute paths back to repo-relative for the human-facing
	// warning. The pair structure is preserved; only the display strings
	// change.
	const display = matches.map((m) => ({
		...m,
		staged: toRel(m.staged),
		dirtyFile: toRel(m.dirtyFile),
	}));
	return formatDirtyDependentWarning({ matches: display });
}

/**
 * Compute the full post-write content of a file from a Write / Edit /
 * MultiEdit tool_input. Returns null when the operation's shape doesn't
 * map cleanly to a full content (apply_patch, NotebookEdit) — callers
 * skip the supply-chain manifest check on those paths.
 */
function computeFullNewContent(
	absPath: string,
	toolInput: Record<string, unknown>,
): string | null {
	if (typeof toolInput.content === "string") return toolInput.content;
	const readCurrent = (): string | null => {
		if (!existsSync(absPath)) return "";
		try {
			return readFileSync(absPath, "utf-8");
		} catch {
			return null;
		}
	};
	if (typeof toolInput.new_string === "string" && typeof toolInput.old_string === "string") {
		const current = readCurrent();
		if (current === null) return null;
		return current.replace(toolInput.old_string, toolInput.new_string);
	}
	if (Array.isArray(toolInput.edits)) {
		const current = readCurrent();
		if (current === null) return null;
		let result = current;
		for (const edit of toolInput.edits as unknown[]) {
			if (edit && typeof edit === "object") {
				const oldS = (edit as Record<string, unknown>).old_string;
				const newS = (edit as Record<string, unknown>).new_string;
				if (typeof oldS === "string" && typeof newS === "string") {
					result = result.replace(oldS, newS);
				}
			}
		}
		return result;
	}
	return null;
}
