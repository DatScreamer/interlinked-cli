// ===========================================
// Taint Tracking + Step-Budget Guards (PreToolUse)
// ===========================================
//
// Enforces the session-sensitivity model (Public / Internal / Confidential /
// Secret): ratchets sensitivity when the agent reads labelled files, blocks
// outbound network commands once the session is tainted, escalates for the
// classifier at the Internal threshold, and enforces step budgets with
// graceful degradation to read-only once exceeded.

import type { JsonObject } from "../../lib/json-types.js";
import {
	classifyFileSensitivity,
	formatTaintSources,
	getStepBudgetWarning,
	isNetworkCommand,
	isStepLimitExceeded,
	ratchetSensitivity,
	SENSITIVITY_ORDER,
	shouldBlockNetwork,
} from "../taint-tracker.js";
import type {
	EscalationRequest,
	GuardRulesConfig,
	HarnessDecision,
	SessionTrajectory,
} from "../types.js";
import { isBash, isFileWrite, isReadOperation } from "./tool-classifiers.js";

/** Read-only tools that stay allowed once the step budget is exhausted. */
const READ_ONLY_TOOLS_ON_BUDGET = new Set(["Read", "Glob", "Grep", "Ls", "WebSearch"]);

/** Tail length for `recent_tool_sequence` when assembling an escalation request. */
const ESCALATION_TAIL_LENGTH = 10;

/** High-water mark (fraction of step limit) past which we raise an escalation
 *  on a state-changing tool call. */
const HIGH_BUDGET_THRESHOLD = 0.8;

/** Public API — return shape from {@link evaluateTaintGuards}. */
export type TaintGuardsResult =
	| { kind: "block"; decision: HarnessDecision }
	| { kind: "allow-readonly"; decision: HarnessDecision }
	| { kind: "ok"; warnings: string[]; escalation?: EscalationRequest };

export interface TaintGuardsArgs {
	toolName: string;
	toolInput: JsonObject;
	rules: GuardRulesConfig;
	session: SessionTrajectory;
	pendingEscalation: EscalationRequest | undefined;
}

/** Public API — consumed by evaluator/pre-tool.ts when `rules.taint_tracking.enabled`
 *  and a live session are both present. Encapsulates all four sub-checks:
 *  sensitivity ratcheting, tainted-network blocking, step-budget warnings,
 *  and step-limit graceful degradation. */
export function evaluateTaintGuards(args: TaintGuardsArgs): TaintGuardsResult {
	const { toolName, toolInput, rules, session } = args;
	const warnings: string[] = [];
	let escalation = args.pendingEscalation;

	if (!rules.taint_tracking) return { kind: "ok", warnings, escalation };

	// On file read, check sensitivity and ratchet.
	if (isReadOperation(toolName)) {
		const filePath = (toolInput.file_path as string) || "";
		if (filePath) {
			const fileSensitivity = classifyFileSensitivity(filePath, rules.taint_tracking);
			if (SENSITIVITY_ORDER[fileSensitivity] > SENSITIVITY_ORDER[session.sensitivity_level]) {
				ratchetSensitivity(session, filePath, fileSensitivity, rules.taint_tracking);
				const blockStatus = shouldBlockNetwork(session, rules.taint_tracking)
					? "BLOCKED"
					: "monitored";
				warnings.push(
					`[interlinked:taint] Sensitivity escalated to ${fileSensitivity} after reading ${filePath}. Outbound network commands will be ${blockStatus}.`,
				);
			}
		}
	}

	// Block network commands when tainted.
	if (isBash(toolName) && shouldBlockNetwork(session, rules.taint_tracking)) {
		const cmd = (toolInput.command as string) || "";
		if (isNetworkCommand(cmd)) {
			return {
				kind: "block",
				decision: {
					decision: "block",
					reason: `BLOCKED: Outbound network command while session is tainted at ${session.sensitivity_level} level (tainted by: ${formatTaintSources(session)}). Sensitive data may be exfiltrated.`,
					warnings,
				},
			};
		}
	}

	// ESCALATION: tainted_network_internal — network command at Internal sensitivity.
	// Confidential+ is hard-blocked above; Internal is a judgment call for the classifier.
	if (
		isBash(toolName) &&
		!shouldBlockNetwork(session, rules.taint_tracking) &&
		SENSITIVITY_ORDER[session.sensitivity_level] >= SENSITIVITY_ORDER.Internal &&
		!escalation
	) {
		const cmd = (toolInput.command as string) || "";
		if (isNetworkCommand(cmd)) {
			escalation = {
				trigger: "tainted_network_internal",
				summary: `Network command while session is tainted at ${session.sensitivity_level} level (tainted by: ${formatTaintSources(session)})`,
				tool_name: toolName,
				tool_input_redacted: { command: "[REDACTED — network command]" },
				sensitivity_level: session.sensitivity_level,
				step_number: session.tool_call_count,
				recent_tool_sequence: session.tool_sequence.slice(-ESCALATION_TAIL_LENGTH),
			};
		}
	}

	// Step budget warnings (at 80% and 95%)
	const budgetWarning = getStepBudgetWarning(session);
	if (budgetWarning) warnings.push(budgetWarning);

	// ESCALATION: high_step_budget — approaching step limit with state-changing tool.
	if (
		session.step_limit !== Number.POSITIVE_INFINITY &&
		session.tool_call_count > session.step_limit * HIGH_BUDGET_THRESHOLD &&
		(isFileWrite(toolName) || isBash(toolName)) &&
		!escalation
	) {
		const filePath = (toolInput.file_path as string) || "";
		escalation = {
			trigger: "high_step_budget",
			summary: `Agent at ${Math.round((session.tool_call_count / session.step_limit) * 100)}% of step budget (${session.tool_call_count}/${session.step_limit}) with state-changing tool`,
			tool_name: toolName,
			tool_input_redacted: filePath ? { file_path: filePath } : { command: "[REDACTED]" },
			sensitivity_level: session.sensitivity_level,
			step_number: session.tool_call_count,
			recent_tool_sequence: session.tool_sequence.slice(-ESCALATION_TAIL_LENGTH),
		};
	}

	// Step limit check — graceful degradation: block mutations but allow reads
	// so the agent can investigate and hand off cleanly.
	if (isStepLimitExceeded(session)) {
		if (READ_ONLY_TOOLS_ON_BUDGET.has(toolName)) {
			warnings.push(
				`[interlinked:budget] Step limit (${session.step_limit}) exceeded — read-only mode. Mutations are blocked. Wrap up and commit.`,
			);
			return { kind: "allow-readonly", decision: { decision: "allow", warnings } };
		}
		return {
			kind: "block",
			decision: {
				decision: "block",
				reason: `BLOCKED: Step limit (${session.step_limit}) exceeded at ${session.sensitivity_level} sensitivity level. Read-only tools (Read, Glob, Grep) are still allowed.`,
				warnings,
			},
		};
	}

	return { kind: "ok", warnings, escalation };
}
