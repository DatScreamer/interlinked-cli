// interlinked-tdd: exempt — Worker entrypoint. The OAuthProvider is the front
// door: it owns /token + /register, validates Bearer tokens on the apiRoute
// prefixes and forwards authorized requests (with identity in ctx.props) to
// ApiHandler, and passes everything else (/health, /authorize, /callback) to
// the GitHub defaultHandler. See docs/design/onboarding-and-connection-flow.md.

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { ApiHandler } from "./api-handler.js";
import { githubDefaultHandler } from "./auth/github-handler.js";

// The Durable Object class must be exported from the Worker's main module so
// the SUPERVISOR binding can resolve it.
export { Supervisor } from "./dos/supervisor.js";

export default new OAuthProvider({
	// Protected surfaces — a valid access token is required; identity arrives
	// in ctx.props. Trailing slash so "/governor/evaluate" matches "/governor/".
	// /mcp and /sync join this list when those surfaces are built.
	apiRoute: ["/governor/", "/admin/"],
	apiHandler: ApiHandler,
	// Public + auth UI: /health, /authorize (→ GitHub), /callback (← GitHub).
	defaultHandler: githubDefaultHandler,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
	scopesSupported: ["governor"],
});
