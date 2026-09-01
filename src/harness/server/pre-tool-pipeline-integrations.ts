import { injectCoordinationWarnings, shouldCoordinate } from "../auto-coordinate.js";
import {
	appendShadowLog,
	buildEvidenceEnvelope,
	callClassifier,
	createClassifierSessionState,
	hashEvidence,
} from "../policy-classifier.js";
import type { HarnessDecision, HarnessEvent, SessionTrajectory } from "../types.js";
import {
	getAutoCoordState,
	type ServerRuntime,
	summarizeToolInput,
} from "./runtime-context.js";

interface IntegrationInput {
	ctx: ServerRuntime;
	event: HarnessEvent;
	session: SessionTrajectory;
	preDecision: HarnessDecision;
}

interface ClassifierIntegrationInput extends IntegrationInput {
	now: () => number;
	timestamp: () => string;
}

interface CoordinationIntegrationInput extends IntegrationInput {
	now: () => number;
}

/**
 * Run the optional LLM policy-classifier escalation in shadow mode.
 *
 * The classifier can add context to an allowed decision, but it cannot promote
 * that decision to a block. Errors remain fail-open and are recorded through
 * the runtime status/log sinks.
 */
export async function runClassifierEscalation({
	ctx,
	event,
	session,
	preDecision,
	now,
	timestamp,
}: ClassifierIntegrationInput): Promise<void> {
	const classifierConfig = ctx.rules.policy_classifier;
	if (!(preDecision.decision === "allow" && preDecision._escalation && classifierConfig?.enabled)) {
		return;
	}
	const classifierStart = now();
	try {
		let classifierState = ctx.classifierSessions.get(event.session_id);
		if (!classifierState) {
			classifierState = createClassifierSessionState();
			ctx.classifierSessions.set(event.session_id, classifierState);
		}

		const evidence = buildEvidenceEnvelope(event, session, preDecision._escalation);
		const classification = await callClassifier(evidence, classifierConfig, classifierState);
		const latencyMs = now() - classifierStart;
		const wouldHaveChanged =
			classification.label === "deny" &&
			classification.confidence >= (classifierConfig.confidence_threshold || 0.8);

		appendShadowLog(
			{
				ts: timestamp(),
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
			ctx.cwd,
		);

		if (classifierConfig.mode === "shadow") {
			const warnings = preDecision.warnings || [];
			warnings.push(
				`[interlinked:policy] Shadow: ${classification.label} (${classification.confidence.toFixed(2)}) — ${classification.reasoning}`,
			);
			preDecision.warnings = warnings;
		}

		ctx.writeClassifierStatus(
			`${classifierConfig.provider}:${classifierConfig.model}:ok:${latencyMs}ms`,
		);
		ctx.log(
			`Policy classifier: ${classification.label} (${classification.confidence.toFixed(2)}) for ${preDecision._escalation.trigger} — ${latencyMs}ms`,
		);
	} catch (classifierErr) {
		ctx.writeClassifierStatus(`${classifierConfig.provider}:${classifierConfig.model}:error`);
		ctx.log(
			`Policy classifier error (fail-open): ${classifierErr instanceof Error ? classifierErr.message : String(classifierErr)}`,
		);
	}
}

/** Periodically fetch read-only team context and attach it to the decision. */
export async function runAutoCoordination({
	ctx,
	event,
	session,
	preDecision,
	now,
}: CoordinationIntegrationInput): Promise<void> {
	const eventToolName = event.tool_name || "";
	if (
		!(
			preDecision.decision === "allow" &&
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
			session.last_coordination_ts = now();
			coordState.consecutiveMisses = 0;
			coordState.totalCheckins++;
			ctx.log(
				`Auto-coordination: ${coordResponse.unread.total} unread, ${coordResponse.task_changes.length} task changes`,
			);
		} else {
			coordState.consecutiveMisses++;
			if (coordState.consecutiveMisses >= ctx.autoCoordConfig.max_misses_before_disable) {
				coordState.disabled = true;
				ctx.log("Auto-coordination: disabled after consecutive misses");
			}
		}
	} catch {
		coordState.consecutiveMisses++;
	}
}

/** Report a blocking guard decision to the optional team bridge. */
export function reportGuardBlock({
	ctx,
	event,
	session,
	preDecision,
}: IntegrationInput): void {
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
