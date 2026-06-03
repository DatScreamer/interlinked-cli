// ===========================================
// Taint Tracking + Step-Budget Guards (PreToolUse)
// ===========================================
//
// Enforces the session-sensitivity model (Public / Internal / Confidential /
// Secret): ratchets sensitivity when the agent reads labelled files, blocks
// outbound network commands once the session is tainted, escalates for the
// classifier at the Internal threshold, and enforces step budgets with
// graceful degradation to read-only once exceeded.
//
// Provenance axis (orthogonal to sensitivity): the
// `checkProvenanceTaintToExternalAction` guard intercepts external-action
// tool calls whose input strings contain references to files whose taint
// source was flagged as `fetched_external` or `mcp_remote`. This is the
// "data from the internet flowing into a publish / push / deploy" failure
// mode — even if the data is labelled Public, the agent should confirm
// before acting on it externally.

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
	TaintProvenance,
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
	| { kind: "ask"; decision: HarnessDecision }
	| { kind: "allow-readonly"; decision: HarnessDecision }
	| { kind: "ok"; warnings: string[]; escalation?: EscalationRequest | undefined };

/** Untrusted provenance values — taint sources from these origins gate the
 *  external-action confirmation. Local code reads and document reads of
 *  local files are considered trusted (the prose may carry instructions
 *  but did not come over an unverified channel). */
const UNTRUSTED_PROVENANCE: ReadonlySet<TaintProvenance> = new Set<TaintProvenance>([
	"fetched_external",
	"mcp_remote",
]);

/**
 * External-action tool detection — stubbed allowlist gating which tool
 * invocations are sensitive enough to require confirmation when their
 * input may carry untrusted-provenance data. Three signals match:
 *   1. Explicit network-fetch tools (WebFetch, WebSearch).
 *   2. Bash commands containing destructive-external verbs
 *      (curl/wget/scp/rsync/ssh/mail/git push/npm publish/gh pr create/
 *      docker push/kubectl apply/terraform apply).
 *   3. MCP tool names with mutating-verb segments (send / publish /
 *      deploy / push / email / create_pull_request / post).
 *
 * TODO(item-4-coordination): Item #4 ships a proper
 * `classifyToolExternality(toolName, toolInput)` taxonomy. When that
 * lands, the merger should replace this stub with
 * `classifyToolExternality(toolName, toolInput) === "external_action"`
 * and delete this helper.
 */
const BASH_EXTERNAL_VERBS = [
	"curl",
	"wget",
	"scp",
	"rsync",
	"ssh",
	"mail",
	"git push",
	"npm publish",
	"gh pr create",
	"docker push",
	"kubectl apply",
	"terraform apply",
];

/** Compile once — case-sensitive, word-boundary where appropriate. The
 *  multi-token entries (`git push`, `npm publish`) check literal substrings
 *  rather than word boundaries because the second token would not match a
 *  `\b` after the space on some regex flavors. */
const MCP_EXTERNAL_ACTION_RE =
	/^mcp__.*(send|publish|deploy|push|email|create_pull_request|post)/i;

function isExternalActionTool(toolName: string, toolInput: JsonObject): boolean {
	if (toolName === "WebFetch" || toolName === "web_fetch" || toolName === "WebSearch") {
		return true;
	}
	if (MCP_EXTERNAL_ACTION_RE.test(toolName)) return true;
	if (isBash(toolName)) {
		const cmd = (toolInput.command as string) || "";
		if (!cmd) return false;
		for (const verb of BASH_EXTERNAL_VERBS) {
			if (cmd.includes(verb)) return true;
		}
	}
	return false;
}

/**
 * Flatten the tool_input into a single searchable string — every value in
 * the JsonObject is concatenated so substring matching can find a tainted
 * file path regardless of which key it was passed under (`file_path`,
 * `command`, `url`, `body`, MCP-specific keys, etc.).
 *
 * v1 derivation tracking is coarse substring-match — it catches the obvious
 * cases ("pipe README.md through curl") but misses derived values (read the
 * file, base64-encode it, send the result). v2 is byte-level data-flow.
 *
 * TODO(provenance-v2): track byte-level data-flow so derived/transformed
 * values from a tainted source still trip this guard.
 */
function flattenToolInputToString(toolInput: JsonObject): string {
	const parts: string[] = [];
	const walk = (v: unknown): void => {
		if (v == null) return;
		if (typeof v === "string") {
			parts.push(v);
			return;
		}
		if (typeof v === "number" || typeof v === "boolean") {
			parts.push(String(v));
			return;
		}
		if (Array.isArray(v)) {
			for (const e of v) walk(e);
			return;
		}
		if (typeof v === "object") {
			for (const e of Object.values(v as JsonObject)) walk(e);
		}
	};
	walk(toolInput);
	return parts.join("\n");
}

/**
 * Public API — guard that fires `decision: "ask"` when an external-action
 * tool call carries any reference (substring match) to a taint source whose
 * provenance is `fetched_external` or `mcp_remote`. Returns `null` when no
 * untrusted-provenance flow is detected, letting the rest of the guard
 * chain proceed.
 *
 * The "ask" decision is preferred over "block" here because the action
 * may be legitimate — the agent might intentionally be pushing data the
 * user gave it from the web. Confirmation lets the user make the call.
 */
export function checkProvenanceTaintToExternalAction(
	toolName: string,
	toolInput: JsonObject,
	session: SessionTrajectory,
): HarnessDecision | null {
	if (!isExternalActionTool(toolName, toolInput)) return null;
	if (!session.taint_sources || session.taint_sources.length === 0) return null;

	const haystack = flattenToolInputToString(toolInput);
	if (!haystack) return null;

	for (const src of session.taint_sources) {
		if (!UNTRUSTED_PROVENANCE.has(src.provenance)) continue;
		if (!src.file) continue;
		if (haystack.includes(src.file)) {
			return {
				decision: "ask",
				reason:
					`${toolName} would act on data sourced from untrusted provenance ` +
					`(${src.file} via ${src.provenance}). Confirm intent before proceeding.`,
			};
		}
	}
	return null;
}

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

	// Provenance axis (orthogonal to sensitivity): if the current tool is
	// an external-action tool and its input carries any reference to a
	// taint source with untrusted provenance (fetched_external / mcp_remote),
	// surface a confirmation prompt. The sensitivity-axis hard block above
	// already catches Confidential+ exfiltration; this catches the case
	// where Public-but-untrusted data flows outward.
	const provenanceAskDecision = checkProvenanceTaintToExternalAction(
		toolName,
		toolInput,
		session,
	);
	if (provenanceAskDecision) {
		return {
			kind: "ask",
			decision: {
				...provenanceAskDecision,
				warnings,
			},
		};
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
