// interlinked-tdd: exempt — request-handler orchestration shell; the pure
// logic (state codec, workspace derivation, user parsing, authorize URL) lives
// in oauth-helpers.ts and is unit-tested there.
//
// This is the OAuthProvider `defaultHandler`: it serves the public /health
// endpoint and runs the GitHub upstream OAuth dance for /authorize + /callback.
// The provider itself owns /token and /register.

import type { Env, Props } from "../types.js";
import {
	decodeOAuthState,
	deriveWorkspaceId,
	encodeOAuthState,
	githubAuthorizeUrl,
	parseGithubUser,
} from "./oauth-helpers.js";

const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_FETCH_TIMEOUT_MS = 10_000;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_GATEWAY = 502;
const HTTP_REDIRECT = 302;
const PATH_HEALTH = "/health";
const PATH_AUTHORIZE = "/authorize";
const PATH_CALLBACK = "/callback";

// parseAuthRequest's return type — captured structurally so we don't depend on
// the library's exported type name. The value round-trips through `state`.
type AuthRequest = Awaited<ReturnType<Env["OAUTH_PROVIDER"]["parseAuthRequest"]>>;

export const githubDefaultHandler = {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === PATH_HEALTH) {
			return json({ status: "ok", environment: env.ENVIRONMENT ?? "unknown" });
		}
		if (url.pathname === PATH_AUTHORIZE) {
			return handleAuthorize(request, env);
		}
		if (url.pathname === PATH_CALLBACK) {
			return handleCallback(request, env);
		}
		return new Response("not found", { status: HTTP_NOT_FOUND });
	},
};

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
	const oauthReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
	const redirectUri = `${new URL(request.url).origin}/callback`;
	const state = encodeOAuthState(oauthReq);
	const dest = githubAuthorizeUrl({ clientId: env.GITHUB_CLIENT_ID, redirectUri, state });
	// Not an open redirect: githubAuthorizeUrl always targets the hardcoded
	// github.com/login/oauth/authorize host; no part of `dest`'s host is
	// caller-controlled (only our own query params are appended).
	return Response.redirect(dest, HTTP_REDIRECT);
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	if (!code || !state) return json({ error: "missing code or state" }, HTTP_BAD_REQUEST);

	const decoded = decodeOAuthState(state);
	if (!decoded) return json({ error: "invalid state" }, HTTP_BAD_REQUEST);
	const oauthReq = decoded as AuthRequest;

	const accessToken = await exchangeGithubCode(env, code, `${url.origin}/callback`);
	if (!accessToken) return json({ error: "github token exchange failed" }, HTTP_BAD_GATEWAY);

	const user = await fetchGithubUser(accessToken);
	if (!user) return json({ error: "github user fetch failed" }, HTTP_BAD_GATEWAY);

	const props: Props = {
		githubId: user.id,
		login: user.login,
		name: user.name,
		workspaceId: deriveWorkspaceId(user.id),
	};

	const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
		request: oauthReq,
		userId: String(user.id),
		scope: oauthReq.scope ?? [],
		metadata: { login: user.login },
		props,
	});
	// Not an open redirect: `redirectTo` is produced by the OAuth provider, which
	// matches the request's redirect_uri against the requesting client's
	// pre-registered URIs and rejects any mismatch before returning it.
	return Response.redirect(redirectTo, HTTP_REDIRECT);
}

async function exchangeGithubCode(
	env: Env,
	code: string,
	redirectUri: string,
): Promise<string | null> {
	try {
		const res = await fetch(GITHUB_TOKEN_URL, {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify({
				client_id: env.GITHUB_CLIENT_ID,
				client_secret: env.GITHUB_CLIENT_SECRET,
				code,
				redirect_uri: redirectUri,
			}),
			signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		const body = (await res.json()) as { access_token?: unknown };
		return typeof body.access_token === "string" ? body.access_token : null;
	} catch {
		return null;
	}
}

async function fetchGithubUser(accessToken: string): Promise<ReturnType<typeof parseGithubUser>> {
	try {
		const res = await fetch(GITHUB_USER_URL, {
			headers: {
				authorization: `Bearer ${accessToken}`,
				accept: "application/vnd.github+json",
				"user-agent": "interlinked-cloud",
			},
			signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		return parseGithubUser(await res.json());
	} catch {
		return null;
	}
}

function json(body: unknown, status = HTTP_OK): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
