# Cloud-mirror compatibility changes (do these now)

**Status:** Plan / not yet implementation. Pre-work for `cloud-local-disagreement-policy.md`, `multi-agent-pre-push-review.md`, and the broader cloud-mirror architecture.
**Audience:** Engineers picking up CLI work in the months before the cloud-side substrate exists; reviewers approving "small refactors that look like nothing but unlock big things later."

---

## Why this doc

We've designed a substantial set of cloud-side features (deterministic check mirror, multi-agent pre-push review, AI Gateway proxy Worker, subscription-token credential storage). The cloud substrate is months of work and depends on team decisions outside the CLI. But the CLI can — and should — make small compatibility-preserving changes *now* so that when the cloud arrives, we don't have to retrofit credential serialization, hook installation, or config layering through code that assumed local-only.

These are deliberately narrow refactors. None of them ship a new feature; each one removes a constraint that would later force a wider rewrite. **Each item should be one PR or smaller.**

---

## 1. Add a `proxy_url` config field to `auth.ts`

**Today.** `auth.ts` resolves auth tokens via two paths: CLI's own `access_token` from `config.local.json`, and Claude Code credentials fallback from `~/.claude/.credentials.json`. Both target Anthropic directly.

**Change.** Add a third resolution path: a configured `proxy_url` (e.g., `https://team.example.com/ai-gateway/anthropic`). If set, model requests go to `<proxy_url>/...` instead of `api.anthropic.com/...`, with auth handled by the proxy Worker per `cf-sandbox-egress-proxy-pattern.md`.

**Why now.** This is one config field. Adding it before any classifier or reviewer code paths exist means those features can be written against the proxy URL from day one. Without it, every cloud-routing feature has to invent its own base-URL configurability, then we have to consolidate.

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

**Change.** Add `opencode` and a generic `cloud-reviewer` family (`claude-code-cloud-reviewer`, `codex-cloud-reviewer`) so events from cloud-side reviewers can identify themselves correctly.

**Why now.** When the multi-agent reviewer pipeline ships, review-agent activity events will need correct provenance. If the enum is closed, we'll be forced to choose between mislabeling (using `claude` for Claude-as-reviewer events, conflating with the user's primary agent) or doing a migration. Adding the entries now is one line and avoids the migration.

**Specifics:**
- Extend `AgentSource` type in `src/lib/activity-utils.ts` (or wherever it's defined)
- Update validators that whitelist values
- No behavior change today — entries are valid but unused
- Add `opencode` as a first-class entry now even though we don't actively integrate OpenCode yet

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

**Change.** Add git pre-commit and pre-push hook installers to the `CLIENT_INSTALL_REGISTRY` pattern. The pre-commit hook calls `interlinked verify --stage=pre-commit`. The pre-push hook calls `interlinked verify --stage=pre-push` and (in the future) the multi-agent reviewer dispatcher.

**Why now.** The lifecycle-tiered gating model from `cloud-local-disagreement-policy.md` and `multi-agent-pre-push-review.md` depends on git hooks. Building that infrastructure now is small — it's the same pattern as the existing per-CLI installers. Without it, the lifecycle architecture has nowhere to plug in.

**Specifics:**
- New `installGitHooks(repoRoot)` in `hook-installers.ts`
- Writes to `.git/hooks/pre-commit` and `.git/hooks/pre-push` (preserving any existing hooks via the same merge pattern used for `.claude/settings.json`)
- The hook script is a self-contained `.mjs` (matching the existing hook pattern) — no imports from the CLI package, must work standalone
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

## 6. Add a credential-export affordance to `auth.ts`

**Today.** `auth.ts` resolves credentials for the CLI's own use. There's no path to *export* a credential bundle for use by another process or environment.

**Change.** Add `exportCredentialBundle({ scope })` that produces a sealed credential bundle. Initially used for: local subprocess reviewer dispatch (the orchestrator sends a sealed bundle to the harness, which decrypts and uses it for the local subprocess CLI invocation). Later possibly used for: other agent-environment auth handoff, secure provisioning of cloud sandboxes.

**Why now.** The local-subprocess reviewer pattern from `cli-subscription-credential-plumbing.md` needs a clean way for the cloud orchestrator to dispatch a review-spec to the harness, which then runs `claude -p` or `codex exec` locally. Building credential serialization with seal-in-transit semantics now means we don't have to retrofit it later through code that assumed creds-are-local-only.

**Specifics:**
- `exportCredentialBundle(opts: { scope: string, recipient_pubkey: string }): Promise<SealedBundle>` — uses the recipient's public key to seal, can only be opened by the holder of the corresponding private key
- `unsealCredentialBundle(bundle: SealedBundle): Promise<UnsealedCredentials>` — for the harness side
- `SealedBundle` is a typed structure with the cryptographic envelope, never raw credentials
- Implementation uses `node:crypto` with libsodium-style box (or similar standard primitive)
- **Important:** This is *not* shipping creds to a cloud sandbox today. It's the primitive that future flows (local-subprocess dispatch, sealed cloud-token storage) will compose. Keep the surface narrow.

**Touchpoints:**
- New `src/lib/credential-bundle.ts` with the seal/unseal primitives
- Tests for the cryptographic round-trip
- Documentation about scope semantics

**Risk:** Medium. Crypto primitives must be correct. Use a battle-tested library (libsodium / Node's `crypto.box`-equivalent), not roll-your-own. Don't ship until the `multi-agent-pre-push-review.md` flow actually needs this; this entry can be DEFERRED if it turns out the local-subprocess path doesn't need cloud-originated credentials at all.

---

## Order to ship

Recommended sequence, by risk and dependency:

1. **#2 (agent_source enum)** — trivial, do first. Unblocks any future event tagging.
2. **#1 (proxy_url config field)** — small, high-leverage. Unblocks classifier and reviewer routing.
3. **#3 (verify --stage)** — medium effort, but the cloud orchestration features all depend on it. Worth doing before they ship.
4. **#5 (remote config URL)** — medium effort, async refactor. Less urgent than #3 but unlocks the team-onboarding story.
5. **#4 (git hook installers)** — medium effort. Defer until the multi-agent reviewer pipeline is actually about to ship — pre-push hook is useless without something to run on push.
6. **#6 (credential-export affordance)** — defer until needed. May not be needed at all if the local-subprocess pattern can use vendor credentials directly without cloud-originated bundles.

Items 1, 2, and 3 are the hard "do these now" items. The others can wait but should be designed-in (the items above describe the shape so future implementation has a target).

---

## What this plan is NOT

- **Not a feature ship.** Nothing here adds user-visible behavior on its own. These are seams that future features will fit into.
- **Not a cloud rollout.** The cloud Worker, Sandbox orchestration, AI Gateway proxy, and review aggregator are out of scope here. Those depend on a server-side substrate that's a separate workstream (likely lives in the sibling `mcp-agent-chat` repo per project memory).
- **Not a breaking-change spree.** Every item is designed to preserve current behavior when the new field/flag is unset.

## Cross-references

- [`cloud-local-disagreement-policy.md`](../design/cloud-local-disagreement-policy.md) — drives #3 (stage-aware verify)
- [`multi-agent-pre-push-review.md`](../design/multi-agent-pre-push-review.md) — drives #4 (git hooks), #6 (credential export)
- [`cli-subscription-credential-plumbing.md`](../design/cli-subscription-credential-plumbing.md) — drives #1 (proxy URL), #6 (sealed bundles)
- [`cf-sandbox-egress-proxy-pattern.md`](../design/cf-sandbox-egress-proxy-pattern.md) — server-side counterpart to #1
- [`three-product-architecture.md`](../design/three-product-architecture.md) — overall product framing
- [`_phase3-cloud-deferrals.md`](./free-cli-adoption/_phase3-cloud-deferrals.md) — drives #3 (which checks per stage)

## Sources

- [Cloudflare iMARS / Internal AI Engineering Stack](https://blog.cloudflare.com/internal-ai-engineering-stack/) — the discovery-endpoint pattern that #5 is modeled on
- [Cloudflare Sandbox SDK](https://developers.cloudflare.com/sandbox/) — the substrate #1 and #4 ultimately route to
- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) — durable orchestration that the multi-agent reviewer (drives #4) depends on
- [Cloudflare Artifacts (press release)](https://www.cloudflare.com/press/press-releases/2026/cloudflare-expands-its-agent-cloud-to-power-the-next-generation-of-agents/) — Git-compatible storage for cloud-side repo forks
