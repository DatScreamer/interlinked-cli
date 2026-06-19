// interlinked-tdd: exempt
// ===========================================
// PreToolUse decision phases (block-or-null guards)
// ===========================================
//
// Cluster extracted from pre-tool.ts: the PreToolUse phases that can return a
// blocking `HarnessDecision` (sequence/lockdown, auto-reservation, file-dump,
// exfil, write-content, read, graph-prediction, taint) plus the never-blocking
// late side-effects phase. Each pushes into a shared `warnings` array by
// reference and threads cross-phase mutable state through the `PreToolCtx`
// holder (also defined here). Moved verbatim; the orchestrator in pre-tool.ts
// imports them.

import type { SharedConfig } from "../../lib/config.js";
import type { CohortManager } from "../cohort.js";
import { extractScannableContent } from "../content-scanner/extractor.js";
import type { ContentScanRequest } from "../content-scanner/types.js";
import type { ErrorHistory } from "../error-history.js";
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
import type {
	EscalationRequest,
	GuardRulesConfig,
	HarnessDecision,
	HarnessEvent,
	SessionTrajectory,
} from "../types.js";
import type { ToolInput } from "./pre-tool-context-phases.js";
import { evaluateFileDumpGuard } from "./file-dump-guard.js";
import { evaluateTaintGuards } from "./taint-guards.js";
import {
	isBash,
	isFileWrite,
	isReadOperation,
} from "./tool-classifiers.js";
import { evaluateWriteContentGuards } from "./write-content-guards.js";
import {
	computePostInjectionEscalation,
	evaluateErrorMemory,
	evaluatePermissionPatternDetection,
} from "./pre-tool-phases.js";
import {
	evaluateExfilGuards,
	evaluateReadGuards,
	isGraphPredictionEnabled,
	readGraphPredictionMode,
} from "./pre-tool-helpers.js";

/**
 * Mutable pipeline state that spans phases of `evaluatePreToolUse`. Extracting
 * cohesive phases into internal helpers means the cross-phase locals
 * (`pendingEscalation`, the content-scan request, and the graph-prediction
 * additional-context string) have to be carried by reference rather than as
 * function-scoped `let`s. Holding them on one object keeps the helper
 * signatures small and the threading explicit.
 */
export interface PreToolCtx {
	// These mirror the original function-scoped `let x: T | undefined` locals, so
	// the fields are explicitly `T | undefined` (assignable from `undefined`)
	// rather than optional-only — the delegated guards return
	// `EscalationRequest | undefined` and assign it directly.
	escalation: EscalationRequest | undefined;
	contentScan: ContentScanRequest | undefined;
	graphPredAdditionalContext: string | undefined;
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
export function evaluateSequenceAndLockdown(
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
export function evaluateAutoReservation(
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
 * tail/head/cat output-budget enforcement (file-dump-guard, Bash only). Blocks
 * foreground `tail -f` and unfiltered dumps of large files or large line
 * counts; warns on overlarge slices even when filtered. Returns a block
 * `HarnessDecision` or `null`.
 */
export function evaluateFileDumpPhase(
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
export function evaluateExfilPhase(
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
export function evaluateWriteContent(
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
 * Read guards — block sensitive files, warn on oversized files. Runs only for
 * read operations carrying a `file_path`. Returns a block `HarnessDecision` or
 * `null`.
 */
export function evaluateReadPhase(
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
 * Graph-prediction protocol — predict/reveal/reconcile on top of the existing
 * impact-warning surface. Only Case E-fresh activates the challenge; other
 * cases are observation-only. Default mode is `shadow` (telemetry-only). On a
 * predicted block, returns a block `HarnessDecision`; on additional context,
 * mirrors it to both `warnings` (stderr) and `ctx.graphPredAdditionalContext`
 * (the model-only injection channel). Returns a block `HarnessDecision` or
 * `null`.
 */
export function evaluateGraphPrediction(
	event: HarnessEvent,
	graph: ProjectGraph | undefined,
	sharedConfig: SharedConfig | null,
	warnings: string[],
	ctx: PreToolCtx,
): HarnessDecision | null {
	if (!isGraphPredictionEnabled(sharedConfig)) return null;
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
 * Taint guards — sensitivity tracking, network blocking, step budget
 * (delegated). Runs only when taint tracking is enabled and a session exists.
 * The block / ask / allow-readonly result kinds each short-circuit with their
 * decision (merging the decision's own warnings); otherwise threads
 * `ctx.escalation`. Returns a `HarnessDecision` or `null`.
 */
export function evaluateTaintPhase(
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
export function evaluateLateSideEffects(
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
