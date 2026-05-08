# Cloud ↔ local disagreement policy

**Status:** Plan / not yet implementation. Pairs with `three-product-architecture.md` (the three-tier product) and `_phase3-cloud-deferrals.md` (which checks live where).
**Scope:** How verdicts from local deterministic checks combine with verdicts from the cloud mirror (Guardrails / Agent CI) when they disagree, and what gets enforced when they're absent or stale.
**Audience:** Engineers implementing the cloud-mirror feature; reviewers approving any verdict-merging behavior.

---

## TL;DR

Run the same deterministic checks **locally and in the cloud, in parallel, against the same diff**. Most disagreements between the two are infrastructure failures (toolchain drift, artifact lag, cloud unreachable), not genuine differing verdicts. Treat *meaningful* disagreement (same evidence, same toolchain, different verdict) as a P1 bug. For the meaningful cases that remain, the policy is:

- **Most restrictive wins** — block-side wins when both checks have run on identical evidence.
- **Decouple decision from source** — neither cloud nor local is privileged; the verdict that says "block" wins regardless of which side it came from.
- **Sync regime vs async regime** — when both verdicts arrive before the tool executes, max-restrictive applies trivially. When the cloud verdict arrives late, it doesn't retroactively undo the action — it elevates trajectory sensitivity for subsequent steps.
- **Evidence mismatch ≠ disagreement** — if the cloud was running on different toolchain versions or a stale artifact, the result isn't a verdict, it's a parity-violation warning that should be made loud to the user.
- **Escape hatch** — `--bypass-cloud-verdict <reason>` exists, is audited centrally, and is loud enough that it doesn't quietly become routine.

---

## 1. Why we mirror

The local harness already runs deterministic checks in the PreToolUse / PostToolUse / pre-commit / pre-push lifecycle stages defined in `three-product-architecture.md`. The cloud mirror runs **the same check set** against **the same diff** in parallel, for three reasons:

1. **Parity as a testable invariant.** When local and cloud run the same code and disagree, that's a bug. Without the mirror, we have no way to detect drift between the harness and any future cloud-side reimplementation.
2. **Heavy checks the local 30s budget can't afford.** Per `_phase3-cloud-deferrals.md`, structural deep-scan, full prompt-injection, full-surface affected-tests, and full-ruleset semgrep all blow the local budget. The cloud has no 30s ceiling and can run the *full* set.
3. **Shared warm cache across users.** Locally, `.tsbuildinfo` / biome cache / project-graph cache are per-machine. In cloud, an artifact fork from `HEAD~1` already has the incremental tsc state from the last person who edited near these files. Shared cache amortizes cold-start cost across the whole user base.

The point is: the cloud isn't a *different* product from the local CLI. It's the local product, run again, with checks that local can't afford. Same rule pack, same evidence, ideally same verdict — and when not, we want to know.

## 2. What "disagreement" actually means

A naïve framing says "local says allow, cloud says block — what do we do?" But most cases that *look* like disagreement are infrastructure problems, not differing verdicts. Categorizing matters:

| Category | Example | What it is | What policy applies |
|---|---|---|---|
| **A. Cloud ran a check local couldn't afford** | Local skipped semgrep due to 30s budget; cloud ran it and found something | Legitimate cloud-only finding | Most-restrictive-wins ⇒ cloud-block applies |
| **B. Local saw an edit cloud doesn't have yet** | Cloud working from a stale artifact fork | Cloud verdict is on stale evidence | Don't apply cloud verdict; refresh artifact and rerun |
| **C. Toolchain drift** | Cloud has a different tsc/biome version than local; one passes, the other fails | Spurious disagreement; both are "right" for their environment | This is a parity-violation bug; emit loud warning, fall back to local |
| **D. Cloud timeout / unreachable** | Network blip, sandbox cold start | Infrastructure failure, not a verdict | Fail-degraded (see §6) |
| **E. Genuine bug in one rule pack** | Local rule has a regression cloud doesn't, or vice versa | Real disagreement | Block-side wins, but emit a P1 alert so the buggy side gets fixed |
| **F. Both ran the same check on the same evidence with the same toolchain and disagreed** | (Should be vanishingly rare) | True bug | Block-side wins, alert investigator |

**Categories A, E, F** are where "most restrictive wins" applies. **Categories B, C, D** are infrastructure problems and should not be treated as verdicts at all. The implementation must distinguish.

## 3. The parity invariant

For the policy to be meaningful, both sides must run on identical evidence. Concretely:

- **Same artifact** — cloud forks the user's repo at the exact commit the local hook is evaluating. If the user has uncommitted changes, the diff is included in the artifact. No staleness.
- **Same toolchain** — cloud sandbox pins `tsc`, `biome`, `semgrep`, `gitleaks`, etc. to the versions in the user's lockfile. The Sandbox image either reads `package.json` / `package-lock.json` / `bun.lockb` / `pnpm-lock.yaml` and installs matching versions, or refuses to run with a parity-violation warning.
- **Same rule pack version** — `distilled-rules.json` and the harness rule pack are content-addressed; cloud verifies the hash matches local before running.
- **Same OS-relevant behavior** — path normalization, line-ending handling, encoding behavior. Linux-vs-Mac path differences are real and matter for some checks.

When any of these fail to align, the cloud emits `parity-violation: <which-axis-drifted>` and the orchestrator falls back to local-only with that warning surfaced to the user. **That's not "cloud disagreed" — it's "we couldn't compare."**

The `check-pipeline-parity.test.ts` regression test pattern (already in the codebase) is the model for how to enforce this in CI: same evidence, same code, must produce the same output. The cloud just makes that a runtime invariant on every actual run, not just CI.

## 4. Sync regime — both verdicts before tool execution

The PreToolUse hook can hold the response open until both local and cloud return. Per `three-product-architecture.md` budgets:

- **Read-class** (Read, Grep, Glob, Bash-ls, etc.): 300ms total budget — too tight for a cloud round-trip on every call. Run local-only for most read-class. Cloud verdicts for reads land async (see §5).
- **Modify-class** (Edit, Write, Bash with mv/cp/code execution): 800ms total. With pre-warmed sandbox + persistent connection + speculative parallel execution, this fits. Sync gate.
- **Side-effect-class** (Bash with `git push`, `gh pr merge`, `rm -rf`, deploy): 2000ms total. Plenty of room. Sync gate.

Within the sync regime, "most restrictive wins" applies trivially — `Promise.all([local, cloud])` resolves to both verdicts; if either says block, block.

Three pieces of plumbing make modify-class sync gating realistic without horrible latency:

1. **Pre-warming on SessionStart.** When the agent session begins, the harness tells the cloud to fork the repo into an Artifact and spin up a Sandbox. By the time the first modify-class tool call arrives, the environment is hot.
2. **Persistent connection.** HTTP/2 stream or WebSocket between the harness and the cloud Worker. Removes per-call TCP+TLS handshake cost.
3. **Speculative parallel execution.** Fire the cloud request the moment the PreToolUse event arrives, in parallel with local check execution. Total latency = `max(local, cloud)`, not `local + cloud`.

## 5. Async regime — cloud arrives late

For read-class, or when the cloud is just slow, the cloud verdict arrives after the local hook has already responded "allow." The tool has executed; you can't time-travel the action away.

Two reasonable policies, compatible with each other:

**Policy 5a: Warning surface.** A late cloud-block becomes a PostToolUse warning on the next agent turn — `[interlinked:cloud-review] step N issued retroactive block: <reason>`. The agent sees it, the user sees it, but step N already happened. Useful for low-stakes findings.

**Policy 5b: Trajectory sensitivity escalation.** A late cloud-block doesn't undo step N, but it raises session sensitivity for steps N+1 onward. Concretely:

- The session's `sensitivity_level` is bumped one tier (Public → Internal, Internal → Confidential, etc.)
- A pending cloud-block must resolve before the next destructive operation
- The trajectory state machine (`05-trajectory-state-machine.md`) treats the unresolved block as a taint source

This reuses the existing prompt-injection-detection machinery — late cloud-blocks act like injection-detected events, escalating subsequent decisions. The cloud-block doesn't directly stop step N+1, but it makes step N+1's evaluation stricter, which often does stop it indirectly.

**Use both.** Policy 5a is the user-visible artifact ("this got flagged after the fact"); Policy 5b is the safety mechanism that prevents the agent from compounding the issue. Neither alone is sufficient.

## 6. Infrastructure failure — fail-degraded

When the cloud is genuinely unreachable (timeout, 5xx, sandbox boot failure), there's no verdict, just an absence. Three postures:

- **Fail-open** — cloud unavailability silently allows; local-only verdict applies. Preserves dev flow, but accepts a security gap.
- **Fail-closed** — cloud unavailability blocks; dev can't work offline without an explicit `--offline-mode` flag. Strongest security, worst UX.
- **Fail-degraded** — cloud unavailability is treated as "no verdict," local applies, *and* the trajectory's sensitivity is bumped one tier so the next destructive operation gets stricter scrutiny. The user sees `cloud-unavailable` in the statusline so they know they're operating without the second tier.

**Default: fail-degraded.** It preserves dev flow, doesn't pretend the cloud was there, and applies a small safety penalty that compounds if the cloud stays down. Power users can opt into fail-closed via a flag (`--security-mode strict`).

This is consistent with existing harness philosophy in `feedback_safety_continuity.md`: no circuit breakers on safety layers; fail-open is preferable to fail-closed for the *availability* dimension, but the trajectory escalation gives us a soft fail-closed for the *risk* dimension without making the dev wait on Cloudflare.

## 7. The escape hatch

The cloud verdict can be wrong. Bug in a rule, false-positive on a heuristic, model regression. The dev needs an unblock path that doesn't quietly defeat the whole layer.

**`interlinked verify --bypass-cloud-verdict <reason>`** (and the equivalent for `git push`) does three things:

1. Skips applying the most recent cloud verdict for this commit
2. Logs a structured event to the central audit trail (server-side, not just local)
3. Surfaces in the statusline and in any team observability dashboard for the rest of the session

The `<reason>` is required and stored. Empty reasons are rejected. Bypass count over the past N days is a metric the team admin can watch — if a particular cloud rule is being bypassed by 5% of devs with reason "false positive," that rule needs to go on the demote-to-advisory path (per `verify.ts`'s `DEFAULT_ADVISORY_SKIPS` model).

Critically: bypass is per-event, not per-session. A bypass at PreToolUse step 5 doesn't unlock the session for the rest of the run. Each cloud verdict that the user wants to bypass requires its own `--bypass-cloud-verdict` invocation.

## 8. Implementation hooks

Concrete touchpoints in the existing harness (cross-reference, not implementation order):

| Concern | Existing surface | Change needed |
|---|---|---|
| Sync gating in PreToolUse | `evaluatePreToolUse()` in `evaluator.ts` | Add `Promise.all([localPromise, cloudPromise])` with budget-driven timeout per tool class |
| Async cloud verdict arrival | `processEvent()` in `server.ts` | Add `recordCloudVerdict(sessionId, stepNumber, verdict)` that updates trajectory + emits warning on next turn |
| Trajectory escalation | `session-state.ts` | Add `cloud_blocks_pending` counter; rule evaluator already escalates on sensitivity_level changes |
| Parity invariant | `policy-classifier.ts` (closest pattern) | New `cloudMirrorClient.ts` that includes lockfile hash + rule pack hash in every request |
| Audit trail for bypass | `server-bridge.ts` | New event type `bypass-cloud-verdict`, posted to MCP server |
| Statusline integration | `statusline-snapshot.ts` | Add `cloud_unreachable`, `cloud_blocks_pending`, `last_bypass_reason` fields |

## 9. What this is NOT

To prevent scope drift in implementation:

- **Not a circuit breaker.** No "stop calling cloud after N failures" mechanic. Per `feedback_safety_continuity.md`, safety layers fail-open on infra problems but stay alive — they don't get shut down.
- **Not a vote across multiple cloud reviewers.** That's `multi-agent-pre-push-review.md`'s problem. This doc is about the *deterministic* check mirror, not the AI reviewer cohort.
- **Not a confidence-weighted merge.** Verdicts are binary (allow/block). Confidence belongs to the LLM classifier path (`policy-classifier.ts`), which already has its own confidence-threshold model.
- **Not a "cloud is canonical" stance.** Local is the in-process gate; cloud is the parallel mirror. Neither owns the verdict.

## 10. Open questions

- **What's the actual measured cloud round-trip on a warm sandbox + persistent connection?** Speculative parallel execution gives `max(local, cloud)`, but if cloud routinely takes 3s vs local 200ms for modify-class, sync gating is dead in the water and we have to fall back to async-only for everything but side-effect. Needs benchmarking before commit to sync gating broadly.
- **How does the trajectory-escalation policy interact with multi-agent sessions** (a primary agent + worker agents from the cohort)? A late cloud-block in a worker's trajectory should probably escalate the worker's sensitivity but not the lead's. The cohort manager already separates these; verify the escalation paths use cohort scoping.
- **Should bypass be per-rule, not per-event?** "Bypass the whole verdict" is one shape; "bypass rule X for this commit" is another. The latter is more surgical but adds complexity. Defer this until we see real bypass usage.

---

## Sources

The lifecycle stages, latency budgets, and product tiers referenced here come from prior design docs in this repo:

- [`three-product-architecture.md`](./three-product-architecture.md) — defines Free CLI / Guardrails / Agent CI tiers and per-tool-class latency budgets
- [`free-cli-architecture.md`](./free-cli-architecture.md) — the local CLI substrate
- [`_phase3-cloud-deferrals.md`](../plans/free-cli-adoption/_phase3-cloud-deferrals.md) — which checks must move to cloud and why
- `harness-risk-tiers-and-severity.md` (sibling repo: `mcp-agent-chat/docs/design/`) — the risk tier model

External references shaping the design:

- [Cloudflare Internal AI Engineering Stack — iMARS post](https://blog.cloudflare.com/internal-ai-engineering-stack/) — establishes the parity invariant pattern via their Code Reviewer + AI Gateway
- [Cloudflare Sandbox SDK GA](https://blog.cloudflare.com/sandbox-ga) — runtime substrate for the cloud mirror
- [Cloudflare Artifacts](https://www.cloudflare.com/press/press-releases/2026/cloudflare-expands-its-agent-cloud-to-power-the-next-generation-of-agents/) — Git-compatible storage primitive for forked repo state
- [Cloudflare Workflows](https://blog.cloudflare.com/dynamic-workflows/) — durable orchestration for cloud-side check execution

Project memory references that constrain the design:

- `feedback_safety_continuity.md` — no circuit breakers on safety; fail-open over fail-closed
- `feedback_harness_deterministic_only.md` — no LLM inference in the deterministic check pipeline; this disagreement policy applies to deterministic verdicts only
