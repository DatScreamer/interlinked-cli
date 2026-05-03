# Cloud-mirror compatibility changes (do these now)

**Status:** Plan / not yet implementation. Pre-work for `cloud-local-disagreement-policy.md`, `multi-agent-pre-push-review.md`, and the broader cloud-mirror architecture.
**Audience:** Engineers picking up CLI work in the months before the cloud-side substrate exists; reviewers approving "small refactors that look like nothing but unlock big things later."

---

## Why this doc

We've designed a substantial set of cloud-side features (deterministic check mirror, multi-agent pre-push review running in per-(user, repo) Cloudflare Sandboxes, AI Gateway proxy Worker for the classifier). The cloud substrate is months of work. But the CLI can — and should — make small compatibility-preserving changes *now* so that when the cloud arrives, we don't have to retrofit credential plumbing, hook installation, or config layering through code that assumed local-only.

These are deliberately narrow refactors. None of them ship a new feature; each one removes a constraint that would later force a wider rewrite. **Each item should be one PR or smaller.**

The corrected architecture (per `cli-subscription-credential-plumbing.md`) is that **both Claude Code and Codex run as reviewers inside per-(user, repo) cloud Sandboxes** with subscription billing — not the heterogeneous cloud/local split previously sketched. Two of the items below have been adjusted to reflect this; one (item #6) has been demoted to "defer until needed."

---

## 1. Add a `proxy_url` config field to `auth.ts`

**Today.** `auth.ts` resolves auth tokens via two paths: CLI's own `access_token` from `config.local.json`, and Claude Code credentials fallback from `~/.claude/.credentials.json`. Both target Anthropic directly.

**Change.** Add a third resolution path: a configured `proxy_url` (e.g., `https://team.example.com/ai-gateway/anthropic`). If set, model requests go to `<proxy_url>/...` instead of `api.anthropic.com/...`, with auth handled by the proxy Worker per `cf-sandbox-egress-proxy-pattern.md`.

**Why now.** This is one config field. Adding it before any classifier or proxied-inference code paths exist means those features can be written against the proxy URL from day one. Without it, every cloud-routing feature has to invent its own base-URL configurability, then we have to consolidate.

This is primarily for the **classifier** (per `policy-classifier.ts`, which today calls Groq directly) and any future Worker-mediated inference. The pre-push reviewers don't use this — they call vendor CLIs directly inside Sandboxes.

**Specifics:**
- New field in `config.local.json`: `proxy_url?: string` (optional, defaults unset = direct path)
- New `resolveInferenceBaseURL()` in `auth.ts` that returns the proxy URL if set, otherwise the vendor's default
- Existing token-resolution code unchanged; `proxy_url` doesn't affect *which* token is sent, just *where* the request goes
- Add a regression test: with `proxy_url` set, the URL passed to fetch goes to the proxy; without, goes to vendor default

**Touchpoints:**
- `src/lib/auth.ts` — add the field and resolver
- `src/lib/config.ts` — extend the schema for `config.local.json`
- `src/harness/policy-classifier.ts` — switch to use `resolveInferenceBaseURL()` instead of hardcoded URLs
- Tests in `src/lib/__tests__/`

**Risk:** Trivially low. Default behavior unchanged when `proxy_url` is unset.

---

## 2. Open up the `agent_source` enum

**Today.** The `agent_source` field in activity events is a fixed set: `claude` | `copilot` | `gemini` | `codex`. This identifies which CLI generated the event.

**Change.** Add `claude-code-cloud-reviewer` and `codex-cloud-reviewer` so events from cloud-side reviewers can identify themselves correctly. Also add `opencode` — even though it's not used in the v1 reviewer cohort, it's a documented fallback option in `cli-subscription-credential-plumbing.md` and is referenced in CF's iMARS pattern.

**Why now.** When the multi-agent reviewer pipeline ships, review-agent activity events will need correct provenance. If the enum is closed, we'll be forced to choose between mislabeling (using `claude` for Claude-as-reviewer events, conflating with the user's primary agent) or doing a migration. Adding the entries now is one line and avoids the migration.

**Specifics:**
- Extend `AgentSource` type in `src/lib/activity-utils.ts` (or wherever it's defined)
- Update validators that whitelist values
- No behavior change today — entries are valid but unused

**Touchpoints:**
- `src/lib/activity-utils.ts`
- Any test that lists the enum members
- `docs/design/three-product-architecture.md` if it references the enum

**Risk:** Trivially low.

---

## 3. Refactor `interlinked verify` into a stage-aware pipeline

**Today.** `interlinked verify` is a single-stage command that runs the full check pipeline. The harness has separate PreToolUse / PostToolUse / pre-commit / pre-push concepts internally, but the verify command itself isn't stage-aware.

**Change.** Introduce a `--stage=<pre-tool|pre-commit|pre-push|all>` flag that selects which subset of the check engine runs. The check engine itself stays unified; what changes is the rule pack scope and severity thresholds applied per stage.

**Why now.** `_phase3-cloud-deferrals.md` already defines per-stage budget rules and which checks belong where. The cloud architecture extends this with per-stage cloud-side dispatching. Both are easier if the local verify command natively supports the stage axis. Without this, cloud orchestration has to either re-implement stage selection or fight against a single-stage local command.

**Specifics:**
- Add `--stage` flag to `verify.ts`, default `all`
- Define a `StagedCheckSet` enum that maps each existing check to a default stage
- `--stage=pre-tool` runs only checks tagged for PreToolUse (fast, narrow)
- `--stage=pre-commit` runs the deterministic check set (tsc, biome, semgrep, structural, etc.)
- `--stage=pre-push` runs the full set including heavy checks (full-project tsc, full-surface tests, etc.)
- `DEFAULT_ADVISORY_SKIPS` becomes stage-aware: a check can be advisory at one stage and gating at another
- Update the regression test that pins `DEFAULT_ADVISORY_SKIPS` to also pin per-stage policy

**Touchpoints:**
- `src/commands/verify.ts`
- `src/harness/check-metadata.ts` (add `default_stage` field to check metadata)
- `src/commands/__tests__/cli-bugs.test.ts` (extend regression test)
- `docs/design/three-product-architecture.md` (cross-reference)
- `docs/plans/free-cli-adoption/_phase3-cloud-deferrals.md` (already implies this; explicit support is the change)

**Risk:** Medium. Touches the verify pipeline. Existing behavior preserved by `--stage=all` being the default. Test coverage required for stage-specific behavior.

---

## 4. Install pre-commit and pre-push git hooks alongside existing client hooks

**Today.** `interlinked enable` installs PreToolUse / PostToolUse hooks for Claude Code, Copilot, Gemini, Codex via `hook-installers.ts`. Git hooks (pre-commit, pre-push) are not installed.

**Change.** Add git pre-commit and pre-push hook installers to the `CLIENT_INSTALL_REGISTRY` pattern. The pre-commit hook calls `interlinked verify --stage=pre-commit`. The pre-push hook calls `interlinked verify --stage=pre-push` and (in the future) the cloud orchestrator that dispatches the multi-agent reviewer.

**Why now.** The lifecycle-tiered gating model from `cloud-local-disagreement-policy.md` and `multi-agent-pre-push-review.md` depends on git hooks. Building that infrastructure now is small — it's the same pattern as the existing per-CLI installers. Without it, the lifecycle architecture has nowhere to plug in.

**Specifics:**
- New `installGitHooks(repoRoot)` in `hook-installers.ts`
- Writes to `.git/hooks/pre-commit` and `.git/hooks/pre-push` (preserving any existing hooks via the same merge pattern used for `.claude/settings.json`)
- The hook script is a self-contained `.mjs` (matching the existing hook pattern) — no imports from the CLI package, must work standalone
- The pre-push hook needs to handle streaming responses from the cloud orchestrator (for the bootstrap-login UX flow described in `multi-agent-pre-push-review.md` §8) — design the hook protocol to support this from day one
- `interlinked enable` calls it; `interlinked disable` removes it
- Conflict detection: if `.git/hooks/pre-commit` exists with non-Interlinked content, prompt or merge per existing pattern
- A `--no-git-hooks` flag on `enable` for users who manage git hooks externally (Husky, lefthook, etc.)

**Touchpoints:**
- `src/lib/hook-installers.ts` — new entry in registry
- `src/lib/hooks.ts` — orchestration changes
- `src/lib/hooks-template.ts` — new git-hook script template
- New tests in `src/lib/__tests__/`

**Risk:** Medium. Touches the user's `.git/` directory; needs careful conflict detection to not break existing setups. Recommend gating behind a conservative default (`--with-git-hooks` opt-in) until the v1 scope settles.

---

## 5. Support remote config URLs in `resolveConfig()`

**Today.** `resolveConfig()` merges `.interlinked/config.json` (committed) and `.interlinked/config.local.json` (gitignored). Both are local files.

**Change.** Add a third tier: a remote config URL (e.g., `https://team.example.com/.well-known/interlinked`) that returns JSON config. The remote config is fetched once at startup, cached locally, and refreshed periodically. This is the foundation for the team-wide config-via-discovery-endpoint pattern from CF's iMARS post.

**Why now.** The discovery-endpoint pattern is a powerful onboarding affordance — teams can have devs run `interlinked auth login https://team.example.com/.well-known/interlinked` and inherit rule packs, classifier config, and review-agent rosters. Without remote config support, every cloud-tier feature has to invent its own config-fetching path.

**Specifics:**
- New field in `config.local.json`: `team_config_url?: string`
- `resolveConfig()` becomes async; fetches the URL if set, merges with file-tier config (file tiers win for conflicts)
- Cached at `.interlinked/team-config.cache.json` with an `expires_at`; refreshed when stale
- Auth handled per `auth.ts` (the URL might require Cloudflare Access JWT or similar)
- Failure mode: if remote fetch fails, fall back to local-only with a warning; never block startup on remote config

**Touchpoints:**
- `src/lib/config.ts` — async resolve, cache layer
- `src/lib/auth.ts` — auth integration for the fetch
- All callers of `resolveConfig()` need to be async-aware (most already are because of token fetches)

**Risk:** Medium. Async config resolution touches many call sites. Phased rollout: ship the cache and fetch first behind a feature flag (`team_config_url` is just unset for everyone), then opt teams in.

---

## 6. (DEFERRED) Credential-export affordance to `auth.ts`

**Status: deferred until needed.** The corrected architecture (`cli-subscription-credential-plumbing.md`) puts both reviewers in cloud Sandboxes, eliminating the primary motivation for shipping local credentials to remote infrastructure.

**Why this was originally proposed.** The previous heterogeneous architecture had Codex reviews running as local subprocesses on the user's machine (because Codex had no portable subscription token). The cloud orchestrator dispatched review specs to the local harness, which spawned `codex exec` against the user's `~/.codex/auth.json`. Sealed credential bundles were the secure handoff primitive for cross-machine credential operations.

**Why it's deferred now.** Codex reviews now run inside the per-(user, repo) Cloudflare Sandbox with the user logging in directly to that Sandbox via `codex login --device-auth`. The credential never transits between machines. Claude's `CLAUDE_CODE_OAUTH_TOKEN` ships from local to cloud once during bootstrap (via Wrangler secret), but that's a one-time operation that doesn't need the bundle primitive — a Wrangler `secret put` covers it.

**When it might come back.** Two scenarios:

1. **Fallback C path becomes important.** If a meaningful number of users can't complete cloud-side Codex bootstrap (workspace-admin gating + no preview-URL access), they'll need the local-subprocess fallback per `cli-subscription-credential-plumbing.md` §7. That path requires the cloud orchestrator to dispatch a review-spec to the local harness — same protocol shape as the original design — and a sealed credential primitive for any credential that would be used in that path.
2. **Cross-Sandbox auth sharing for a single user.** If we want one Codex login to cover all of a user's project Sandboxes (instead of N logins for N projects), we'd need to copy auth.json between Sandboxes — the credential-bundle primitive would be the right primitive for that. ToS-questionable per `cli-subscription-credential-plumbing.md` §5; defer.

**For now, do nothing.** Build the bundle primitive only if we hit one of the scenarios above. The primary architecture doesn't need it.

---

## 7. (NEW) Reserve the `(userId, repoSlug)` Sandbox identity scheme

**Today.** Nothing. The CLI doesn't yet have a concept of a stable identity for a developer-repo pairing.

**Change.** Decide and document the scheme for `sandboxId` derivation. Per CF's [`git-repo-per-sandbox` template](https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/), the orchestrator's `getSandbox(env.Sandbox, sandboxId)` call needs the same `sandboxId` to return the same Sandbox across pushes. We need a stable, collision-free way to derive it.

Proposed scheme: `sandboxId = sha256(`${userId}:${repoCanonicalUrl}`).slice(0, 16)`. Where:

- `userId` is the dev's Cloudflare Access subject claim (or whatever auth identity the orchestrator uses)
- `repoCanonicalUrl` is the repo's canonical git remote URL (e.g., `https://github.com/QuentinCody/interlinked-cli`)
- Hash output truncated to 16 chars for readability and CF's sandbox-id constraints

**Why now.** This identity scheme is what binds together all the cloud-side features: same Sandbox across commits (per-push reviews), same Sandbox holds the Codex auth.json, same Sandbox is paired with the same Artifacts repo. Picking the scheme upstream of any cloud-side code means we can plumb it through CLI features (the local hook needs to compute it; the orchestrator needs to validate it) consistently.

**Specifics:**
- Define `deriveSandboxId(userId, repoUrl): string` as a pure function in a new `src/lib/sandbox-identity.ts`
- `repoCanonicalUrl` derivation: get repo URL from `git remote get-url origin`, normalize (strip `.git` suffix, lowercase host, etc.)
- The CLI computes this when it sends events to the cloud, so the orchestrator can route to the right Sandbox without round-tripping
- Document the scheme in `docs/design/multi-agent-pre-push-review.md`

**Touchpoints:**
- New `src/lib/sandbox-identity.ts`
- Tests for stable derivation across repo-URL variants

**Risk:** Trivially low. It's a pure function with no behavior dependencies.

---

## Order to ship

Recommended sequence, by risk and dependency:

1. **#2 (agent_source enum)** — trivial, do first. Unblocks any future event tagging.
2. **#7 (Sandbox identity scheme)** — also trivial. Pure function, no behavior change. Prerequisite for any cloud orchestrator wiring.
3. **#1 (proxy_url config field)** — small, high-leverage. Unblocks classifier and any Worker-mediated routing.
4. **#3 (verify --stage)** — medium effort, but the cloud orchestration features all depend on it. Worth doing before they ship.
5. **#5 (remote config URL)** — medium effort, async refactor. Less urgent than #3 but unlocks the team-onboarding story.
6. **#4 (git hook installers)** — medium effort. Defer until the multi-agent reviewer pipeline is actually about to ship — pre-push hook is useless without something to run on push.
7. **#6 (credential-export affordance)** — deferred. Build only if Fallback C becomes load-bearing.

Items 1, 2, 3, and 7 are the "do these now" items. Items 4-6 can wait but should be designed-in. Item 6 is deferred indefinitely.

---

## What this plan is NOT

- **Not a feature ship.** Nothing here adds user-visible behavior on its own. These are seams that future features will fit into.
- **Not a cloud rollout.** The cloud Worker, Sandbox orchestration, AI Gateway proxy, and review aggregator are out of scope here. Those depend on a server-side substrate that's a separate workstream (likely lives in the sibling `mcp-agent-chat` repo per project memory).
- **Not a breaking-change spree.** Every item is designed to preserve current behavior when the new field/flag is unset.

## Cross-references

- [`cloud-local-disagreement-policy.md`](../design/cloud-local-disagreement-policy.md) — drives #3 (stage-aware verify)
- [`multi-agent-pre-push-review.md`](../design/multi-agent-pre-push-review.md) — drives #4 (git hooks), #7 (Sandbox identity)
- [`cli-subscription-credential-plumbing.md`](../design/cli-subscription-credential-plumbing.md) — drives #1 (proxy URL), reframes #6 (no longer needed for primary architecture)
- [`cf-sandbox-egress-proxy-pattern.md`](../design/cf-sandbox-egress-proxy-pattern.md) — server-side counterpart to #1
- [`three-product-architecture.md`](../design/three-product-architecture.md) — overall product framing
- [`_phase3-cloud-deferrals.md`](./free-cli-adoption/_phase3-cloud-deferrals.md) — drives #3 (which checks per stage)

## Sources

- [Cloudflare Sandbox SDK + Artifacts (`git-repo-per-sandbox`)](https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/) — the lifecycle pattern that #7 reflects
- [Cloudflare iMARS / Internal AI Engineering Stack](https://blog.cloudflare.com/internal-ai-engineering-stack/) — the discovery-endpoint pattern that #5 is modeled on
- [Cloudflare Sandbox SDK](https://developers.cloudflare.com/sandbox/) — the substrate #1, #4, and #7 ultimately route to
- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) — durable orchestration for the multi-agent reviewer (drives #4)
- [Anthropic Claude Code Authentication — `claude setup-token`](https://code.claude.com/docs/en/authentication) — the bootstrap flow #4 must support for `CLAUDE_CODE_OAUTH_TOKEN` distribution
- [OpenAI Codex Authentication](https://developers.openai.com/codex/auth) — the device-auth flow #4 must support for in-Sandbox interactive bootstrap
