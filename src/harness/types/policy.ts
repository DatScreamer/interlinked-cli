// interlinked-tdd: exempt — type declarations only, no runtime logic.
// ===========================================
// Interlinked Harness — Escalation & LLM Policy Classifier Types
// ===========================================

import type { AgentRole } from "./events.js";
import type { SensitivityLevel } from "./taint.js";

// ===========================================
// Escalation Request (evaluator → server.ts → policy classifier)
// ===========================================

/** Escalation request set by the evaluator when deterministic result is "allow"
 * but escalation criteria match. Consumed by server.ts to invoke the LLM classifier. */
export interface EscalationRequest {
	/** Trigger ID: "tainted_network_internal" | "external_url" | "high_step_budget" | "post_injection_action" */
	trigger: string;
	/** Human-readable summary (no secrets) */
	summary: string;
	/** Tool that triggered the escalation */
	tool_name: string;
	/** Redacted tool input (URLs redacted, file paths kept, content stripped) */
	tool_input_redacted: Record<string, string>;
	/** Current session sensitivity level */
	sensitivity_level: SensitivityLevel;
	/** Current tool call count */
	step_number: number;
	/** Last 10 entries from session.tool_sequence */
	recent_tool_sequence: string[];
}

// ===========================================
// LLM Policy Classifier Configuration
// ===========================================

/** Configuration for the LLM policy classifier */
export interface ClassifierConfig {
	/** Whether the classifier is enabled (default: false) */
	enabled: boolean;
	/** Operating mode — v1 supports only "shadow" */
	mode: "shadow" | "enforce";
	/** Inference provider type */
	provider: "groq" | "huggingface" | "openai_compatible" | "anthropic" | "claude_code";
	/** Full endpoint URL for chat completions */
	endpoint: string;
	/** Environment variable name containing the API key (never stored in config) */
	api_key_env: string;
	/** Model identifier */
	model: string;
	/** Request timeout in milliseconds (default: 3000) */
	timeout_ms: number;
	/** Maximum input tokens for evidence serialization (default: 800) */
	max_input_tokens: number;
	/** Confidence threshold for enforcement mode (default: 0.8) */
	confidence_threshold: number;
	/** Maximum classifier calls per session — tracked for metrics, NOT enforced (default: 50) */
	max_calls_per_session: number;
}

/** Classification result from the LLM policy classifier */
export interface PolicyClassification {
	/** Whether the action should be allowed or denied */
	label: "allow" | "deny";
	/** Confidence score 0.0 - 1.0 */
	confidence: number;
	/** One-sentence reasoning */
	reasoning: string;
	/** Which policy was violated (if any) */
	policy_id?: string;
}

/** Structured evidence envelope sent to the classifier (redacted, no raw content) */
export interface PolicyEvidence {
	// What's happening
	tool: string;
	action_class: string;
	target_summary: string;

	// Why it's uncertain
	trigger: string;
	trigger_reason: string;

	// Session context (aggregated, not raw)
	session_sensitivity: SensitivityLevel;
	step_number: number;
	taint_source_count: number;
	taint_source_levels: string[];
	recent_actions: string[];
	agent_role: AgentRole;
	files_written_count: number;
	errors_this_session: number;

	// Intent scope (if assigned)
	intent_goal?: string;
	intent_file_patterns?: string[];

	// Injection context
	injection_detected_in_session: boolean;
	steps_since_injection?: number;

	// Active policies to evaluate
	policies: PolicyRule[];
}

/** Declarative policy rule for the classifier to evaluate */
export interface PolicyRule {
	/** Unique policy identifier */
	id: string;
	/** Human-readable policy name */
	name: string;
	/** Natural language description for the LLM to evaluate against */
	description: string;
	/** Which escalation triggers this policy applies to */
	applies_to_triggers: string[];
	/** Which agent roles this policy applies to (omit for all) */
	applies_to_roles?: AgentRole[];
}
