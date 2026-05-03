# Cloudflare Agent Cloud

- **Source:** [Press release: Cloudflare Expands its Agent Cloud](https://www.cloudflare.com/press/press-releases/2026/cloudflare-expands-its-agent-cloud-to-power-the-next-generation-of-agents/) • [Internal AI Engineering Stack post (iMARS)](https://blog.cloudflare.com/internal-ai-engineering-stack/) • [Agent setup — Codex](https://developers.cloudflare.com/agent-setup/codex/) • [Agent setup — Claude Code](https://developers.cloudflare.com/agent-setup/claude-code/) • [Sandbox tutorial — Claude Code](https://developers.cloudflare.com/sandbox/tutorials/claude-code/) • [OpenAI/Cloudflare partnership announcement](https://openai.com/index/cloudflare-openai-agent-cloud/)
- **Encountered:** 2026-05-02 through 2026-05-03, while designing the cloud-mirror + multi-agent pre-push architecture
- **Verdict:** Cloud-roadmap entry (lane 5 primary, lane 3 secondary, lane 4 tertiary)

## 1. Core idea (one sentence)

Cloudflare has built a coordinated set of primitives — Workers, Sandboxes, Artifacts, Workflows, AI Gateway, Workers AI, MCP Server Portal — that together form a substrate for running long-lived multi-agent workloads at scale, and they've validated the substrate by running their own internal AI engineering stack (3,683 users, 241B tokens/month) on it.

## 2. Anatomy (concrete walkthrough)

This is a multi-component announcement, not a single project. The load-bearing pieces, in order of relevance to Interlinked:

**Sandbox SDK (GA, April 2026).** Persistent isolated Linux containers with shells, filesystems, processes. Agents clone repos, install packages, run builds. The SDK has a clean security model — `enableInternet = false` + `interceptHttps = true` + `outboundByHost` egress proxy means the parent Worker can mediate every outbound request and inject credentials *server-side* so they never enter the container. First-party examples for Claude Code, Codex (`codex-app-server`), and OpenCode all live in [`cloudflare/sandbox-sdk/examples`](https://github.com/cloudflare/sandbox-sdk/tree/main/examples). The Codex example uses the egress-proxy pattern; the Claude example uses the simpler env-var pattern but supports both API key and `CLAUDE_CODE_OAUTH_TOKEN` (subscription) routes.

**Artifacts.** Git-compatible versioned storage, "fork from any remote source," scoped tokens. Designed for tens of millions of repos. The architectural unit for "fork the user's repo into a per-review immutable artifact, run reviewers against it, throw it away." Substrate, not pattern.

**Workflows (April 2026 architecture).** Durable, multi-step orchestration with retries/persistence. 50K concurrency, 300 instances/sec, 2M queued. The right substrate for the multi-agent reviewer orchestrator — a review that fails halfway shouldn't restart from scratch.

**AI Gateway proxy Worker pattern.** Documented end-to-end in the iMARS post. CF's setup: every internal AI request goes through a proxy Worker that validates a Cloudflare Access JWT, strips client auth headers, injects `cf-aig-authorization: Bearer ${API_KEY}` and `cf-aig-metadata: {userId: <anonymous-uuid>}`, forwards to AI Gateway, AI Gateway routes to the actual provider. Email→UUID mapping via D1+KV cache. **Result: no API keys on user machines, per-user attribution, BYOK + ZDR per-tenant.** This is the same architectural pattern as Sandbox `outboundByHost`, applied at a different boundary (user-to-Gateway instead of Sandbox-to-internet).

**Discovery endpoint pattern.** From iMARS: `opencode auth login https://opencode.internal.domain` triggers a fetch to `/.well-known/opencode` that returns `{auth, config}`. Auth completes via Cloudflare Access SSO; config (providers, MCP servers, agents, commands, default permissions) merges into the local CLI. **One-command team onboarding** — the team admin deploys the Worker, devs run one command, no per-machine config.

**MCP Server Portal + Code Mode aggregation.** CF's internal portal aggregates 13 MCP servers, 182+ tools, behind one OAuth flow. Code Mode collapses many tool definitions into two (`portal_codemode_search`, `portal_codemode_execute`) so the model sees a small surface but can reach the full tool set via code. Token-budget reduction at scale — they cite 7.5% of a 200K context being saved per request.

**Engineering Codex.** Distillation of internal engineering standards into rules ("If you need X, use Y"), surfaced as agent skills with progressive disclosure. The AI Code Reviewer cites specific Codex rule IDs in MR feedback. Generated AGENTS.md across 3,900 repos using Backstage metadata + repo analysis. **Structurally identical to what Interlinked's `enforce` skill + `distilled-rules.json` + harness rule packs do.**

**AI Code Reviewer.** Every MR at Cloudflare gets an AI code review via OpenCode-with-multi-agent-coordinator. The coordinator triages by risk tier (trivial/lite/full) and dispatches to specialized review agents (code quality, security, codex compliance, documentation, performance, release impact). Each agent uses AI Gateway for model access, pulls Engineering Codex rules from a central repo, reads `AGENTS.md` for repo context, posts structured comments. **The reference implementation for our `multi-agent-pre-push-review.md` design.**

**OpenAI/Cloudflare partnership (April 13, 2026).** Adds OpenAI frontier models (GPT-5.4) and the Codex harness as hosted options on CF Agent Cloud. Coexists with Workers AI for open-weight models. Enterprise-flavored — billed via API tokens / Workers AI pricing. **Does not introduce a portable subscription-token mechanism for Codex** (verified separately by reading OpenAI's Codex auth docs and the open issue [#3820](https://github.com/openai/codex/issues/3820) requesting one).

End-to-end how a coordinated stack would work, in 8 lines:

1. Dev pushes to git
2. Local hook calls a CF Worker, sends signed Access JWT + commit ref
3. Worker forks the repo into an Artifact at that commit
4. Workflow.start() classifies risk tier, fans out reviewers in parallel Sandboxes
5. Each Sandbox uses `outboundByHost` so its API key never leaves the Worker
6. Reviewers return verdicts; orchestrator applies unanimous-allow
7. Verdict bundle gets signed, attached to the commit as audit trail
8. Allow/block returned to local hook; push proceeds or fails with findings

## 3. Deterministic or agentic?

**Hybrid by component.** The substrate (Sandboxes, Artifacts, Workflows, Workers, AI Gateway) is deterministic infrastructure — same inputs, same outputs. The applications running on it are mostly agentic (AI Code Reviewer is multi-agent LLM dispatch; Engineering Codex skills are LLM-driven; AGENTS.md generation uses a model). Where determinism matters for our adoption: the orchestration substrate is reusable substrate-y; the AI applications running on it are inherently lane-5 fodder (cloud-only by virtue of LLM cost/latency/scale).

**License.** Cloudflare products are paid services; the SDKs and skills repos under `cloudflare/*` GitHub are open source (typically Apache 2.0 or MIT — case-by-case). [`cloudflare/sandbox-sdk`](https://github.com/cloudflare/sandbox-sdk), [`cloudflare/agents`](https://github.com/cloudflare/agents), [`cloudflare/skills`](https://github.com/cloudflare/skills), [`cloudflare/mcp-server-cloudflare`](https://github.com/cloudflare/mcp-server-cloudflare) — all open. The patterns and example code are freely borrow-able. The platform itself is paid.

## 4. Substrate vs. surface

The substrate is heavily reusable; the surface is CF-specific.

**Substrate worth borrowing or invoking:**

- The `outboundByHost` egress-proxy pattern (lane 4 → eventually substrate when we ship our own Workers; documented in `cf-sandbox-egress-proxy-pattern.md`)
- The proxy-Worker-as-credential-boundary pattern (lane 4 → drives the AI Gateway proxy approach in `cli-subscription-credential-plumbing.md` Fallback B)
- **The `git-repo-per-sandbox` lifecycle pattern** (lane 4, load-bearing → drives the per-(user, repo) Sandbox architecture for both reviewers; documented in `cli-subscription-credential-plumbing.md` §1)
- The discovery-endpoint pattern (`/.well-known/<name>` returning `{auth, config}`) (lane 4 → drives the team-config item in `cloud-mirror-compatibility-changes.md`)
- The risk-tier orchestrator pattern (lane 4 → drives `multi-agent-pre-push-review.md`)
- Sandbox SDK + Artifacts + Workflows as the cloud-side execution stack (lane 5 — when Interlinked builds its cloud, this is what it runs on)
- Engineering Codex pattern (lane 4 — already mirrored by `enforce` + `distilled-rules.json`; we're independently building a parallel)

**Surface that's CF-locked:**

- Cloudflare Access (Zero Trust SSO) — substitutable with any OIDC provider but CF's Access flow is what makes the iMARS pattern frictionless for a CF-dependent team
- AI Gateway specifically (any inference proxy works in principle, but CF's adds caching + ZDR + analytics + BYOK in one box)
- Workers AI for inference (any inference provider works; CF's locality benefit is real for users on CF infra)
- Sandbox SDK persistent-Sandbox lifecycle with the auth-survives-sleep property (the load-bearing primitive for the Codex bootstrap path; substitutes are theoretical but not actually shipping in any other cloud platform that matches the per-(user, repo) keying model)

**Critically: subscription-auth portability is partial, but the Sandbox lifecycle bridges the gap.** Anthropic's `claude setup-token` works on or off Cloudflare — fully portable. OpenAI has no `setup-token` equivalent, but **the Sandbox SDK's persistent (user, repo) lifecycle gives Codex an effectively-portable subscription path anyway**: log in once inside the Sandbox, the auth.json persists across all subsequent commits to that repo. The CF stack doesn't fix the vendor-side gap (no portable token) but provides an execution substrate where the vendor's interactive headless auth flow (`codex login --device-auth`) only has to run once per (user, repo) pair, then is reused indefinitely. This is what made the cloud-Sandbox-for-both architecture viable; without the persistent-Sandbox property, we'd have been forced into the heterogeneous local-Codex / cloud-Claude split.

## 5. Lane (1–6)

**Lane 5 (cloud-only fodder)** primary — most of what's interesting requires cloud infrastructure (Sandboxes, Workflows, parallel agent execution, durable orchestration). The local CLI can't host any of this.

**Lane 3 (substrate)** secondary — the patterns above (egress proxy, discovery endpoint, risk-tier orchestrator) are reusable design substrate that we borrow when building our own cloud Worker / Sandbox setup.

**Lane 4 (pattern)** tertiary — the Engineering Codex / iMARS internal stack architecture is a *worked example* of the system we're building. It's a memory entry plus the design docs already written this turn.

**Not lane 1 or 2** — there are no specific imperative rules or detection techniques to import directly.

## 6. Smallest spike

A 1-day spike that proves the load-bearing piece: **deploy a minimal CF Worker that forks an artifact, runs `claude -p '/security-review'` in a Sandbox using `CLAUDE_CODE_OAUTH_TOKEN`, and returns the verdict.** Specifically:

1. Run `claude setup-token` locally; store token as Wrangler secret
2. Adapt CF's `examples/claude-code` template — keep the `/sub` route, drop the `/` route
3. Add a `gitCheckout` of a sample repo (this one)
4. Run `claude -p` against the diff with `--system-prompt` from a security-review template
5. Return the JSON verdict

If this works end-to-end in <1 day, the Claude side of the architecture is real. **Pair it with a second Codex spike** to validate the per-(user, repo) Sandbox lifecycle for Codex specifically:

1. Adapt CF's `git-repo-per-sandbox` template — keyed Sandbox ID, persistent across calls
2. Run `codex login --device-auth` interactively in the Sandbox; complete OAuth on local browser
3. Confirm `~/.codex/auth.json` is written and `codex exec '/security-review'` works against subscription
4. Configure `SANDBOX_SLEEP_AFTER=24h+`, idle the Sandbox, wake it next day
5. Confirm `codex exec` still works without re-login (refresh-token survives sleep)

If both spikes pass, the unified cloud-Sandbox architecture is buildable as designed. If `codex login --device-auth` fails for individual Plus/Pro plans (per [Issue #9253](https://github.com/openai/codex/issues/9253)), the fallback is port-forwarded browser flow via Sandbox preview URLs — slightly more complex bootstrap, same end state.

These spikes do NOT touch:

- The orchestrator Workflow (deferred — start with single-reviewer single-call flow)
- Multi-agent fan-out (deferred — start with serial reviewers in one Sandbox)
- Risk-tier triage (deferred — start with always-full)
- Per-tenant config / discovery endpoint (deferred — start with hardcoded test config)

## 7. Artifact

Cloud-roadmap entry **plus** five design docs (already written this turn):

- [`docs/design/cloud-local-disagreement-policy.md`](../design/cloud-local-disagreement-policy.md)
- [`docs/design/multi-agent-pre-push-review.md`](../design/multi-agent-pre-push-review.md)
- [`docs/design/cli-subscription-credential-plumbing.md`](../design/cli-subscription-credential-plumbing.md)
- [`docs/design/cf-sandbox-egress-proxy-pattern.md`](../design/cf-sandbox-egress-proxy-pattern.md)
- [`docs/plans/cloud-mirror-compatibility-changes.md`](../plans/cloud-mirror-compatibility-changes.md)

## 8. Surface

**Primarily guardrails-cloud / agency-cloud** — the multi-agent reviewer, deterministic check mirror, AI Gateway proxy Worker all live in the paid cloud tier (per `three-product-architecture.md`). The free CLI gets a small set of compatibility-preserving changes (per the plan doc above) so the cloud features have plug-in points when they ship.

The pattern reuses are explicitly *not* CLI features — they shape the design of the cloud-side substrate that Interlinked will eventually build.

## Notes

**Marketing-vs-reality flag (per the rubric), AND a self-correction.** The press coverage paraphrasing has a real signal-to-noise problem, but **so did my own first read of it.** Both worth flagging:

*The press coverage's actual misleading claims:*

- "Frontier models in Agent Cloud" reads like agents pay subscription rates. Reading the iMARS post directly showed CF's internal stack still routes via API keys through AI Gateway — no subscription path mentioned in CF's own internal use.
- The OpenAI/Cloudflare announcement page is gated by CF's bot challenge from automated fetchers; the user pasted the actual text, which confirmed the API/enterprise framing rather than subscription-friendly framing — though that doesn't mean subscription paths *don't exist*, just that this announcement isn't what unlocks them.

*My own initial misread (caught and corrected during this investigation):*

- I conflated "no portable Codex token like `claude setup-token`" (TRUE — there is no `codex setup-token` analog) with "therefore Codex can't be subscription-billed in cloud Sandboxes" (FALSE — overgeneralized).
- The corrected reading: Codex CAN run in cloud Sandboxes with subscription billing if you treat the Sandbox as a *long-lived per-(user, repo) compute environment* and have the user log in interactively once via `codex login --device-auth`. The auth.json then persists in the Sandbox FS across all subsequent commits, just like it does on a developer's laptop.
- The "git-repo-per-sandbox" CF template explicitly enables this: same `sandboxId` returns the same Sandbox forever; auth state survives sleep cycles. CF's own `codex-app-server` example uses API keys because it's demonstrating a *multi-tenant app-server* pattern, not a per-developer Sandbox pattern.
- Reading CF's [`examples/codex-app-server/Dockerfile`](https://github.com/cloudflare/sandbox-sdk/tree/main/examples/codex-app-server) once showed me API keys; reading the [`git-repo-per-sandbox` Artifacts example](https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/) the user pointed me to settled the question that the per-developer pattern was always available.

This is *the rubric working*. Reading the source closely enough to see what the per-Sandbox pattern actually allows — not just the headline use case CF chose to demonstrate — exposed the false generalization. The lesson generalizes: "vendor doesn't ship a portable headless token" is a different claim from "vendor doesn't authorize headless subscription auth at all."

**Verbatim Anthropic ToS / authentication quotes** that anchor `cli-subscription-credential-plumbing.md` are in that doc and not duplicated here. They were retrieved during this same investigation.

**Cross-references to specific iMARS-derived patterns** that landed as design decisions:

- Workers AI for high-volume specialized inference (mentioned in iMARS at 91% frontier / 9% Workers AI mix) → drives the classifier-on-Workers-AI plan in `project_classifier_inference.md` (memory)
- AI Gateway as the *single proxy boundary* for all model traffic → drives the third path in `auth.ts` (`cloud-mirror-compatibility-changes.md` item #1)
- Backstage as the structured-org-data substrate → not adopted; we don't have an analog and don't need one for the CLI's scope
- The Cursor/Windsurf coverage in `agent-setup` pages → cross-references the existing `multi-agent-cli-support.md` plan in `docs/plans/`

## Sources (primary)

- [Cloudflare Sandbox SDK + Artifacts (`git-repo-per-sandbox` template)](https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/) — **load-bearing**: the Sandbox-paired-with-Artifacts-repo lifecycle that makes the per-(user, repo) architecture work for both reviewers
- [Cloudflare Expands its Agent Cloud (press release)](https://www.cloudflare.com/press/press-releases/2026/cloudflare-expands-its-agent-cloud-to-power-the-next-generation-of-agents/) — overview of Dynamic Workers, Artifacts, Sandboxes, Think framework, unified model catalog
- [The AI engineering stack we built internally (iMARS post)](https://blog.cloudflare.com/internal-ai-engineering-stack/) — the canonical worked example; covers proxy Worker pattern, MCP Server Portal, AGENTS.md generation, AI Code Reviewer, Engineering Codex
- [Cloudflare Agent Setup — Codex](https://developers.cloudflare.com/agent-setup/codex/) — Codex CLI integration with CF skills + MCP
- [Cloudflare Agent Setup — Claude Code](https://developers.cloudflare.com/agent-setup/claude-code/) — Claude Code integration with CF skills + MCP; the GitHub Action also defaults to API keys
- [Cloudflare Sandbox Tutorial — Claude Code](https://developers.cloudflare.com/sandbox/tutorials/claude-code/) — 5-minute walkthrough of running Claude in a Sandbox
- [OpenAI / Cloudflare Agent Cloud announcement](https://openai.com/index/cloudflare-openai-agent-cloud/) — partnership context (provided as direct text paste, page is gated to bots)

## Sources (secondary, referenced)

- [Cloudflare Sandbox SDK (GitHub)](https://github.com/cloudflare/sandbox-sdk) — repo with all examples
- [Sandbox SDK examples — claude-code](https://github.com/cloudflare/sandbox-sdk/tree/main/examples/claude-code) — both API-key and `CLAUDE_CODE_OAUTH_TOKEN` routes
- [Sandbox SDK examples — codex-app-server](https://github.com/cloudflare/sandbox-sdk/tree/main/examples/codex-app-server) — `OPENAI_API_KEY` via `outboundByHost` egress proxy
- [Sandbox SDK examples — opencode](https://github.com/cloudflare/sandbox-sdk/tree/main/examples/opencode) — provider-agnostic harness alternative
- [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/) — substrate for stateful multi-step agents
- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) — durable orchestration
- [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) — inference proxy with caching, BYOK, ZDR
- [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) — open-weight inference at the edge
- [Cloudflare MCP Server Portal](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/) — multi-tool aggregation behind single OAuth
- [Cloudflare Sandbox SDK GA blog post](https://blog.cloudflare.com/sandbox-ga) — substrate context
- [Cloudflare Dynamic Workflows blog post](https://blog.cloudflare.com/dynamic-workflows/) — Workflow architecture
- [Cloudflare Project Think blog post](https://blog.cloudflare.com/project-think/) — long-running agent context
- [Cloudflare AI Code Review (deeper post)](https://blog.cloudflare.com/ai-code-review) — referenced from iMARS as a follow-up technical deep-dive
- [Cloudflare Enterprise MCP post](https://blog.cloudflare.com/enterprise-mcp/) — MCP governance pattern
- [Cloudflare Code Mode post](https://blog.cloudflare.com/code-mode/) — context aggregation for MCP
- [Cloudflare Workers AI large models post](https://blog.cloudflare.com/workers-ai-large-models/) — Kimi K2.5, security agent that processes 7B tokens/day on Workers AI

## Sources (Anthropic / OpenAI auth, for cross-reference)

- [Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms) — Section 2 (account credentials), Section 3 Clause 7 (automated access)
- [Anthropic Usage Policy](https://www.anthropic.com/legal/aup)
- [Claude Code Authentication](https://code.claude.com/docs/en/authentication) — `claude setup-token` documentation
- [Claude Code Headless](https://code.claude.com/docs/en/headless) — programmatic CLI mode
- [Claude Code GitHub Actions](https://code.claude.com/docs/en/github-actions) — defaults to `ANTHROPIC_API_KEY`
- [Anthropic Claude Code Action repo](https://github.com/anthropics/claude-code-action) — official GitHub Action source
- [OpenAI Codex Authentication](https://developers.openai.com/codex/auth)
- [OpenAI Codex Non-interactive](https://developers.openai.com/codex/noninteractive)
- [GitHub openai/codex repo](https://github.com/openai/codex)
- [GitHub openai/codex Issue #3820 — Headless ChatGPT auth](https://github.com/openai/codex/issues/3820)
- [GitHub openai/codex Issue #9253 — Device code auth gating](https://github.com/openai/codex/issues/9253)

## Sources (third-party context)

- [OpenCode (anomalyco/opencode)](https://opencode.ai/) — provider-agnostic terminal agent CF uses for AI Code Reviewer
- [Cloudflare Brings GPT-5.4 and Codex to Agent Cloud (aiproductivity.ai)](https://aiproductivity.ai/news/cloudflare-openai-agent-cloud-enterprise/) — third-party coverage of the partnership
- [Codex API Key vs Subscription (laozhang.ai)](https://blog.laozhang.ai/en/posts/codex-api-key-vs-subscription) — third-party explainer
- [Codex CLI Authentication: Device-Code Flow with ChatGPT (Instagit)](https://instagit.com/openai/codex/codex-cli-authentication-methods/) — third-party explainer
- [opencode-openai-codex-auth (GitHub plugin)](https://github.com/numman-ali/opencode-openai-codex-auth) — community plugin attempting subscription-style Codex auth in OpenCode; demonstrates the gap is widely felt
