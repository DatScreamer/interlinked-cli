// ===========================================
// PreToolUse Evaluation (Layer 1 deterministic + lifecycle enforcement)
// ===========================================
//
// Orchestrator for every PreToolUse guard. Composes the extracted modules
// (rule-matching, tool-classifiers, write-content-guards, taint-guards,
// permission-patterns, plus the pre-tool-{guards,rules,phases} siblings) and
// inlines the remaining shorter guard blocks — auto-reservations, curl-to-MCP,
// Bash file-dump, exfil, markdown-first, Read-sensitive, structural context,
// supermodel graph, graph-prediction, project setup, and diagnostics.
//
// The extracted helpers follow one contract: each pushes into the shared
// `warnings` array by reference and returns either a `HarnessDecision` (which
// the orchestrator returns immediately, short-circuiting) or `null`/void to
// continue. The call order below is identical to the historical inline order,
// preserving every early-return and side-effect.
//
// All 81 evaluator.test.ts cases exercise this function.

import type { SharedConfig } from "../../lib/config.js";
import type { CohortManager } from "../cohort.js";
import { extractScannableContent } from "../content-scanner/extractor.js";
import type { ContentScanRequest } from "../content-scanner/types.js";
import type { ErrorHistory } from "../error-history.js";
import { recordDeliveryForShadow } from "../event-dedup.js";
import { driveGraphPrediction } from "../graph-prediction-pre-tool.js";
import {
	DEFAULT_LOCKDOWN_CONFIG,
	evaluateLockdown,
} from "../lockdown-policy.js";
import {
	formatSequenceFinding,
	runSequenceDetectorsForPhase,
} from "../sequence-checks/index.js";
import type { ProjectGraph } from "../project-graph.js";
import type { ReservationManager } from "../reservations.js";
import type { RouteMap } from "../route-map.js";
import { extractAllEditedFilePaths } from "../server-tool-helpers.js";
import type { SessionTracker } from "../session-state.js";
import { getPreToolUseContext } from "../structural-checks.js";
import type {
	EscalationRequest,
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import {
	evaluateConfigLooseningGate,
	evaluateEditOldStringGuard,
	evaluateGitScopeGate,
	evaluateManifestEditGuard,
	evaluateMetaTestWrapper,
	evaluatePackageInstallGuard,
	evaluateProtectedFilesGuard,
	evaluateRepoConfinementGuard,
	evaluateSupermodelShardGuard,
	evaluateTddGate,
	evaluateWebFetchGuard,
} from "./pre-tool-guards.js";
import { evaluateDestructiveRules } from "./pre-tool-rules.js";
import {
	computePostInjectionEscalation,
	evaluateErrorMemory,
	evaluatePermissionPatternDetection,
	evaluatePreChecksSelfKillEnv,
	evaluatePreChecksTail,
} from "./pre-tool-phases.js";
import { evaluateFileDumpGuard } from "./file-dump-guard.js";
import { extractScannableText } from "./spans.js";
import { evaluateTaintGuards } from "./taint-guards.js";
import {
	isBash,
	isBrowserNavigate,
	isFileWrite,
	isReadOperation,
} from "./tool-classifiers.js";
import { evaluateWriteContentGuards } from "./write-content-guards.js";
import {
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
	// set. See evaluateMetaTestWrapper for the full rationale.
	{
		const d = evaluateMetaTestWrapper(toolName, toolInput);
		if (d) return d;
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
	{
		const d = evaluateSupermodelShardGuard(event);
		if (d) return d;
	}

	// GUARD: Supply-chain — block package-install shell commands whose
	// packages are not on the per-ecosystem allowlist.
	{
		const d = evaluatePackageInstallGuard(event, toolName, toolInput);
		if (d) return d;
	}

	// GUARD: Git session-scope gate (PB&J Free-CLI item #7) — asks before
	// `git add` / `git commit` / `git push` includes files this session didn't
	// write.
	{
		const d = evaluateGitScopeGate(event, rules, session, toolName, toolInput, warnings);
		if (d) return d;
	}

	// GUARD: Destructive patterns — Bash, Write, Edit, all tools — plus the
	// Bash-routed code-file write bypass and compound-command decomposition.
	{
		const d = evaluateDestructiveRules(event, rules, session, warnings);
		if (d) return d;
	}

	// GUARD: Protected files
	{
		const d = evaluateProtectedFilesGuard(toolName, toolInput, rules, warnings);
		if (d) return d;
	}

	// GUARD: Repo confinement — block writes outside CWD
	{
		const d = evaluateRepoConfinementGuard(event, toolName, toolInput, rules, warnings);
		if (d) return d;
	}

	// TDD gate — block new non-test .ts/.tsx without a companion test (enforce mode only).
	{
		const d = evaluateTddGate(event, rules, session, toolName, warnings);
		if (d) return d;
	}

	// Config-loosening gate — ask before strict-flag relaxations on
	// tsconfig.json / package.json / known config files.
	{
		const d = evaluateConfigLooseningGate(event, toolName, warnings);
		if (d) return d;
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
	{
		const d = evaluateEditOldStringGuard(toolName, toolInput, warnings);
		if (d) return d;
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
	{
		const d = evaluateWebFetchGuard(toolName, toolInput, warnings);
		if (d) return d;
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

	// PRE-CHECKS (head): self-kill + env-leak-to-git (delegated). The block
	// decisions intentionally omit `warnings` (matches the historical shape).
	{
		const d = evaluatePreChecksSelfKillEnv(event, toolName, toolInput, warnings);
		if (d) return d;
	}

	// GUARD: Supply-chain — block Write/Edit of a package manifest that
	// would introduce a new, unapproved dependency.
	{
		const d = evaluateManifestEditGuard(event, toolName, toolInput);
		if (d) return d;
	}

	// PRE-CHECKS (tail): line cap + stale-branch + dirty-tree + large-file +
	// concurrent-edit (delegated). The block decision intentionally omits
	// `warnings` (matches the historical shape).
	{
		const d = evaluatePreChecksTail(event, session, sessions, toolName, toolInput, warnings);
		if (d) return d;
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
	pendingEscalation = computePostInjectionEscalation(
		event,
		session,
		toolName,
		toolInput,
		pendingEscalation,
	);

	// PERMISSION PATTERN DETECTION
	evaluatePermissionPatternDetection(session, toolName, toolInput, warnings);

	// CONTEXT: Error memory — cross-session history
	evaluateErrorMemory(event, rules, session, graph, errorHistory, toolName, toolInput, warnings);

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
