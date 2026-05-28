// interlinked-tdd: exempt
import type { Facet } from "./dos/facet.js";
import type { Supervisor } from "./dos/supervisor.js";

export interface HookEvent {
	hook_event: "PreToolUse" | "PostToolUse" | "Stop" | "SessionEnd";
	session_id: string;
	agent_source: string;
	agent_name?: string;
	tool_name: string;
	tool_input?: unknown;
	timestamp: string;
}

export type VerdictDecision = "allow" | "block";

export interface Verdict {
	decision: VerdictDecision;
	reason?: string;
	warnings?: string[];
	rule_id?: string;
}

export interface Env {
	SUPERVISOR: DurableObjectNamespace<Supervisor>;
	FACET: DurableObjectNamespace<Facet>;
	BEARER_TOKEN?: string;
	ENVIRONMENT?: string;
}
