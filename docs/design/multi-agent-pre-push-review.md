# Multi-agent pre-push review

**Status:** Plan / not yet implementation. Builds on `three-product-architecture.md` (Agent CI tier) and `cloud-local-disagreement-policy.md` (verdict policy).
**Scope:** A pre-push gate that dispatches the diff to multiple AI reviewers — Claude Code, Codex CLI — running as `/security-review` invocations against the diff in **per-(user, repo) Cloudflare Sandboxes**. Risk-tier orchestrator decides which cohort runs. Verdicts merge under unanimous-allow.
**Product surface:** **Agent CI / managed remote tier only.** This doc's hard-gate semantics (unanimous-allow, "any reviewer says block, push is blocked", audited bypass) belong to the managed remote surface — the place where team policy, audit trails, and asymmetric false-block-vs-false-allow reasoning earn their cost. The local Interlinked CLI's git pre-push hook is **warn-only by default** with personal opt-in blocking — see `runtime-pipeline-staging.md` §9.9 for the local-surface contract and `feedback_reluctance_to_push.md` for why local push-gating creates bad pressure. Same reviewer architecture, two different product contracts.
**Audience:** Engineers building the pre-push gate; reviewers approving the orchestrator architecture; product folks evaluating the commercial frame.

**Related.** `runtime-pipeline-staging.md` — this doc's multi-agent fan-out at pre-push is the §9.9 multi-agent debate / synthesis check at Stage 6 in the seven-stage pipeline. Note the product-surface split: §9.9 (Free CLI / local pre-push hook) is warn-only by default; this doc (Agent CI / managed remote) is the canonical hard-gate version.

---

## TL;DR

Before `git push` succeeds, the diff goes through a fan-out of AI reviewers — each running its vendor's `/security-review` (or equivalent) prompt against the diff, returning a structured verdict. Both Claude Code and Codex run as **subprocess invocations inside the developer's per-(user, repo) Cloudflare Sandbox**, with subscription billing preserved for both. The Sandbox is paired one-to-one with the developer's Artifacts repo (the [`git-repo-per-sandbox`](https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/) pattern); commits accumulate in the Artifacts repo, the Sandbox persists across all of them, and auth state survives every push.

Bootstrap is asymmetric — Claude uses a portable `CLAUDE_CODE_OAUTH_TOKEN` (one-time setup on local machine), Codex uses interactive `codex login --device-auth` (one-time setup inside the Sandbox). Steady state is identical: both reviewers run cleanly on every commit with subscription billing.

The orchestrator triages the diff into a risk tier (trivial / lite / full) and dispatches the appropriate cohort. Verdicts merge under "unanimous-allow" — any reviewer says block, push is blocked. Bypass is loud and audited.

---

## 1. Why pre-push, why multi-agent

The lifecycle stages from `three-product-architecture.md` give us escalating gate intensity as code moves toward more permanent state. Pre-push is where heavy review earns its place:

- The user is already paused — `git push` is a deliberate user action with seconds-to-tens-of-seconds tolerance built in
- The blast radius just stepped up — code is about to leave the laptop and reach team / CI / deploy
- The check budget can be 10-60 seconds without UX degradation
- Multi-agent fan-out parallelizes naturally — multiple reviewers concurrent is the same wall-clock as one

Why multiple reviewers, not one:

- **Different vendor models catch different patterns.** Claude finds different security issues than Codex. Federated coverage is more robust than single-model coverage.
- **Diversification of failure modes.** A model regression in one vendor doesn't take out the whole gate.
- **Audit defensibility.** "Multiple independent AI reviewers approved this push" is a stronger claim than "one model said it was fine."

This is the pattern Cloudflare uses internally — their AI Code Reviewer runs OpenCode with a multi-agent review coordinator that dispatches to specialized review agents (code quality, security, codex compliance, documentation, performance, release impact), per the [iMARS post](https://blog.cloudflare.com/internal-ai-engineering-stack/). Our pattern is the same shape, but with the user's vendor CLIs running against their own subscriptions.

## 2. The reviewer surface

Each reviewer is a vendor CLI invoked with a structured prompt against the diff. The CLIs we support:

| Reviewer | Invocation | Notes |
|---|---|---|
| Claude Code | `claude -p '<security-review-prompt>' --output-format json --json-schema <schema>` | Has native `/security-review` slash command (in interactive); programmatic prompt is the same content |
| Codex | `codex exec --sandbox workspace-write --json '<security-review-prompt>'` | Codex's non-interactive mode |

Optional but deferred:

| Reviewer | Why deferred |
|---|---|
| OpenCode | Provider-agnostic, useful for consensus across multiple models, but adds another bootstrap surface and isn't needed for v1 |
| Gemini CLI | Doesn't have an analogous `/security-review` capability worth wrapping today; revisit when one ships |

The contract is: **same prompt, same diff, structured verdict.** Each reviewer gets:

- The unified diff (from `git diff <upstream>..HEAD`)
- The repo's `AGENTS.md` / `CLAUDE.md` for codebase context
- A normalized prompt envelope describing the review task
- A JSON schema for the verdict

The verdict shape:

```json
{
  "verdict": "approve" | "block",
  "confidence": 0.0,
  "findings": [
    { "severity": "critical" | "important" | "suggestion", "file": "path", "line": 0, "message": "...", "category": "security" | "quality" | "..." }
  ],
  "reviewer": "claude-code" | "codex",
  "model": "claude-opus-4-7" | "gpt-5.4" | "...",
  "elapsed_ms": 0
}
```

This is the same shape as the existing harness `[interlinked:<check>]` warning format, just nested inside a reviewer envelope so we can track which reviewer said what.

## 3. Risk-tier triage

Running every reviewer on every push is expensive and noisy. The orchestrator triages the diff into a tier first, then dispatches the right cohort. Same pattern Cloudflare's reviewer uses — classify by risk tier, delegate to the cohort that matches.

| Tier | Diff signature | Cohort |
|---|---|---|
| **Trivial** | Docs-only, README-only, comment-only, formatting-only, dependency lockfile churn | Skip review entirely; emit a "trivial" trace event for audit |
| **Lite** | < 50 LOC changed, single file, no security-sensitive patterns (auth, crypto, network, exec, eval), no new dependencies | Single reviewer (Claude Code with security prompt) |
| **Full** | Larger or touches sensitive surface (auth modules, crypto code, shell-out, network egress, dependencies, migrations, infrastructure) | Both reviewers, parallel |

The signature classifier is deterministic — heuristics over the diff's file paths, file extensions, line counts, and a small allowlist of "always-trivial" path globs. Not an LLM call; the LLM call is the expensive part we're trying to amortize.

The user / team admin can override the triage:

- `interlinked.review.always_full = true` — never short-circuit
- `interlinked.review.skip_trivial = false` — even docs changes go through review
- `interlinked.review.cohort.<tier> = ["claude-code", "codex"]` — pick which reviewers run at which tier

## 4. Verdict aggregation — unanimous-allow

When the cohort returns, the orchestrator merges verdicts under "unanimous-allow":

- All reviewers must return `verdict: "approve"` for the push to proceed
- Any `verdict: "block"` blocks the push
- Reviewers that timeout or error are treated per the §6 fallback policy (not as silent approvals)

The findings are deduplicated across reviewers — if two reviewers flag the same line for the same category, the finding shows up once with both reviewers credited. Severity is the max of any reviewer's claim.

This is symmetric with the deterministic verdict policy from `cloud-local-disagreement-policy.md` ("most restrictive wins"), just extended across multiple agentic reviewers.

**Why unanimous-allow over majority-vote:** Majority-vote means a single bad/regressed reviewer can override two correct ones. Unanimous-allow means a single overcautious reviewer can block, but the bypass mechanism makes that recoverable, while a majority-vote allow lets a real issue through with no recovery. Asymmetric cost: false-block is annoying, false-allow is bad code shipping.

## 5. Cloud-Sandbox execution for both reviewers

Both reviewers run inside the user's per-(user, repo) Cloudflare Sandbox — same Sandbox, same auth state, same lifecycle. See [`cli-subscription-credential-plumbing.md`](./cli-subscription-credential-plumbing.md) for the full credential-plumbing analysis; this section covers what the orchestrator does with that infrastructure.

**Sandbox lifecycle (from CF's [`git-repo-per-sandbox` template](https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/)):**

- One Sandbox per (developer, repository) — `sandboxId = ${userId}-${repoSlug}`
- Same `getSandbox(env.Sandbox, sandboxId)` call always returns the same Sandbox
- Sandbox sleeps when idle (configurable `SANDBOX_SLEEP_AFTER`, set high — hours/days), wakes on demand
- Sandbox FS persists across sleep cycles; auth state, npm caches, and `.git` survive
- The Artifacts repo (paired one-to-one with the Sandbox) accumulates commits over time

**Per-commit review flow inside the persistent Sandbox:**

```bash
# Inside the long-lived (user, repo) Sandbox:
mkdir /tmp/review-${commitSha}
cd /tmp/review-${commitSha}
git fetch artifacts
git checkout ${commitSha}

# Run reviewers in parallel
claude -p '/security-review' --output-format json --json-schema $SCHEMA &
CLAUDE_PID=$!
codex exec --sandbox workspace-write --json '/security-review' &
CODEX_PID=$!
wait $CLAUDE_PID $CODEX_PID

# Capture verdicts, return to orchestrator
cd / && rm -rf /tmp/review-${commitSha}
```

Per-commit workspace isolation lives in `/tmp/review-${commitSha}`. Persistent auth lives in `/root/.claude/.credentials.json` (Claude) and `/root/.codex/auth.json` (Codex), outside the tmpdir. Each review starts with a clean working tree but reuses the auth state.

**Bootstrap (one-time, when (user, repo) Sandbox is first provisioned):**

- **Claude Code:** Worker injects `CLAUDE_CODE_OAUTH_TOKEN` as a Sandbox env var (the token was stored as a per-user Wrangler secret when the dev ran `claude setup-token` on their local machine). `claude -p` reads the env var and authenticates automatically — zero interactive flow needed inside the Sandbox.
- **Codex:** Worker triggers `codex login --device-auth` inside the Sandbox. Codex prints a URL + code; orchestrator surfaces these to the dev's local terminal via streaming response. Dev visits URL, types code, completes OAuth on their browser. `~/.codex/auth.json` lands in the Sandbox FS. Done.

After the bootstrap, both reviewers run on every push with no further interaction.

**If `codex login --device-auth` is gated** for the user's plan (per [Issue #9253](https://github.com/openai/codex/issues/9253), workspace-admin restriction on Team/Enterprise), the fallback is port-forwarded browser flow via Sandbox preview URLs. Same end state, slightly more complex bootstrap. See `cli-subscription-credential-plumbing.md` §3 for details.

## 6. Reviewer failure handling

A reviewer can fail in three ways. Each gets a different policy:

| Failure | Policy |
|---|---|
| Timeout (reviewer didn't return within budget) | Treat as "no verdict"; emit `reviewer_timeout` to audit trail; gate proceeds with verdicts from reviewers that did return; user sees a warning |
| Hard error (subprocess crash, network 5xx, auth failure) | Treat as "no verdict"; same as timeout but log error class for ops |
| Returned malformed verdict (JSON parse failure, missing fields) | Treat as "no verdict"; flag the reviewer for investigation; same fallback as timeout |

**Critical: a missing verdict is NOT an implicit approval.** If only 1 of 2 configured reviewers returns successfully, and that one says approve, the push is gated by a "degraded review" flag. The user can `--bypass-degraded-review <reason>` (audited) to proceed, but the gate doesn't quietly pass.

**Auth-specific failure cases worth calling out:**

- **Codex auth.json expired or revoked.** Refresh token failure surfaces as a `codex exec` exit code. Orchestrator surfaces this to the dev as "Codex auth has expired — please re-run setup for this repo." Dev re-runs the bootstrap login, Sandbox writes a fresh auth.json.
- **`CLAUDE_CODE_OAUTH_TOKEN` expired.** Token is one-year. Orchestrator monitors the per-user secret expiry, warns the dev N days before expiry, prompts for re-running `claude setup-token` to refresh.
- **Sandbox lost.** If the Sandbox itself is gone (CF eviction, manual cleanup), provisioning a new one re-bootstraps both reviewers. Costs the dev one Codex re-login but doesn't otherwise lose state.

The threshold for "enough reviewers for a verdict" is configurable — default is "all configured reviewers must return," strict mode is the same, lenient mode is "at least one reviewer must return and approve." We default to strict because lenient defeats the multi-reviewer point.

## 7. The cloud blueprint — Workflow + Sandbox + Artifacts

The cloud-side execution should be a **Cloudflare Workflow** orchestrating Sandbox + Artifact operations. Reasoning:

- A multi-agent review can take 30-60s; if the orchestrator Worker dies mid-review (deploy, restart, OOM), Workflows give us retry/persistence/checkpointing without restarting from scratch.
- The Artifacts repo is the long-lived per-(user, repo) source of truth for code under review. Each commit pushed to the dev's git remote also lands in the Artifacts repo (via the orchestrator). Per [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/), this is what Artifacts is designed for.
- Both reviewers run *inside the same Sandbox*, in parallel processes; the Workflow awaits both, applies unanimous-allow.

The flow:

```
git push (local hook)
  ↓
local harness → cloud orchestrator (HTTPS, with diff + Cloudflare Access auth)
  ↓
Workflow.start(userId, repoSlug, commitId)
  ↓
step.do("get-or-create-sandbox-pair")    // sandboxId = ${userId}-${repoSlug}, reuse if exists
  ↓
step.do("ensure-bootstrap")               // returns "ready" / "needs-claude-token" / "needs-codex-login"
  ↓ (if not ready) handle bootstrap, return to user; resume Workflow on completion
  ↓
step.do("classify-tier")                  // deterministic risk tiering
step.do("dispatch-reviewers")             // single Sandbox, parallel processes, see below
step.do("aggregate-verdicts")             // unanimous-allow
step.do("write-audit-record")             // commit signed verdict bundle to per-user audit log
  ↓
return verdict to local hook
  ↓
local hook either allows push or blocks with findings
```

Within `dispatch-reviewers`, the orchestrator sends one command to the Sandbox that spawns both reviewers in parallel:

```ts
const { stdout: claudeJson } = sandbox.exec(`
  cd /tmp/review-${commitSha} &&
  (claude -p ${PROMPT} --output-format json --json-schema ${SCHEMA} > /tmp/claude.json) &
  (codex exec --sandbox workspace-write --json ${PROMPT} > /tmp/codex.json) &
  wait
  echo "{\"claude\": $(cat /tmp/claude.json), \"codex\": $(cat /tmp/codex.json)}"
`);
```

(In practice, more careful error handling, exit-code capture per reviewer, timeout enforcement. Sketch above is the shape.)

Every push gets a signed bundle of verdicts attached as audit trail, stored alongside the commit in the per-(user, repo) Artifacts repo. This satisfies the "production-ready audit defensibility" claim.

## 8. The user experience

When a review fails, the dev needs actionable feedback, not a wall of text. The output format is the same as the harness's `[interlinked:<check>]` warning convention:

```
✗ pre-push review BLOCKED by: claude-code (security), codex (quality)

[claude-code/security] CRITICAL: src/lib/auth.ts:142
  Password is logged in plaintext on auth failure path.
  Suggest: replace `console.log(creds)` with `console.log({user: creds.user})`

[codex/quality] IMPORTANT: src/lib/auth.ts:89
  Function `validateCreds` accepts `any`; should be `{user: string, pass: string}`.
  Suggest: add proper TypeScript type.

To proceed: address findings or run `git push --bypass-cloud-review <reason>`.
```

Two paths from here:

- **Happy path:** dev addresses findings, re-runs review against the patched commit, push proceeds
- **Escape hatch:** `git push --bypass-cloud-review <reason>` — same shape as the deterministic-verdict bypass from `cloud-local-disagreement-policy.md`. Audited centrally, surfaced in team observability, persistent enough that it doesn't quietly become routine.

The bypass is intentionally not configurable to be silent. A bypassed review writes a banner into the commit message trailer (or a follow-up comment on the PR) so that anyone reviewing the PR later sees that an AI review was skipped.

**First-time bootstrap UX** is the one place where the experience differs significantly from steady state. When the dev pushes for the first time after enabling Interlinked review for a repo:

```
$ git push
Provisioning review environment for interlinked-cli...
✓ Sandbox created (sandbox-id: qcody-interlinked-cli)
✓ Claude Code authenticated via stored token
○ Codex needs interactive login. Visit:
    https://chatgpt.com/auth/device
  Enter code: ABCD-1234
  Waiting...
✓ Codex authenticated
Running review...
✓ pre-push review APPROVED
```

After this first run, every subsequent push skips the bootstrap entirely and goes directly to "Running review..." — sub-30-second wall clock for typical reviews.

## 9. Cost model

Cost analysis matters because this gate runs on every push.

Per push, assuming full-tier (worst case):

- Triage classifier: 0 (deterministic)
- Sandbox wake from sleep: ~1-3s wall clock, negligible per-push compute cost
- Claude Code review: 10-30s, runs against subscription billing via `CLAUDE_CODE_OAUTH_TOKEN` (free relative to API rates)
- Codex review: 10-30s, runs against subscription billing via persistent `auth.json` (free relative to API rates)
- Reviewers run in parallel inside the Sandbox; wall-clock is `max(claude, codex)` not `claude + codex`

For a single-developer setup with Claude Pro/Max + ChatGPT Plus, the *marginal cost* of a full pre-push review is essentially zero — they're already paying for the subscriptions, and we're using them. **This is the entire point of the unified cloud-Sandbox architecture** — without subscription billing for both, we'd be back to ~$3-8/PR API costs per reviewer, which adds up to hundreds per developer per month for active workloads.

Cloudflare-side costs (Sandbox compute + Artifacts storage) are nominal — sleeping Sandbox + on-demand wake means you're billed for active review time only, ~25 minutes/month for a typical 50-commit cadence.

## 10. Configuration

User-level config (in `.interlinked/config.local.json`):

```json
{
  "review": {
    "enabled": true,
    "reviewers": ["claude-code", "codex"],
    "cohort": {
      "trivial": [],
      "lite": ["claude-code"],
      "full": ["claude-code", "codex"]
    },
    "timeout_ms": 60000,
    "sandbox_idle_sleep_after": "24h"
  }
}
```

Team-level config (in `.interlinked/config.json`, committed):

```json
{
  "review": {
    "always_full": false,
    "min_reviewers": 1,
    "audit_endpoint": "https://team.example.com/api/review-audit"
  }
}
```

Sensible defaults: enable on `git push`, full-tier on changes touching `src/auth/**`, `**/migrations/**`, `**/infrastructure/**`, `package*.json`. Lite tier elsewhere. Trivial tier for `**/*.md`, `**/CHANGELOG`, `**/.gitignore`.

`sandbox_idle_sleep_after` should be set high (hours/days) so the Sandbox doesn't tear down between active dev cycles. CF Sandbox supports configurable sleep windows; setting this conservatively means re-bootstrap (especially the Codex interactive login) is rare.

## 11. What this is NOT

- **Not a replacement for human review.** The gate catches what AI is good at catching (regressions, security smells, magic literals, broken types). It does not replace architectural review or design judgment.
- **Not a replacement for `interlinked verify`.** Verify is the deterministic check pipeline (tsc, biome, semgrep, etc.). This is the AI reviewer pipeline. Both run; both must pass.
- **Not a "build the pre-push hook today" plan.** The Workflow + Sandbox + Artifacts substrate doesn't exist yet. This doc describes the shape, not the immediate next step. See `cloud-mirror-compatibility-changes.md` for what to build now in the CLI to stay compatible with this design.
- **Not the deterministic check mirror.** That's `cloud-local-disagreement-policy.md`. The two systems share infrastructure (cloud orchestrator, Sandboxes, Artifacts) but address different concerns: deterministic mirror = parity verification, pre-push review = AI cohort approval.
- **Not a multi-tenant team-shared review service.** Each developer has their own (user, repo) Sandbox per Section 2 of vendor terms (no shared credentials). Team-shared review would require API-key billing — a v2 design.

## 12. Open questions

- **What does the bootstrap UX look like when the dev's `git push` is happening from CI/automation rather than their local machine?** The "visit URL, type code" Codex flow assumes a human is at the terminal. If pre-push review needs to run from CI (e.g., on behalf of merge-via-bot workflows), interactive login isn't an option. Probably falls back to API key in cloud Sandbox via egress proxy — see `cf-sandbox-egress-proxy-pattern.md`. Acceptable as long as we're explicit about it.
- **Sandbox eviction semantics.** Cloudflare's documentation on max retention for idle Sandboxes is not yet clear. If a Sandbox stays idle for, say, 30 days and gets evicted, the next push triggers re-bootstrap (Codex re-login). UX needs to handle this gracefully. Worth verifying CF's actual eviction policy before committing this in code.
- **Multi-developer workflow.** When dev A pushes to a repo that dev B is reviewing, whose Sandbox runs the review? The author's, by default — they triggered the review action. But if a team policy says "all PRs to main must be reviewed by dev B's review setup," that requires either dev B's Sandbox running on dev A's behalf (forbidden by Section 2 of vendor terms) or a separate orchestration model. Defer until a concrete team-review use case surfaces.
- **What happens during a review if the user's local machine goes offline?** Both reviewers run in the cloud Sandbox; the orchestrator returns a verdict to the local hook. The dev's local machine is involved only at the endpoints (initiating the push, receiving the verdict). If they go offline mid-review, the orchestrator finishes the review and the verdict is queued; the next time the dev's machine reconnects, the verdict is delivered. This is fine but worth confirming the streaming-response protocol survives reconnects.

---

## Sources

This design is derived from:

- [Cloudflare Sandbox SDK + Artifacts (`git-repo-per-sandbox` template)](https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/) — the lifecycle pattern that makes per-(user, repo) Sandboxes work cleanly across many commits
- [Cloudflare Internal AI Engineering Stack — iMARS post](https://blog.cloudflare.com/internal-ai-engineering-stack/) — the multi-agent review coordinator pattern with risk-tier triage
- [Cloudflare AI Code Review post](https://blog.cloudflare.com/ai-code-review) — referenced as a deeper technical follow-up to iMARS
- [Cloudflare Sandbox SDK examples — claude-code](https://github.com/cloudflare/sandbox-sdk/tree/main/examples/claude-code) — first-party blueprint demonstrating both API-key and `CLAUDE_CODE_OAUTH_TOKEN` paths
- [Cloudflare Sandbox SDK examples — codex-app-server](https://github.com/cloudflare/sandbox-sdk/tree/main/examples/codex-app-server) — CF's API-key-via-egress-proxy reference (used as our Fallback B path, not the primary)
- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) — durable orchestration substrate for the pre-push gate
- [Cloudflare Artifacts overview](https://www.cloudflare.com/press/press-releases/2026/cloudflare-expands-its-agent-cloud-to-power-the-next-generation-of-agents/) — Git-compatible storage for repo state
- [Anthropic Claude Code Authentication — `claude setup-token`](https://code.claude.com/docs/en/authentication) — explicit permission for subscription tokens in CI/scripts
- [OpenAI Codex Authentication](https://developers.openai.com/codex/auth) — sign-in methods, including device-code flow for headless environments
- [GitHub Issue #9253 — Codex device-auth gating](https://github.com/openai/codex/issues/9253) — fallback risk for the primary Codex bootstrap

Cross-reference docs in this repo:

- [`three-product-architecture.md`](./three-product-architecture.md) — the Agent CI tier this gate lives in
- [`cloud-local-disagreement-policy.md`](./cloud-local-disagreement-policy.md) — verdict policy this borrows from
- [`cli-subscription-credential-plumbing.md`](./cli-subscription-credential-plumbing.md) — credential plumbing for the Sandbox bootstrap (the load-bearing partner doc)
- [`cf-sandbox-egress-proxy-pattern.md`](./cf-sandbox-egress-proxy-pattern.md) — Fallback B path when subscription bootstrap can't complete
- [`cloud-mirror-compatibility-changes.md`](../plans/cloud-mirror-compatibility-changes.md) — concrete CLI changes to make today
