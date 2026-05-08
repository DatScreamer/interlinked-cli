# CLI subscription credential plumbing

**Status:** Plan / not yet implementation. Pairs with `multi-agent-pre-push-review.md` (which uses these patterns) and `cf-sandbox-egress-proxy-pattern.md` (the egress-proxy primitive used as a fallback).
**Scope:** How Interlinked authenticates to vendor coding-agent CLIs (Claude Code, Codex) when invoking them as automated reviewers. Specifically: how to use subscription billing for both vendors in a cloud-Sandbox-based architecture, and the asymmetric bootstrap flow that gets you there.
**Audience:** Engineers implementing the credential layer; product/legal folks evaluating ToS posture; anyone tempted to assume "this is impossible without API keys."

---

## TL;DR

Both Claude Code and Codex run as reviewers in **per-(user, repo) Cloudflare Sandboxes** with subscription billing. The bootstrap UX is asymmetric — Claude uses a portable token, Codex requires interactive login — but the **steady state is identical**: each commit's review runs in the same Sandbox the user already authenticated to, with auth state persisting across the Sandbox's lifetime.

Concrete:

- **Claude Code:** Run `claude setup-token` once on the developer's local machine. Get back a one-year `CLAUDE_CODE_OAUTH_TOKEN`. Store as a per-user Wrangler secret. Every (user, repo) Sandbox auto-authenticates via env-var injection. Anthropic explicitly authorizes this for "CI pipelines, scripts, or other environments where interactive browser login isn't available."
- **Codex:** When a (user, repo) Sandbox is first provisioned, the user does `codex login --device-auth` once interactively (or port-forwarded browser flow). `~/.codex/auth.json` writes to the Sandbox FS and persists. Subsequent commits to the same repo reuse the same Sandbox and the same auth.json. Login is per-(user, repo), not per-commit.

The previous "heterogeneous cloud-Claude / local-Codex" architecture was based on the false assumption that Sandboxes had to be per-commit. They don't. The CF [`git-repo-per-sandbox` template](https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/) explicitly pairs one Sandbox with one Artifacts repo, persistent across all commits to that repo. That fixes the auth problem for Codex.

API-key fallbacks (Patterns C and D from the original analysis) remain available for users whose environments can't complete interactive OAuth for Codex.

---

## 1. The per-(user, repo) Sandbox lifecycle

This is the key insight that makes the whole architecture work.

Cloudflare's Sandbox SDK and Artifacts compose via the `git-repo-per-sandbox` pattern:

```js
const sandbox = getSandbox(env.Sandbox, sandboxId);
// sandboxId is `${userId}-${repoSlug}` — same id always returns the same Sandbox

if (sandboxWasJustCreated) {
  const created = await env.ARTIFACTS.create(sandboxId);
  // first-time provisioning
} else {
  const repo = await env.ARTIFACTS.get(sandboxId);
  // reuse existing repo
}
```

Same `sandboxId` returns the same Sandbox **forever** (until explicitly destroyed). The Artifacts repo accumulates commits over time — it's a Git repo, that's literally what they're for. The Sandbox persists across all those commits, with its full filesystem state intact.

Lifecycle in practice:

| Event | What happens |
|---|---|
| Dev wires up Interlinked review for repo `foo` for the first time | Worker creates Sandbox + Artifacts repo with id `${userId}-foo`. Bootstrap login flows run (see §2 and §3 below). Tokens / auth state land in the Sandbox FS. |
| Dev pushes commit A | `getSandbox(env.Sandbox, "${userId}-foo")` returns the existing Sandbox. Sandbox does `git fetch && git checkout A`. Runs both reviewers. Both auth states from the bootstrap are still there. |
| Dev pushes commit B (next day) | Same Sandbox. Might have been sleeping (idle); wakes on the call. Auth state intact. |
| Dev pushes commit C (next week) | Same. Refresh tokens have been refreshed naturally on each invocation. |
| Dev wires up review for a different repo `bar` | New `(userId, bar)` Sandbox. New bootstrap login for that one. Per-repo isolation by design. |

**The per-commit isolation people might want is preserved at a different level — not at Sandbox lifecycle, but at workspace within the Sandbox.** Inside the long-lived Sandbox, each review starts in a fresh tmpdir:

```bash
mkdir /tmp/review-${commitSha}
cd /tmp/review-${commitSha}
git fetch artifacts
git checkout ${commitSha}
codex exec --sandbox workspace-write '/security-review against this diff'
cd / && rm -rf /tmp/review-${commitSha}
```

Per-commit clean working tree + persistent auth in `/root/.codex/auth.json` (outside the tmpdir). Best of both worlds.

## 2. Claude Code — `claude setup-token` bootstrap

The portable-token path is officially documented and explicitly authorized. From [https://code.claude.com/docs/en/authentication](https://code.claude.com/docs/en/authentication):

> **Generate a long-lived token** — For CI pipelines, scripts, or other environments where interactive browser login isn't available, generate a one-year OAuth token with `claude setup-token`:
>
> ```bash
> claude setup-token
> ```
>
> The command walks you through OAuth authorization and prints a token to the terminal. It does not save the token anywhere; copy it and set it as the `CLAUDE_CODE_OAUTH_TOKEN` environment variable wherever you want to authenticate:
>
> ```bash
> export CLAUDE_CODE_OAUTH_TOKEN=your-token
> ```
>
> This token authenticates with your Claude subscription and requires a Pro, Max, Team, or Enterprise plan. It is scoped to inference only and cannot establish Remote Control sessions.

The full bootstrap flow:

1. Dev runs `interlinked review setup` (or equivalent) on their local machine
2. Wrapper invokes `claude setup-token` — opens browser, dev authorizes, token prints to terminal
3. Wrapper captures the token and stores it as a per-user Wrangler secret keyed to the dev's identity (e.g., via Cloudflare Access JWT subject claim)
4. When a (user, repo) Sandbox is provisioned, the orchestrator Worker reads the secret and injects `CLAUDE_CODE_OAUTH_TOKEN` as a Sandbox env var
5. `claude -p '/security-review'` inside the Sandbox uses the env-var token automatically

**One caveat from the docs:** `--bare` mode does NOT read `CLAUDE_CODE_OAUTH_TOKEN`. Reviewer subprocess invocations cannot use `--bare` if you want subscription billing. Acceptable — the small startup-time win isn't worth losing subscription pricing.

**Section 2 of the consumer terms** (no shared credentials) means each user has their own `CLAUDE_CODE_OAUTH_TOKEN`, stored under their own per-user secret entry. Multi-tenant Sandboxes where teammate A's review uses teammate B's token clearly violate this. **Per-user Sandboxes only.**

## 3. Codex — `codex login --device-auth` bootstrap

There's no portable token. Auth happens interactively, once per (user, repo) Sandbox lifetime.

The flow:

1. (User, repo) Sandbox is provisioned for the first time
2. Orchestrator Worker triggers `codex login --device-auth` inside the Sandbox
3. Codex prints a URL + a 6-character code to the Sandbox's stdout
4. The orchestrator surfaces this to the dev's local terminal (e.g., via Streaming response from the push hook, or a separate setup flow before first push)
5. Dev visits the URL in their browser, types the code, completes OAuth
6. Codex finishes the OAuth flow inside the Sandbox; `~/.codex/auth.json` is written to `/root/.codex/auth.json`
7. From then on, `codex exec` inside this Sandbox reuses that auth.json with subscription billing

The auth.json contains an OAuth refresh token. Codex CLI handles refresh internally on every invocation, so as long as the dev is pushing regularly, the refresh stays valid. Standard OAuth refresh tokens are typically months-to-years with use extending; specific TTL for ChatGPT is not publicly documented but observed behavior is "stays valid as long as you keep using it."

**If `--device-auth` is gated** (per [Issue #9253](https://github.com/openai/codex/issues/9253), Team/Enterprise plans may require workspace admin to enable device-code auth), the fallback is port-forwarded browser flow:

1. Sandbox starts a local OAuth callback server (Codex's normal browser flow uses `localhost:<port>`)
2. CF Sandbox SDK has [preview URL features](https://developers.cloudflare.com/sandbox/) that can expose a Sandbox-internal port at a public URL
3. Codex inside the Sandbox writes its OAuth callback URL into the auth flow with the public preview URL substituted for `localhost`
4. Dev's browser completes OAuth, callback hits the preview URL, traffic forwards to the Sandbox's callback server
5. auth.json gets written same as the device-auth path

Slightly more complex bootstrap; same end state.

## 4. Anthropic Consumer Terms — verbatim text

Still load-bearing, retained for legal reference. From [https://www.anthropic.com/legal/consumer-terms](https://www.anthropic.com/legal/consumer-terms):

**Section 2 — Account Creation and Access:**

> "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else. You also may not make your Account available to anyone else."

**Section 3 — Use of Our Services, Clause 7:**

> "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise."

**Anthropic's explicit permission for `claude setup-token` in CI/scripts** is the second clause's escape hatch. Per the Authentication docs, this method is documented for "CI pipelines, scripts, or other environments." The cloud Sandbox bootstrap above fits that envelope exactly — a per-user CI-like environment running the user's own automation against their subscription.

## 5. OpenAI position — what's documented

From [https://developers.openai.com/codex/auth](https://developers.openai.com/codex/auth):

> "Sign in with ChatGPT for subscription access" / "Sign in with an API key for usage-based access"
>
> "use API key authentication for programmatic Codex CLI workflows (for example CI/CD jobs)"

The "use API key for CI/CD" guidance is for non-interactive automated workflows. **A per-(user, repo) Sandbox where the user themselves logged in interactively, then runs reviews triggered by their own pushes, is closer to "user's remote dev environment" than to "scripted CI/CD job."** The defining characteristic of "CI/CD" in the OpenAI sense is that nobody's home — the script runs against a service-account API key on a schedule with no user awareness. That's not what we're doing. We're letting a user authenticate their own Sandbox, then using it for reviews they triggered.

The headless paths OpenAI explicitly ships:

- `codex login --device-auth` — device-code flow for headless environments. Workspace-admin-gated for some plans (per [Issue #9253](https://github.com/openai/codex/issues/9253)) — primary fallback risk.
- Manual `~/.codex/auth.json` copy — explicitly cautioned ("treat like a password"). We do NOT use this; we have the user log in directly inside the Sandbox.

**The [Issue #3820](https://github.com/openai/codex/issues/3820) feature request** ("Enable Headless or Command-line Authentication for Codex CLI (ChatGPT Plans)") is open and being actively discussed. If/when OpenAI ships a `codex setup-token` analog, the bootstrap UX simplifies to match Claude — single token, distributed to Sandboxes via secret. Until then, interactive bootstrap once per (user, repo) is the cleanest ToS-compliant subscription path.

## 6. Recommended architecture

| Reviewer | Bootstrap | Storage | Per-commit invocation | Billing |
|---|---|---|---|---|
| Claude Code | One-time `claude setup-token` on user's local machine | Per-user Wrangler secret keyed to dev identity | `claude -p '/security-review'` with `CLAUDE_CODE_OAUTH_TOKEN` env-var injected by orchestrator | Subscription |
| Codex | One-time `codex login --device-auth` (or port-forwarded browser) inside the Sandbox at provisioning | `/root/.codex/auth.json` in Sandbox FS | `codex exec '/security-review'` against the persistent auth state | Subscription |

The architecture has **one fewer surface** than the previous "cloud-Claude / local-Codex" recommendation:

- No local-subprocess dispatch protocol needed
- No bidirectional streaming between cloud orchestrator and local harness for review specs
- Both reviewers identical from the orchestrator's perspective (HTTPS dispatch to the right Sandbox, await verdict)
- Identical cost profile (subscription billing for both)

This is dramatically simpler than the heterogeneous architecture I proposed in the original draft of this doc. The original was a workaround for a constraint that turned out not to exist.

## 7. API-key fallbacks (in priority order)

If the primary subscription path fails for any reason — workspace admin gating prevents `--device-auth`, dev can't complete browser flow, environment doesn't support preview URLs — there are three fallback paths in increasing operational complexity:

**Fallback A: Port-forwarded browser flow** (still subscription)

Same as the device-auth path but routes through the Sandbox preview URL feature instead of a 6-character code. Slightly more complex bootstrap UX. Same Sandbox lifecycle, same subscription billing.

**Fallback B: API key in cloud Sandbox via egress proxy** (Pattern D)

Per [`cf-sandbox-egress-proxy-pattern.md`](./cf-sandbox-egress-proxy-pattern.md). Worker holds the API key; Sandbox makes outbound requests to `http://api.openai.com/v1`; Worker `outboundByHost` handler injects `Authorization: Bearer ${OPENAI_API_KEY}` server-side; key never enters the container. ToS-clean (API keys for CI is exactly what OpenAI recommends), but pays API rates instead of subscription rates.

**Fallback C: Local subprocess on user's machine** (Pattern A)

The old fallback. Cloud orchestrator dispatches the review-spec to the local harness via streaming RPC; harness spawns `codex exec` against the user's existing `~/.codex/auth.json`; results stream back. Subscription billing preserved, but loses cloud parallelism. Useful only if neither cloud bootstrap path is viable for the user.

## 8. Where credentials live

In the corrected architecture:

| Credential | Where it lives | Crosses the network? |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Per-user Wrangler secret + injected as Sandbox env var | Yes — Wrangler secret → Sandbox env var on each Sandbox wake. Token is OAuth-scoped (inference only, one-year expiry). |
| Codex `auth.json` | `/root/.codex/auth.json` in Sandbox FS | No — written by `codex login` running inside the Sandbox; never transits between machines. The user's *interactive OAuth flow* transits, not the resulting auth.json. |
| `OPENAI_API_KEY` (Fallback B) | Worker secret only; never enters the container | No, except as a Bearer header on outbound requests at the Worker boundary |

Codex is **stronger** than Claude on credential transit: the auth.json is born inside the Sandbox during interactive login, never leaves. Claude's token transits from local machine → Wrangler secret → Sandbox env var, with each step encrypted but the token doing more travel.

This is fine because Anthropic's `setup-token` is explicitly designed for this distribution pattern. They scoped the token to inference only and bounded it to one year specifically because they expect users to ship it around to CI environments. The risk is bounded by design.

## 9. Multi-tenant team review — what's NOT supported

Even with the unified cloud-Sandbox architecture, **per-developer scoping remains hard-required**:

- Each developer has their own (user, repo) Sandbox
- Each Sandbox has its own auth.json (Codex) and CLAUDE_CODE_OAUTH_TOKEN (Claude)
- Section 2 of Anthropic's terms ("don't share credentials") and the equivalent OpenAI guidance both forbid sharing
- A "team-shared review Sandbox" running everyone's reviews against one set of credentials clearly violates this
- A reviewer wants to review someone else's PR? Their own Sandbox handles it, billed against their own subscription, but they're using their own credentials — not the PR author's. That's fine.

For team-level features like "review everyone's PRs to main against the same audit policy," the pattern is: each reviewer's own Sandbox handles their own review action, but the orchestration logic (what to review, who to notify, what counts as approved) lives in the cloud orchestrator and aggregates per-user verdicts.

If a use case genuinely needs shared-credential review (e.g., a managed-service tier where Interlinked runs reviews on behalf of customers without per-developer subscriptions), that's the API-key path — Fallback B with org-level billing. v2 feature.

## 10. Cost comparison

Updated math given both reviewers are now subscription-billed in cloud:

For a developer with Claude Pro/Max ($20-200/mo) + ChatGPT Plus/Pro ($20-200/mo) already paid:

- **Marginal cost of unlimited cloud reviews:** ~$0/month — already paying for the subscriptions, the reviews use them
- **Cloud Sandbox compute time:** small. Sandboxes sleep when idle; only billed for active review time. Reviewing 50 commits/month at ~30s each = 25 minutes of active Sandbox time = nominal CF cost
- **CF Artifacts storage:** scales with repo size and history; one Artifacts repo per (user, repo) pair

For the same dev on API-key fallback (Fallback B):

- ~$3-8 per full review × 50 reviews/month = $150-400/month per dev for Codex API alone
- Plus equivalent for any non-subscription Claude reviews

The 5-10× claim from earlier conversations bears out: subscription path is roughly an order of magnitude cheaper for active dev workloads. **This is why the unified cloud-Sandbox architecture matters** — without it, we'd be forced into Pattern C/D for at least one reviewer and lose the savings.

## 11. Implementation surface

Concrete touchpoints in the existing CLI codebase, updated for the corrected architecture:

| Concern | Existing surface | Change needed |
|---|---|---|
| Resolve auth path per-CLI | `lib/auth.ts` | Add `resolveCloudReviewerAuth(reviewer, userId)` that returns per-reviewer auth instructions for the orchestrator (token to inject, or "interactive login required"). Generalizes existing token resolution |
| One-time bootstrap commands | New | Add `interlinked review setup-claude` (runs `claude setup-token`, captures, sends to orchestrator for storage). Add `interlinked review setup-codex <repo>` (triggers per-(user, repo) Sandbox provisioning + interactive login flow) |
| Token storage on cloud side | New (orchestrator Worker) | Per-user encrypted KMS storage for `CLAUDE_CODE_OAUTH_TOKEN`s, keyed to dev identity. Sandbox provisioning reads + injects |
| Sandbox lifecycle | New (orchestrator Worker) | Cooperative sleep config (`SANDBOX_SLEEP_AFTER` set high — hours or days). Wake-on-push semantics. Health checks before review to confirm Sandbox state intact |
| Bootstrap UX flow | New | Streaming response from `git push` hook that surfaces `codex login --device-auth` URL+code to the dev's terminal, awaits completion before proceeding with the first review |

What's removed from the original implementation surface:

- Local-subprocess reviewer dispatch path (no longer needed — both reviewers in cloud)
- Bidirectional streaming RPC for review specs (no longer needed)
- Sealed credential bundles for shipping local creds to cloud (no longer needed)
- The `exportCredentialBundle` primitive in `auth.ts` (only needed if we want to share creds across user's own Sandboxes — see open question §13)

The local-subprocess pattern is now strictly a fallback (Fallback C above), not a primary path.

## 12. Pre-flight verification before betting on this

Three concrete tests to run before committing the architecture in code:

**Test 1: Does `codex login --device-auth` work for individual Plus/Pro plans?**
- Spin up a fresh CF Sandbox manually
- Install Codex CLI, run `codex login --device-auth`
- If it prints a URL+code and completes OAuth without "contact your workspace admin," the primary path works
- If it fails for individual plans the way #9253 implies it might, fallback to port-forwarded browser flow is required

**Test 2: Does Codex's auth.json refresh-after-sleep actually work?**
- Log in to a Sandbox, run a `codex exec` to confirm working
- Configure `SANDBOX_SLEEP_AFTER=24h`, idle the Sandbox for 24h+
- Wake it via a new request, run `codex exec` again
- Confirm it works without re-login. If the refresh token has expired during sleep, the architecture needs a "refresh-on-wake check" that prompts re-login when needed (still tenable, just adds friction)

**Test 3: How does `CLAUDE_CODE_OAUTH_TOKEN` interact with refresh / expiry?**
- The token is documented as one-year. What happens at month 11?
- Does the dev get a clear "your token expires in N days" warning?
- What's the renewal flow? `claude setup-token` again, replace the secret? Or auto-renew?

If all three pass, the architecture is solid and this doc reflects reality. If Test 1 fails for individual plans, the primary path becomes the port-forwarded browser flow — same end state, slightly more complex initial bootstrap. If Test 2 fails, we add a refresh-on-wake check. If Test 3 reveals an unfriendly renewal flow, we add token-expiry monitoring to the CLI.

## 13. Open questions

- **Cross-repo auth sharing for Codex.** If a dev works on 5 projects, that's 5 (user, repo) Sandboxes, each with its own auth.json — meaning 5 device-auth flows over the dev's lifetime. Could we use a per-user "auth-host" Sandbox that holds one auth.json, then copy it to project-specific Sandboxes on provisioning? Technically yes; ToS-questionable since it's the "treat auth.json like a password and copy it around" pattern OpenAI explicitly cautions against. **Defer until we see how painful the per-repo login burden is in practice.** For most devs working on 1-3 active projects, it's a non-issue.

- **Sandbox loss recovery.** If a Sandbox gets evicted by CF (extended idle past max retention, infrastructure event), the auth.json is gone. The dev's next push triggers re-bootstrap. UX needs to handle this gracefully — clear "Sandbox needs re-login" state in the statusline, not a silent failure mid-review.

- **Token rotation for `CLAUDE_CODE_OAUTH_TOKEN`.** One-year tokens need rotation. The CLI needs a `interlinked review refresh-claude-token` command and a "expires in N days" notification path tied to local statusline. Not designed yet but trivial to add.

- **What if a dev's subscription lapses?** If they cancel Claude Pro, the token gets revoked next time the API checks. Reviews fail with auth errors. We need a clear failure path: surface the revocation to the dev, prompt re-bootstrap (which will fail until they re-subscribe), don't pretend the cloud reviewer is healthy when it isn't.

- **Multi-developer pre-push review workflow.** When dev A pushes to a repo that dev B is also reviewing, whose Sandbox runs the review? The author's, by default — they triggered the review action. But what if a team policy says "all PRs to main must be reviewed by dev B's review setup"? That requires either dev B's Sandbox running on dev A's behalf (forbidden by Section 2) or a separate orchestration model where the team admin owns the review credentials (Pattern B/D, paying API rates). **Defer until we have a concrete team-review use case.**

## 14. What this is NOT

- **Not a "share credentials" workaround.** Section 2 still applies. Per-user Sandboxes always.
- **Not a multi-tenant managed service.** That's a future product with its own auth model (likely API keys with org billing).
- **Not a permanent design.** When OpenAI ships `codex setup-token`, this entire doc simplifies dramatically — Codex bootstrap becomes one-line just like Claude, no interactive login needed.
- **Not a workaround for ToS.** It's explicit use of vendor-provided headless auth flows (`claude setup-token`, `codex login --device-auth`) — doing exactly what the docs say is supported.

---

## Sources

Verbatim ToS / authentication text:

- [Anthropic Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms) — Section 2 (account credentials), Section 3 Clause 7 (automated access)
- [Anthropic Usage Policy](https://www.anthropic.com/legal/aup)
- [Claude Code Authentication docs](https://code.claude.com/docs/en/authentication) — `claude setup-token` and `CLAUDE_CODE_OAUTH_TOKEN` explicit permission
- [Claude Code Headless docs](https://code.claude.com/docs/en/headless) — bare-mode incompatibility
- [Claude Code GitHub Actions docs](https://code.claude.com/docs/en/github-actions) — Anthropic's preferred CI flow defaults to API key
- [Anthropic Claude Code Action repo](https://github.com/anthropics/claude-code-action)

OpenAI Codex sources:

- [Codex Authentication docs](https://developers.openai.com/codex/auth) — sign-in methods and CI guidance
- [Codex Non-interactive docs](https://developers.openai.com/codex/noninteractive) — `codex exec` flags
- [GitHub Issue #3820 — Enable Headless or Command-line Authentication for Codex CLI (ChatGPT Plans)](https://github.com/openai/codex/issues/3820) — open feature request for portable subscription token
- [GitHub Issue #9253 — Codex CLI cannot log in on headless environments unless Device Code auth is enabled by workspace admin](https://github.com/openai/codex/issues/9253) — workspace-admin gating risk

Cloudflare substrate:

- [Sandbox SDK + Artifacts (`git-repo-per-sandbox` template)](https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/) — the lifecycle pattern that makes the per-(user, repo) architecture work
- [Cloudflare Sandbox SDK overview](https://developers.cloudflare.com/sandbox/) — preview URLs, sleep config, env var injection
- [Sandbox SDK examples — claude-code](https://github.com/cloudflare/sandbox-sdk/tree/main/examples/claude-code) — both `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` routes demonstrated
- [Sandbox SDK examples — codex-app-server](https://github.com/cloudflare/sandbox-sdk/tree/main/examples/codex-app-server) — egress-proxy pattern (Fallback B path)
- [Sandbox SDK examples — opencode](https://github.com/cloudflare/sandbox-sdk/tree/main/examples/opencode)

Cross-reference docs:

- [`multi-agent-pre-push-review.md`](./multi-agent-pre-push-review.md) — uses these patterns to dispatch reviewers
- [`cf-sandbox-egress-proxy-pattern.md`](./cf-sandbox-egress-proxy-pattern.md) — Fallback B / Pattern D in detail
- [`three-product-architecture.md`](./three-product-architecture.md) — broader product framing
- [`cloud-mirror-compatibility-changes.md`](../plans/cloud-mirror-compatibility-changes.md) — concrete CLI changes to support this architecture
