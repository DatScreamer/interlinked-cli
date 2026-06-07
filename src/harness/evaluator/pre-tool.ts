// ===========================================
// PreToolUse Evaluation (Layer 1 deterministic + lifecycle enforcement)
// ===========================================
//
// Orchestrator for every PreToolUse guard. Composes the extracted modules
// (rule-matching, tool-classifiers, write-content-guards, taint-guards,
// permission-patterns, plus the pre-tool-{guards,rules,phases} siblings) and
// the internal phase helpers below — auto-reservations, curl-to-MCP, Bash
// file-dump, exfil, markdown-first, Read-sensitive, structural context,
// supermodel graph, graph-prediction, project setup, and diagnostics.
//
// Every phase is a function returning either a `HarnessDecision` (which
// short-circuits the pipeline) or `null` to continue; phases push into a shared
// `warnings` array by reference and thread cross-phase mutable state through a
// `PreToolCtx` holder. `evaluatePreToolUse` lists the phases as an ordered array
// of thunks and runs them through a single loop, returning on the first
// non-null decision. The list order is identical to the historical inline
// order, preserving every early-return and side-effect — the array is just the
// linear sequence made data, so complexity lives in the small phase helpers
// rather than one 90+-branch function.
//
// All evaluator.test.ts cases exercise this function.

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

/** The harness event's tool-input bag, normalized to a non-undefined object. */
type ToolInput = NonNullable<HarnessEvent["tool_input"]>;

/**
 * Mutable pipeline state that spans phases of `evaluatePreToolUse`. Extracting
 * cohesive phases into internal helpers means the cross-phase locals
 * (`pendingEscalation`, the content-scan request, and the graph-prediction
 * additional-context string) have to be carried by reference rather than as
 * function-scoped `let`s. Holding them on one object keeps the helper
 * signatures small and the threading explicit.
 */
interface PreToolCtx {
	// These mirror the original function-scoped `let x: T | undefined` locals, so
	// the fields are explicitly `T | undefined` (assignable from `undefined`)
	// rather than optional-only — the delegated guards return
	// `EscalationRequest | undefined` and assign it directly.
	escalation: EscalationRequest | undefined;
	contentScan: ContentScanRequest | undefined;
	graphPredAdditionalContext: string | undefined;
}

/**
 * Phase D.2 trajectory detector — feeds the per-session ring buffer and
 * surfaces any anti-pattern findings as warnings. Lazy: only instantiated
 * when at least one `harness.trajectory.*` flag is enabled (default off, so
 * this is a no-op until the flags flip via SharedConfig override). Warning-only.
 */
function evaluateTrajectoryDetectorPhase(
	event: HarnessEvent,
	session: SessionTrajectory | undefined,
	sharedConfig: SharedConfig | null,
	warnings: string[],
): void {
	if (!session) return;
	const trajectoryWarnings = runTrajectoryDetector(event, session, sharedConfig);
	if (trajectoryWarnings.length > 0) warnings.push(...trajectoryWarnings);
}

/**
 * Sequence detectors (local-tier trajectory checks) + lockdown evaluation.
 * `pre_block` findings short-circuit with a block decision; `pre_warn` findings
 * append to `warnings`. Lockdown may upgrade some `pre_warn` findings to
 * `pre_block` and may emit new findings (2-of-3-legs trifecta). The original
 * `pre_warn` entry for an upgraded finding is suppressed to avoid
 * double-rendering. No-op when no session, or until detectors register with
 * `default_enabled: true`. Returns a block `HarnessDecision` or `null`.
 */
function evaluateSequenceAndLockdown(
	event: HarnessEvent,
	session: SessionTrajectory | undefined,
	warnings: string[],
): HarnessDecision | null {
	if (!session) return null;
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
	return null;
}

/**
 * Auto file reservation. On a remote-cohort conflict, returns a block decision
 * carrying the reservation detail; on a same-agent conflict, appends a note.
 * Returns a `HarnessDecision` to short-circuit, else `null`.
 */
function evaluateAutoReservation(
	event: HarnessEvent,
	session: SessionTrajectory | undefined,
	toolName: string,
	toolInput: ToolInput,
	reservations: ReservationManager,
	cohort: CohortManager,
	warnings: string[],
): HarnessDecision | null {
	if (!isFileWrite(toolName)) return null;
	const filePath = (toolInput.file_path as string) || (toolInput.path as string) || "";
	if (!filePath) return null;
	const agentName = event.agent_name || session?.agent_name || "unknown";
	const conflict = reservations.checkAndReserve(filePath, agentName, cohort);
	if (!conflict) return null;
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
	return null;
}

/**
 * curl-to-MCP detection (Bash only). Only treats repeated localhost curls as an
 * "MCP server may be disconnected" signal when the request targets an
 * MCP-shaped path (/mcp, /sse, /messages). Port presence alone is NOT an MCP
 * signal. Classifies the command's EXECUTED spans only (extractScannableText
 * blanks quoted / comment / heredoc spans), so a commit message that merely
 * mentions curl + /mcp does not fire. Warning-only.
 */
function evaluateCurlMcpPhase(
	session: SessionTrajectory | undefined,
	rules: GuardRulesConfig,
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
): void {
	if (!isBash(toolName)) return;
	const mcpScanCommand = extractScannableText((toolInput.command as string) || "");
	const targetsMcpPath = /\/(?:mcp|sse|messages?)\b/i.test(mcpScanCommand);
	warnings.push(
		...evaluateCurlMcpGuards({
			mcpScanCommand,
			targetsMcpPath,
			curlMcpDetection: rules.curl_mcp_detection,
			session,
		}),
	);
}

/**
 * tail/head/cat output-budget enforcement (file-dump-guard, Bash only). Blocks
 * foreground `tail -f` and unfiltered dumps of large files or large line
 * counts; warns on overlarge slices even when filtered. Returns a block
 * `HarnessDecision` or `null`.
 */
function evaluateFileDumpPhase(
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
): HarnessDecision | null {
	if (!isBash(toolName)) return null;
	const cmd = (toolInput.command as string) || "";
	const result = evaluateFileDumpGuard({ command: cmd, cwd: process.cwd() });
	if (result.kind === "block") {
		return { ...result.decision, warnings };
	}
	if (result.kind === "warn") {
		warnings.push(result.message);
	}
	return null;
}

/**
 * Pipe-to-bash / remote code execution + curl-data exfiltration +
 * dirty-dependent pre-commit + /tmp dropper-staging (delegated, Bash only).
 * Threads `ctx.escalation`. Returns a block `HarnessDecision` or `null`.
 */
function evaluateExfilPhase(
	event: HarnessEvent,
	session: SessionTrajectory | undefined,
	graph: ProjectGraph | undefined,
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
	ctx: PreToolCtx,
): HarnessDecision | null {
	if (!isBash(toolName)) return null;
	const cmd = (toolInput.command as string) || "";
	const exfilResult = evaluateExfilGuards({
		cmd,
		toolName,
		session,
		graph,
		cwd: event.cwd,
		pendingEscalation: ctx.escalation,
	});
	warnings.push(...exfilResult.warnings);
	ctx.escalation = exfilResult.escalation;
	if (exfilResult.block) {
		return { ...exfilResult.block, warnings };
	}
	return null;
}

/**
 * Write/Edit content validation (delegated). Runs only for file-write tools
 * that carry `content` or `new_string`. On block, merges the decision's own
 * warnings into the running list. Otherwise threads `ctx.escalation`. Returns a
 * block `HarnessDecision` or `null`.
 */
function evaluateWriteContent(
	event: HarnessEvent,
	session: SessionTrajectory | undefined,
	rules: GuardRulesConfig,
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
	ctx: PreToolCtx,
): HarnessDecision | null {
	if (!(isFileWrite(toolName) && (toolInput.content || toolInput.new_string))) return null;
	const result = evaluateWriteContentGuards({
		toolName,
		toolInput,
		event,
		rules,
		session,
		pendingEscalation: ctx.escalation,
	});
	if (result.kind === "block") {
		return {
			...result.decision,
			warnings: [...warnings, ...(result.decision.warnings || [])],
		};
	}
	warnings.push(...result.warnings);
	ctx.escalation = result.escalation;
	return null;
}

/**
 * Markdown-first web-fetching nudges. The browser-navigate side nudges toward a
 * `curl -H "Accept: text/markdown"` first (Cloudflare Markdown for Agents);
 * the Bash side delegates to the curl-specific guard. Warning-only.
 */
function evaluateMarkdownFirstPhase(
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
): void {
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
}

/**
 * Read guards — block sensitive files, warn on oversized files. Runs only for
 * read operations carrying a `file_path`. Returns a block `HarnessDecision` or
 * `null`.
 */
function evaluateReadPhase(
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
): HarnessDecision | null {
	if (!(isReadOperation(toolName) && toolInput.file_path)) return null;
	const filePath = toolInput.file_path as string;
	const readResult = evaluateReadGuards(filePath);
	if (readResult.block) {
		return { ...readResult.block, warnings };
	}
	warnings.push(...readResult.warnings);
	return null;
}

/**
 * Structural context injection. Runs only when a project graph, session
 * tracker, and `structural_checks.enabled` are all present. Warning-only.
 */
function evaluateStructuralContextPhase(
	event: HarnessEvent,
	rules: GuardRulesConfig,
	graph: ProjectGraph | undefined,
	sessions: SessionTracker | undefined,
	session: SessionTrajectory | undefined,
	routeMap: RouteMap | undefined,
	warnings: string[],
): void {
	if (!(graph && sessions && rules.structural_checks?.enabled)) return;
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

/**
 * Supermodel graph awareness — surface blast radius and the function-level
 * call graph from Supermodel-emitted .graph.* shards if the user is running
 * their daemon. Read-only consumer; silent when no shard exists. Loops over
 * every edited path so multi-file Codex apply_patch payloads each get their own
 * warning(s). `isFileWrite()` already includes "apply_patch", so the gate
 * covers Codex too. The [calls] context line is gated behind a firing [impact]
 * line. Warning-only.
 */
function evaluateSupermodelGraphContext(
	event: HarnessEvent,
	toolName: string,
	warnings: string[],
): void {
	if (!isFileWrite(toolName)) return;
	for (const editedPath of extractAllEditedFilePaths(event)) {
		const graphWarning = getSupermodelGraphWarning(editedPath, event.cwd);
		if (!graphWarning) continue;
		warnings.push(graphWarning);
		const callContext = getSupermodelCallContext(editedPath, event.cwd);
		if (callContext) warnings.push(callContext);
	}
}

/**
 * Graph-prediction protocol — predict/reveal/reconcile on top of the existing
 * impact-warning surface. Only Case E-fresh activates the challenge; other
 * cases are observation-only. Default mode is `shadow` (telemetry-only). On a
 * predicted block, returns a block `HarnessDecision`; on additional context,
 * mirrors it to both `warnings` (stderr) and `ctx.graphPredAdditionalContext`
 * (the model-only injection channel). Returns a block `HarnessDecision` or
 * `null`.
 */
function evaluateGraphPrediction(
	event: HarnessEvent,
	graph: ProjectGraph | undefined,
	sharedConfig: SharedConfig | null,
	warnings: string[],
	ctx: PreToolCtx,
): HarnessDecision | null {
	const mode = readGraphPredictionMode(sharedConfig);
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
		ctx.graphPredAdditionalContext = result.additional_context;
	}
	return null;
}

/**
 * One-time project-setup validation (first tool call only). Warning-only.
 */
function evaluateProjectSetupPhase(event: HarnessEvent, warnings: string[]): void {
	const setupWarnings = getProjectSetupWarnings(event.cwd || process.cwd());
	if (setupWarnings.length > 0) warnings.push(...setupWarnings);
}

/**
 * PreToolUse file diagnostics (tsc + biome). Runs only for file-write tools
 * targeting a diagnosable extension when quality checks are enabled.
 * Warning-only.
 */
function evaluateDiagnosticsPhase(
	event: HarnessEvent,
	rules: GuardRulesConfig,
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
): void {
	if (!(isFileWrite(toolName) && rules.quality_checks)) return;
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

/**
 * Drain pending session warnings (queued by SessionStart async checks).
 * Warning-only; clears the queue after draining.
 */
function drainPendingSessionWarnings(
	session: SessionTrajectory | undefined,
	warnings: string[],
): void {
	if (!session) return;
	const carrier = session as SessionTrajectory & { pendingSessionWarnings?: string[] };
	const pending = carrier.pendingSessionWarnings;
	if (pending && pending.length > 0) {
		warnings.push(...pending);
		carrier.pendingSessionWarnings = [];
	}
}

/**
 * Taint guards — sensitivity tracking, network blocking, step budget
 * (delegated). Runs only when taint tracking is enabled and a session exists.
 * The block / ask / allow-readonly result kinds each short-circuit with their
 * decision (merging the decision's own warnings); otherwise threads
 * `ctx.escalation`. Returns a `HarnessDecision` or `null`.
 */
function evaluateTaintPhase(
	rules: GuardRulesConfig,
	session: SessionTrajectory | undefined,
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
	ctx: PreToolCtx,
): HarnessDecision | null {
	if (!(rules.taint_tracking?.enabled && session)) return null;
	const taintResult = evaluateTaintGuards({
		toolName,
		toolInput,
		rules,
		session,
		pendingEscalation: ctx.escalation,
	});
	if (
		taintResult.kind === "block" ||
		taintResult.kind === "ask" ||
		taintResult.kind === "allow-readonly"
	) {
		return {
			...taintResult.decision,
			warnings: [...warnings, ...(taintResult.decision.warnings || [])],
		};
	}
	warnings.push(...taintResult.warnings);
	ctx.escalation = taintResult.escalation;
	return null;
}

/**
 * Late side-effect phases that never block: post_injection_action escalation
 * computation, permission-pattern detection, cross-session error memory, and
 * the synchronous content-scan request bundle (the scan itself runs async in
 * server.ts). Mutates `ctx.escalation` / `ctx.contentScan` and `warnings`.
 */
function evaluateLateSideEffects(
	event: HarnessEvent,
	rules: GuardRulesConfig,
	session: SessionTrajectory | undefined,
	graph: ProjectGraph | undefined,
	errorHistory: ErrorHistory | undefined,
	toolName: string,
	toolInput: ToolInput,
	warnings: string[],
	ctx: PreToolCtx,
): void {
	// ESCALATION: post_injection_action
	ctx.escalation = computePostInjectionEscalation(
		event,
		session,
		toolName,
		toolInput,
		ctx.escalation,
	);

	// PERMISSION PATTERN DETECTION
	evaluatePermissionPatternDetection(session, toolName, toolInput, warnings);

	// CONTEXT: Error memory — cross-session history
	evaluateErrorMemory(event, rules, session, graph, errorHistory, toolName, toolInput, warnings);

	// CONTENT SCAN: collect scannable fragments for PII/secret detection.
	// The scan itself is async and happens in server.ts next to the existing
	// classifier flow; here we only build the request bundle synchronously.
	if (rules.content_scanner?.enabled) {
		ctx.contentScan = extractScannableContent(event, rules.content_scanner);
	}
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
	const cfg = sharedConfig ?? null;

	// Meta-test wrapper short-circuit: `interlinked harness test "..."` is the
	// CLI's own command for evaluating a synthetic tool call against the rule
	// set. See evaluateMetaTestWrapper for the full rationale. Kept ahead of the
	// pipeline so it never instantiates the trajectory/sequence machinery.
	{
		const d = evaluateMetaTestWrapper(toolName, toolInput);
		if (d) return d;
	}

	const ctx: PreToolCtx = {
		escalation: undefined,
		contentScan: undefined,
		graphPredAdditionalContext: undefined,
	};
	void _blameInjectedFiles; // reserved for future blame-injection dedup

	// The PreToolUse pipeline as an ordered list of phases. Each phase pushes
	// warnings by reference and returns either a `HarnessDecision` (short-circuit)
	// or `null` (continue). Side-effect-only phases return null. The order is the
	// historical inline order verbatim — see the per-phase helpers for what each
	// does and why. Running them through one loop keeps this orchestrator's
	// branching minimal while preserving every early-return and side-effect.
	const phases: Array<() => HarnessDecision | null> = [
		// Trajectory detector (warning-only, lazy/no-op until flags flip).
		() => {
			evaluateTrajectoryDetectorPhase(event, session, cfg, warnings);
			return null;
		},
		// Sequence detectors + lockdown (pre_block short-circuits, pre_warn warns).
		() => evaluateSequenceAndLockdown(event, session, warnings),
		// Supermodel `.graph.*` shard write protection — apply_patch layer.
		() => evaluateSupermodelShardGuard(event),
		// Supply-chain — block package-install shell commands not on the allowlist.
		() => evaluatePackageInstallGuard(event, toolName, toolInput),
		// Git session-scope gate — ask before staging/committing unwritten files.
		() => evaluateGitScopeGate(event, rules, session, toolName, toolInput, warnings),
		// Destructive patterns — Bash/Write/Edit + Bash-routed write bypass.
		() => evaluateDestructiveRules(event, rules, session, warnings),
		// Protected files.
		() => evaluateProtectedFilesGuard(toolName, toolInput, rules, warnings),
		// Repo confinement — block writes outside CWD.
		() => evaluateRepoConfinementGuard(event, toolName, toolInput, rules, warnings),
		// TDD gate — block new non-test .ts/.tsx without a companion test.
		() => evaluateTddGate(event, rules, session, toolName, warnings),
		// Config-loosening gate — ask before strict-flag relaxations.
		() => evaluateConfigLooseningGate(event, toolName, warnings),
		// Auto file reservation.
		() =>
			evaluateAutoReservation(event, session, toolName, toolInput, reservations, cohort, warnings),
		// curl-to-MCP detection (warning-only).
		() => {
			evaluateCurlMcpPhase(session, rules, toolName, toolInput, warnings);
			return null;
		},
		// tail/head/cat output-budget enforcement.
		() => evaluateFileDumpPhase(toolName, toolInput, warnings),
		// Pipe-to-bash / exfiltration / dropper-staging.
		() => evaluateExfilPhase(event, session, graph, toolName, toolInput, warnings, ctx),
		// Edit tool — verify old_string exists.
		() => evaluateEditOldStringGuard(toolName, toolInput, warnings),
		// Write/Edit content validation.
		() => evaluateWriteContent(event, session, rules, toolName, toolInput, warnings, ctx),
		// WebFetch — exfiltration and safety.
		() => evaluateWebFetchGuard(toolName, toolInput, warnings),
		// Markdown-first web-fetching nudges (warning-only).
		() => {
			evaluateMarkdownFirstPhase(toolName, toolInput, warnings);
			return null;
		},
		// Read — block sensitive files, warn on oversized files.
		() => evaluateReadPhase(toolName, toolInput, warnings),
		// Structural context injection (warning-only).
		() => {
			evaluateStructuralContextPhase(
				event,
				rules,
				graph,
				sessions,
				session,
				routeMap,
				warnings,
			);
			return null;
		},
		// Supermodel graph awareness (warning-only).
		() => {
			evaluateSupermodelGraphContext(event, toolName, warnings);
			return null;
		},
		// Graph-prediction protocol.
		() => evaluateGraphPrediction(event, graph, cfg, warnings, ctx),
		// One-time project-setup validation (warning-only).
		() => {
			evaluateProjectSetupPhase(event, warnings);
			return null;
		},
		// PreToolUse file diagnostics (warning-only).
		() => {
			evaluateDiagnosticsPhase(event, rules, toolName, toolInput, warnings);
			return null;
		},
		// Pre-checks (head): self-kill + env-leak-to-git.
		() => evaluatePreChecksSelfKillEnv(event, toolName, toolInput, warnings),
		// Supply-chain — block manifest edits adding an unapproved dependency.
		() => evaluateManifestEditGuard(event, toolName, toolInput),
		// Pre-checks (tail): line-cap / stale-branch / dirty-tree / large-file /
		// concurrent-edit.
		() => evaluatePreChecksTail(event, session, sessions, toolName, toolInput, warnings),
		// Drain pending session warnings (warning-only).
		() => {
			drainPendingSessionWarnings(session, warnings);
			return null;
		},
		// Taint: sensitivity tracking, network blocking, step budget.
		() => evaluateTaintPhase(rules, session, toolName, toolInput, warnings, ctx),
		// Late side-effects (escalation / permission-pattern / error-memory /
		// content-scan); never blocks.
		() => {
			evaluateLateSideEffects(
				event,
				rules,
				session,
				graph,
				errorHistory,
				toolName,
				toolInput,
				warnings,
				ctx,
			);
			return null;
		},
	];

	for (const phase of phases) {
		const decision = phase();
		if (decision) return decision;
	}

	return {
		decision: "allow",
		warnings: warnings.length > 0 ? warnings : undefined,
		additional_context: ctx.graphPredAdditionalContext,
		_escalation: ctx.escalation,
		_contentScan: ctx.contentScan,
	};
}
