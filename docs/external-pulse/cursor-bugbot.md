# Cursor Bugbot — June 2026 update (pre-push /review, patch-ID dedup, incremental review)

- **Source:** [Bugbot is now over 3x faster…](https://cursor.com/blog/bugbot-updates-june-2026) (Smale/Volkov/Zhao, 2026-06-10) + [Bugbot docs](https://cursor.com/docs/bugbot) + linked posts [`bugbot-autofix`](https://cursor.com/blog/bugbot-autofix), [`bugbot-learning`](https://cursor.com/blog/bugbot-learning)
- **Encountered:** 2026-06-10 (same-day drop), user pasted the post + INTAKE pointer.
- **Verdict:** compound — **PR** (verify receipts: run-grain "already verified this exact tree" dedup in the Free CLI — the `proof-of-enforcement.md` §3 Policy+Binding slice, with Bugbot's cache-UX wedge), **design annotations** (incremental-review cursor + patch-ID keying into `tier-3-async-deep-review.md` / `multi-agent-pre-push-review.md`), **cloud-roadmap confirmations** (autofix, effort levels, learned-rule synthesis → Agent CI), **skip** (Composer 2.5 training + speed marketing — no surface for us). Third Cursor intake — sibling of `cursor-harness.md` (harness shape) and `cursor-classifier.md` (run-mode classifier).

## 1. Core idea (one sentence, your words)

Cursor's cloud PR reviewer gained a local pre-push entry point (`/review`, which prompts a choice of Bugbot / Security Review agents) whose verdicts are deduplicated against later PR reviews by storing the **patch ID of the reviewed diff**, plus an opt-in incremental mode that reviews only the delta since the last review — making "this exact diff was already reviewed" a first-class, deterministic, cross-surface fact.

## 2. Anatomy (load-bearing claims, your words)

Prose + docs source; anatomy = the claims worth carrying.

1. **Pre-push review entry point.** `/review` (chooser), `/review-bugbot`, `/review-security` run the same cloud review on the working diff before push (Cursor 3.7+ and cursor.com/agents; "CLI support coming soon"). Catch-before-push, not a push gate — opt-in, advisory.
2. **Patch-ID dedup across surfaces.** Docs, verbatim mechanism: running `/review` locally "stores the patch ID of the reviewed diff. When Bugbot on your SCM sees a diff with the same patch ID, it skips the review and leaves a comment noting it already reviewed that diff." Review identity = diff identity; local and CI reviews are fungible. A deterministic mechanism inside an agentic product.
3. **Incremental review.** Default behavior re-reviews the full PR on every push — their own framing admits this re-flags code it already approved. Opt-in dashboard setting reviews "only the changes since the previous Bugbot review" — a review cursor, sold as both focus and cost reduction.
4. **Perf via harness + trained model.** >3× faster, 22% cheaper, +10% bugs/review; 90% of runs <3 min. Attributed to "harness improvements" plus Composer 2.5 now powering Bugbot. Org model block-lists honored, falling back to next-best model.
5. **Surrounding product (from the linked docs/posts).** Reporting = a GitHub check (`success` / `neutral` / `failure`) where findings default to **neutral**; a hard gate exists only via opt-in fail-on-unresolved-issues. Autofix spawns a cloud agent in its own VM, new branch or commit to the PR branch, max 3 attempts to prevent loops; ≥35% of proposed fixes get merged; resolution rate ("% of identified bugs users address before merging") 52% → 76–80% over ~9 months. Learned rules: downvotes / developer replies / human-reviewer comments → candidate rules → promoted to active on accumulated evidence, demoted on negative feedback (44k+ learned rules across 110k+ repos); `@cursor remember [fact]` for manual capture; `.cursor/BUGBOT.md` rule files traversed upward from changed files; precedence Team → repo → project `BUGBOT.md` → user. Effort levels (Default / High / Custom) trade review cost vs thoroughness.

## 3. Deterministic or agentic?

The review itself is agentic and cloud-only (auto-routes to lane 5). The two transferable mechanisms are **deterministic**: patch-ID review identity (a hash lookup) and the incremental cursor (a last-reviewed ref). In the learning loop, signal *collection* (downvotes, replies, dismissals) is deterministic; rule *synthesis* is agentic. **License:** proprietary product, prose+docs intake — pattern-borrow only, nothing importable.

## 3b. Role in its native architecture — and does it transfer?

Natively the dedup receipt is trustworthy because **both surfaces phone the same vendor cloud**: the cloud ran the review, the cloud stored the patch ID, the SCM app asks the cloud — the local client never attests anything. Transplanted into our topology that property splits in two (`proof-of-enforcement.md` §4, [[feedback_local_checks_not_a_trust_boundary]]): a **local** receipt written by the local harness is agent-forgeable, so it may only discharge *local convenience re-runs* (a cache); a receipt that a cloud/CI surface honors must be **cloud-anchored** (R1 sample-and-sign). And per the standing rule, security-class checks are never dischargeable by a local receipt. Native role: server-side cache + UX. Our roles: local = cache; cross-surface = signed receipt.

## 4. Substrate vs. surface

Surface: PR comments, GitHub check, editor slash commands, dashboard analytics. Substrate: (a) a diff-identity store keyed on patch ID, (b) a review cursor, (c) a feedback→candidate-rule promotion pipeline. (a) and (b) are borrowable as ~50-line deterministic mechanisms with no surface attached; (c) is the lane-5 fleet-scale version of what `interlinked recurrence` already does deterministically on one repo.

## 5. Lane

**Lane 4 primary** (review-receipt fungibility, review cursor, receipt-as-cache adoption wedge), **landing as a thin lane-2/3 build** (verify receipts in the CLI). **Lane 5 secondary** — the reviewer, autofix, effort levels, learned-rule synthesis all confirm Agent CI roadmap items we already designed. The model-training and speed-marketing claims are lane 6.

## 6. Dependency & displacement

- **Deps:** none — `git patch-id` / tree hashing + JSONL, all local, zero imports.
- **Displacement:** `check-engine/` memoizes per-check/per-content (finer grain); structure `baseline.ts` + diff-aware filtering suppress at *finding* grain; obligation-discharge (287f42b) closes per-session coverage obligations. None provide run-grain "this exact tree already verified clean — skip" semantics; the receipt sits above all of them and replaces none. (Checked before claiming: the existing "receipt" code — `confirmation-receipts.test.ts`, `cloud-escalation.ts::receipt_id` — is ask-prompt target rendering and unsigned telemetry ids, unrelated.)
- **Equivalence (capability-by-capability):**
  - Pre-push local review entry → **designed**: `tier-3-async-deep-review.md` + `multi-agent-pre-push-review.md`, local surface warn-only per [[feedback_reluctance_to_push]]. Bugbot lands on the same split independently (neutral-by-default check, opt-in fail mode) — convergent validation.
  - Patch-ID dedup / review receipt → **designed, absent in code**: `proof-of-enforcement.md` §3 marks Policy + Binding "❌ in code today" and calls them "a weekend… single-player value immediately." This find supplies the missing adoption wedge: receipt as *cache with a visible skip line* first, attestation second.
  - Incremental review cursor → **shipped at edit grain** (diff-aware filtering), **absent at review-run grain**. Their default-mode failure ("new flags on code it had already reviewed") is the same family as [[project_escalation_amplifies_stable_fp]].
  - Learned rules from review feedback → **shipped (deterministic half)**: `interlinked recurrence` (count/group/propose; `recurrence flag` ≈ `@cursor remember`) + `/enforce` distillation into `.interlinked/distilled-rules.json` ≈ `.cursor/BUGBOT.md` rule files. **Designed (agentic half)**: rule synthesis is Tier 2/3 cloud fodder.
  - Autofix → **different position, stronger locally**: our findings land in-loop at edit time (PostToolUse → the coding agent fixes immediately, pre-commit); PR-time autofix-by-cloud-agent is an Agent CI feature, parked. Their max-3-attempts cap is the same loop-control instinct as repeated-denial stops (`openai-auto-review.md` §2.5).
  - Effort levels → **designed**: the per-edit cost router (local-bounded ∃ vs cloud-exhaustive) in `test-category-adoption-from-the-wild.md`.
  - Model block-list fallback → **shipped substrate**: AI Gateway multi-provider failover (`reference_cloudflare_ai_substrate`).

## 7. Smallest spike

**Verify receipts (≤1 day).** On a clean default-gate `interlinked verify`: append `{schema, tree_id, ruleset_hash, mode, findings: 0, at}` to `.interlinked/verify-receipts.jsonl`. At the start of the next run, recompute the identity; on a hit, print `✓ identical tree verified clean <when> (receipt <id>) — --force re-runs` and exit 0. `tree_id` = HEAD tree hash + digest over porcelain-v2 status + content hashes of dirty/untracked files. `ruleset_hash` = the `proof-of-enforcement.md` §3 Policy hash (v1: CLI version + guard-rules/config/distilled-rules file hashes + pinned tool versions). Carve-out: time-varying checks break "frozen tree ⇒ frozen verdict" (dep-audit advisories move daily) → receipts carry a TTL (~24h) or exclude `dep_audit` from discharge. The receipt doubles as the R0 attestation artifact; diff-grain `git patch-id --stable` keying comes later with Tier 3.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | Verify receipts: run-grain skip-if-identical-tree + §3 Policy/Binding fields, visible "already verified" line | §7 | now |
| Agent CI (P4–5) | Patch-ID-keyed local↔cloud review fungibility (cloud-anchored receipts only); incremental-review cursor recorded per Tier 3 review; autofix with attempt cap; effort levels = the cost router | when Tier 3 builds: share the §7 receipt schema; record last-reviewed tree in the review record | next |

(Guardrails P2–3 row deleted — the sub-second gate operates below review/run grain; a receipt lookup there is premature.)

## 9. Artifact

This intake + the §7 PR. Compound verdict: **adopt** the patch-ID/tree-receipt and review-cursor mechanisms (the deterministic carve-outs); **annotate** the two pre-push design docs rather than opening new RFCs; **confirm** Agent CI roadmap items (autofix, effort levels, rule synthesis) without rebuilding anything; **reject** local receipts discharging anything security-class, or being honored cross-surface without cloud signing; **skip** the model-training and speed claims.

## Notes

- **Dedup-of-work vs dedup-of-disclosure.** When Bugbot skips an already-reviewed diff it leaves only a comment that it already reviewed it — if the findings surfaced privately in the editor, the PR audience never sees them. Our receipts should carry verdict + finding counts, and Tier 3's skip path should re-post findings; otherwise dedup quietly becomes suppression.
- `git patch-id --stable` is the obvious primitive for diff-grain identity: line-number-invariant and stable across rebase/hunk-reorder, so rebase-then-push still discharges. Tree-grain (verify) and diff-grain (review) are two keys of one receipt shape.
- "90% of runs under 3 minutes" is the market-acceptable latency bar for PR-grain cloud review; the `maximal-local-enforcement-roadmap.md` cloud target (~25s wall-clock via fan-out) is comfortably a differentiator, not table stakes.
- **Resolution rate** (52% → 76–80%) is the metric they steer by — % of flagged bugs addressed before merge. It has a deterministic local analog we could compute from the recurrence/activity logs per check id (finding emitted → was the flagged span edited before commit?). Candidate ratchet input; noted, not actioned.
- Their learning loop runs on fleet telemetry from "hundreds of thousands of PRs per day." The scale asymmetry vs single-repo recurrence counting is the real moat gap — and exactly the gap the Agent CI surface exists to close.
