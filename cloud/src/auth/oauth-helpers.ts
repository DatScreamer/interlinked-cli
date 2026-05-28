// Pure, framework-agnostic helpers for the GitHub-upstream OAuth flow.
// Kept separate from the request-handler shell so they're unit-testable
// without a Worker runtime or mocked env.

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
// We only need the public profile (id + login) to establish identity.
const GITHUB_SCOPE = "read:user";

/** Deterministic personal-workspace id. For v0 every user gets a personal
 *  workspace keyed by their immutable GitHub numeric id — no registry storage
 *  needed. Teams (a shared workspace_id with a membership table) come later. */
export function deriveWorkspaceId(githubId: number): string {
	return `ws_${githubId}`;
}

/** Unicode-safe base64url encode. */
export function b64urlEncode(s: string): string {
	const bytes = new TextEncoder().encode(s);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Unicode-safe base64url decode. Throws on invalid input (callers that want
 *  graceful handling use decodeOAuthState). */
export function b64urlDecode(s: string): string {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(b64);
	const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

// The OAuth request info from parseAuthRequest is passed through the GitHub
// round-trip opaquely (encoded into the `state` param), then handed back to
// completeAuthorization. We don't need to know its shape — only round-trip it.
// NOTE (v0): the state is not signed. The embedded redirect_uri is matched
// against the registered client downstream by completeAuthorization, which
// rejects a mismatch — so a tampered state fails there. A signed/HMAC state
// is a hardening follow-up.
export function encodeOAuthState(reqInfo: unknown): string {
	return b64urlEncode(JSON.stringify(reqInfo));
}

/** Decode the state param back into the OAuth request info. Returns null on
 *  any malformed input rather than throwing, so the callback can 400 cleanly. */
export function decodeOAuthState(state: string): unknown {
	if (!state) return null;
	try {
		return JSON.parse(b64urlDecode(state));
	} catch {
		return null;
	}
}

export interface GithubUser {
	id: number;
	login: string;
	name?: string;
}

/** Validate the GitHub GET /user response at the trust boundary. Returns null
 *  when the shape isn't what we require (numeric id + string login). */
export function parseGithubUser(value: unknown): GithubUser | null {
	if (!value || typeof value !== "object") return null;
	const v = value as { id?: unknown; login?: unknown; name?: unknown };
	if (typeof v.id !== "number") return null;
	if (typeof v.login !== "string") return null;
	return {
		id: v.id,
		login: v.login,
		name: typeof v.name === "string" ? v.name : undefined,
	};
}

/** Validate the OAuth grant props the provider hands to the apiHandler via
 *  this.ctx.props. The apiHandler only runs for provider-authorized requests,
 *  but we still validate the shape at the boundary and derive identity from it
 *  (never from the client request). Returns null on any malformed shape so the
 *  caller can 401 rather than route with a partial identity. */
export function parseProps(value: unknown): import("../types.js").Props | null {
	if (!value || typeof value !== "object") return null;
	const p = value as {
		githubId?: unknown;
		login?: unknown;
		name?: unknown;
		workspaceId?: unknown;
	};
	if (typeof p.githubId !== "number") return null;
	if (typeof p.login !== "string") return null;
	if (typeof p.workspaceId !== "string" || p.workspaceId.length === 0) return null;
	return {
		githubId: p.githubId,
		login: p.login,
		name: typeof p.name === "string" ? p.name : undefined,
		workspaceId: p.workspaceId,
	};
}

/** Build the GitHub authorize URL the user's browser is redirected to. */
export function githubAuthorizeUrl(opts: {
	clientId: string;
	redirectUri: string;
	state: string;
}): string {
	const url = new URL(GITHUB_AUTHORIZE_URL);
	url.searchParams.set("client_id", opts.clientId);
	url.searchParams.set("redirect_uri", opts.redirectUri);
	url.searchParams.set("scope", GITHUB_SCOPE);
	url.searchParams.set("state", opts.state);
	return url.toString();
}
