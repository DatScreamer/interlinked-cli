// ===========================================
// PreToolUse evaluation pipeline
// ===========================================
// The `if (isPreToolUse(event))` block extracted verbatim from
// `processEvent` in server.ts. Runs the guard evaluator, then layers on the
// policy classifier, content-scanner WebFetch proxy + scan-request handling,
// auto-coordination, learned rules, the TDD / project-wide commit gates,
// grep + tsgo acceleration, and the diff-aware pre-edit baseline capture.
//
// Behavior-preserving move: bare module-level state (`rules`, `trigramIndex`,
// …) becomes `ctx.rules`, `ctx.trigramIndex`, …; `getGraphForFile(x)` /
// `getAutoCoordState(x)` take `ctx` as the first argument.
//
// `runPreToolPipeline` is a thin orchestrator: each cohesive phase lives in an
// INTERNAL helper below (no public-surface change). Phases that can replace the
// decision return `HarnessDecision | null` (null = continue); phases that only
// annotate the running decision mutate `preDecision` in place and return void.
// Side-effect ordering is preserved exactly — see the orchestrator at the foot
// of the file.

import { readSharedConfig } from "../../lib/config.js";
import { shouldCoordinate } from "../auto-coordinate.js";
import { injectCoordinationWarnings } from "../auto-coordinate.js";
import { isCoverageSuiteCommand, noteCoverageSuiteRunStart } from "../coverage-discharge.js";
import {
	runCommitGate,
	runCoverageWriteGate as runCoverageWriteGateExtracted,
} from "./pre-tool-coverage-gates.js";
import { evaluatePreToolUse, extractPermissionPattern } from "../evaluator.js";
import {
	appendShadowLog,
	buildEvidenceEnvelope,
	callClassifier,
	createClassifierSessionState,
	hashEvidence,
} from "../policy-classifier.js";
import type { HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";
import {
	captureDiffAwareBaseline,
	injectStructureContext,
	runProjectWideGitGate,
	runTddCommitGate,
} from "./pre-tool-pipeline-stages.js";
import {
	runContentScanRequest,
	runWebFetchProxy,
} from "./pre-tool-pipeline-content-scan.js";
import {
	classifySearchTool,
	emitIndexStatusWarning,
	runGrepAcceleration,
	runTsgoAcceleration,
} from "./pre-tool-pipeline-search.js";
import {
	getAutoCoordState,
	getGraphForFile,
	type ServerRuntime,
	summarizeToolInput,
} from "./runtime-context.js";

// ---------------------------------------------------------------------------
// Phase helpers (internal — not exported)
// ---------------------------------------------------------------------------

/**
 * Resolve the file path the tool acts on, supporting both `file_path` (Write /
 * Edit / Read) and `path` (alternate tools), falling back to "".
 */
function resolveEventFilePath(event: HarnessEvent): string {
	return (event.tool_input?.file_path as string) || (event.tool_input?.path as string) || "";
}

/**
 * Deliver any async-deferred findings enqueued for this session as PreToolUse
 * context. Drain is exactly-once; a no-op until the first async check is wired.
 */
function drainDeferredFindings(ctx: ServerRuntime, event: HarnessEvent, preDecision: HarnessDecision): void {
	const deferredFindings = ctx.asyncFindings.drain(event.session_id);
	if (deferredFindings.length > 0) {
		preDecision.warnings = [
			...(preDecision.warnings ?? []),
			...deferredFindings.map((f) => f.message),
		];
	}
}

/**
 * LLM Policy Classifier escalation (shadow mode). Only runs when the decision
 * is "allow", the evaluator attached an escalation, and the classifier is
 * enabled. Mutates `preDecision.warnings` in shadow mode; never changes the
 * decision (enforce-mode promotion is not wired yet). Fail-open on any error.
 */
async function runClassifierEscalation(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	preDecision: HarnessDecision,
): Promise<void> {
	const CWD = ctx.cwd;
	const log = ctx.log;
	const classifierConfig = ctx.rules.policy_classifier;
	if (!(preDecision.decision === "allow" && preDecision._escalation && classifierConfig?.enabled)) {
		return;
	}
	const classifierStart = Date.now();
	try {
		// Get or create per-session classifier state
		let classifierState = ctx.classifierSessions.get(event.session_id);
		if (!classifierState) {
			classifierState = createClassifierSessionState();
			ctx.classifierSessions.set(event.session_id, classifierState);
		}

		const evidence = buildEvidenceEnvelope(event, session, preDecision._escalation);
		const classification = await callClassifier(evidence, classifierConfig, classifierState);

		const latencyMs = Date.now() - classifierStart;
		const wouldHaveChanged =
			classification.label === "deny" &&
			classification.confidence >= (classifierConfig.confidence_threshold || 0.8);

		// Shadow log
		appendShadowLog(
			{
				ts: new Date().toISOString(),
				session_id: event.session_id,
				agent_name: event.agent_name || session.agent_name,
				trigger: preDecision._escalation.trigger,
				tool_name: event.tool_name || "",
				action_class: evidence.action_class,
				local_decision: "allow",
				classification,
				would_have_changed: wouldHaveChanged,
				latency_ms: latencyMs,
				evidence_hash: hashEvidence(evidence),
			},
			CWD,
		);

		// Shadow mode: inject warning but never change decision
		if (classifierConfig.mode === "shadow") {
			const warnings = preDecision.warnings || [];
			warnings.push(
				`[interlinked:policy] Shadow: ${classification.label} (${classification.confidence.toFixed(2)}) — ${classification.reasoning}`,
			);
			preDecision.warnings = warnings;
		}
		// Enforce mode will promote the shadow-only classifier result into
		// a blocking decision once that path is wired up.

		ctx.writeClassifierStatus(
			`${classifierConfig.provider}:${classifierConfig.model}:ok:${latencyMs}ms`,
		);
		log(
			`Policy classifier: ${classification.label} (${classification.confidence.toFixed(2)}) for ${preDecision._escalation.trigger} — ${latencyMs}ms`,
		);
	} catch (classifierErr) {
		// Fail-open: classifier errors never block the tool call
		ctx.writeClassifierStatus(`${classifierConfig.provider}:${classifierConfig.model}:error`);
		log(
			`Policy classifier error (fail-open): ${classifierErr instanceof Error ? classifierErr.message : String(classifierErr)}`,
		);
	}
}

/**
 * Auto-coordination: periodic read-only check-in with the MCP server. Mutates
 * `preDecision` (coordination warnings) and the per-session coord state on a
 * successful check-in; increments misses (and may disable) otherwise. Catch
 * path increments misses. No-op unless allow + a server bridge + the cadence.
 */
async function runAutoCoordination(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	preDecision: HarnessDecision,
): Promise<void> {
	const log = ctx.log;
	const eventToolName = event.tool_name || "";
	if (
		!(
			preDecision.decision === "allow" &&
			session &&
			ctx.serverBridge &&
			shouldCoordinate(
				session,
				getAutoCoordState(ctx, event.session_id),
				ctx.autoCoordConfig,
				eventToolName,
			)
		)
	) {
		return;
	}
	const coordState = getAutoCoordState(ctx, event.session_id);
	try {
		const coordResponse = await ctx.serverBridge.fetchCoordinationState(
			event.agent_name || session.agent_name,
			session,
			ctx.autoCoordConfig.timeout_ms,
		);
		if (coordResponse) {
			injectCoordinationWarnings(preDecision, coordResponse);
			session.last_coordination_at = session.tool_call_count;
			session.last_coordination_ts = Date.now();
			coordState.consecutiveMisses = 0;
			coordState.totalCheckins++;
			log(
				`Auto-coordination: ${coordResponse.unread.total} unread, ${coordResponse.task_changes.length} task changes`,
			);
		} else {
			coordState.consecutiveMisses++;
			if (coordState.consecutiveMisses >= ctx.autoCoordConfig.max_misses_before_disable) {
				coordState.disabled = true;
				log("Auto-coordination: disabled after consecutive misses");
			}
		}
	} catch {
		coordState.consecutiveMisses++;
	}
}

/**
 * Inject any pending findings from background async analysis as tagged
 * warnings on `preDecision`. No-op when there is no file path or no findings.
 */
function injectAsyncAnalysisFindings(
	ctx: ServerRuntime,
	filePath: string,
	preDecision: HarnessDecision,
): void {
	if (!filePath) return;
	const asyncFindings = ctx.asyncAnalysis.consume(filePath);
	if (asyncFindings.length > 0) {
		const warnings = preDecision.warnings || [];
		for (const f of asyncFindings) {
			warnings.push(`[interlinked:async] ${f.name}: ${f.message}`);
		}
		preDecision.warnings = warnings;
		ctx.log(`Injected ${asyncFindings.length} async finding(s) for ${filePath}`);
	}
}

/**
 * Cross-session learned rules: observe allowed patterns and warn when a
 * pattern crosses the recurrence threshold. Mutates `preDecision.warnings`.
 */
function observeLearnedRules(
	ctx: ServerRuntime,
	event: HarnessEvent,
	preDecision: HarnessDecision,
): void {
	if (!(preDecision.decision === "allow" && event.tool_name)) return;
	const pat = extractPermissionPattern(event.tool_name, event.tool_input || {});
	if (pat && !ctx.learnedRules.has(pat)) {
		const learned = ctx.learnedRules.observe(pat, event.session_id);
		if (learned) {
			const warnings = preDecision.warnings || [];
			warnings.push(
				`[interlinked:learned] Pattern "${pat}" observed ${learned.observation_count} times across sessions — saved as learned rule.`,
			);
			preDecision.warnings = warnings;
			ctx.log(`Learned rule: ${pat}`);
		}
	}
}

/**
 * Report blocks to the server for team visibility. No-op unless a server
 * bridge is present and the decision is a block.
 */
function reportGuardBlock(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
	preDecision: HarnessDecision,
): void {
	if (ctx.serverBridge && preDecision.decision === "block") {
		ctx.serverBridge.reportGuardEvent({
			agent_name: event.agent_name || session.agent_name,
			event_type: "guard_block",
			tool_name: event.tool_name,
			tool_input_summary: summarizeToolInput(event),
			decision: "block",
			reason: preDecision.reason || "Blocked by guard rule",
			occurred_at: event.timestamp,
		});
	}
}

/**
 * Run the full PreToolUse pipeline for a tool-use event. Returns the final
 * `HarnessDecision` (allow / block / ask).
 */
export async function runPreToolPipeline(
	ctx: ServerRuntime,
	event: HarnessEvent,
	session: SessionTrajectory,
): Promise<HarnessDecision> {
	const { rules } = ctx;
	const CWD = ctx.cwd;
	// Resolve graph for the file being edited (supports cross-repo edits)
	const filePath = resolveEventFilePath(event);
	const activeGraph = getGraphForFile(ctx, filePath || CWD);

	// `sharedConfig` carries Phase D.2 trajectory feature flags
	// (`harness.trajectory.tool_loop`, etc.). Without passing it through,
	// `isFeatureEnabled` falls back to the defaults map (every flag false)
	// and the trajectory detector silently no-ops even after the user
	// explicitly enables it in `.interlinked/config.json`. Reading per
	// event is cheap (small JSON, fs cache) and matches what the hook
	// script does for mode resolution.
	const preDecision = evaluatePreToolUse(
		event,
		rules,
		session,
		ctx.reservations,
		ctx.cohort,
		activeGraph,
		ctx.sessions,
		ctx.routeMap,
		ctx.errorHistory,
		readSharedConfig(CWD),
	);

	// Async-deferred findings — deliver anything an off-critical-path
	// check enqueued for this session as PreToolUse context.
	drainDeferredFindings(ctx, event, preDecision);

	// --- Coverage-discharge run-window observation (finding 2026-06, round 6) ---
	// Note when a coverage-suite shell command STARTS so the PostToolUse
	// discharge pass can bind report freshness to THIS run's window instead of
	// only the obligation's age (a failed earlier run's report is not this
	// run's evidence). Pure observation over total string ops — never affects
	// the decision.
	const preCmd = typeof event.tool_input?.command === "string" ? event.tool_input.command : "";
	if (preCmd && isCoverageSuiteCommand(preCmd)) {
		noteCoverageSuiteRunStart(event.session_id, event.timestamp);
	}

	// --- Per-edit coverage gate (config-gated, DEFAULT OFF) ---
	// The expensive apply-before-disk overlay+suite check. Placed after the
	// synchronous cheap checks; short-circuits the rest of the async pipeline on
	// a coverage block. A no-op (returns null immediately) unless the repo opts
	// in via `per_edit_coverage.enabled`.
	const coverageDecision = await runCoverageWriteGateExtracted(ctx, event, preDecision);
	if (coverageDecision) return coverageDecision;

	// --- Commit-time quality gate (config-gated, DEFAULT OFF) ---
	// The hard gate for repos whose suite is too big for per-edit enforcement:
	// on a real `git commit` Bash call it runs the FULL suite + coverage on the
	// working tree and blocks a red bar / uncovered changed line / CRAP-over /
	// cyclomatic-over. A pure no-op (returns null immediately) for non-commit
	// commands and unless the repo opts in via `per_edit_coverage.enabled`.
	const commitDecision = await runCommitGate(ctx, event, preDecision);
	if (commitDecision) return commitDecision;

	// --- LLM Policy Classifier: escalation check (shadow mode) ---
	await runClassifierEscalation(ctx, event, session, preDecision);

	// --- Content Scanner: WebFetch proxy (3-way human review) ---
	const webFetchDecision = await runWebFetchProxy(ctx, event, preDecision);
	if (webFetchDecision) return webFetchDecision;

	// --- Content Scanner: run ML PII detection on the scan request (if present) ---
	await runContentScanRequest(ctx, event, preDecision);

	// Clean up _escalation and _contentScan from the decision before returning to hook script
	// (internal fields, not part of the hook protocol)
	delete preDecision._escalation;
	delete preDecision._contentScan;

	// --- Auto-coordination: periodic read-only check-in with MCP server ---
	await runAutoCoordination(ctx, event, session, preDecision);

	// Inject any pending findings from background async analysis
	injectAsyncAnalysisFindings(ctx, filePath, preDecision);

	// Cross-session learned rules: observe allowed patterns
	observeLearnedRules(ctx, event, preDecision);

	// Report blocks/warns to server for team visibility
	reportGuardBlock(ctx, event, session, preDecision);

	// --- TDD commit gate: check for unresolved test failures before git commit ---
	runTddCommitGate(ctx, event, session, preDecision);

	// --- Project-wide typecheck gate (commit + push) + push-only test tier ---
	runProjectWideGitGate(ctx, event, session, preDecision);

	// --- Grep acceleration: intercept search tools via trigram index ---
	// Substitution path (block-and-answer) is DISABLED by default. Reason:
	//   - Bypasses the content scanner — substituted output reaches the
	//     model via permissionDecisionReason, an envelope the OPF scanner
	//     and checks/pii.ts weren't designed to inspect.
	//   - Index can be stale: incrementalUpdate uses `git diff baseCommit
	//     ..HEAD`, refresh fires on SessionStart only, external file edits
	//     are invisible until next session.
	//   - Partially-formed hookSpecificOutput envelopes have hit Claude
	//     Code's "(root): Invalid input" validator failure (fail-closed
	//     on a safety boundary, contradicts feedback_safety_continuity).
	// The trigram index itself stays loaded, but with substitution off its
	// only live consumer is PostToolUse sibling expansion (sibling-expansion.ts);
	// it is also read for the freshness warning below. Impact analysis, the
	// project graph, and structural checks build their own dependency graphs
	// and do NOT use it.
	// Re-enable: set INTERLINKED_GREP_ACCELERATOR=1 OR set
	// guard-rules.json `grep_acceleration.substitution_enabled: true`.
	const searchFlags = classifySearchTool(event, rules);
	const grepDecision = runGrepAcceleration(ctx, event, preDecision, searchFlags);
	if (grepDecision) return grepDecision;

	// For search tools that weren't accelerated, add index status as a warning.
	emitIndexStatusWarning(ctx, event, preDecision, searchFlags);

	// --- tsgo acceleration: rewrite tsc → tsgo when available ---
	const tsgoDecision = runTsgoAcceleration(ctx, event, preDecision);
	if (tsgoDecision) return tsgoDecision;

	// --- Diff-aware: capture pre-edit baseline for file write tools ---
	captureDiffAwareBaseline(ctx, event, filePath);

	// --- Structure context injection (non-blocking) ---
	injectStructureContext(ctx, event, session, preDecision, filePath);

	return preDecision;
}
