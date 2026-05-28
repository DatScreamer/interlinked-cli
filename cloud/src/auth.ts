import type { Env } from "./types.js";

export interface AuthResult {
	authenticated: boolean;
	workspace_id?: string;
	error?: string;
}

// v0: dev-mode constant-bearer comparison. v1: swap the impl for Cloudflare
// Access JWKS validation against the configured Access app — same interface,
// different validator; no callers need to change.
export function authenticateRequest(request: Request, env: Env): AuthResult {
	if (!env.BEARER_TOKEN) {
		return { authenticated: false, error: "server-misconfigured: BEARER_TOKEN unset" };
	}
	const header = request.headers.get("authorization");
	if (!header || !header.startsWith("Bearer ")) {
		return { authenticated: false, error: "missing or malformed authorization header" };
	}
	const token = header.slice("Bearer ".length).trim();
	if (token !== env.BEARER_TOKEN) {
		return { authenticated: false, error: "invalid bearer token" };
	}
	// v0: single-workspace mode. v1: derive workspace_id from token claims.
	return { authenticated: true, workspace_id: "default" };
}
