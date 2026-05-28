// interlinked-tdd: exempt
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
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

// Identity carried in the OAuth grant props (end-to-end encrypted by
// workers-oauth-provider, passed to the apiHandler on every authorized
// request via this.ctx.props). workspaceId is DERIVED from the GitHub user
// at login (ws_<githubId>) — never supplied by the client.
export interface Props {
	githubId: number;
	login: string;
	name?: string;
	workspaceId: string;
}

export interface Env {
	SUPERVISOR: DurableObjectNamespace<Supervisor>;
	OAUTH_KV: KVNamespace;
	// Injected by workers-oauth-provider — the callback API (parseAuthRequest,
	// completeAuthorization, lookupClient, ...).
	OAUTH_PROVIDER: OAuthHelpers;
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	ENVIRONMENT?: string;
}
