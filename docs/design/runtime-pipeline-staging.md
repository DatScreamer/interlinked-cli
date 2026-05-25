# Runtime Pipeline Staging and Confidence-Based Skip Logic

**Status:** Design / not yet implementation. Synthesis doc — names an organizing artifact (seven-stage pipeline, Stages 0 through 6) and adds two new contributions on top of existing work (per-stage output schema, confidence-accumulation skip logic).

**Audience:** Engineers extending `src/harness/evaluator/`, `src/harness/check-engine/`, and `src/harness/server.ts`. Coding agents picking up implementation work from this spec.

**Supersedes:** Nothing. This doc explicitly composes with what already exists.

**References / composes with:**
- `three-tier-architecture-v2.md` — architectural backbone (free CLI / Guardrails / Agent CI tiers) AND the Stage 4 typed-signal classifier + Cedar adjudication pattern (supersedes `tier-2-llm-policy-gate.md`)
- `pre-post-pipelined-cloud-checks-and-failure-recovery.md` — the Pre → Post cloud pipelining contract, receipts, and pending-completion UX. **The current `HARNESS_PRE_TIMEOUT_MS = 5000` ceiling and 30/50/60s mode-based PostToolUse budgets are sourced from there.**
- `escalation-rules.md` — deterministic synthesis across per-edit findings (Stage 3 → aggregation)
- `cloud-local-disagreement-policy.md` — how local and cloud verdicts combine when both run
- `graph-prediction-protocol.md` — predict-reveal-reconcile against authoritative graph shards
- `tier-3-async-deep-review.md` — Stage 6 prose-policy review at pre-push (auto-invocation) and on-demand via `/review` / `/security-review`; default warn-only with opt-in `block_on_critical` for critical findings
- `stop-event-checks.md` — Tier 1 stop-event checks shipped + Tier 2/3 backlog; design principle that Stop hooks reflect rather than push to ship
- `incremental-posttooluse.md` — incremental check work that informs Stage 3 latency

**What this doc adds over the references above:**
1. **A named seven-stage pipeline (Stages 0 through 6).** The stages exist implicitly across the references; this doc names them and pins what runs where. Stages 0 through 5 are driven by the agent-runtime hook framework (PreToolUse / PostToolUse / Stop / SubagentStop / SessionEnd); Stage 6 is driven by git pre-push, CI, scheduled background jobs, and on-demand commands rather than by agent-runtime hooks.
2. **Per-stage output schema.** Today each check returns `{verdict, findings}`. To support skip logic, stages need to emit `{verdict, confidence_delta, signal_summary}`. This doc specifies the new contract (the full `StageOutput` type is in §5).
3. **Confidence-accumulation skip logic.** A non-blocking cheap check can suppress a more expensive later check when accumulated same-lane positive confidence **meets or exceeds** the later check's skip threshold; negative deltas lower confidence and make later checks more likely to run. (The "meets" half matters: the implementation skips at equality — `confidence_score >= skip_threshold` triggers the skip — to match the `< skip_threshold` "must-run" predicate in the §6 algebra.) This doc specifies the algebra, per-check thresholds, and calibration.
4. **A single latency budget table across all proposed checks**, including the unbuilt ones from the runtime-pipeline conversation (cross-agent prediction, test-outcome prediction, diff-mutation testing at Stop, counterfactual Graph Prediction Protocol, multi-oracle reconciliation, etc.).
5. **A flowchart** showing the gate transitions and parallelism that's currently implicit.

---

## Reconciliation log

This synthesis has been reviewed across fifteen rounds (2026-05-20 / 2026-05-21). The first thirteen rounds resolved entries 1–74 round-by-round; rounds 14 and 15 are surgical cleanup passes folding their findings into one row each (entries 75 and 76) per the user's "stop the per-round commit cycle" directive. Round 15 (entry 76) cleared four residuals left by round 14's Tier-3-to-Post-side propagation. Entries 77 and 78 are internal-consistency passes — not review rounds. Entry 77 fixed three confirmed self-contradictions (four further items raised in the same review were checked against the files and found not live, recorded in the row so the same false alarms aren't re-raised). Entry 78 fixed five cleanup-level terminology / latency / semantics inconsistencies flagged in a pre-handoff review.

> **Normativity — read before using any row below.** This log is **historical**. Each row records what a review round changed *at the time*, and each row's Resolution text is written in the present tense *of that round* — it is not a description of the current design. Where any row conflicts with the numbered design sections §§1–15, **the numbered sections are normative.** Rows are intentionally **not** rewritten when later rounds supersede them: rewriting a historical row to match current design would falsify the record of what each round actually did. The most load-bearing example: every round before entry 75 describes Tier 3 live feedback as a Stage 4-**Pre** spawn with a Pre-minted receipt (see e.g. entries 49, 55, 57, 60, 65, 66, 71–73). That was the design at the time. **Entry 75 (round 14) moved Tier 3 live feedback to Stage 4-Post**; §3 (Stage 4-Pre / Stage 4-Post) and §9.13 carry the current contract. Do not read a pre-75 row in isolation as implementation guidance.

**Current canonical Stage 4 contract** — a reader's-aid summary of §3 Stage 4-Pre / Stage 4-Post and §9.13. Those sections are normative; this box must be updated in lockstep with them if the Stage 4 contract ever changes again:

```text
Stage 4 typed-signal classifier:
  Pre:  preflight → mint receipt → spawn classifier; pipelines with tool execution.
  Post: collect receipt → bounded wait → Cedar evaluation; pending-receipt UX if late.

Stage 4 Tier 3 live feedback:
  Pre:  evaluate periodic eligibility ONLY — no receipt, no redaction, no spawn.
  Post: compose input (pre_event + tool_output + landed_diff + recent_trajectory)
        → preflight → mint receipt → spawn supermodel → bounded wait → render.
        Does not pipeline with tool execution (input needs the landed output).
  T2 fail-open fallback: same-event at Post, terminal-failure-only
        (receipt failed / timeout / complete-with-null-verdict) —
        a bounded-wait overrun is a pending receipt, NOT a fallback trigger.
```

| # | Finding | Resolution | Date |
|---|---|---|---|
| 1 | Stage 4 used stale Tier 2 semantics (verdict-shape) | Rewritten around typed-signal classifier + Cedar adjudication per `three-tier-architecture-v2.md:33-37`; affects §3 Stage 4, §7 latency | 2026-05-20 |
| 2 | Stage 4 ignored the Pre/Post pipelining contract | Split into Stage 4-Pre (spawn) and Stage 4-Post (collect + Cedar eval) per `pre-post-pipelined-cloud-checks-and-failure-recovery.md:42-61`; affects §3, §4 flowchart, §7 latency, §10.4 | 2026-05-20 |
| 3 | Confidence-skip logic was cross-domain | Added evidence lanes (`correctness`, `prediction`, `recurrence`, `prose`, `coordination`); same-lane suppression only per `tier-3-async-deep-review.md:19`; affects §5 schema, §6 algebra / thresholds / deltas / sampling / SkipDecision | 2026-05-20 |
| 4 | §9.4 contradicted Graph Prediction Protocol v1.2 narrowing | Removed §9.4; removed §10.5 failure mode; removed §12 Phase E bullet; added §13a reconciliation note per `graph-prediction-protocol.md:118-129` | 2026-05-20 |
| 5 | Stale implementation handoff paths | Verified against current code; replaced `src/harness/evaluator/post-tool.ts` orchestration claim with `src/harness/server/post-tool-pipeline.ts`; updated §5 current shape, §14 source files, §15 handoff checklist | 2026-05-20 |
| 6 | Latency numbers mixed current / target / transport | Extracted "Hook transport overhead" sub-section above Stage 0; added framing note distinguishing transport / current / target; tagged Stage 3 (current) row from `incremental-posttooluse.md:5`; affects §7 | 2026-05-20 |
| 7 | Cohort-level circuit breaker conflicted with per-layer policy | Replaced with per-check failover; safety-critical fail-classify-conservative, advisory may suppress per check; affects §10.4 per `cloud-local-disagreement-policy.md` §2 / §6 / §9 and `three-tier-architecture-v2.md` §4.6 / §6.3 | 2026-05-20 |
| 8 | Hash-chained audit log conflicted with v2 receipt model | Replaced with per-receipt HMAC + `key_id`; updated `SkipDecision` type and `.interlinked/skip-decisions.jsonl` description; affects §6 skip-receipt format, §10.3 calibration-log poisoning per `three-tier-architecture-v2.md:722` and §6.4 | 2026-05-20 |
| 9 | Diff-mutation rollout's `enforced` mode hard-blocked Stop | Demoted Stage 5 `enforced` to `ack_required` (warning + recorded acknowledgment, never a hard block) per `stop-event-checks.md:5-15` and `feedback_reluctance_to_push.md`; affects §9.6 rollout and §12 Phase E | 2026-05-20 |
| 10 | Tier 3 prose-policy review was placed at Stage 5 / Stop | Relocated to Stage 6 (pre-push auto + on-demand `/review`, `/security-review`, `/ultrareview`; warn-only) per `tier-3-async-deep-review.md:29` and `tier-3-async-deep-review.md:52`; affects §1 references, §3 Stage 5, §3 Stage 6, §4 flowchart, §6 skip-threshold table, §7 latency tables, §9.8, §12 Phase E, §13 out-of-scope, §14 cross-references | 2026-05-20 |
| 11 | Stage 4-Pre visualization order wrong (TL;DR + flowchart implied Post-only) | Restructured TL;DR + §4 flowchart into Pre/Post fork (Stage 4-Pre on Pre branch, fire-and-forget; tool execution; Stage 4-Post on Post branch) per `pre-post-pipelined-cloud-checks-and-failure-recovery.md:42-61` | 2026-05-20 |
| 12 | Stage 4 fail-mode self-contradicted (§3 fail-open vs §10.4 fail-conservative) | Split into local-preflight (fail-conservative) vs remote-classifier (fail-open) per `three-tier-architecture-v2.md` §6.3 (lines 752–766) and §6.4 (lines 838–853); affects §3 Stage 4 invariants and §10.4 mitigation 4 | 2026-05-20 |
| 13 | Stage 4-Post Cedar verbs included `block`/`ask`/`halt_session` (cannot retroactively block) | Scoped Post-side verbs to `warn`/`inject_feedback`/`sensitivity_bump`; `block`/`ask`/`halt_session` reserved for next-call Pre-side evaluation informed by the late verdict; affects §3 Stage 4-Post per `pre-post-pipelined-cloud-checks-and-failure-recovery.md:246` | 2026-05-20 |
| 14 | "Six-stage pipeline" naming contradicted Stage 0–6 reality | Renamed throughout to "seven-stage pipeline (Stages 0 through 6)"; updated §0 status, §1 TL;DR bullets + ASCII diagram + one-line summary, §3 intro heading, §3 Stage 6 status, §4 flowchart, and the cross-doc references in `three-tier-architecture-v2.md:27` and `tier-3-async-deep-review.md:13` | 2026-05-20 |
| 15 | Stage 6 hook ambiguity (presented as both hook-driven and "never in hook") | Disambiguated "hook" everywhere: bare "hook" = agent-runtime hook (PreToolUse/PostToolUse/Stop/SubagentStop/SessionEnd); Stage 6 fires from the **git** pre-push hook, CI, scheduled jobs, on-demand commands. Updated §3 Stage 6, §4 flowchart arrow, §4 gate-logic 5→6 row, §1 TL;DR ASCII Stage 6 arrow | 2026-05-20 |
| 16 | Cross-agent prediction agreement assigned to inconsistent lanes (prediction vs coordination) | Moved to coordination lane consistently: §5 Lane definition (prediction → coordination), §5 SignalSummary (prediction sub-record → coordination sub-record); §6 delta table was already correct. Rationale: lane reflects property measured (multi-agent consistency), not subsystem that produces the signal | 2026-05-20 |
| 17 | Stage 4-Post Cedar verb list included `sensitivity_bump` (not in Cedar schema) | Scoped Post-side Cedar emissions to `warn` and `inject_feedback` only (the two canonical `@action_on_violation` values from `interlinked-cedar-extensions.cedarschema:103-145` that are actionable post-execution); moved `sensitivity_bump` to a new typed `side_effects?: SideEffect[]` field on `StageOutput`; added §5 `SideEffect` discriminated union (`sensitivity_bump` / `additional_context_injected` / `trajectory_annotation`); updated §4 flowchart Stage 4-Post box | 2026-05-20 |
| 18 | §13 out-of-scope still pointed Tier 2 implementers at superseded `tier-2-llm-policy-gate.md` | Updated to point at `three-tier-architecture-v2.md` (v2 spec — typed-signal classifier + Cedar adjudication) with v1 explicitly marked historical; consistent with §1 references that already supersede v1 | 2026-05-20 |
| 19 | Optimistic-parallelism license too broad ("Stages 0–3 can optimistically parallel" implied Stage 3 could run in PreToolUse) | Removed the original "Stages 0–3 can optimistically parallel" bullet from §4 parallelism rules; replaced with per-hook-surface scoping: PreToolUse branch (Stages 0/1/2 + Stage 4-Pre fire-and-forget), PostToolUse branch (Stages 3 + 4-Post), cross-branch speculation forbidden per Stage 3 PostToolUse-only contract in §3 | 2026-05-20 |
| 20 | Skip-logic intro inverted polarity ("negative evidence crosses threshold") | Corrected to match §6 algebra: "accumulated same-lane positive confidence exceeds the later check's skip threshold; negative deltas lower confidence and make later checks more likely to run"; affects §1 bullet 3 | 2026-05-20 |
| 21 | New `Tier3ReviewOutput` shape added for Stage 6 (separate consumer from `StageOutput`) | Added new §5a "Stage 6 output (separate consumer)" sketching `Tier3ReviewOutput` (range_sha, scope, model, findings, prose_policy_artifacts_consulted, duration_ms, push_proceeded: true); canonical shape lives in `tier-3-async-deep-review.md` §7. `StageOutput.stage` stays as `0 \| 1 \| 2 \| 3 \| 4 \| 5` with an explicit comment block explaining Stage 6 exclusion | 2026-05-20 |
| 22 | `Tier3ReviewOutput.push_proceeded: true` literal type couldn't represent the opt-in block path | Widened to `push_proceeded: boolean` + optional `block_reason?: string`; the only path to `false` is the opt-in `block_on_critical: true` setting in `.interlinked/config.local.json` per `tier-3-async-deep-review.md:341` AND at least one finding at severity `critical`; affects §5a | 2026-05-20 |
| 23 | Multi-agent synthesis at Stage 5 / Stop contradicted canonical pre-push design | Relocated §9.9 from Stage 5 to Stage 6 per `multi-agent-pre-push-review.md:1-7` (canonical design is a pre-push gate, not a Stop check); affects §3 Stage 5/6 What-runs lists, §4 flowchart Stage 5/6 boxes, §6 skip-threshold table (Stage 5 row removed; Stage 6 is not in the skip-logic algebra), §7 Stage 5/6 latency tables, §9.9 rename + Surface/Trigger/warn-only-contract rewrite, §12 Phase E renumber adding new bullet 8 for §9.9 | 2026-05-20 |
| 24 | Stage 4-Post parallelism wording understated the Stage 3 data dependency | Refined §4 to split Stage 4-Post into receipt-wait phase (can overlap Stage 3 execution; both fire on PostToolUse) and Cedar-evaluation/merge phase (requires Stage 3 output as input per §3 Stage 4-Post Cedar evaluation bullet); receipt-wait cancellable on Stage 3 block-tier finding | 2026-05-20 |
| 25 | `StageOutput` scope to Stage 0–5 wasn't propagated to TL;DR / Phase A handoff prose | Updated §1 TL;DR "Each stage emits" → "Each Stage 0–5 emits" with note that Stage 6 emits `Tier3ReviewOutput` per §5a; same change to §12 Phase A bullet 2 and §15 handoff checklist bullet 2 | 2026-05-20 |
| 26 | Stale six-stage / tier-2-llm-policy-gate references in sibling design docs | Updated `pre-post-pipelined-cloud-checks-and-failure-recovery.md:12` ("six-stage" → "seven-stage" with Stage 4-Pre/4-Post call-out); updated `tier-3-async-deep-review.md:5-8` companion references from superseded `tier-2-llm-policy-gate.md` to canonical `three-tier-architecture-v2.md` (with v1 marked historical) | 2026-05-20 |
| 27 | `StageOutput.verdict` schema lied about Cedar action (literal type didn't include `null` or Cedar verbs, but the side-effects comment said verdict "holds the Cedar @action_on_violation value") | Split into two named types: `HarnessGateDecision` ("allow"/"ask"/"block"/"defer"/"skipped") and `CedarAction` ("warn"/"block"/"ask"/"inject_feedback"/"halt_session"); `verdict: HarnessGateDecision \| null`; added `cedar_action?: CedarAction` field on `StageOutput`. The two answer different questions (what the harness did vs what Cedar said should happen). Updated §3 Stage 4-Post Cedar bullet to reference the new fields. Picked option (a) — separate fields, no overloading | 2026-05-20 |
| 28 | Multi-agent pre-push contract self-contradiction (warn-only in §9.9 vs unanimous-allow hard gate in canonical `multi-agent-pre-push-review.md`) | Resolved via two-product-surface split (option c): **Free CLI / local git pre-push hook (Stage 6, §9.9)** is default warn-only with personal opt-in `block_on_critical`; **Agent CI / managed remote (`multi-agent-pre-push-review.md`)** is the canonical hard-gate with unanimous-allow / audited bypass / team policy. Same reviewer architecture, two product contracts. Added explicit "Product surface" declaration to `multi-agent-pre-push-review.md` top; rewrote §9.9 with explicit Product surface split section; updated `multi-agent-pre-push-review.md:7` backlink | 2026-05-20 |
| 29 | Stale Stage 5 references to multi-agent synthesis after round-4 relocation to Stage 6 | Removed multi-agent synthesis from §4 parallelism "Within Stage 5" bullet, §7 end-to-end Stop row, `stop-event-checks.md:5` backlink. (`multi-agent-pre-push-review.md:7` backlink already updated in row 28) | 2026-05-20 |
| 30 | Tier 3 "never blocks" prose self-contradicted "opt-in `block_on_critical` may block" elsewhere in the same paragraph | Reframed §9.8 line 945 and `tier-3-async-deep-review.md:70` + `:75` to "Default warn-only; opt-in `block_on_critical` may block on critical findings"; no longer asserts "never blocks" then carves out an exception | 2026-05-20 |
| 31 | §8 "Surfacing Stage 3 findings when an earlier stage already blocked" implied cross-branch optimistic parallelism (Stage 3 alongside a Pre-side Stage 0/1/2 block) | Scoped the rule to PostToolUse only: PreToolUse Stage 0/1/2 blocks don't have a Stage 3 alongside them (Stage 3 hasn't fired yet), so the surfacing question doesn't arise; PostToolUse blocks may have Stage 3 running same-branch optimistically per §4 parallelism | 2026-05-20 |
| 32 | §6 sampling prose said "Stage 5 checks run anyway" but defaults table covered Stage 4 too | Rephrased to "Stage 4 and Stage 5 checks run anyway with probability `P_sample` (defaults below — 0.02 for Stage 4, 0.05 for Stage 5)" | 2026-05-20 |
| 33 | `three-tier-architecture-v2.md:89` said 105 built-in guard rules; staging doc and generated docs say 110 | Updated v2 doc count to 110 (matches `docs/generated/guard-rules.md:4`) | 2026-05-20 |
| 34 | `cedar_action` comments said "only Stage 4-Post produces" but §3 prose acknowledges Stage 4-Pre Cedar evaluation can emit `block` / `ask` / `halt_session` | Updated both the `CedarAction` type comment and the `cedar_action` field comment to say Stage 4-Pre AND Stage 4-Post both produce, with distinct verb sets (Pre may emit any of the five; Post is scoped to `warn` / `inject_feedback` because Post-side cannot retroactively block) | 2026-05-20 |
| 35 | Multiple Tier 3 absolute-statement residuals (`never blocks push` / `push always proceeds` / `NEVER blocks push`) contradicted the opt-in `block_on_critical` carve-out | Reworded §1:15 reference, §3:242 Stage 6 Tier 3 bullet, §7:887 latency end-to-end table, §13:1149 out-of-scope entry, and `tier-3-async-deep-review.md:333` to use "default warn-only; opt-in `block_on_critical` may block critical findings" framing throughout | 2026-05-20 |
| 36 | Implementation handoff in Phase A wired aggregation into `post-tool-pipeline.ts` only, but Stages 0–5 fire across three surfaces (PreToolUse / PostToolUse / Stop) with separate orchestrators (`runPreToolPipeline`, `runPostToolPipeline`, `lifecycle-events.ts`) | Introduced a shared stage-aggregator at `src/harness/check-engine/stage-aggregator.ts` as the single per-tool-call output path, called from all three surfaces. Updated §14 source-file references to clarify each pipeline's scope (Pre: Stages 0/1/2 + Stage 4-Pre; Post: Stages 0/1/2/3 + Stage 4-Post; lifecycle-events: Stage 5). Added `lifecycle-events.ts` entry to source files | 2026-05-20 |
| 37 | Skip-threshold equality semantics inconsistent: prose said confidence "exceeds" threshold (strict `>`), code skips at equality (runs only when `score < threshold`) | Unified on the code's semantics: prose now says "meets or exceeds" for skip; §1 TL;DR algebra rewritten as `confidence_score < skip_threshold` (the must-run predicate); §6 sampling intro updated to `>=` (the would-otherwise-skip condition) | 2026-05-20 |
| 38 | Reconciliation log header said "the eight findings below were resolved" but the table now has 33+ rows across five reconciliation cycles | Rewrote header to "33 findings below have been resolved (originally 8 first-round; subsequent rounds added entries 9–39 spanning six review cycles)"; clarifies the multi-round history | 2026-05-20 |
| 39 | `docs/external-pulse/qmd.md:76` artifact line said "Adds pointers from..." but `rg qmd docs/design docs/external-pulse` showed no actual cross-links existed | Reworded artifact line to "Should add pointers from..." with an explicit note that the cross-links are not yet in place; matches the actual state until the pointers land | 2026-05-20 |
| 40 | Tier 3 blocking semantics still inconsistent across `three-tier-architecture-v2.md:641, 645` (absolute "Never blocks push" / "never blocks, never halts") AND staging `§1153` ("no `enforced` promotion path" was too absolute given the opt-in path exists) | Unified phrasing everywhere: "default warn-only; local opt-in `block_on_critical`; Agent CI hard gate is a separate surface." Updated 2 lines in `three-tier-architecture-v2.md` §5.1 / §5.2 and §12 Phase E close-out paragraph in staging | 2026-05-20 |
| 41 | Output contract called Stage 0–5 a "per-tool-call" aggregator, but Stage 5 fires on Stop / SubagentStop / SessionEnd — agent-runtime events, not tool calls | Renamed to "per-event stage aggregator" throughout (keyed on PreToolUse / PostToolUse for Stages 0–4; Stop / SubagentStop / SessionEnd for Stage 5); affects §1 TL;DR (line 115), §5 StageOutput comment block (line 472), §5a §6 reference (line 594), §12 Phase A bullet 2 (line 1123), §15 handoff bullet (line 1306) | 2026-05-20 |
| 42 | §5a "Stage 6 output" header was misleading — the type was only `Tier3ReviewOutput` but Stage 6 also includes multi-agent debate / synthesis (§9.9) which has its own output shape owned by `multi-agent-pre-push-review.md` | Renamed §5a to "Tier 3 output (separate consumer)"; added intro paragraph explicitly noting multi-agent synthesis has its own output shape owned by the canonical doc; both share the `.interlinked/reviews/` artifact store but are not the same type | 2026-05-20 |
| 43 | Scanner roadmap (CodeQL / OSV-Scanner / OWASP Dependency-Check / Trivy) wasn't represented; prior discussions implied a separate adapter family rather than wedging into Stage 5 | Added new §12 **Phase G — External scanner adapters (deferred; scope TBD)** after Phase F; placed at Stage 6 surface, scoped as per-scanner adapters with their own output schemas, and sequenced after Tier 3 + multi-agent + Phase F. Marked as needing its own memo before implementation | 2026-05-20 |
| 44 | §15 handoff still called the shared aggregator a "single per-tool-call output path" — inconsistent with the §1 / §5 "per-event stage aggregator" rename that covers Stage 5 lifecycle events | Renamed §15 phrasing to "single per-event stage-output path" so the aggregator naming is consistent end-to-end | 2026-05-20 |
| 45 | §1 TL;DR and §12 Phase A bullet 2 implied Stage 6 emits only `Tier3ReviewOutput`, but §5a notes Tier 3 is one of multiple shapes and §12 Phase G adds scanner adapters with separate per-scanner schemas | Reworded both spots to "Stage 6 emits dedicated outputs such as `Tier3ReviewOutput` per §5a, the multi-agent synthesis output owned by `multi-agent-pre-push-review.md`, and the per-scanner adapter outputs proposed in §12 Phase G" | 2026-05-20 |
| 46 | §3 Stage 6 "What runs" list omitted scanner adapters even though Phase G adds them at the Stage 6 surface | Added deferred bullet "External scanner adapters (deferred — see §12 Phase G) — CodeQL / OSV-Scanner / OWASP Dependency-Check / Trivy, each with its own output schema" to the Stage 6 What-runs list so the stage taxonomy stays aligned with the phase plan | 2026-05-20 |
| 47 | §14 cross-references entry for `tier-3-async-deep-review.md` still said "warn-only" without the settled contract phrasing | Updated to "default warn-only with opt-in `block_on_critical`; Agent CI hard gate as separate surface" matching the canonical phrasing established in rec log row 40 | 2026-05-20 |
| 48 | `three-tier-architecture-v2.md:630` still said Tier 3 "warn-only, never blocks" in the live-feedback "what it does NOT do by default" list, while nearby text allows local opt-in blocking and Agent CI hard gates | Reworded to "does not block by default; local opt-in `block_on_critical` may block critical findings; Agent CI hard gate (per `multi-agent-pre-push-review.md`) is a separate surface" so the absolute phrasing no longer contradicts the canonical contract | 2026-05-20 |
| 49 | Tier 3 live feedback channel (`three-tier-architecture-v2.md` §5.1 Surface 1) had no stage placement in the synthesis doc — Stage 6 was mapped to pre-push only, and the rollout phases only covered Tier 3 pre-push | Mapped Tier 3 live feedback into Stage 4-Post as a parallel cloud-feedback channel (alongside the typed-signal classifier at the same PostToolUse surface but with different invocation policy and prose output shape). Added a new bullet to §3 Stage 4-Post "What runs", a §6 skip-threshold row at Stage 4 (prose lane, 0.55), a §7 latency row in the Stage 4-Post sub-table, and a full §9.13 implementation hook with rollout sequencing after the typed-signal classifier infrastructure | 2026-05-20 |
| 50 | §5a said `Tier3ReviewOutput` was "one of two output shapes" but Phase G adds scanner adapters and rec log row 45 added multi-agent → three families | Reworded to "one of several Stage 6 output families" and named all three explicitly: Tier 3 prose review (§5a), multi-agent synthesis (§9.9 / `multi-agent-pre-push-review.md`), external scanner adapter outputs (§12 Phase G) | 2026-05-20 |
| 51 | §15 handoff checklist mentioned `Tier3ReviewOutput` and multi-agent synthesis as Stage 6 outputs but omitted scanner adapter outputs (which §12 Phase G adds) — would have implementors routing scanner results into the wrong shape | Added scanner adapter outputs to the §15 Stage 6 list: "Tier3ReviewOutput per §5a, the multi-agent synthesis output owned by multi-agent-pre-push-review.md, and the per-scanner adapter outputs deferred to §12 Phase G" | 2026-05-20 |
| 52 | §7 Stage 6 latency table omitted scanner adapters even though §3 Stage 6 "What runs" list and §12 Phase G both add them | Added "External scanner adapters (CodeQL / OSV-Scanner / OWASP Dependency-Check / Trivy) | TBD per §12 Phase G memo | TBD" row to the Stage 6 latency table so taxonomy, phases, and latency framing stay aligned | 2026-05-20 |
| 53 | `tier-3-async-deep-review.md:231` and `:248` showed only default warn-only example output text, while elsewhere the doc allows opt-in `block_on_critical` — the examples didn't match the schema's `push_proceeded: boolean` | Updated both example bodies: §7.1 report `## Did this review affect the push?` now says "No (default warn-only mode)" with an inline note describing the opt-in `block_on_critical` variant that would read "Yes (blocked by opt-in...)" instead. §7.2 stderr footer now says "Push proceeding (default warn-only)" with a description of the opt-in variant's "Push BLOCKED: ..." output | 2026-05-20 |
| 54 | Stage 4 invariant "every Stage 4 LM call returns typed EvidenceSignal" contradicted §9.13 Tier 3 live feedback (which emits prose findings, not EvidenceSignal) | Narrowed the invariant to "typed-signal subchannel" only; added explicit note that Tier 3 live feedback is the one Stage 4 LM call that emits `LiveFeedbackOutput` instead, and that the `block_on_critical` opt-in synthesizes a typed `EvidenceSignal` (`T3LiveCriticalFinding`) so even the live-feedback path ultimately feeds Cedar through a typed-evidence bridge | 2026-05-20 |
| 55 | Live-feedback latency was contradictory: §7 table claimed 10–80ms total for Stage 4-Post but listed the supermodel call at 3–15s synchronously | Resolved via receipt/pending path (same pattern as typed-signal classifier): the supermodel call is async, overlaps tool execution off-process via an independent receipt minted at Stage 4-Pre, collected at Stage 4-Post with a bounded wait. Restructured §7 table to separate on-process work (10–80ms typed-signal happy path) from off-process cloud wall-clock (3–15s) from at-Post collect (5–50ms + bounded wait) | 2026-05-20 |
| 56 | The opt-in `block_on_critical` path for live feedback wasn't mechanically specified — said "may escalate into Cedar block" but didn't define the typed schema or the prose-to-Cedar mapping | Defined `LiveFeedbackFinding` (category + severity + message + source_event_id + cited_locations) and `LiveFeedbackOutput` (receipt_id + findings + rendered_text + duration_ms) in §9.13. Specified the T3-finding-to-Cedar-evidence mapping: when `block_on_critical: true` AND any finding has `severity: "critical"`, the harness synthesizes a typed `EvidenceSignal` of label `T3LiveCriticalFinding` (carrying severity bucket + finding count + receipt_id reference + highest-severity category) and threads it into the session trajectory for the next PreToolUse Cedar evaluation | 2026-05-20 |
| 57 | Stage 4-Post gate was classifier-receipt-specific but now Stage 4-Post also owns live feedback | Updated §3 Stage 4-Post gate to read "either the typed-signal classifier `receipt_id` OR the Tier 3 live-feedback `receipt_id` is recoverable". The two receipts are minted independently at Stage 4-Pre (different invocation policies) and collected independently at Stage 4-Post; either may be present without the other. If neither exists, Stage 4-Post degrades to a local-only verdict; if only one exists, the other is treated as `not invoked` rather than `failed`. §3 Latency bullet also updated to mention both receipt reads and the sync-barrier framing | 2026-05-20 |
| 58 | §9.x numbering was out of order — §9.13 (added in round 9) appeared between §9.8 and §9.9 instead of after §9.12 | Moved §9.13 to its correct position after §9.12, immediately before §10 "Failure modes". Numerical order restored: §9.1, §9.2, §9.3, §9.5, §9.6, §9.7, §9.8, §9.9, §9.10, §9.11, §9.12, §9.13 | 2026-05-20 |
| 59 | §12 Phase E rollout list omitted §9.13 — the typed-signal classifier infrastructure was implied but Tier 3 live feedback (the second Stage 4-Post check) had no rollout slot | Added new Phase E bullet 7 for §9.13 between "Remaining Stage 5 checks" and "Tier 3 prose-policy review at pre-push" — sequenced after the typed-signal classifier infrastructure stabilizes and before pre-push Tier 3, so the Tier 3 implementation track lands in dependency order. Renumbered subsequent bullets (8 = pre-push prose review, 9 = multi-agent debate) | 2026-05-20 |
| 60 | Stage 4-Pre "What runs" list documented only typed-signal classifier work; live-feedback receipt mint / selective spawn / output threading had no entry even though §9.13 and Stage 4-Post both depend on Pre-side spawning the live-feedback receipt | Rewrote Stage 4-Pre "What runs": "Receipt minting" → "Receipt minting (per channel)" minting up to two independent receipts; renamed classifier-spawn bullets to "typed-signal" prefix; added new "Tier 3 live feedback selective spawn (§9.13)" bullet covering selective-trigger evaluation + receipt mint + async spawn; updated "Pre-filter for Cedar" to mention synthesized `T3LiveCriticalFinding` signals from prior live-feedback critical findings; updated "Output to PostToolUse" to mention up to two receipt_ids | 2026-05-20 |
| 61 | Stage 4 invariant block said "Both halves share the following invariants" but the "Two classifier shapes" invariant applied only to the typed-signal subchannel (live-feedback emits `LiveFeedbackOutput`, not `ClassifierResult`) | Updated the invariant intro to "Most of these invariants apply to both subchannels; two are tagged 'typed-signal subchannel only'" and added the explicit tag to "Two classifier shapes" with a sentence noting Tier 3 live feedback has its own discriminated-finding schema (`LiveFeedbackFinding[]`) per §9.13 | 2026-05-20 |
| 62 | Live-feedback output was logged to `.interlinked/classifier-log/<session-id>.jsonl` alongside classifier output, but live feedback is not a classifier result (different shape, different schema) — muddied the audit-log contract | Split live feedback to its own log: `.interlinked/live-feedback-log/<session-id>.jsonl`. Both channels share session granularity and the audit-key model but not the log file, since they produce different output shapes (`ClassifierResult` vs `LiveFeedbackOutput`). Updated §3 Stage 4-Post parallel-channel bullet and §9.13 Delivery bullet to reflect the split | 2026-05-20 |
| 63 | `tier-3-async-deep-review.md:13` said "Tier 3 corresponds to **Stage 6**" without disambiguating the two Tier 3 surfaces — now misleading since the live-feedback surface (Surface 1) is at Stage 4-Post per `runtime-pipeline-staging.md` §9.13 | Clarified that this memo covers only the pre-push Tier 3 surface (Surface 2 per v2 §5.1) mapped to Stage 6, and explicitly added a sentence pointing readers to `runtime-pipeline-staging.md` §9.13 for the Surface 1 live-feedback channel at Stage 4-Post | 2026-05-20 |
| 64 | Pending-receipt UX wording was classifier-specific ("when the cloud classifier has not returned") even though live-feedback receipts can also be pending; the latency-table footer had the same blind spot | Updated §3 Stage 4-Post "Pending-receipt UX" bullet to be channel-aware: `[interlinked:cloud-classifier]` vs `[interlinked:tier3-live]` prefixed one-liners, one per still-pending channel; updated §7 latency-table footer to mirror the channel-aware framing (per-channel auto-fetch on the next PostToolUse turn) | 2026-05-20 |
| 65 | §1 TL;DR and §4 flowchart still framed Stage 4 as classifier-only ("Classifier spawn" / "Classifier collect") even after the live-feedback subchannel was added — the diagrams contradicted the §3 contract that now mints two independent receipts | Rewrote both ASCII diagrams: TL;DR Stage 4-Pre/Post boxes now show "Cloud spawn(s)" / "Cloud collect(s)" wording with both subchannels (typed-signal classifier + Tier 3 live feedback per v2 §5.4 selective policy) and both independent receipts; §4 flowchart Stage 4-Pre box now lists "Typed-signal classifier spawn ... receipt minted" + "Tier 3 live-feedback spawn (selective per v2 §5.4) ... independent live-feedback receipt minted"; §4 Stage 4-Post box reads "Cloud collect(s) + Cedar eval" reading both receipts independently | 2026-05-20 |
| 66 | §7 Stage 4-Pre latency table undercounted the live-feedback path — only budgeted classifier work, while Stage 4-Post already had live-feedback rows (added in round 10); the pre/post latency model was asymmetric | Added Stage 4-Pre rows for: live-feedback selective-trigger evaluation (~0.1–1ms), second live-feedback receipt mint (1–5ms when v2 §5.4 fires), live-feedback supermodel spawn (1–3ms when fires), live-feedback supermodel wall-clock (3–15s Sonnet / 8–25s Opus off-process). Updated total to "Total Stage 4-Pre on-process (worst case: both channels fire) 10–60ms / 230ms" and renamed the section to "Cloud spawn(s)" mirroring the diagram update | 2026-05-20 |
| 67 | §3 Stage 4 invariant "Remote classifier failure" and §10.4 "Remote classifier infrastructure failure" rows still said "classifier-only" language even though most invariants apply to both subchannels — the failure rows hadn't propagated the live-feedback addition | Updated both failure rows to "Remote cloud-call failure — fail-open (applies to BOTH subchannels)" framing, with explicit subchannel-id tagging in policy-misses log (`typed_signal` vs `tier3_live`). Added explicit note that per-channel SLOs and budgets are tracked independently — a typed-signal outage does not suppress live-feedback and vice versa. Local preflight failure (shared infrastructure) suppresses both subchannels in lockstep when it fires | 2026-05-20 |
| 68 | §14 source-file inventory described pre/post-tool-pipeline as classifier-only and omitted §9.13's proposed modules (`tier3-live-feedback.ts`, `cloud/supermodel.ts`, `tier3-evidence-bridge.ts`) and the distinct `live-feedback-log/` artifact path | Updated `pre-tool-pipeline.ts` and `post-tool-pipeline.ts` descriptions to mention both Stage 4 subchannels (typed-signal classifier + Tier 3 live feedback per v2 §5.4). Added the three §9.13 proposed module entries plus the per-channel audit-log paths (`.interlinked/classifier-log/` for classifier output, `.interlinked/live-feedback-log/` for live-feedback output), each tagged "proposed, Phase E bullet 7" so they're clearly future work | 2026-05-20 |
| 69 | Reconciliation log header still said "entries 9-39 spanning six review cycles" even though the table now runs through entry 69 across twelve rounds | Updated header to "twelve rounds in 2026-05-20" with entry range "9 through 69 across eleven additional review cycles" and a pointer to `git log -- docs/design/runtime-pipeline-staging.md` for the per-round commit history (which records each round as its own commit) | 2026-05-20 |
| 70 | Stage 4 cloud-failure semantics conflicted with `cloud-local-disagreement-policy.md` §6 — runtime says null verdict + empty `confidence_delta` (no caution signal) per §10.4, but the policy doc said cloud unreachable defaults to fail-degraded with automatic sensitivity bump per §6 | Narrowed `cloud-local-disagreement-policy.md` scope: added explicit `(do not apply to Stage 4 language-model channels)` paragraph at §6, scope statement at the doc header, and a `Related` clarification — fail-degraded covers the deterministic cloud-mirror layer (same rule pack run in both places), not Stage 4's typed-signal classifier or Tier 3 live-feedback supermodel. Added reciprocal "Scoping note" to runtime §10.4 pointing back, making the boundary readable from either direction | 2026-05-20 |
| 71 | `StageOutput` could not represent the two-receipt Stage 4 shape — `stage: 0 \| 1 \| ... \| 5` had no Stage 4-Pre / Stage 4-Post discriminator, and `receipt_id?: string` was singular even though Stage 4-Pre may mint two independent receipts (typed-signal classifier + Tier 3 live feedback) per §3 | Added `substage?: "pre" \| "post"` discriminator populated when `stage === 4`; replaced singular `receipt_id?: string` with `receipts?: Partial<Record<Stage4Subchannel, string>>` per-channel map keyed on `"typed_signal" \| "tier3_live"`; added `Stage4Subchannel` type alias above `StageOutput`. Aggregator consumers MUST now dispatch on `(stage, substage)` for Stage 4 events; the receipt map cleanly expresses both-present / one-present / neither-present states | 2026-05-20 |
| 72 | Live-feedback default invocation policy disagreed across docs — `three-tier-architecture-v2.md` §5.4 line 672 said `every commit + every 50 tool calls + on T2 fail-open`, but `runtime-pipeline-staging.md` §3 Stage 4-Pre and §9.13 Trigger both omitted the `+ on T2 fail-open` triplet. The dropped third trigger is the highest-value one — it's the fallback when typed-signal cannot classify | Added `+ on T2 fail-open` to runtime's default-policy wording in both §3 Stage 4-Pre and §9.13 Trigger, with the implementation mechanic: a `tier3_eligible_next_event: true` session-state flag is set at Stage 4-Post when a `typed_signal` collection returns `failed` / `timeout` / `null verdict`, consumed (and cleared) by the next event's Stage 4-Pre decision. Cross-linked into §10.4's fail-open rule so the trigger mechanic is explained in both places (Trigger + Failure rule) | 2026-05-20 |
| 73 | Stage 4 overview surfaces still described a single classifier path — TL;DR diagram's "cloud classifier in flight" label, gate transitions table's "classifier spawn is fire-and-forget" wording, and parallelism rule's "The classifier call is spawned" framing all hadn't propagated the two-channel addition | Rewrote three sites: (a) TL;DR diagram's tool-execution-time label now reads "cloud channels in flight (typed-signal classifier + Tier 3 live feedback, both off-process)"; (b) `2 → 4-Pre` and `3 → 4-Post` rows in gate-transitions table now describe up to two spawns at Pre + per-channel receipt collection at Post with explicit "no receipt → local-only verdict" and "one receipt → that channel only" wording; (c) parallelism rule now describes per-channel budget controls + per-channel caches + per-channel bounded wait at Post | 2026-05-20 |
| 74 | `three-tier-architecture-v2.md:27` runtime-staging backlink said Tier 3 corresponds to Stage 6 only, but v2 §5.1 has been Tier-3-Surface-1 (live feedback at Stage 4-Post) + Tier-3-Surface-2 (pre-push at Stage 6) since round 9 of the synthesis reconciliation | Rewrote the backlink to enumerate both surfaces: Surface 1 (live feedback) at Stage 4-Post, Surface 2 (pre-push) at Stage 6. Preserved the "Stage 5 was an earlier draft placement" history but scoped it to Surface 2 only (Surface 1 was never at Stage 5; it landed at Stage 4-Post in round 9) | 2026-05-20 |
| 75 | **Round 14 surgical cleanup — folded five findings into one pass.** F1 (high, design): Tier 3 live feedback was framed as Stage 4-Pre spawn using a Pre-side redacted form, but §9.13 said it reviews tool-call output — output doesn't exist at Pre. The "on T2 fail-open" trigger also set a next-event flag, so the fallback would have reviewed the wrong event. F2 (medium): T3 in the §6 skip table consumed prose-lane confidence as a single check, so periodic prose-lane saturation could suppress the T2-fail-open fallback whose purpose is classifier-availability coverage. F3 (medium): `three-tier-architecture-v2.md:1229` implementation-sequence step said only `every commit + every 50 tool calls` while §5.4 line 672 said `+ on T2 fail-open`. F4 (medium): runtime §10.4 line 1232 and §13 line 1313 still imported `cloud-local-disagreement-policy.md` Category D / Stage 3-vs-Stage 4 framing even though round 13 had narrowed that doc to the deterministic cloud-mirror layer. F5 (low): the Pre/Post pipelining companion doc still described one cloud check / one receipt without naming itself as the primitive | **F1 resolved** by moving Tier 3 live-feedback genuinely Post-side: Stage 4-Pre evaluates periodic-trigger eligibility only (no spawn, no receipt, no preflight); Stage 4-Post composes the supermodel input from `pre_event + tool_output + landed_diff + recent_trajectory`, runs its own preflight, mints the receipt, spawns the supermodel, and collects with a per-channel bounded wait. The "on T2 fail-open" trigger now fires same-event from Stage 4-Post when typed-signal collection produces no usable verdict (not a next-event flag). Updated §3 invariants, §3 Stage 4-Pre, §3 Stage 4-Post, §4 flowchart, §1 TL;DR diagram, gate-transitions table, parallelism rule, §5 receipts comment, §7 latency tables, §9.13, §10.4 step 4, §14 source-file inventory. Removed the `tier3_eligible_next_event` cross-event flag; new flag is `tier3_live_eligible_for_this_event` set at Pre and consumed same-event at Post. **F2 resolved** by splitting the §6 skip-table row into two: "T3 live feedback supermodel (periodic)" (prose lane, threshold 0.55, skippable) and "T3 live feedback supermodel (T2 fail-open fallback)" (unskippable). **F3 resolved** by aligning v2:1229 with v2:672 — added `+ on T2 fail-open (same-event fallback...)` and a cross-link to runtime §9.13. **F4 resolved** by rewording runtime §10.4 step 2 from "This is Category D from cloud-local-disagreement-policy.md" to "analogous to Category D" + explicit scope statement that Stage 4 LM-channel failures are governed by §10.4 not by the disagreement-policy doc; rewrote §13 cloud-local entry to explicitly state the disagreement-policy doc covers the deterministic cloud-mirror layer only. **F5 resolved** by adding a one-paragraph "Scope: this doc is the single-receipt primitive" note at the top of `pre-post-pipelined-cloud-checks-and-failure-recovery.md` pointing readers to `runtime-pipeline-staging.md` §3 / §9.13 for the per-channel composition rules | 2026-05-20 |
| 76 | **Round 15 surgical cleanup — four residuals from round 14's Tier-3-to-Post propagation.** F1 (medium): the T2-fail-open fallback in §9.13 said it fires on `failed` / `timeout` / `null verdict`, but §3 Stage 4-Post and the companion primitive treat "still running past the bounded wait" as a *pending receipt* (next-turn auto-fetch), not a failure — leaving it ambiguous whether a local bounded-wait overrun counts as "no usable T2 verdict" and triggers same-event T3. F2 (medium/low): §10.4's local-preflight-failure bullet still said the conservative path "lives entirely in Stage 4-Pre" and aborts "the classifier call", contradicting the round-14 per-channel split (typed-signal preflight at Pre, live-feedback preflight at Post). F3 (low): the `Stage4Subchannel` type comment still said Stage 4-Pre may mint the `tier3_live` receipt. F4 (low): the §14 cross-reference list still described `cloud-local-disagreement-policy.md` as "local-vs-cloud verdict merging", broad enough to reopen the Stage 4 LM-channel confusion round 13/14 closed | **F1 resolved**: §9.13 now defines the fallback trigger as *terminal failure only* — receipt `cloud.status` of `failed` / `timeout`, or `complete` with a null/unusable verdict — and explicitly states a bounded-wait overrun (`running` / `pending` at expiry) is a *late, not lost* verdict that stays on the pending-receipt path; a late-fetched verdict that later resolves to failure is logged for SLO tracking but does not retroactively spawn a stale-event T3. **F2 resolved**: §10.4 local-preflight bullet rewritten to the per-channel model — preflight runs once per cloud call at the stage that issues it (typed-signal at Pre, live-feedback at Post), a preflight failure aborts only that channel, and the hook-return-unaffected note now covers both PreToolUse (typed-signal) and PostToolUse (live-feedback). **F3 resolved**: `Stage4Subchannel` comment rewritten — `typed_signal` minted at Pre, `tier3_live` minted at Post. **F4 resolved**: §14 cross-reference reworded to "deterministic cloud-mirror verdict merging" with an explicit "does not govern Stage 4 LM channels — see §13" tail | 2026-05-21 |
| 77 | **Final pre-commit internal-consistency pass — three confirmed self-contradictions.** Item 1: §3 declares Stage 1/2 `Surface: PreToolUse and PostToolUse` and Stage 0 `Surface: PreToolUse`, but the §1 TL;DR and §4 flowchart drew Stages 0–2 as a single shared prelude, and §14/§15 said `runPostToolPipeline` runs "Stages 0/1/2/3" — claiming Stage 0 (instant disqualifiers, which gate an action) re-runs at Post where the action has already executed. Item 2: the Stage 4-Post gate said "degrade to a local-only verdict" but no section defined the term. Item 6: §15 implementation checklist hard-coded "the existing 765 tests should all still pass" — stale (the feat commit immediately below the doc commits reports 7838 passing). | Item 1: corrected §14 and §15 to `Stages 1/2/3` for `runPostToolPipeline` (Stage 0 is PreToolUse-only); added a diagram note under the §1 TL;DR and an expanded fork annotation in the §4 flowchart stating Stages 0–2 are drawn once but Stage 0 is PreToolUse-only and Stages 1–2 re-run on the Post branch. Item 2: added a definition at the §3 Stage 4-Post gate — a local-only verdict is the `StageOutput` built from Stage 0–3 deterministic evidence alone (Cedar still evaluates, minus cloud `EvidenceSignal`; empty `receipts`). Item 6: replaced the hard-coded count with "the existing suite" + an instruction to run `npx vitest run` for the live number. **Four further items checked and found not live:** (3) `CedarAction` not encoding Pre/Post verb scoping is a type looser than a prose usage-constraint, documented adjacent — not a contradiction; (4) "analogous to Category D" — verified `cloud-local-disagreement-policy.md:42` still carries the Category D row in §2 with the exact class label §10.4 cites; round 13 narrowed only §6's remedy, and round 14's F4 already disclaimed it; (5) bounded-wait vs terminal-failure — already defined by entry 76 F1, §3 and §9.13 verified consistent; (7) reconciliation-log header — math checks (1–74 / 13 rounds, 75–76 / rounds 14–15), the old-text quotes at entries 38 and 69 are correct historical records, not drift. | 2026-05-21 |
| 78 | **Pre-handoff cleanup pass — five terminology / latency / semantics inconsistencies.** Item 1: the §"What this doc adds" bullet said stages emit `{verdict, confidence_delta, signal}` while §5 `StageOutput` and the §1 TL;DR use `signal_summary` — an implementer following the bullet would create the wrong field name. Item 2: §2 said the 5s `HARNESS_PRE_TIMEOUT_MS` covers PreToolUse "Stages 0–2 only", but Stage 4-Pre (receipt mint + fire-and-forget classifier spawn) also runs synchronously in the PreToolUse window. Item 3: §3 stage-heading latencies disagreed with the §7 budget table — Stage 0 heading `0–5ms` vs §7 `~5–25ms / 80ms`; Stage 1 heading `5–100ms` vs §7 `70–400ms / 1.5s`; Stage 2 heading `100ms–2s` vs §7 `150–700ms / ~2.1s`. Item 4: the §7 Stage 4-Post table's "cloud still running" cell said Cedar is "n/a — no Cedar verdict", contradicting §3's local-only-verdict definition where Cedar still evaluates deterministic evidence. Item 5: Stages 1–2 run on both surfaces and their Gate lines say "BLOCK", but BLOCK cannot mean the same thing at Post (tool already ran) as at Pre. | Item 1: bullet corrected to `{verdict, confidence_delta, signal_summary}` + pointer to §5. Item 2: §2 reworded — the budget covers Stages 0–2 plus the small Stage 4-Pre receipt/spawn step; cloud wall-clock is explicitly off-process. Item 3: §3 Stage 0/1/2 latency headings rewritten to restate the §7 totals verbatim, each with a "§7 is canonical" pointer. Item 4: the §7 cell rewritten — "Cedar evaluates the deterministic-only context (Stage 0–3 evidence); no cloud-derived `EvidenceSignal` yet, so the verdict is provisional and pending-receipt UX fires." Item 5: added a "BLOCK semantics by surface" preamble to §3 — PreToolUse BLOCK prevents the call; PostToolUse BLOCK returns a blocking/error result requiring next-turn remediation and cannot undo the executed tool (the same rule §3 Stage 4-Post states for late cloud verdicts). | 2026-05-21 |

---

## 1. TL;DR

Seven stages (Stages 0 through 6), gate-pattern, short-circuit downward. Stages 0 through 5 are evaluated inside agent-runtime hooks (PreToolUse / PostToolUse / Stop); Stage 6 is evaluated outside the agent-runtime hook surface (git pre-push, CI, scheduled jobs, on-demand commands):

```
[Tool call / edit / Bash command]
       │
       ▼
Stage 0 — Instant disqualifiers (0–5ms, sequential)
       │ pass
       ▼
Stage 1 — Fast local deterministic (5–100ms, parallel)
       │ pass
       ▼
Stage 2 — Light local with disk/parse (100ms–2s, parallel)
       │ pass
       ▼
┌─────────── PreToolUse branch ──────────┐   ┌─────────── PostToolUse branch ──────────┐
│ Stage 4-Pre — Typed-signal spawn       │   │ Stage 3 — Local expensive deterministic │
│   (~ms local; one fire-and-forget      │   │   (1–15s, parallel; PostToolUse only)   │
│   typed-signal classifier receipt      │   │   │ aggregated findings                 │
│   minted when in-scope; Tier 3 live    │   │   ▼                                     │
│   feedback eligibility evaluated and   │   │                                         │
│   forwarded to Post, NOT spawned here) │   │ Stage 4-Post — Typed-signal collect +   │
│   │ Pre returns                        │   │   Tier 3 mint/spawn/collect + Cedar     │
└────┼───────────────────────────────────┘   │   evaluation                            │
     │                                       │   (bounded wait on in-flight typed-     │
     ▼                                       │   signal classifier; mint+spawn+wait    │
[Tool executes] ─────────────────────────────►  for Tier 3 live-feedback supermodel    │
   typed-signal classifier in flight         │   on landed tool output; Cedar over     │
   off-process                               │   EvidenceSignal set incl. synthesized  │
                                             │   T3LiveCriticalFinding per §9.13;      │
                                             │   verdicts at Post-side modify          │
                                             │   trajectory + surface as additional_   │
                                             │   context; cannot retroactively block)  │
                                             │   │                                     │
                                             │   ▼ (Stop event only)                   │
                                             │ Stage 5 — Stop deep gates               │
                                             │   (1–10 min, Claude Code / Codex only)  │
                                             └─────────────────────────────────────────┘
       │
       ▼ (push / CI / scheduled, never in agent-runtime hook; Stage 6 is driven by git pre-push, CI, scheduled jobs, and on-demand commands)
Stage 6 — Truly async
```

*Diagram note: Stages 0–2 are drawn once as a shared prelude for readability. Per §3 they do not all share one surface — Stage 0 (instant disqualifiers) fires on PreToolUse only, while Stages 1 and 2 fire on **both** PreToolUse and PostToolUse and therefore re-run on the PostToolUse branch before Stage 3.*

Each Stage 0–5 emits `{verdict, confidence_delta, signal_summary, findings}` consumed by the per-event stage aggregator — keyed on agent-runtime events (PreToolUse / PostToolUse for Stages 0–4; Stop / SubagentStop / SessionEnd for Stage 5). (Stage 6 is intentionally outside the per-event aggregator — it emits dedicated outputs such as `Tier3ReviewOutput` per §5a, the multi-agent synthesis output owned by `multi-agent-pre-push-review.md` (§9.9), and the per-scanner adapter outputs proposed in §12 Phase G — all consumed by the pre-push reviewer and `.interlinked/reviews/` filesystem store rather than by this aggregator.) A later stage's trigger condition is `triggers_met(check) AND (confidence_score < skip_threshold(check))` — i.e., the check runs only while confidence is strictly below threshold; at or above threshold, the check skips (subject to random sampling per §6). Skip decisions are auditable to the agent and the user.

---

## 2. Why this matters

Without explicit staging:
- Running every proposed check on every tool call blows the portable 30s PostToolUse budget. The proposed set (cross-agent prediction + test-outcome prediction + counterfactual Graph Prediction Protocol + Tier 2 cloud + mutation testing + multi-agent synthesis + ...) is at minimum 90s sequential if all fire.
- Cheap checks that succeed produce no signal that would prevent expensive checks from firing. The deep gates run on every Stop event regardless of session health, becoming noise.
- The current implicit gating is encoded in scattered conditionals in `src/harness/evaluator/post-tool.ts` and `src/harness/server.ts`. A new check needs to find the right place to insert; getting it wrong means it always runs or never runs.

With explicit staging:
- The portable 30s budget is achievable because most calls exit at Stage 1 or 2.
- The expensive checks only fire when cheap signals don't already settle the matter.
- New checks register against a named stage with a declared trigger condition; the registration is the integration.
- The 5s `HARNESS_PRE_TIMEOUT_MS` becomes a deliberate budget for the synchronous PreToolUse work — Stages 0–2 plus the small Stage 4-Pre receipt-mint and fire-and-forget classifier spawn — rather than a load-bearing accident. The cloud classifier's wall-clock runs off-process and is explicitly outside this PreToolUse wait.

---

## 3. The seven stages (Stages 0 through 6)

**BLOCK semantics by surface — read before the per-stage Gate lines.** Stages 1 and 2 fire on both PreToolUse and PostToolUse, so "BLOCK" in their Gate lines means different things depending on surface. **On PreToolUse, a BLOCK prevents the tool call from executing.** **On PostToolUse, the tool has already run** — a BLOCK there cannot undo it; it means the harness returns a blocking / error result to the agent runtime, surfaced as `additional_context` (or stderr fallback), requiring the agent to remediate on its next turn. This is the same "cannot retroactively block" rule §3 Stage 4-Post spells out for late cloud verdicts, applied to the deterministic Stages 1–2 on the Post surface. Stage 0 is PreToolUse-only, so its BLOCK is unambiguously the prevent-the-call form; Stage 3 is PostToolUse-only, so its hard-failure errors are always the remediate-next-turn form.

### Stage 0 — Instant disqualifiers
- **Latency:** ~5–25ms typical, 80ms worst case — sequential. (Per-check work only; see the §7 Stage 0 table for the breakdown. §7 is the canonical latency budget; these stage headings restate its totals.)
- **Surface:** PreToolUse
- **Gate:** Any block fires → BLOCK return, no further stages run
- **What runs:**
  - Dangerous command patterns (`rm -rf /`, force-push main, `DROP TABLE`, etc.) — `src/harness/rules-loader.ts` built-in rules
  - Protected path writes (`.env`, credentials, `.git/` internals, baseline JSON files)
  - File reservation held by another agent — `src/harness/reservations.ts`
  - Large-file-policy block (Write/Edit that would grow a cappable file past the cap) — `src/harness/large-file-policy.ts`
- **Status:** Fully shipped. Sequential by design — these are short-circuit checks where the cost of running them in order is negligible.

### Stage 1 — Fast local deterministic
- **Latency:** 70–400ms typical, 1.5s worst case — parallel fan-out (see the §7 Stage 1 table; §7 is canonical)
- **Surface:** PreToolUse and PostToolUse
- **Gate:** Block-tier finding → BLOCK, skip Stages 2–5
- **What runs:**
  - Secrets in tool input — `src/harness/quality-checks/secret-detection.ts` (existing)
  - Guard rule patterns (110 rules) — `src/harness/rules-loader.ts` (existing)
  - Trigram grep accelerator for Grep / rg / Bash grep calls — `src/harness/grep-accelerator.ts` (existing)
  - Static input features (path, size, extension, content sniff for binary/generated) — existing across checks
  - **[proposed] Cross-agent prediction read** — round-trip to Workspace Durable Object for other agents' predicted post-edit state. Live state already exists per `src/harness/reservations.ts`; the prediction-state layer is new.
- **Status:** Mostly shipped. Cross-agent prediction is the proposed addition.

### Stage 2 — Light local with disk/parse
- **Latency:** 150–700ms typical, ~2.1s worst case — parallel (see the §7 Stage 2 table; §7 is canonical)
- **Surface:** PreToolUse and PostToolUse
- **Gate:** Block-tier in enforced mode (e.g., Graph Prediction Protocol miss on high-impact file in `enforced`) → BLOCK. Warnings → attach to context, continue.
- **What runs:**
  - Graph Prediction Protocol shard comparison (predict → reveal → reconcile) — `src/harness/graph-prediction-*.ts` modules (existing). **Cases B/D/E-stale stay observational by design** per `graph-prediction-protocol.md` v1.2; see §13a.
  - Test router (diff → affected tests via project graph) — composes `src/harness/project-graph.ts` (existing); exposing the result as agent-visible context is **proposed**
  - **[proposed] Change-Risk-Anti-Patterns composite (CRAP)** — combines existing cyclomatic complexity + a new `.interlinked/coverage-manifest.json` refreshed out-of-band; threshold on the composite, not the individual metrics
  - Memory nudge (regex match against project memory) — touches the memory system; **proposed** as a Stage 2 surface (currently implicit)
  - Fast diff risk scorer (static features only — file paths, line counts, sensitive paths) — **proposed** as a deterministic feature
- **Status:** Graph Prediction Protocol shipped; rest are proposed compositions of existing infrastructure.

### Stage 3 — Local expensive deterministic
- **Latency:** 1–15s, parallel
- **Surface:** PostToolUse only (PreToolUse exits at Stage 2)
- **Gate:** Hard failures → return errors. All findings flow into the escalation evaluator per `escalation-rules.md`.
- **What runs:**
  - TypeScript compiler (`tsc --incremental`) — `src/harness/quality-checks.ts` (existing)
  - biome / oxlint — existing
  - gitleaks re-check — existing
  - semgrep local rules — existing
  - 25 structural checks (export surface, import resolution, cycles, blast radius) — `src/harness/structural-checks.ts` (existing)
  - 50+ inline check families — `src/harness/checks/<family>.ts` (existing)
  - **[proposed] Surprise score** — predicted-vs-actual outcome diff from the Graph Prediction Protocol observation log
  - **[proposed] Recurrence-log append** — already exists; needs to emit a `signal` for the confidence score
  - **[proposed] Escalation evaluator** — deterministic synthesis per `escalation-rules.md`; runs at end of Stage 3 before aggregation
- **Status:** Tooling checks shipped; surprise score and signal-emission are the proposed additions.

### Stage 4 — Typed-signal classifier plus Cedar adjudication (Tier 2)

The Tier 2 architecture documented in `three-tier-architecture-v2.md` supersedes the older "language model as adjudicator" framing in `tier-2-llm-policy-gate.md`. The current pattern: the language model classifies content into a typed taxonomy, and deterministic Cedar policies decide what to do with the classification. The decision boundary stays in deterministic territory; the language model's job is bounded to multi-class classification with JSON-schema-constrained output. Stage 4 inherits that contract, and it is split across PreToolUse and PostToolUse so the cloud round-trip is pipelined against tool execution rather than billed onto the PostToolUse window in full. The two halves are documented separately below as Stage 4-Pre and Stage 4-Post.

Most of these invariants apply to both subchannels (typed-signal classifier + Tier 3 live feedback); two are tagged "typed-signal subchannel only" because they describe the classifier-specific output shape and the EvidenceSignal contract. All sourced from `three-tier-architecture-v2.md`. The two channels also differ in *when* their cloud call is issued: typed-signal at Stage 4-Pre (pipelined with tool execution), Tier 3 live-feedback at Stage 4-Post (input depends on landed tool output). Live-feedback specifics (selective invocation, prose-finding schema, T3-finding-to-Cedar-evidence mapping, Post-side mint mechanics, same-event T2-fail-open fallback) live in §9.13; the per-channel mint-stage split is canonical in §3 Stage 4-Pre / Stage 4-Post.

- **Detection / decision separation (typed-signal subchannel).** Every Stage 4 **typed-signal classifier** call returns a typed `EvidenceSignal` (label, valence, confidence, source). Cedar — not the language model — emits allow / warn / block / ask / inject-feedback / halt. `attribute_only` is the default `llm_action_mode`; authoritative verbs require explicit opt-in via `allowed_authoritative_actions`. The **Tier 3 live feedback subchannel** (§9.13) at Stage 4-Post is the only Stage 4 LM call that does NOT return an `EvidenceSignal` — it returns a `LiveFeedbackOutput` of typed prose findings (severity-tagged). When the opt-in `tier3.live_feedback.block_on_critical: true` setting is active, the harness synthesizes a typed `EvidenceSignal` (`T3LiveCriticalFinding`) from critical findings and threads it into the next PreToolUse Cedar evaluation — so even the live-feedback subchannel ultimately feeds Cedar through a typed-evidence bridge, preserving the detection / decision separation principle (see §9.13 for the schema and the T3-finding-to-Cedar-evidence mapping). All other invariants below (redaction, trust classes, HMAC receipts, fail paths) apply to both subchannels.
- **Two classifier shapes (typed-signal subchannel only).** A per-event classifier keyed on a content hash, and a trajectory classifier keyed on a prefix hash plus appended delta. Both honor the `ClassifierBackend` interface (`trust_class`, `supported_data_classes`, `classify`, `healthCheck`) and return a `ClassifierResult` whose `metadata` is a discriminated union (`kind: "per_event"` carries `content_hash`; `kind: "trajectory"` carries `prefix_hash` plus `delta_hash`). Both can emit `Label::"InsufficientEvidence"` rather than silently defaulting to benign. The Tier 3 live-feedback subchannel does NOT fit this two-shape contract — it produces `LiveFeedbackOutput` per §9.13, which has its own discriminated-finding schema (`LiveFeedbackFinding[]` with category + severity), not an `EvidenceSignal` or `ClassifierResult`.
- **Redaction and data-class preflight before any remote call.** The PII / secret scanner runs first, emits typed findings, and produces a redacted form. Backend selection is the maximum-of-all-sources over scanner labels, file-sensitivity rules, path heuristics, and session taint — no language model is in the preflight path. Scanner failure escalates to `HighlyConfidential` and restricts the call to `local_private` backends. Redactor failure aborts the classifier call entirely; T1 still applies.
- **Backend trust classes govern failover.** `local_private` / `interlinked_managed` / `org_managed` / `user_byo` / `third_party_public`. Failover is allowed only within the explicitly authorized trust-class set (`policy_engine.allowed_failover_classes`, default empty); the next eligible backend must satisfy both the trust-class filter and the `remote_inference_allowed_for_data_class` allowlist.
- **HMAC receipt model.** Every redacted span carries an HMAC-SHA256 hash keyed on a per-workspace secret stored at `.interlinked/audit-keys/<key_id>.key` (mode 0600), with `key_id` recorded on every log row so equality survives key rotation within the configured retention window.
- **Two distinct failure paths; logging is always-on.** The fail behavior depends on *where* the failure occurred — the local preflight that decides whether the classifier can be called safely, or the remote classifier itself once a backend has been selected. The split is canonical per `three-tier-architecture-v2.md` §6.3 (lines 752–766) and §6.4 (lines 838–853).
  - **Remote cloud-call failure — fail-open (applies to BOTH subchannels).** For either the typed-signal classifier OR the Tier 3 live-feedback supermodel: cloud backend unreachable after trust-class-and-data-class failover, call timeout, malformed schema-constrained response, or §4.11 budget exhaustion produces a null verdict with `confidence_delta: {}` (empty per-lane map — no trust signal, no caution signal) for that channel; the other channel proceeds independently if it succeeded. No Cedar decision is emitted from a failed channel. T1 already passed; the tool proceeds. This is the row "T2 per-event classifier / trajectory classifier — Backend unreachable — Failover to next eligible backend after trust/data filtering; ultimately fail-open with log" in the §6.3 fail-mode matrix, extended here to also cover the live-feedback supermodel call.
  - **Local preflight failure — fail-conservative; the affected subchannel call is aborted.** Preflight (PII / secret scanner + redactor) runs once per cloud call, on the input that call will consume. **The typed-signal classifier's preflight runs at Stage 4-Pre** because that call ships with the proposed tool input. **The Tier 3 live-feedback supermodel's preflight runs at Stage 4-Post** because its input includes the just-landed tool output and is not assembled until Post — Stage 4-Pre cannot redact data that doesn't exist yet. When the PII/secret scanner errors or times out, routing classifies the content at `HighlyConfidential` (the most-restrictive data class) per the conservative rule at `three-tier-architecture-v2.md` §6.4 (lines 842–846); only `local_private` backends remain eligible for the affected channel. When the redactor fails to produce a redacted form, **that channel's cloud call is not attempted on any backend** (including `local_private`) per `three-tier-architecture-v2.md` §6.4 (lines 847–853); the affected channel's verdict for that event is null and T1's deterministic floor continues to apply to the current event as it always does. Both preflight failures abort cleanly before that channel's remote call; neither is a "fail-open at the evaluation layer" case. The two channels do not lockstep here — a Pre-side preflight failure suppresses the typed-signal channel but does not pre-suppress live-feedback (whose own Post-side preflight may still succeed), and vice versa.
  - The trajectory log and both per-channel audit logs (`.interlinked/classifier-log/<session-id>.jsonl` for the typed-signal classifier, `.interlinked/live-feedback-log/<session-id>.jsonl` for live feedback) still record the attempt in both paths. Fail-open events are logged to `.interlinked/policy-misses.jsonl` per `three-tier-architecture-v2.md` §6.1, tagged with the subchannel id (`typed_signal` or `tier3_live`) so per-channel SLO tracking is possible.

### Stage 4-Pre — Classifier spawn and pre-filter (PreToolUse)
- **Latency:** synchronous portion is fire-and-forget on the local process (~ms); the cloud classifier itself runs in parallel with tool execution and has no PreToolUse latency budget
- **Surface:** PreToolUse, inside the 5s `HARNESS_PRE_TIMEOUT_MS` ceiling
- **Gate:** Stage 0–2 passed AND deterministic preflight selects an eligible backend AND budget controls (§4.11 of the v2 architecture) have not tripped the hard cap
- **What runs:**
  - **Receipt minting (typed-signal channel only at Pre).** PreToolUse mints the typed-signal classifier `receipt_id` (UUID v7, prefix `rcpt_`) when the classifier fires on this event. Initial `CheckReceipt` written to `.interlinked/checks/<receipt_id>.json` with `cloud.status: "pending"`, id threaded through the synchronous return for PostToolUse to recover. The Tier 3 live-feedback receipt is **not** minted at Pre — it is minted at Stage 4-Post when the supermodel call is actually issued (because its input depends on the landed tool output, which doesn't exist yet at Pre). See §9.13 for the Post-side mint mechanic.
  - **Redaction and data-class preflight for the typed-signal channel.** Scanner runs, redactor runs, initial data class is locked, backend eligibility is filtered against trust class plus `supported_data_classes`. This preflight gates the typed-signal cloud call only — if redaction fails for this event, the typed-signal classifier call is not attempted on any backend. The Tier 3 live-feedback channel has its own Post-side preflight (per §3 invariants, since its input includes the landed tool output not seen here) that runs separately.
  - **Per-event typed-signal classifier spawn.** When the event is in-scope and the content-hash cache misses, the typed-signal classifier call is issued with `void spawnCloudWorkflow(...)` — explicit fire-and-forget — and Pre returns immediately. Cache hits short-circuit the spawn and surface the cached `EvidenceSignal` synchronously.
  - **Trajectory typed-signal classifier spawn.** Every non-T1-blocked tool call is in-scope for trajectory classification by default. Under budget pressure, events satisfying the deterministic low-risk predicate (§4.2a of the v2 architecture) may skip evaluation; logging continues regardless.
  - **Tier 3 live feedback eligibility evaluation (§9.13; spawn is at Post, not Pre).** Pre-side evaluates whether the v2 §5.4 selective-invocation policy fires for this event (default policy: every commit + every periodic-N tool calls; periodic triggers are scheduled at Pre because the trigger predicates — commit boundary, call-count threshold, trajectory-shape signals — are computable from session state alone, not from tool output). When a periodic trigger fires, Pre records the eligibility decision in session state (`tier3_live_eligible_for_this_event: true`) so Stage 4-Post can pick it up and execute the actual supermodel call. **Pre does not mint a receipt, does not redact, does not call the supermodel** — those are Post-side responsibilities because the supermodel's input includes the landed tool output. The "on T2 fail-open" trigger is also a Post-side concern (it fires same-event, not next-event — see §9.13 Trigger and §10.4 step 4); Pre-side does not need to anticipate it.
  - **Pre-filter for Cedar.** Cached `EvidenceSignal` outputs from earlier in the session — including synthesized `T3LiveCriticalFinding` signals from prior live-feedback critical findings (§9.13 T3-finding-to-Cedar-evidence mapping) — are read into Cedar context so PreToolUse Cedar evaluation can already short-circuit on a strong prior negative signal.
- **Output to PostToolUse:** At most one `receipt_id` (the typed-signal classifier's, when fired) plus any synchronous Cedar verdict plus the `tier3_live_eligible_for_this_event` flag if a periodic policy fired. The typed-signal cloud call (if still running) lands in its receipt store; the live-feedback receipt and its call are minted/issued at Stage 4-Post per §9.13.
- **Status:** Proposed. The receipt minting plus async spawn primitive comes from `pre-post-pipelined-cloud-checks-and-failure-recovery.md`; the typed-signal classifier-plus-Cedar contract comes from `three-tier-architecture-v2.md`; the parallel live-feedback channel comes from `three-tier-architecture-v2.md` §5.1 Surface 1.

### Stage 4-Post — Classifier collect, Tier 3 live feedback spawn-and-collect, Cedar evaluation, and merge (PostToolUse)
- **Latency:** typed-signal receipt read is local (~ms); live-feedback receipt **mint plus spawn** runs at Post (1–10ms on-process + 3–15s cloud wall-clock for the supermodel call, off-process); Cedar evaluation over the collected `EvidenceSignal` set is sub-100ms; the per-channel bounded wait on any still-running cloud call consumes up to the PostToolUse mode budget remaining after Stage 3 (30 / 50 / 60s per `src/harness/rules/modes.ts`). The typed-signal channel pipelined with tool execution; the live-feedback channel does **not** pipeline (it starts at Post because its input includes the landed output) and is therefore the longer-tail of the two channels.
- **Surface:** PostToolUse only
- **Gate:** Stage 3 completed AND **at least one of**: (a) the typed-signal classifier `receipt_id` is recoverable from session state, (b) the `tier3_live_eligible_for_this_event` flag is set by Stage 4-Pre (periodic trigger), or (c) Stage 4-Post itself detects the T2-fail-open condition during typed-signal collection (same-event fallback — see §9.13 Trigger and §10.4 step 4). The typed-signal receipt is minted at Pre; the live-feedback receipt is minted **here at Post** (per §9.13) when (b) or (c) holds. If none of the three conditions hold (mid-session start with no Pre-side spawn AND no periodic eligibility AND no T2-fail-open at this event), Stage 4-Post degrades to a local-only verdict. A **local-only verdict** is the Stage 4-Post `StageOutput` built from Stage 0–3 deterministic evidence alone: Cedar still evaluates, but its request carries only the deterministic context fields populated by Stages 0–3 (no cloud `EvidenceSignal` from a classifier, and no synthesized `T3LiveCriticalFinding`). It is the same evaluation Stage 4-Post runs in the happy path minus the cloud-channel inputs — not a skipped stage. `verdict` is whatever Cedar emits over that reduced evidence set (typically `"allow"`); `cedar_action` is populated only if a deterministic-evidence policy fires; `receipts` is empty.
- **What runs:**
  - **Receipt collection.** PostToolUse reads `.interlinked/checks/<receipt_id>.json`. Three terminal cases are handled distinctly: `complete` (findings merged), `failed` / `timeout` (fail-open with logged event), or still `running` / `pending` past the bounded wait (the pending-receipt UX described in §1 of `pre-post-pipelined-cloud-checks-and-failure-recovery.md` fires).
  - **Cedar evaluation.** All `EvidenceSignal` outputs — per-event classifier, trajectory classifier, plus the deterministic context fields already populated by Stage 3 — flow into a single Cedar request keyed on the policy bundle for the event. The discriminated `ClassifierMetadata` (per-event versus trajectory) is logged to `.interlinked/classifier-log/<session-id>.jsonl` for cache-observability auditing. **Post-side Cedar verdicts cannot retroactively undo the tool call that just ran** — per `pre-post-pipelined-cloud-checks-and-failure-recovery.md` §1.3 (line 246): *"Pre's decision is final unless cloud finds a blocker. If cloud finds `severity: error` later, Post surfaces it for the agent's next turn — but the original tool call has already been allowed."* The set of verbs Stage 4-Post can emit is therefore scoped to what is actionable after the fact:
    - **`warn` / `inject_feedback`** — the only `@action_on_violation` values from the canonical schema (`interlinked-cedar-extensions.cedarschema` lines 110–134) that Stage 4-Post emits. These populate `StageOutput.cedar_action` (see §5); the harness's own gate decision (`verdict`) at Stage 4-Post is typically `"allow"` because both `warn` and `inject_feedback` are non-blocking — the tool already ran, and the Cedar action surfaces as `additional_context` on the current PostToolUse return so the agent sees the late verdict on its next turn. `inject_feedback` additionally reads `context.feedback` and routes it through the runner's PostToolUse channel (`additional_context` JSON on Claude Code / Cursor, stderr fallback on Codex / Copilot CLI / Gemini CLI) per the schema's `inject_feedback` semantics.
    - **`block` / `ask` / `halt_session`** — the remaining three schema values (`interlinked-cedar-extensions.cedarschema` lines 116–145) are reserved for the NEXT PreToolUse Cedar evaluation, informed by this late verdict. They are not emitted from Stage 4-Post itself; instead, the late verdict is durable in the receipt and in the trajectory, and the next call's Pre-side Cedar evaluation reads the cached `EvidenceSignal` as a strong prior per Stage 4-Pre's "Pre-filter for Cedar" bullet — at which point Pre is the layer that can pre-emptively block, defer-to-user, or halt the *next* call. Side-effect-class calls that require a hard cloud verdict before a tool runs must escalate at Pre-side via `decision: "ask"` (defer to user / require confirmation) per `pre-post-pipelined-cloud-checks-and-failure-recovery.md` §1.3 (line 246).
    - **Harness side effects (not Cedar verbs).** Alongside the Cedar verdict, Stage 4-Post may trigger harness-internal state mutations that are *not* `@action_on_violation` values. The canonical case is `sensitivity_bump`: raising `session.sensitivity_level` per `three-tier-architecture-v2.md` §6.4 (line ~830) so the next PreToolUse preflight ratchets the data class up before its routing decision. A second case is `additional_context_injected`: the act of populating the runner's PostToolUse `additional_context` envelope (or stderr fallback) with text supplied by the verdict path. These are not Cedar decisions — they are typed side effects the harness executes in response to a verdict, and they are surfaced through the `side_effects?: SideEffect[]` field of `StageOutput` (see §5) rather than the `verdict` field. Engines that ignore `side_effects` still see the Cedar `warn` / `inject_feedback` verdict via the standard channel; the side-effect channel is additive and is what makes the state mutation observable to logging, tests, and downstream stages.
  - **Tier 3 live feedback — mint, redact, spawn, collect (all at Post).** Beyond the typed-signal classifier + Cedar adjudication described above, Stage 4-Post owns the **Tier 3 live feedback channel** introduced in `three-tier-architecture-v2.md` §5.1 Surface 1 end-to-end — receipt mint, redaction preflight, supermodel spawn, bounded wait, and findings delivery — because the supermodel reviews the just-landed tool output. The channel runs on the v2 §5.4 selective-invocation policy via two paths into Post (`tier3_live_eligible_for_this_event` flag from Pre-side periodic triggers, OR same-event T2-fail-open fallback detected here). When either path fires:
    1. **Compose input.** Build the redacted supermodel input from `pre_event` (the proposed tool call captured at Pre) + `tool_output` (the just-landed result) + `landed_diff` (when the tool was Edit / Write / MultiEdit) + `recent_trajectory` (the prior N events in this session). The input is **Post-side content that does not exist at Pre**, which is why the spawn lives here.
    2. **Run preflight.** PII / secret scanner + redactor run on the composed input. Per the §3 invariants block, scanner failure ratchets eligibility to `local_private` backends; redactor failure aborts the supermodel call (T1 already passed; tool already ran; the live-feedback channel falls null for this event).
    3. **Mint receipt + spawn.** UUID v7 receipt with prefix `rcpt_`, written to `.interlinked/checks/<receipt_id>.json` with `cloud.status: "pending"`. Supermodel call (Sonnet 4.6 default; Opus 4.7 or larger on opt-in) issued with the same `void spawnCloudWorkflow(...)` fire-and-forget primitive used by typed-signal at Pre — but issued at Post.
    4. **Bounded wait + collect.** Per-channel bounded wait up to the remaining PostToolUse mode budget after Stage 3 has emitted its `StageOutput`. Outcome handling matches the typed-signal channel — `complete` (findings merged), `failed` / `timeout` (fail-open with logged event), or still `running` past the bounded wait (pending-receipt UX, see below).
    5. **Output.** `LiveFeedbackFinding[]` per §9.13 schema, delivered as `additional_context` (model-visible on Claude Code / Cursor; stderr fallback on Codex / Copilot CLI / Gemini CLI per `project_posttooluse_visibility.md`). Does **not** populate `cedar_action` on `StageOutput` (the supermodel doesn't emit `@action_on_violation` values). With the opt-in `tier3.live_feedback.block_on_critical: true` setting, critical findings synthesize a typed `EvidenceSignal` (`T3LiveCriticalFinding`) for the next PreToolUse Cedar evaluation — see §9.13 for the schema and the T3-finding-to-Cedar-evidence mapping.

    Audit log: `.interlinked/live-feedback-log/<session-id>.jsonl` (distinct from `.interlinked/classifier-log/<session-id>.jsonl` since the output shapes — `LiveFeedbackOutput` vs `ClassifierResult` — differ). See §9.13 for the full implementation hook and v2 §5.1/§5.4 for the canonical invocation contract.
  - **Reconciliation against the landed diff.** When the cloud classifier ran against the Pre-side proposed input, Stage 4-Post checks whether the actual landed diff matches; reconciliation drift is itself a Cedar context field and can be surfaced as a warning.
  - **Pending-receipt UX on overrun (per channel).** When either the typed-signal classifier OR the Tier 3 live-feedback supermodel has not returned by the bounded wait, PostToolUse emits a channel-tagged one-line `additional_context` of the form `[interlinked:cloud-classifier] receipt rcpt_xyz pending — fetch with 'interlinked checks show rcpt_xyz' or wait for next-turn auto-fetch.` or `[interlinked:tier3-live] receipt rcpt_xyz pending — fetch with 'interlinked checks show rcpt_xyz' or wait for next-turn auto-fetch.` (one line per still-pending channel; if both channels are pending, the agent sees both lines on the same PostToolUse return). Subsequent PostToolUse turns auto-fetch completed receipts on a per-channel basis so the agent sees each verdict on the next interaction.
  - **Cohort merge.** Findings from Stage 3 and from the Stage 4-Post Cedar verdict merge through the same aggregator as the rest of the pipeline, producing the `StageOutput` plus `confidence_delta` that downstream stages and the skip-logic algebra of §6 consume.
- **Channel delivery.** Verdicts land through the runner's existing PostToolUse channel — model-visible `additional_context` JSON on Claude Code and Cursor, stderr fallback on Codex, Copilot CLI, and Gemini CLI. The disk receipt at `.interlinked/checks/<receipt_id>.json` is the universal channel and the human read path.
- **Status:** Proposed. The collect / wait / pending-receipt mechanics are sourced from `pre-post-pipelined-cloud-checks-and-failure-recovery.md`; the Cedar adjudication contract is sourced from `three-tier-architecture-v2.md`.

### Stage 5 — Stop deep gates
- **Latency:** 1–10 min, Claude Code / Codex only (longer hook timeout ceilings; not portable)
- **Surface:** Stop / SubagentStop / SessionEnd
- **Gate:** Per-check trigger conditions; parallel within stage when multiple trigger
- **What runs (all proposed):**
  - **Diff-mutation testing** — runs Stryker (JS/TS) or mutmut (Python) on changed lines with affected tests only. Trigger: diff has both code AND non-snapshot test changes. Proposed module: `src/harness/checks/mutation-testing.ts`.
  - **Counterfactual Graph Prediction Protocol** — applies edit in a Cloudflare Sandbox, regenerates shard, compares predicted post-edit graph to actual. Trigger: edit hits Case E-fresh high-impact file. Composes `graph-prediction-protocol.md`.
  - **Property-based testing on diff** — Hypothesis / fast-check generates inputs from signatures. Trigger: signature-extractable new functions exist in diff.
  - **Patch-level cloud-model review** — single or multi-pass review on the diff. Trigger: ≤500-line diff, no prior cloud review this session.
  - **Transitive prediction K hops downstream** — Graph Prediction Protocol comparison over the importer/imported-by graph at K=1..3. Trigger: prior misses at K-1 detected.
- **Status:** All proposed. Tier 3 prose-policy review has been relocated to Stage 6 per `tier-3-async-deep-review.md:29` ("less frequent (per push, not per tool call), warn-only output") and `tier-3-async-deep-review.md:52` ("The natural integration point is the git pre-push hook"); see §3 Stage 6 and §9.8.

### Stage 6 — Truly async
- **Latency:** unbounded, no agent-runtime hook involvement
- **Surface:** git pre-push hook / CI / scheduled background jobs / on-demand commands. **"Hook" disambiguation:** throughout this doc, "hook" without qualification refers to the **agent-runtime hook framework** (Claude Code / Codex / Cursor / Copilot / Gemini PreToolUse / PostToolUse / Stop / SubagentStop / SessionEnd). Stage 6 fires from a **git** pre-push hook, which is a different mechanism entirely — a shell hook in `.git/hooks/pre-push` installed by `interlinked enable`, invoked by the `git` binary at push time, not by an LLM agent runtime. Stages 0 through 5 are inside the agent-runtime hook budget; Stage 6 is outside it.
- **What runs:**
  - **Tier 3 prose-policy review** — cloud-side reviewer (Claude Sonnet default, Opus on manual escalation) reads `.interlinked/policies/<group>.prose.md` + session trajectory + staged commit-range diff (`@{u}..HEAD`) + full-repo cross-reference. Auto-invocation on `git push` via the git pre-push hook installed by `interlinked enable`; on-demand via the existing `/review` and `/security-review` skills (and `/ultrareview` for the multi-agent fan-out). Output is **default warn-only** — findings are written to `.interlinked/reviews/<range-sha>.md` and a summary is printed to stderr; the push proceeds in the default mode. The opt-in `block_on_critical: true` setting in `.interlinked/config.local.json` is the only path to a block (per `tier-3-async-deep-review.md:341`), and applies only to critical-severity findings. See `tier-3-async-deep-review.md` §3 (trigger model), §7 (output format), and §13 (default-warn / opt-in-block contract).
  - **Multi-agent debate / synthesis** — N specialist reviewers in parallel (security, performance, test quality, naming, error handling) + senior synthesis pass that ranks findings. Trigger: pre-push auto-invocation (multi-agent fan-out) or on-demand via `/ultrareview`. The canonical design at `multi-agent-pre-push-review.md` is explicitly a pre-push gate, not a Stop check; relocated to Stage 6 in the fourth-round review. See §9.9 for the full implementation hook.
  - Full-codebase mutation testing (Stryker / mutmut on whole repo)
  - Symbolic / abstract interpretation on critical paths (KLEE-class)
  - Ephemeral integration test environments (container spin-up + run)
  - PR comment triage (separate `interlinked review-inbox` surface)
  - "Did the author address my comment?" semantic check (fires on push, not hook)
  - Calibration mining over session corpus (periodic batch)
  - **External scanner adapters (deferred — see §12 Phase G)** — CodeQL / OSV-Scanner / OWASP Dependency-Check / Trivy, each with its own output schema rather than wedged into `Tier3ReviewOutput`; out of scope for the current handoff
- **Status:** Tier 3 prose-policy review is designed (`tier-3-async-deep-review.md`) and lands as its own implementation track; the rest are listed for completeness so implementors don't try to fit them into Stage 5. Stage 6 is a real, separately-budgeted stage of the seven-stage pipeline — not a footnote on Stage 5 — and its non-agent-runtime-hook driving surface is the canonical reason it gets its own slot.

---

## 4. The flowchart

```
[Tool call / edit / Bash command]
       │
       ▼
┌──────────────────────────────────────────────────────────────────┐
│ Stage 0 — Instant disqualifiers (0–5ms, sequential)              │
│   Dangerous cmd / protected path / reservation / large-file      │
│   Any fires → BLOCK return, no further work                      │
└──────────────────────────────────────────────────────────────────┘
       │ pass
       ▼
┌──────────────────────────────────────────────────────────────────┐
│ Stage 1 — Fast local deterministic (5–100ms, parallel)           │
│   Secrets / guard rules / trigram grep / static features         │
│   [proposed] Cross-agent prediction read                         │
│   Block-tier → BLOCK with reason; skip 2–5                       │
└──────────────────────────────────────────────────────────────────┘
       │ pass
       ▼
┌──────────────────────────────────────────────────────────────────┐
│ Stage 2 — Light local with disk/parse (100ms–2s, parallel)       │
│   Graph Prediction Protocol shard comparison                     │
│   Test router / memory nudge / fast diff risk scorer             │
│   [proposed] Change-Risk-Anti-Patterns composite                 │
│   Enforced-mode block → BLOCK; skip 3+                           │
└──────────────────────────────────────────────────────────────────┘
       │
       │ (event-surface fork: PreToolUse branch / PostToolUse branch.
       │  Stages 0–2 are drawn once above; per §3, Stage 0 is
       │  PreToolUse-only and Stages 1–2 re-run on the PostToolUse
       │  branch before Stage 3.)
       │
       ├──── PreToolUse branch ────────────────────────────────────┐
       │                                                            │
       │     ▼                                                      │
       │  ┌──────────────────────────────────────────────────────┐  │
       │  │ Stage 4-Pre — Typed-signal classifier spawn          │  │
       │  │   (~ms on-process)                                   │  │
       │  │   Redaction + data-class preflight (typed-signal     │  │
       │  │     channel only — see §3 invariants)                │  │
       │  │   Typed-signal classifier spawn (per-event+trajectory│  │
       │  │     when in scope) → typed-signal receipt minted     │  │
       │  │     (void, fire-and-forget)                          │  │
       │  │   Tier 3 live-feedback eligibility evaluated         │  │
       │  │     (periodic triggers only; no spawn here — flag    │  │
       │  │     forwarded to Post per §9.13)                     │  │
       │  │   PreToolUse returns (5s HARNESS_PRE_TIMEOUT_MS)     │  │
       │  └──────────────────────────────────────────────────────┘  │
       │     │                                                      │
       │     ▼                                                      │
       │  [Tool executes — typed-signal call in flight off-process] │
       │     │                                                      │
       └─────┘                                                      │
                                                                    │
       ┌──── PostToolUse branch ───────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────┐
│ Stage 3 — Local expensive deterministic (1–15s, parallel)        │
│   TypeScript compiler / biome / oxlint / semgrep / gitleaks      │
│   25 structural checks / 50+ inline check families               │
│   [proposed] Surprise score / signal-emission                    │
│   [proposed] Escalation evaluator (deterministic synthesis)      │
│   Hard failures → return errors                                  │
└──────────────────────────────────────────────────────────────────┘
       │ aggregated findings + confidence_score
       ▼
┌──────────────────────────────────────────────────────────────────┐
│ Stage 4-Post — Typed-signal collect + Tier 3 mint/spawn/collect  │
│   + Cedar eval (PostToolUse)                                     │
│   Read typed-signal receipt (when minted at Pre); bounded wait   │
│   Tier 3 live feedback (when eligibility flag set at Pre OR      │
│     T2 fail-open detected here at Post): compose input from      │
│     pre_event + tool_output + landed_diff + recent_trajectory;   │
│     redact; mint receipt; spawn supermodel; bounded wait         │
│   Typed-signal: EvidenceSignal set → Cedar → warn /              │
│     inject_feedback at Post-side (sensitivity_bump emitted as    │
│     side_effects, not a Cedar verb); block / ask / halt_session  │
│     reserved for the NEXT PreToolUse Cedar evaluation, informed  │
│     by this late verdict via trajectory + session sensitivity +  │
│     additional_context                                           │
│   Tier 3 live feedback: LiveFeedbackOutput → additional_context  │
│     (model-visible on Claude / Cursor, stderr on Codex / Copilot │
│     CLI / Gemini CLI); opt-in block_on_critical may synthesize   │
│     T3LiveCriticalFinding EvidenceSignal for next PreToolUse     │
│   Pending receipts surfaced per channel as additional_context    │
│     one-liner; next-turn PostToolUse auto-fetches completed      │
│     receipts                                                     │
└──────────────────────────────────────────────────────────────────┘
       │
       ▼  (Stop event only)
┌──────────────────────────────────────────────────────────────────┐
│ Stage 5 — Stop deep gates (1–10 min, Claude Code / Codex only)   │
│   Trigger conditions per check, parallel if multiple trigger:    │
│   Diff-mutation testing                                          │
│   Counterfactual Graph Prediction Protocol                       │
│   Property-based testing on diff                                 │
│   Patch-level cloud-model review                                 │
│   Transitive prediction K hops                                   │
└──────────────────────────────────────────────────────────────────┘
       │
       ▼  (push / CI / scheduled / on-demand, never in agent-runtime hook;
       ▼   driven by git pre-push, CI, scheduled jobs, on-demand commands)
┌──────────────────────────────────────────────────────────────────┐
│ Stage 6 — Truly async                                            │
│   Tier 3 prose-policy review (pre-push auto + /review on-demand) │
│   Multi-agent debate / synthesis (pre-push fan-out, /ultrareview)│
│   Full mutation / symbolic interpretation / integration envs     │
│   PR comment triage / calibration mining                         │
└──────────────────────────────────────────────────────────────────┘
```

### Gate logic per transition

| From → To | Gate condition |
|---|---|
| 0 → 1 | Stage 0 clean, else BLOCK |
| 1 → 2 | No block-tier findings, else BLOCK |
| 2 → 3 | Surface is PostToolUse (PreToolUse exits at 2) AND no Stage 2 enforced-mode block |
| 2 → 4-Pre | Surface is PreToolUse AND Stage 0–2 clean AND deterministic preflight selects an eligible backend AND budget not exhausted. One cloud spawn at most: the typed-signal classifier, fire-and-forget on the local process, minting a typed-signal receipt. Tier 3 live-feedback eligibility is evaluated here (periodic triggers) but the spawn lives at Post per §3 / §9.13 |
| 3 → 4-Post | Surface is PostToolUse AND at least one of: (a) typed-signal receipt recoverable from Pre, (b) Tier 3 eligibility flag set at Pre (periodic trigger), (c) Stage 4-Post itself detects T2 fail-open on typed-signal collection (same-event fallback). When (b) or (c), Tier 3 receipt is minted here at Post and supermodel call issued on the composed Post-side input. None of (a)/(b)/(c) → local-only verdict |
| 4-Post → 5 | Surface is Stop AND ≥1 Stage-5 trigger met, AND confidence_score < skip_threshold |
| 5 → 6 | Never inside the agent-runtime hook framework — Stage 6 is driven by the git pre-push hook / CI / scheduled jobs / on-demand commands, not by agent-runtime hooks (PreToolUse / PostToolUse / Stop / SubagentStop / SessionEnd) |

### Parallelism rules

- **Stage 4-Pre's typed-signal spawn runs concurrently with the tool itself; Tier 3 does not pipeline.** The typed-signal classifier call is issued during PreToolUse and overlaps tool execution; cost is bounded by the per-event content-hash cache and the trajectory prefix-hash-plus-delta cache, plus §4.11 budget controls of `three-tier-architecture-v2.md`. The Tier 3 live-feedback supermodel call **does not pipeline with tool execution** — it is mint/spawn/collect at Stage 4-Post because its input (`pre_event + tool_output + landed_diff + recent_trajectory`) is not assembled until the tool has run. The trade-off is deliberate: Tier 3 sacrifices the pipelining latency win for a higher-value review surface (the actual landed effect of the tool call), and the bounded per-channel wait at Post plus the pending-receipt UX absorbs the long-tail wall-clock. Stage 4-Post waits on each cloud call independently, up to the remaining PostToolUse mode budget, and merges findings from whichever channels returned in time.
- **Stage 5 still sequentially gates.** Sandbox spin-up and supermodel review cost seconds even when language-model tokens are cached. Wait for the Stage 4-Post Cedar verdict before deciding whether Stage 5 is worth invoking.
- **Within Stage 5, parallel by default.** Diff-mutation + counterfactual Graph Prediction Protocol + property-based testing + patch-level cloud review can all run concurrently if their trigger conditions independently fire. Synthesis after all return. (Tier 3 prose-policy review and multi-agent debate / synthesis are no longer Stage 5 checks; they run at Stage 6 / pre-push per §9.8 and §9.9.)
- **Optimistic parallelism is scoped per hook surface, with one intra-branch data dependency.** Stage 3 is PostToolUse-only (see §3), so it cannot speculate across a PreToolUse evaluation. Within the PreToolUse branch, Stages 0, 1, and 2 can run optimistically in parallel (and Stage 4-Pre's classifier spawn is already fire-and-forget alongside them). Within the PostToolUse branch, **Stage 4-Post's receipt-wait phase can overlap with Stage 3 execution** — both fire on the same PostToolUse event, the receipt-wait is just an I/O wait on `.interlinked/checks/<receipt_id>.json`, and starting it as soon as PostToolUse fires saves wall-clock when the cloud classifier has already returned. **But Stage 4-Post's Cedar evaluation and merge phase requires Stage 3 output as input** (Cedar consumes the Stage 3 `EvidenceSignal` context fields per §3 Stage 4-Post): Cedar evaluation does not start until Stage 3 has emitted its `StageOutput`. Cancel Stage 4-Post's receipt-wait if Stage 3 produces a block-tier finding before the receipt arrives. Cross-branch speculation is forbidden: Pre and Post fire on different events at different times and share no live evaluation context. Net win because local CPU is free; the rule is "same hook surface, respect intra-branch data dependencies."

---

## 5. Per-stage output schema

### Current (implicit) shape

Today, the harness returns a `HarnessDecision` (from `src/harness/types/decisions.ts`) shaped as:

```typescript
type HarnessDecision = {
  decision: "allow" | "block" | "ask";
  reason?: string;
  warnings?: string[];
  check_results?: CheckResultEntry[];
  checks_skipped?: SkipEntry[];
  checks_timing_ms?: number;
  checks_ran?: string[];
  tool_breakdown?: Array<{ tool: string; ms: number; finding_count: number }>;
  phase_breakdown?: Record<string, number>;
  summary?: string;
  // ... other fields
};

type CheckResultEntry = {
  source: "quality" | "structural" | "suggestion" | "impact" | "structure";
  name: string;
  severity: "error" | "warning" | "info";
  message: string;
  file?: string;
  determinism: Determinism;
  confidence?: number;
  // ... other fields
};
```

Individual check tools (from `src/harness/check-engine/types.ts`) return `CheckResult`:

```typescript
type CheckResult = {
  tool: ToolId;
  severity: "error" | "warning" | "info";
  file: string;
  line: number;
  column?: number;
  message: string;
  ruleId?: string;
};
```

### Proposed new shape

To support skip logic, each stage's aggregated output needs:

```typescript
// Harness gate decision — what the harness actually did to the current
// tool call. Distinct from Cedar's `@action_on_violation` (see CedarAction
// below); the harness gate and Cedar policy answer different questions
// with different timing and authority. `null` is used when the gate
// degrades to fail-open after a classifier infrastructure failure (per
// §3 Stage 4 invariants — the tool still ran because T1 already passed).
type HarnessGateDecision =
  | "allow"
  | "ask"
  | "block"
  | "defer"
  | "skipped";

// Cedar `@action_on_violation` value — what Cedar policy said *should*
// happen under policy. The canonical schema closes this at five values
// (per `interlinked-cedar-extensions.cedarschema:103-145`). Optional on
// `StageOutput` because not every stage runs Cedar — Stage 4-Pre and
// Stage 4-Post both produce a `cedar_action`, but the schema verb set
// they can emit is different: Stage 4-Pre may emit any of the five
// (`block` / `ask` / `halt_session` are pre-emptively actionable because
// the tool hasn't run yet); Stage 4-Post is scoped to `warn` /
// `inject_feedback` because Post-side cannot retroactively block the
// tool call that just ran (see §3 Stage 4-Post Cedar evaluation bullet
// for the verb scoping). Stages 0–3 are deterministic-local and don't
// run Cedar.
//
// Distinct from `HarnessGateDecision`: at Stage 4-Post, Cedar says
// `"warn"` while the harness still emits `verdict: "allow"` (the warning
// is non-blocking and shows up as `additional_context` for the next
// turn). At Stage 4-Pre, Cedar says `"block"` and the harness emits
// `verdict: "block"`. The two fields are not redundant; they answer
// "what did the harness do to the current execution?" and "what did
// Cedar say should happen under policy?" — separately observable so
// downstream consumers (logging, calibration, trajectory) can audit
// each independently.
type CedarAction =
  | "warn"
  | "block"
  | "ask"
  | "inject_feedback"
  | "halt_session";

// Cloud subchannel identifier — names each independent receipt-bearing
// cloud call that Stage 4 may issue. The two channels mint at different
// stages: the typed-signal classifier (`typed_signal`) is minted at
// Stage 4-Pre when its per-event invocation policy fires; the Tier 3
// live-feedback supermodel (`tier3_live`) is minted at Stage 4-Post
// when the v2 §5.4 selective policy fires (periodic eligibility flagged
// at Pre, or same-event T2-fail-open fallback detected at Post) — its
// input depends on the landed tool output, so it cannot be minted at
// Pre. Either may be present without the other. See §3 Stage 4-Pre /
// Stage 4-Post bullets and §9.13 for per-channel mechanics.
type Stage4Subchannel = "typed_signal" | "tier3_live";

type StageOutput = {
  // Stage 0 through 5 only: these are the stages whose verdicts feed the
  // per-event stage aggregator (keyed on PreToolUse / PostToolUse for
  // Stages 0–4 and Stop / SubagentStop / SessionEnd for Stage 5) and
  // the §6 skip-logic algebra. Stage 6 (truly async; git pre-push / CI /
  // scheduled / on-demand) is intentionally excluded — its outputs flow
  // through a separate consumer (`.interlinked/reviews/<range-sha>.md`
  // and the pre-push reviewer summary per `tier-3-async-deep-review.md`
  // §7), not through this per-event aggregator. See §6 "Stage 6 is not
  // in the skip-logic algebra" and the dedicated `Tier3ReviewOutput`
  // shape sketched at §5a below.
  stage: 0 | 1 | 2 | 3 | 4 | 5;
  // Substage discriminator — populated when `stage === 4` because Stage 4
  // is the only stage split across two hook surfaces (Stage 4-Pre at
  // PreToolUse, Stage 4-Post at PostToolUse) and the two halves produce
  // different verbs, different receipt sets, and different consumer
  // contracts per §3. Omitted (or undefined) for Stages 0, 1, 2, 3, and 5
  // which fire at a single hook surface each. Aggregator consumers MUST
  // dispatch on `(stage, substage)` for Stage 4 events; downstream
  // calibration and replay rely on the pair.
  substage?: "pre" | "post";
  // Harness gate result — what the harness did to the current tool call.
  // `null` when the harness gate degraded to fail-open (e.g. Stage 4
  // classifier infrastructure failure per §3 Stage 4 invariants); the
  // tool still ran because T1 already passed.
  verdict: HarnessGateDecision | null;
  // Cedar `@action_on_violation` value when Cedar was evaluated at this
  // stage. Optional because not every stage runs Cedar (Stage 4-Pre and
  // Stage 4-Post both emit, with different verb sets per the `CedarAction`
  // comment above — Pre may emit any of the five, Post is scoped to
  // `warn` / `inject_feedback`; Stages 0–3 are deterministic-local and
  // don't run Cedar). Distinct from `verdict`: see the `CedarAction`
  // comment above for the harness-gate vs Cedar-policy distinction. See
  // §3 Stage 4-Pre / Stage 4-Post Cedar evaluation bullets for the full
  // mapping.
  cedar_action?: CedarAction;
  findings: Finding[];
  // New fields for skip logic:
  confidence_delta: Partial<Record<Lane, number>>; // per-lane signed contribution; lanes a stage cannot speak to are omitted entirely (not zero)
  signal_summary: SignalSummary;                   // structured fingerprint for later stages to consume; entries are co-located under their lane
  duration_ms: number;
  // Per-channel receipt map for async stages. The two channels mint
  // receipts at different stages:
  //   - `typed_signal` is minted at Stage 4-Pre (spawn pipelines with
  //     tool execution; receipt id flows from the Pre StageOutput into
  //     session state and is read back at Post).
  //   - `tier3_live` is minted at Stage 4-Post (input includes the
  //     landed tool output, so the spawn cannot happen at Pre; see §3
  //     Stage 4-Post and §9.13).
  // Either, both, or neither key may be present on any given StageOutput:
  //   - both present → both channels were invoked for this event (e.g.,
  //     typed-signal fired at Pre + Tier 3 fired at Post via periodic
  //     trigger OR T2-fail-open fallback)
  //   - one present → only that channel was invoked; the other is "not
  //     invoked" (distinct from "failed")
  //   - neither present (or `receipts` omitted) → Stage 4-Post degrades
  //     to a local-only verdict per §3 Stage 4-Post gate bullet
  // The lookup is by subchannel id (`Stage4Subchannel`); the receipt id
  // itself is the on-disk filename at `.interlinked/checks/<id>.json`.
  receipts?: Partial<Record<Stage4Subchannel, string>>;
  // Harness-internal mutations triggered alongside the Cedar verdict.
  // Distinct from `verdict` (the harness gate decision) and `cedar_action`
  // (the Cedar policy action): `side_effects` records mutations the
  // harness performs in response to the verdict path. Empty/omitted
  // means the stage produced no state changes beyond findings.
  side_effects?: SideEffect[];
};

// Side effects are harness state mutations triggered by a stage's verdict.
// They are NOT Cedar `@action_on_violation` values — the canonical Cedar verb
// set (interlinked-cedar-extensions.cedarschema:103-145) is closed at
// warn / block / ask / inject_feedback / halt_session. Anything else a stage
// "does" (raise session sensitivity, inject text into a runner channel,
// annotate the trajectory) is a typed side effect on this channel so it is
// observable to logging, tests, and the next stage's evidence collection.
type SideEffect =
  | {
      kind: "sensitivity_bump";
      // New session.sensitivity_level after the bump, per
      // three-tier-architecture-v2.md §6.4 (line ~830). Monotonic upward
      // within a session; downgrades happen only on explicit session reset.
      new_level: number;
      // Why the harness raised the level — surfaces in classifier-log and
      // recurrence aggregation so calibration mining can attribute bumps.
      reason: string;
    }
  | {
      kind: "additional_context_injected";
      // Which runner channel carried the text. `additional_context` is the
      // model-visible JSON envelope on Claude Code / Cursor; `stderr` is the
      // fallback on Codex / Copilot CLI / Gemini CLI. Mirrors the channel
      // matrix in the inject_feedback schema entry
      // (interlinked-cedar-extensions.cedarschema:124-134).
      channel: "additional_context" | "stderr";
      // The text injected — captured here for replay, tests, and the
      // pending-receipt UX, not re-rendered.
      text: string;
    }
  | {
      kind: "trajectory_annotation";
      // Free-form tag that subsequent stages and Cedar's ExtendedTrajectory
      // (interlinked-cedar-extensions.cedarschema:92-96) can read. Used by
      // sequential-precondition policies that need to observe the verdict
      // path itself ("Stage 4-Post emitted inject_feedback on this tool
      // call"), not just the underlying signal.
      tag: string;
      payload: unknown;
    };

type Lane =
  | "correctness"   // TypeScript compiler / biome / oxlint / semgrep / gitleaks / structural / inline checks
  | "prediction"    // Graph Prediction Protocol match, surprise score
  | "recurrence"    // recurrence-log no-match, cohort health, calibration history
  | "prose"         // architectural taste, methodology adherence, prose-policy artifacts
  | "coordination"; // cross-agent reservations, file locking, multi-agent agreement, cross-agent prediction agreement

type SignalSummary = {
  correctness?: {
    typescript_compiler_clean?: boolean;
    structural_clean?: boolean;
    lint_clean?: boolean;             // biome / oxlint combined
    secrets_clean?: boolean;          // gitleaks + Stage 1 secret detection
    semgrep_clean?: boolean;
  };
  prediction?: {
    graph_prediction_match?: "exact" | "tolerant" | "miss" | "absent";
    surprise_score_bucket?: "low" | "medium" | "high";
  };
  recurrence?: {
    recurrence_hits?: number;
    cohort_healthy?: boolean;
    calibration_misses_recent?: number;
  };
  prose?: {
    prose_policy_artifacts_present?: boolean;
    methodology_signals_in_trajectory?: number; // count of trajectory checkpoints that match an active prose policy
    prior_tier3_review_this_session?: boolean;
  };
  coordination?: {
    multi_agent_session?: boolean;
    reservation_conflicts_recent?: number;
    high_impact_paths_touched?: boolean;
    cross_agent_prediction_agreement?: "agree" | "disagree" | "absent";
  };
  // Cross-lane diff descriptors (used by triggers, never by lane scoring):
  diff_size_bucket?: "trivial" | "small" | "medium" | "large";
  test_files_modified?: boolean;
};
```

### 5a. Tier 3 output (separate consumer)

Stage 6 deliberately does **not** emit `StageOutput`. The per-event stage aggregator that consumes `StageOutput` is keyed on agent-runtime events (PreToolUse / PostToolUse for Stages 0–4; Stop / SubagentStop / SessionEnd for Stage 5) and is responsible for the §6 confidence-skip algebra. Stage 6 fires from git pre-push or on-demand commands — outside the agent-runtime event framework entirely — and so has no event to attach to.

This section sketches the **Tier 3 prose-policy review output shape**, which is one of several Stage 6 output families consumed by the pre-push surface and the `.interlinked/reviews/` filesystem store (per `tier-3-async-deep-review.md` §7). The other Stage 6 output families:
- **Multi-agent debate / synthesis output (§9.9)** — owned by `multi-agent-pre-push-review.md` (verdict aggregation under unanimous-allow at the Agent CI surface; advisory-only at the Free CLI surface).
- **External scanner adapter outputs (§12 Phase G, deferred)** — per-scanner output schemas (CodeQL / OSV-Scanner / OWASP Dependency-Check / Trivy), each with its own shape; design needs its own memo before implementation.

All shapes share the `.interlinked/reviews/` artifact store but they are not the same type; the §5a sketch below covers Tier 3 prose review only.

```typescript
type Tier3ReviewOutput = {
  range_sha: string;                  // commit range that was reviewed
  scope: "tight" | "typical" | "full_repo";
  model: "sonnet" | "opus";
  findings: Finding[];
  prose_policy_artifacts_consulted: string[];  // paths under .interlinked/policies/
  duration_ms: number;
  // Warn-only contract per tier-3-async-deep-review.md §13 (lines 331–341):
  // the hook normally exits 0 regardless of finding severity. The only
  // path to a block is the opt-in `block_on_critical: true` setting in
  // `.interlinked/config.local.json` (per tier-3-async-deep-review.md:341)
  // combined with at least one finding at severity `critical`.
  push_proceeded: boolean;
  // Populated when push_proceeded is false; human-readable explanation
  // (e.g. "critical finding(s) under opt-in block_on_critical").
  block_reason?: string;
};
```

This shape is informational here; the type itself lives with the Tier 3 implementation track (see `tier-3-async-deep-review.md` §7 for the canonical output format).

### Where this lives

Proposed module: `src/harness/check-engine/types.ts` (composes with the existing `check-engine/` caching layer).

The aggregation point that builds `StageOutput` from individual `CheckResult`s is proposed at `src/harness/check-engine/stage-aggregator.ts`. It is the consumer of the deterministic escalation evaluator described in `escalation-rules.md` and the producer of the `confidence_delta` consumed by skip logic.

---

## 6. Confidence-based skip logic

### The algebra

```typescript
function needs_check(
  check: CheckId,
  stage_results: StageOutput[],
): boolean {
  if (!triggers_met(check, stage_results)) return false;
  const required_lane = required_lane_for(check); // declared per check in the §6 skip-threshold table
  const score = confidence_score(stage_results, required_lane);
  return score < skip_threshold(check);
}

function confidence_score(
  stage_results: StageOutput[],
  lane: Lane,
): number {
  // Pessimistic-by-default: starts at 0, accumulates only from same-lane signals.
  // Cross-lane suppression is forbidden — a clean TypeScript compiler (correctness lane)
  // never contributes to the prose lane's score, etc.
  // Bounded to [0, 1] per lane.
  const summed = stage_results.reduce((acc, s) => {
    const delta = s.confidence_delta[lane];
    return delta === undefined ? acc : acc + delta;
  }, 0);
  return Math.min(1, Math.max(0, summed));
}
```

### Per-check skip thresholds

Each Stage 4/5 check declares its own threshold *and* the evidence lane its threshold consumes. Higher threshold = more skeptical of skipping = the check is more important to run when ambiguity remains. Cross-lane suppression is forbidden by §5/§6: only same-lane confidence counts. If a check could plausibly be served by two lanes, the table picks the lane closest to the property the check actually verifies.

| Stage | Check | Required lane | skip_threshold | Rationale |
|---|---|---|---|---|
| 4 | Failure classification | correctness | 0.40 | Classifies the failure surfaced by Stage 3 deterministic tools; same-lane evidence is what makes it skippable |
| 4 | Risk classification | correctness | 0.50 | Cheap, but covers a load-bearing decision; consumes the same-lane diff-risk and lint/compiler signals |
| 4 | Tier 2 policy escalation | prose | 0.65 | Policy gate evaluates methodology-shaped rules; only prose-lane signals (prior prose review, methodology checkpoints) should suppress it |
| 4 | Semantic memory lookup | recurrence | 0.50 | Mid-cost; recurrence-lane regex memory hit is the relevant trust signal |
| 4 | Tier 3 live feedback supermodel (periodic) | prose | 0.55 | Periodic-trigger invocations (every commit / every N tool calls / trajectory-shape signals per v2 §5.4) — the supermodel emits prose advice, so prose-lane evidence (prior Tier 3 prose review clean, methodology checkpoints landed) is what should suppress the next periodic invocation |
| 4 | Tier 3 live feedback supermodel (T2 fail-open fallback) | — | **unskippable** | T2-fail-open trigger fires when typed-signal classifier collection at Stage 4-Post produces no usable verdict (failed / timeout / null). Skip logic does not apply: prose-lane confidence is unrelated to the fallback's purpose, which is to recover *classifier* coverage that the prose lane cannot speak to. Periodic invocations remain skippable per the row above; the fallback path bypasses the skip algebra entirely |
| 5 | Diff-mutation testing | correctness | 0.80 | Test-claim verification is a correctness claim; same-lane clean compiler / lint / structural alone is not enough — threshold stays high |
| 5 | Counterfactual Graph Prediction Protocol | prediction | 0.75 | Same-lane prior Graph Prediction Protocol match is the only evidence that should let us skip the counterfactual variant |
| 5 | Property-based testing | correctness | 0.65 | Verifies behavior over generated inputs; correctness-lane same-stage signals (clean compiler, no semgrep flags) are the relevant trust source |
| 5 | Patch-level cloud review | prose | 0.55 | Catches comment/code intent drift and convention adherence — prose-lane property, not correctness |
| 5 | Transitive prediction K hops | prediction | 0.70 | Compounds Graph Prediction cost; same-lane prior K-1 match is the only meaningful skip evidence |

Thresholds are tunable per project at `.interlinked/skip-thresholds.json` (team) and `.interlinked/skip-thresholds.local.json` (personal). The required lane is **not** tunable; lane assignment is a correctness property of the check definition, not a knob.

### confidence_delta values per signal source

Every signal is attributed to exactly one lane. A check evaluating a given lane consumes only its own row of deltas. Cross-lane contamination ("clean compiler suppresses Tier 3 prose review") is a bug, not a feature, and the per-lane `confidence_delta: Partial<Record<Lane, number>>` shape in §5 makes it structurally impossible to express.

| Stage / source | Lane | Positive (trust) | Negative (caution) |
|---|---|---|---|
| Stage 1 secrets clean | correctness | +0.05 | (Block, not delta) |
| Stage 1 guard rules clean | correctness | +0.10 | (Block, not delta) |
| Stage 1 cross-agent prediction agreement | coordination | +0.15 | −0.20 on disagreement |
| Stage 2 Graph Prediction Protocol exact match | prediction | +0.30 | (Block-tier in enforced mode) |
| Stage 2 Graph Prediction Protocol tolerant match | prediction | +0.15 | — |
| Stage 2 Graph Prediction Protocol miss | prediction | — | −0.30 |
| Stage 2 fast diff risk = low | correctness | +0.10 | — |
| Stage 2 fast diff risk = high | correctness | — | −0.15 |
| Stage 2 memory nudge hit (regex) | recurrence | +0.05 | — |
| Stage 3 TypeScript compiler clean | correctness | +0.20 | −0.20 on error |
| Stage 3 biome / oxlint clean | correctness | +0.10 | −0.10 on error |
| Stage 3 structural checks clean | correctness | +0.15 | −0.15 on error |
| Stage 3 recurrence-log no-match | recurrence | +0.05 | −0.05 on match |
| Stage 3 surprise score = low | prediction | +0.10 | −0.15 on high |
| Stage 3 cohort healthy | recurrence | +0.05 | −0.10 on degraded |
| Stage 3 prior prose-policy review clean (this session) | prose | +0.10 | — |
| Stage 3 methodology checkpoint observed in trajectory | prose | +0.05 per checkpoint, capped +0.15 | — |
| Stage 3 reservation conflicts absent | coordination | +0.05 | −0.10 on recent conflict |

Negative deltas are bounded at the lane; one bad signal can't drive a single lane's confidence below 0 single-handedly because of the `Math.max(0, ...)` clamp. This is intentional — a single broken check shouldn't force every deep gate that consumes its lane to fire, and a single trust signal shouldn't suppress every deep gate. Critically, the clamp is per-lane: a correctness-lane crash does not depress the prose-lane or coordination-lane scores, and a prose-lane streak of cleanliness does not buoy the correctness-lane score above its skip threshold.

### Random sampling override (gaming insurance)

Even when `confidence_score(stage_results, required_lane) >= skip_threshold(check)` for the check's own lane (i.e., the check would otherwise skip), Stage 4 and Stage 5 checks run anyway with probability `P_sample` (defaults below — 0.02 for Stage 4, 0.05 for Stage 5). This prevents an agent or pattern that systematically keeps same-lane signals green from avoiding deep gates entirely.

```typescript
function needs_check_with_sampling(check, stage_results, rng): boolean {
  if (!triggers_met(check, stage_results)) return false;
  const required_lane = required_lane_for(check);
  const score = confidence_score(stage_results, required_lane);
  if (score < skip_threshold(check)) return true;
  return rng() < P_sample;  // sampled-in run
}
```

Sampling stays per-check (one `P_sample` per check id, not per lane). Sampling **cannot bypass the lane filter** — it can only override a same-lane skip decision. There is no cross-lane sampling escape hatch; if you want a check to run under different evidence, change its required lane, not its sampling rate.

`P_sample` is configurable per check; defaults are:
- Stage 4 checks: 0.02 (low; the cost is real for users)
- Stage 5 checks: 0.05 (higher; the cost is wall-clock at Stop, less visible)

Tune from observed miss rate within the same lane. If sampled-in runs surface real findings that the same-lane signals missed, raise the threshold or increase `P_sample`. If sampled-in runs never surface anything, lower `P_sample` or raise the threshold. Cross-lane surprises (a prose-lane finding caught by sampling a correctness-lane check) are a signal that the *check's lane assignment is wrong*, not that the sampling rate should change.

### Skip receipt format

When a check is skipped via confidence accumulation, the agent receives a brief receipt:

```
[interlinked:skipped] stage_4.failure_classification
  Reason: stage_3.typescript_compiler_clean + stage_3.lint_clean + stage_3.structural_checks_clean
  Confidence: 0.45 (threshold 0.40)
  Override: interlinked deep-gate --check failure_classification --force
```

Receipts are logged to `.interlinked/skip-decisions.jsonl` for calibration analysis. Each receipt is individually tagged with a per-record HMAC-SHA256 over the canonical-JSON serialization of the record, keyed by the active per-workspace audit key in `.interlinked/audit-keys/<key_id>.key` (mode 0600), and carries the `key_id` of the key that signed it — the same receipt model as the Cedar decision log in `three-tier-architecture-v2.md` §6.1 (line 713, "HMAC-signed per §6.1 / doc 17") and §6.4 (key rotation, retention, `key_id` tracking, lines 800–806). Skip-decisions are **not** hash-chained: per `three-tier-architecture-v2.md` §6.1 (line 722, "per-receipt HMAC only — no hash chain… Chained audit is Guardrails territory") and `docs/plans/free-cli-adoption/17-replay-testing-and-decision-receipts.md:31-38`, chained tamper-evident audit logs are reserved for the Guardrails tier; the local v2 harness ships per-receipt HMAC only. Tamper of a single skip-decision row is detectable by re-verifying its HMAC against the key referenced by its `key_id`; tamper of the log as a whole (insertion / reordering / wholesale deletion) is **out of scope** here — the threat model is "calibration loop reads a row and trusts it" (the per-record HMAC defeats forgery), not "auditor needs to prove no row was removed" (which is a Guardrails responsibility and requires the chained-log infrastructure that doc 17 holds back). Key-rotation behavior follows `three-tier-architecture-v2.md` §6.4: old `key_id`s are retained for `policy_engine.audit_key_retention_days` (default 90 days) so prior receipts remain verifiable; receipts written after that window with retired keys lose their HMAC verifiability but remain in the log for replay. The schema:

```typescript
type SkipDecision = {
  session_id: string;
  timestamp: string;
  check_id: string;
  stage: number;
  lane: Lane;                       // the required lane for this check; calibration analyzes skip rates per lane
  confidence_score: number;         // same-lane score that produced this decision
  skip_threshold: number;
  signal_summary: SignalSummary;
  // For calibration:
  was_overridden: boolean;          // user used --force
  override_finding_severity?: "none" | "warning" | "error" | "block";
  // Per-receipt tamper-evidence (three-tier-architecture-v2.md §6.1 / §6.4).
  // HMAC-SHA256 over the canonical-JSON of all preceding fields, keyed by
  // the workspace audit key identified by key_id. Not a hash chain — each
  // receipt stands alone. Chained audit is Guardrails-tier and out of scope.
  key_id: string;
  receipt_hmac: string;
};
```

When `was_overridden=true AND override_finding_severity in {error, block}`, that's a "we should have run it" data point; the calibration loop should raise the threshold or increase `P_sample` for that check.

---

## 7. Latency budget table

Three column classes, kept distinct to avoid the conflation the reviewer flagged:

- **Hook transport overhead** — fixed per-event cost on every PreToolUse / PostToolUse / Stop / SessionEnd, independent of which checks run. Hook entry process start, Unix socket connect, daemon eval dispatch. Adds ~30ms warm. Reported separately below so it isn't double-counted into stage totals.
- **Current measured** — what the harness actually exhibits today, including known regressions (`project_hook_script_linger_latency`: ~4.4s/PreToolUse via the generated `.mjs` hook when the server is down; `incremental-posttooluse.md:5`: 14–45s/Edit PostToolUse before incremental caching lands).
- **Target after incremental work** — what the same stage will exhibit after the `incremental-posttooluse.md` content-hash cache + scope-limited tool wrappers + edit-burst dedup have landed.

Per-stage tables below report **target** numbers (the architectural budget) unless a row is explicitly tagged `(current)`. Sources: existing tool benchmarks where shipped, estimates where proposed.

### Hook transport overhead (every event, all surfaces)

| Component | Typical | Worst case |
|---|---|---|
| Hook entry process start (`dist/hook-entry.js`) | ~28ms | 100ms |
| Unix socket connect | 0.5–2ms | 10ms |
| Daemon eval dispatch | ~1ms | 5ms |
| **Total transport (warm-server)** | **~30ms** | 115ms |
| Generated `.mjs` hook with server down (current regression) | **+4.4s (current)** | +4.4s |

Per `project_hook_script_linger_latency`: the generated `.interlinked/hooks/interlinked-activity.mjs` adds ~4.4s per PreToolUse when the server is down (backlog re-flush + leaked abort timers + no `process.exit`). Until this is fixed, every check latency below assumes the warm-server path; the failure mode adds +4.4s on top.

### Stage 0 — Instant disqualifiers (target; check work only, transport reported above)

| Check | Typical | Worst case |
|---|---|---|
| Dangerous command match | 1–5ms | 10ms |
| Protected path check | 1–5ms | 10ms |
| Reservation check | 1–5ms | 10ms |
| Large-file-policy check | 1–10ms | 50ms |
| **Total Stage 0 check work** | **~5–25ms** | 80ms |

### Stage 1 — Fast local deterministic

| Check | Typical | Worst case |
|---|---|---|
| Command pattern match (110 guard rules) | 1–5ms | 10ms |
| Secrets in tool input | 5–30ms | 100ms |
| Trigram grep accelerator | 10–50μs index + 10–200ms rg | 500ms |
| Static input features | 1–10ms | 30ms |
| Cross-agent prediction read (DO round-trip) | 50–300ms | 1s |
| **Total Stage 1** | **70–400ms** | 1.5s |

### Stage 2 — Light local with disk/parse

| Check | Typical | Worst case |
|---|---|---|
| Graph Prediction Protocol shard comparison | 5–30ms | 200ms |
| Test router (project-graph traversal) | 100–500ms | 1s |
| Change-Risk-Anti-Patterns composite | 10–50ms | 200ms |
| Memory nudge (regex match) | 15–50ms | 200ms |
| Fast diff risk scorer | 10–100ms | 500ms |
| **Total Stage 2** | **150–700ms** | ~2.1s |

At PreToolUse, Stage 2 enforces a per-check hard cap of ~1s so the aggregate fits the remaining 5s `HARNESS_PRE_TIMEOUT_MS` budget after transport (~30ms) and Stages 0/1 (~50–400ms); checks that exceed their cap are skipped and treated as `verdict: skipped, reason: pre_budget_exceeded`. At PostToolUse, the table's worst-case applies fully within the mode budget (30 / 50 / 60s).

### Stage 3 — Local expensive deterministic (PostToolUse only; target after incremental caching)

| Check | Typical (warm) | Cold |
|---|---|---|
| TypeScript compiler (`tsc --incremental`) | 200ms–2s | 5–10s |
| biome | 30–300ms | 500ms |
| oxlint | 20–100ms | 200ms |
| gitleaks re-check | 50–200ms | 200ms |
| semgrep local rules | 100–500ms | 1s |
| 25 structural checks | 50–500ms | 1s |
| 50+ inline check families | 1–30ms each, parallel | same |
| Surprise score | 5–30ms | 100ms |
| Recurrence aggregator append | 1–5ms | 20ms |
| Escalation evaluator (deterministic synthesis) | 10–100ms | 300ms |
| **Total Stage 3 (warm, small file; target)** | **500ms–3s** | 8–15s |
| **Total Stage 3 (cold tsc, large file; target)** | 5–15s | 20s |
| **Total Stage 3 (current, no incremental caching, `incremental-posttooluse.md:5`)** | **14–45s (current)** | up to 60s |

### Stage 4-Pre — Typed-signal classifier spawn (PreToolUse, ~ms local; cloud call runs in parallel with the tool)

Stage 4-Pre spawns at most one cloud call: the typed-signal classifier (when in scope). Tier 3 live-feedback eligibility is evaluated here for periodic triggers but the supermodel spawn lives at Stage 4-Post (input depends on landed tool output; see §3 / §9.13). The Stage 4-Pre table below covers on-process typed-signal work plus the off-process classifier wall-clock; Tier 3 latency is accounted for in the Stage 4-Post table.

| Step | Typical | Worst case |
|---|---|---|
| Scanner + redactor preflight (typed-signal channel input) | 5–30ms | 100ms |
| Data-class lock + backend eligibility filter | 1–5ms | 20ms |
| Content-hash / prefix-hash cache probe (typed-signal classifier) | 1–5ms | 20ms |
| Typed-signal classifier receipt mint + write to `.interlinked/checks/<receipt_id>.json` | 1–5ms | 30ms |
| Typed-signal classifier spawn (`void` fire-and-forget) | 1–3ms | 10ms |
| Tier 3 live-feedback periodic-trigger evaluation (v2 §5.4 policy check — typically every-commit + every-N-tool-calls counters; **no spawn here**, flag forwarded to Post) | 0.1–1ms | 5ms |
| **Total Stage 4-Pre on-process** | **8–48ms** | 185ms |
| Typed-signal classifier wall-clock (off-process, overlaps tool) | 2–20s typical (cached prefix) / 5–30s cold | 60s |

The 5s `HARNESS_PRE_TIMEOUT_MS` ceiling is irrelevant to the off-process typed-signal call — PreToolUse returns once the receipt is written, regardless of whether the cloud call has resolved.

### Stage 4-Post — Typed-signal collect + Tier 3 mint/spawn/collect + Cedar evaluation (PostToolUse)

| Step | Typical (cloud done) | Cloud still running |
|---|---|---|
| Typed-signal receipt read from disk | 1–5ms | 1–5ms |
| Bounded wait on in-flight typed-signal classifier | n/a | up to PostToolUse mode budget remaining after Stage 3 (30 / 50 / 60s) |
| Cedar evaluation over the `EvidenceSignal` set | 5–50ms | Cedar evaluates the deterministic-only context (Stage 0–3 evidence); no cloud-derived `EvidenceSignal` yet, so the verdict is provisional and pending-receipt UX fires |
| Reconciliation against landed diff | 2–10ms | n/a |
| Merge into the aggregator output | 1–10ms | 1–10ms |
| Pending-receipt `additional_context` emit | n/a | 1–5ms |
| **Subtotal Stage 4-Post on-process for typed-signal channel** | **10–80ms** | bounded by remaining PostToolUse budget |
| Tier 3 live-feedback gate evaluation (flag from Pre OR T2 fail-open detected here) | 0.1–1ms | n/a |
| Tier 3 live-feedback input composition (`pre_event` + `tool_output` + `landed_diff` + `recent_trajectory`) | 1–10ms | n/a |
| Tier 3 live-feedback scanner + redactor preflight (Post-side, on composed input) | 5–30ms | 100ms |
| Tier 3 live-feedback receipt mint + write to `.interlinked/checks/<receipt_id>.json` | 1–5ms | 30ms |
| Tier 3 live-feedback supermodel spawn (`void` fire-and-forget) | 1–3ms | 10ms |
| Tier 3 live-feedback bounded wait + render to `additional_context` | 5–50ms local + bounded wait | bounded by remaining PostToolUse budget |
| Tier 3 live-feedback supermodel wall-clock (Sonnet 4.6 default / Opus 4.7 opt-in; **does not pipeline with tool execution** since spawn is at Post) | 3–15s (Sonnet) / 8–25s (Opus) | 60s |

If the bounded wait expires for either cloud channel, Stage 4-Post returns immediately with the local-only verdict plus channel-tagged pending-receipt one-liner(s) — one line per still-pending channel; if both channels are pending, both lines surface on the same PostToolUse return. The cloud verdict(s) are auto-fetched by the next PostToolUse turn on the same session, on a per-channel basis.

### Stage 5 — Stop deep gates

| Check | Typical | Worst case |
|---|---|---|
| Diff-mutation testing (20 mutants, small affected suite) | 40–80s | 2–3 min |
| Counterfactual Graph Prediction (Cloudflare Sandbox) | 5–20s | 60s |
| Property-based testing on diff | 5–30s | 90s |
| Patch-level cloud review (single pass) | 5–30s | 90s |
| Transitive prediction K=3 (no model calls) | 250ms–2s | 5s |
| Transitive prediction K=3 (with per-hop model) | 5–30s | 60s |
| **Typical Stop with full stack enabled** | **90s–4 min** | 8 min |

### Stage 6 — Pre-push and on-demand (not in the hook-budget framework)

Stage 6 is bounded by the pre-push wall-clock budget the user is willing to tolerate at `git push` time, not by any per-event hook budget. The table below is informational; Stage 6 latency is never billed against `HARNESS_PRE_TIMEOUT_MS` or the 30 / 50 / 60s PostToolUse mode budgets.

| Check | Typical | Worst case |
|---|---|---|
| Tier 3 prose-policy review, tight scope (1 commit, 3 files, Sonnet) | 10–25s | 60s |
| Tier 3 prose-policy review, typical (3–5 commits, 10–20 files, Sonnet) | 15–45s | 90s |
| Tier 3 prose-policy review, heavy / full-repo (`/ultrareview` or `--scope full-repo`, Opus) | 60–180s | 5 min |
| Multi-agent debate / synthesis (5 agents × 3 rounds, pre-push or `/ultrareview`) | 30–60s | 3 min |
| Full-codebase mutation testing | hours | hours |
| Symbolic interpretation on critical paths | hours | hours |
| Ephemeral integration environments | minutes | hours |
| External scanner adapters (CodeQL / OSV-Scanner / OWASP Dependency-Check / Trivy) | TBD per §12 Phase G memo | TBD |

Per `tier-3-async-deep-review.md` §9, a typical dev does 3–10 pushes/day and Tier 3 sees 1 review per push, so the pre-push cost is paid at a frequency the user controls. Cache hits via `(commit-range-sha, scope-id, prose-policy-hashes)` keep retries cheap (§8 of the canonical memo).

### End-to-end agent experience

| Scenario | Added latency |
|---|---|
| Normal Edit, small file, warm cache | ~1s |
| Normal Edit, large file, cold tsc | 5–15s |
| Bash command (non-destructive) | <100ms |
| Grep via trigram index | 30–250ms |
| PreToolUse only (Stages 0–2 plus Stage 4-Pre spawn within 5s `HARNESS_PRE_TIMEOUT_MS`) | 100ms–3s on-process; classifier wall-clock overlaps tool execution |
| Stop event with diff-mutation + counterfactual Graph Prediction + property-based testing enabled | 90s–4 min |
| Pre-push with Tier 3 prose-policy review (typical scope, Sonnet, Stage 6) | 15–45s; default warn-only, opt-in `block_on_critical` may block critical findings |

### Known regression to fix first

The ~4.4s/PreToolUse `.mjs`-hook regression (described in the "Hook transport overhead" table above) is the highest-leverage fix in the project before adding any new gates. It dwarfs every check in the tables above; until it lands, the failure mode adds +4.4s on top of any other latency number.

---

## 8. Aggregation and presentation order

What the agent actually sees at the end of a tool call, ordered:

```
1. [BLOCK reasons]      — agent was blocked, must understand why
2. [proven] ERRORS      — deterministic verifier said fix required
3. [proven] WARNINGS    — deterministic, fix recommended
4. [heuristic] WARN     — pattern / regex / AST, ask-or-acknowledge
5. CONTEXT              — predictions to reconcile, memory nudges, suggested commands
6. SUGGESTIONS          — test commands to run, refactor hints
7. [skipped] receipts   — checks that did not run, with override commands
```

Within each section, order by:
1. Just-introduced before pre-existing (per the existing diff-aware filtering)
2. High severity before low
3. `[proven]` before `[heuristic]` (determinism tag from `src/harness/quality-checks.ts::classifyDeterminism`)
4. Ratchet metrics last (`as any`, `non_null_assertion`, suppression directives)

### Output size discipline

- Cap at ~8KB to avoid drowning the agent in findings
- Overflow handled with `… N more findings; run interlinked verify for full list`
- Top-N selected by relevance score (combined severity × recency × determinism), not by order of generation

### Surfacing Stage 3 findings when an earlier stage already blocked

Design decision: surface them. When a Stage 0/1/2 block fires on PostToolUse AND Stages 0–3 in the PostToolUse branch ran optimistically in parallel (per §4 parallelism rules — same-hook-surface only), the agent should see all problems with the edit ordered so the block is unambiguously first. Without this, the next attempt is uninformed. (Stage 3 is PostToolUse-only per §3, so this surfacing rule only applies to PostToolUse blocks; PreToolUse blocks at Stage 0/1/2 never have a Stage 3 alongside them — Stage 3 hasn't fired yet — so the question doesn't arise on PreToolUse.)

Rationale: an agent confronting a block but missing the downstream tsc/lint errors will fix the block and re-attempt, only to be blocked again by a different problem. Surfacing the full set lets the next attempt be globally informed. Confusion ("you were blocked + here are 12 tsc errors") is mitigated by clear section ordering.

---

## 9. Proposed checks — implementation hooks

Per-check spec for the unbuilt work. Each section specifies: stage, surface, trigger, file path, dependencies, and rollout mode.

### 9.1 Cross-agent prediction (Stage 1)

- **What:** Before agent B edits `auth.ts:validateToken`, read agent A's predicted post-edit state for the same function. Disagreement is a coordination signal stronger than file-level reservation overlap.
- **Surface:** PreToolUse + PostToolUse
- **Trigger:** Multi-agent session detected (more than one active cohort member per `src/harness/cohort.ts`) AND tool is Write / Edit / MultiEdit on a code file
- **Proposed module:** `src/harness/cross-agent-prediction.ts`
- **Dependencies:** Extends `src/harness/reservations.ts` to carry a `predicted_post_state` field per active reservation; Workspace Durable Object schema change to persist predictions cross-agent
- **Rollout:** `shadow` (log only) → `soft_gate` (warning) → `enforced` (block on high-severity disagreement), mirroring Graph Prediction Protocol's cadence

### 9.2 Test-outcome prediction as third Case-E-fresh oracle (Stage 2)

- **What:** Graph Prediction Protocol today predicts shards. Test pass/fail is itself an authoritative oracle (the test result is ground truth, not a heuristic). Before running affected tests, the agent predicts which will pass/fail and why.
- **Surface:** PreToolUse (request prediction before `vitest related` / `pytest`) + PostToolUse (reveal + reconcile)
- **Trigger:** Bash command matches a known test-runner invocation AND diff contains code changes
- **Proposed module:** `src/harness/checks/test-outcome-prediction.ts`
- **Dependencies:** Composes existing test-router output from Stage 2; extends Graph Prediction Protocol oracle taxonomy to include test results
- **Rollout:** `shadow` → `soft_gate` → no `enforced` mode (test results are observational, not authoritative for blocking)

### 9.3 Change-Risk-Anti-Patterns composite (Stage 2)

- **What:** Existing cyclomatic complexity check + new coverage manifest → composite "complex AND undertested" score. Higher signal than either component alone; FP-low enough to graduate from advisory to default-gate.
- **Surface:** PostToolUse on code edits
- **Trigger:** Edit lands in a function whose composite score crosses configurable threshold
- **Proposed module:** `src/harness/checks/change-risk-anti-patterns.ts`
- **Dependencies:**
  - Existing complexity check in `src/harness/checks/complexity.ts`
  - New `.interlinked/coverage-manifest.json` refreshed by `interlinked coverage refresh` (separate command, not in hook)
  - Manifest schema: `{ file: { function: { lines, cyclomatic, coverage_fraction, last_refreshed_at } } }`
- **Rollout:** advisory first (verify --all-checks only) → default-gate after FP rate confirmed low

### 9.5 Surprise score (Stage 3)

- **What:** `(predicted_outcome, actual_outcome)` pairs from Stage 2 Graph Prediction Protocol observation log → surprise level for the current edit. Drives `confidence_delta` for skip logic.
- **Surface:** PostToolUse
- **Trigger:** Always (cheap)
- **Proposed module:** `src/harness/graph-prediction-surprise.ts`
- **Dependencies:** Reads existing `.interlinked/graph-reconciliations.jsonl`; emits a single `signal` value
- **Rollout:** Single-mode; not gated by shadow/soft/enforced because it produces no user-visible findings — only feeds the confidence score

### 9.6 Diff-mutation testing at Stop (Stage 5)

- **What:** Stryker (JS/TS) or mutmut (Python) on changed lines with affected tests only. Verifies "I added tests for the new behavior" claim — mutation testing is the only check that proves tests discriminate behavior, not just execute lines.
- **Surface:** Stop / SubagentStop
- **Trigger:** Diff includes both code AND non-snapshot test changes; tests added are non-trivial (>3 assertion lines)
- **Proposed module:** `src/harness/checks/mutation-testing.ts`
- **Dependencies:** Stryker / mutmut installed as dev dependencies (per-project); reads `git diff` for changed lines; queries `src/harness/project-graph.ts` for affected tests; writes to `.interlinked/mutation-log.jsonl`
- **Determinism tag:** `[proven]` — the verifier actually ran against actual tests. Add to `PROVEN_TOOL_CHECKS` in `src/harness/quality-checks/instructions.ts`.
- **Hard time budget:** 2 min default, partial result on timeout
- **Per-project config:** `.interlinked/mutation-config.json` — excluded paths, operators, max mutants per Stop, per-language tool selection
- **Rollout:** `shadow` (log only) → `soft_gate` (Stop warning, agent can proceed) → `ack_required` (Stop warning escalated to require an explicit acknowledgment in the trajectory or `.interlinked/mutation-acks.jsonl`; never a hard block). Per `stop-event-checks.md:5-15` ("Stop hooks should make the agent reflect before claiming done, not push it to ship. ... Prefer warnings / `instruct`-style nudges over hard denies — denies should be reserved for things genuinely unsafe to leave unfinished"), an `enforced`-mode hard block at Stop is rejected for diff-mutation testing: surviving mutants are a quality signal, not a safety signal, and a Stop-time block would be a forward-march gate of exactly the shape `feedback_reluctance_to_push.md` rules out. The ack-required tier escalates the wording and requires a recorded acknowledgment without ever denying the Stop transition.
- **Pairs with:** test-outcome prediction (§9.2) — agent predicts mutant survival before run; aligned predictions strengthen confidence in the agent's model of its own tests

### 9.7 Counterfactual Graph Prediction Protocol (Stage 5)

- **What:** Apply the edit in a Cloudflare Sandbox, regenerate the graph shard for the changed file(s), compare the agent's predicted post-edit graph to the actual post-edit graph. Today's Graph Prediction Protocol scores the agent on its model of the current state; this scores it on its model of the change itself.
- **Surface:** Stop
- **Trigger:** Edit hits Case E-fresh high-impact file (per Graph Prediction Protocol case taxonomy)
- **Proposed module:** `src/harness/graph-prediction-counterfactual.ts`
- **Dependencies:** Cloudflare Sandbox SDK; shard generator (Supermodel integration); composes existing Graph Prediction Protocol comparison logic
- **Rollout:** `shadow` only initially — sandbox cost is too real for casual enforcement

### 9.8 Tier 3 prose-policy review at pre-push (Stage 6)

- **What:** Cloud-side reviewer (Claude Sonnet default; Opus on manual `--model opus`) reads `.interlinked/policies/<group>.prose.md` (already emitted by `/enforce` Pass 3) + session trajectory at `.interlinked/session-trajectories/<session-id>.jsonl` + staged commit-range diff (`@{u}..HEAD`) with full-repo cross-reference. Returns structured findings against architectural principles and methodology checkpoints the deterministic Tier 1 layer and the Tier 2 typed-signal classifier cannot encode.
- **Surface:** Stage 6 — pre-push hook (auto-invocation on `git push`) plus on-demand via the existing `/review`, `/security-review`, and `/ultrareview` skills. **Not** the Stop event. The previous placement of this check under Stage 5 / Stop has been corrected per `tier-3-async-deep-review.md:29` ("less frequent (per push, not per tool call), warn-only output") and `tier-3-async-deep-review.md:52` ("Tier 3 runs **after** the agent's work is committed locally but **before** it's pushed remote. The natural integration point is the git pre-push hook").
- **Trigger:** Pre-push hook fires AND prose policy artifacts exist in `.interlinked/policies/` AND the commit range (`@{u}..HEAD` if upstream exists, otherwise `main..HEAD`, otherwise working-tree changes plus the most recent commit per `tier-3-async-deep-review.md:90-99`) is non-empty.
- **Default warn-only; opt-in `block_on_critical` may block on critical findings.** By default Tier 3 writes findings to `.interlinked/reviews/<range-sha>.md`, prints a stderr summary, and exits 0 — the push proceeds regardless of finding severity (per `tier-3-async-deep-review.md:67-75`). The only path to a local block is the opt-in `block_on_critical: true` setting in `.interlinked/config.local.json` combined with at least one finding at severity `critical` (per `tier-3-async-deep-review.md:341`). This default-warn / opt-in-block split is consistent with `feedback_reluctance_to_push.md` and `stop-event-checks.md:5-15` — local push-gating creates bad pressure and easy bypasses, so the harness ships observability by default and lets the user opt into enforcement explicitly.
- **Reference:** Full design in `tier-3-async-deep-review.md`. Trigger model: §3.1 (pre-push) and §3.2 (on-demand). Scope: §4. Model selection: §5. Output format: §7. Warn-only contract: §13. Failure modes (all fail-open): §14.
- **Rollout:** Out-of-scope for this doc beyond the placement correction; see the referenced memo for the implementation-order checklist at its bottom (session trajectory persistence → commit-to-session linkage → data-gathering command → cloud reviewer wiring → pre-push hook installation → calibration).

### 9.9 Multi-agent debate / synthesis at pre-push (Stage 6, Free CLI surface)

- **What:** N specialist reviewers in parallel (security, performance, test quality, naming, error handling) + senior synthesis pass that ranks findings. Filters the LLM-reviewer false-positive flood that's the #1 reason these tools get turned off. **This section describes the local Free CLI Stage 6 surface only.** The canonical reviewer architecture (vendor CLI orchestration, risk-tier dispatch, per-(user, repo) Cloudflare Sandbox, verdict merging) is owned by `multi-agent-pre-push-review.md`; that doc's hard-gate / unanimous-allow contract describes the **Agent CI / managed remote** product surface — see "Product surface split" below.
- **Surface:** Stage 6 — local git pre-push hook fan-out (auto-invocation on `git push` via the hook installed by `interlinked enable`) plus on-demand via the `/ultrareview` skill. **Not** the Stop event.
- **Trigger:** Pre-push hook fires AND the commit range is non-trivial (large diff, >200 lines, OR hits high-impact path per `multi-agent-pre-push-review.md` §3 risk-tier orchestrator). On-demand via `/ultrareview` always fires regardless of size.
- **Proposed module:** `src/harness/checks/multi-agent-debate.ts` plus the orchestrator at `src/harness/multi-agent-orchestrator.ts` (per `multi-agent-pre-push-review.md` §2 reviewer surface and §3 risk-tier dispatch).
- **Product surface split (canonical contracts).** The local Stage 6 surface and the managed remote surface share the same reviewer architecture but ship different contracts:
  - **Free CLI / local git pre-push hook (this §9.9, Stage 6 of the seven-stage pipeline).** **Default warn-only.** Findings are written to `.interlinked/reviews/<range-sha>.md` (shared with Tier 3) and a summary is printed to stderr; the hook exits 0 regardless of finding severity. The only path to a local block is the opt-in `block_on_critical: true` setting in `.interlinked/config.local.json` combined with at least one finding at severity `critical`. Rationale per `feedback_reluctance_to_push.md` and `stop-event-checks.md:5-15`: local push-gating creates bad pressure and easy bypasses; the harness ships observability by default and lets the user opt into enforcement explicitly.
  - **Agent CI / managed remote (canonical `multi-agent-pre-push-review.md`).** **Hard gate.** Verdicts merge under unanimous-allow per `multi-agent-pre-push-review.md` §4: "any reviewer says block, push is blocked. Bypass is loud and audited." This is where team policy, audit trails, and the canonical "false-block annoying, false-allow ships bad code" asymmetric-cost reasoning earn their place. The managed surface is a separate product from the Free CLI; the same reviewer architecture, two different product contracts.
- **Reference:** Full reviewer architecture in `multi-agent-pre-push-review.md` (vendor CLI orchestration, risk-tier dispatch, per-(user, repo) Cloudflare Sandbox, verdict merging, billing). That doc has been updated (2026-05-20 fifth round) to declare its product surface explicitly as Agent CI / managed remote with hard-gate unanimous-allow.
- **Rollout:** Sequenced after Tier 3 prose review (§9.8) since the Free CLI surface shares the pre-push fan-out infrastructure (per-user Sandbox, `.interlinked/reviews/` output store, default-warn-only contract). The Agent CI / managed remote surface is a separate implementation track owned by `multi-agent-pre-push-review.md`.

### 9.10 Property-based testing on diff (Stage 5)

- **What:** Hypothesis (Python) / fast-check (JS/TS) generates inputs from new function signatures, runs N samples, reports counterexamples.
- **Surface:** Stop
- **Trigger:** Diff adds or modifies functions whose signatures admit input generation (typed parameters, no opaque dependencies)
- **Proposed module:** `src/harness/checks/property-based-testing.ts`
- **Dependencies:** Hypothesis / fast-check installed as dev dependencies per language
- **Rollout:** Tier C; specialized check, opt-in per project

### 9.11 Patch-level cloud-model review (Stage 5)

- **What:** Single LLM pass over the diff with structured output. Catches what deterministic checks can't: comment-vs-code agreement, naming consistency against codebase conventions, intent drift between PR title and changes.
- **Surface:** Stop
- **Trigger:** Diff ≤500 lines AND no prior cloud review this session
- **Proposed module:** `src/harness/checks/patch-level-review.ts`
- **Dependencies:** AI Gateway proxy worker (per `ai-agent-orchestration-patterns` skill)
- **Rollout:** `shadow` → `soft_gate` (warnings only) → no `enforced` (cloud LLM verdicts are advisory by design per `cloud-local-disagreement-policy.md`)

### 9.12 Transitive prediction K hops downstream (Stage 5)

- **What:** Graph Prediction Protocol comparison over the importer / imported-by graph at K=1..3. Score falloff in accuracy with depth as a calibrated map of where the agent's world model degrades.
- **Surface:** Stop
- **Trigger:** Prior Graph Prediction Protocol misses at K-1 detected in current or recent sessions
- **Proposed module:** `src/harness/graph-prediction-transitive.ts`
- **Dependencies:** Composes `src/harness/project-graph.ts` (importer/imported-by traversal) + existing Graph Prediction Protocol comparison
- **Rollout:** `shadow` only initially

---

### 9.13 Tier 3 live feedback supermodel (Stage 4-Post)

- **What:** Cloud-side supermodel (Sonnet 4.6 default; Opus 4.7 or larger on opt-in) reviews tool call output during agent work and emits typed prose findings delivered through PostToolUse `additional_context`. Distinct from the typed-signal classifier also at Stage 4-Post (which feeds Cedar with `EvidenceSignal` labels) — this channel produces structured prose findings (severity-tagged), not `@action_on_violation` values. Canonical design at `three-tier-architecture-v2.md` §5.1 Surface 1.
- **Surface:** Stage 4-Post (parallel to the typed-signal classifier at the same PostToolUse surface). Both channels run on the same agent-runtime event but have different invocation policies, output shapes, receipts, and consumers.
- **Trigger:** Selective per `three-tier-architecture-v2.md` §5.4 invocation policy — NOT every event. Default policy per v2 §5.4 (line 672): every commit + every 50 tool calls + on T2 fail-open. The three triggers split across stages:
  - **Periodic (every commit / every N tool calls / trajectory-shape signals).** Evaluated at Stage 4-Pre from session state alone; when fired, Pre sets `tier3_live_eligible_for_this_event: true` for the current event and Stage 4-Post picks it up.
  - **T2 fail-open fallback.** Detected at Stage 4-Post during typed-signal receipt collection: when the typed-signal channel reaches a **terminal failure** state within the Post-side bounded wait, Stage 4-Post immediately schedules a Tier 3 invocation for **the same event** (not the next event). Terminal failure means exactly one of: receipt `cloud.status: "failed"` (backend error), receipt `cloud.status: "timeout"` (the cloud-side workflow itself gave up), or receipt `cloud.status: "complete"` carrying a null / unusable verdict (malformed schema-constrained response). The fallback reviews the just-failed event's tool input + output, which is exactly what the lost typed-signal classification would have covered. Same-event targeting is the correct semantic; a next-event flag would review the wrong content.

    **A bounded-wait overrun is NOT a terminal failure and does NOT trigger the fallback.** When the typed-signal receipt is still `running` / `pending` at Post-side bounded-wait expiry, the cloud call is still alive — its verdict is *late*, not *lost*. That receipt stays on the pending-receipt path (channel-tagged `additional_context` one-liner; next-turn auto-fetch per the "Pending-receipt UX" bullet in §3 Stage 4-Post and the primitive in `pre-post-pipelined-cloud-checks-and-failure-recovery.md`). Spawning a same-event T3 fallback for a merely-late verdict would both waste a supermodel call and race the typed-signal result that is about to arrive. If a late-fetched typed-signal verdict subsequently resolves to a terminal failure on a *later* turn, that is logged to `.interlinked/policy-misses.jsonl` for SLO tracking but does **not** retroactively spawn a T3 review of the now-stale event — same-event targeting is the contract, and a stale event is not the right review target.
  - **User explicit / on-demand.** A slash command (`/review-this`) triggered by the agent or user surfaces at Stage 4-Post via the same eligibility path as a periodic trigger.
  Both periodic and on-demand paths are subject to the §6 skip-logic algebra (prose-lane confidence can suppress them). The T2-fail-open fallback path is **unskippable** — prose-lane confidence is unrelated to classifier-availability gaps; see the split rows for "T3 live feedback supermodel (periodic)" and "T3 live feedback supermodel (T2 fail-open fallback)" in §6. Configurable per workspace.
- **Receipt model (independent of typed-signal classifier; minted at Stage 4-Post).** Tier 3 live feedback mints its receipt **at Stage 4-Post** (not at Pre), because the supermodel input — `pre_event + tool_output + landed_diff + recent_trajectory` — is Post-side content. Path: `.interlinked/checks/<live-feedback-receipt-id>.json`. Stage 4-Post mints the receipt, runs its own scanner + redactor preflight on the composed input, then spawns the supermodel with `void spawnCloudWorkflow(...)` and collects with a per-channel bounded wait. The receipt is independent of the typed-signal receipt (minted at Pre): either may be present without the other; both may be present on the same event (typed-signal at Pre + Tier 3 at Post via periodic eligibility or T2-fail-open fallback); both may be absent (no Pre-side typed-signal spawn AND no Tier 3 eligibility AND no T2-fail-open — Stage 4-Post degrades to local-only).
- **Output schema:**

  ```typescript
  type LiveFeedbackFinding = {
    category: "correctness" | "naming" | "architecture" | "performance" | "security" | "other";
    severity: "info" | "warn" | "critical";
    message: string;                            // prose advice from the supermodel
    source_event_id?: string;                   // which agent event triggered this finding
    cited_locations?: Array<{ file: string; line?: number }>;
  };

  type LiveFeedbackOutput = {
    receipt_id: string;                         // independent of the typed-signal classifier receipt
    findings: LiveFeedbackFinding[];
    rendered_text: string;                      // additional_context payload, redacted per §6.4
    duration_ms: number;
  };
  ```

- **Delivery:** `rendered_text` is delivered via `additional_context` (model-visible on Claude Code / Cursor; stderr fallback on Codex / Copilot CLI / Gemini CLI per `project_posttooluse_visibility.md`). Does not populate `cedar_action` on `StageOutput` — this channel is non-Cedar (the supermodel doesn't emit `@action_on_violation` values directly). Logged to `.interlinked/live-feedback-log/<session-id>.jsonl` for replay (a distinct log from the typed-signal classifier's `.interlinked/classifier-log/<session-id>.jsonl` — the two channels share session granularity and the audit-key model but not the log file, since they produce different output shapes: `ClassifierResult` vs `LiveFeedbackOutput`).
- **Default warn-only; opt-in `block_on_critical` escalates to Cedar evidence.** Per `three-tier-architecture-v2.md` §5.2, the `tier3.live_feedback.block_on_critical: true` setting in `.interlinked/config.local.json` opts the channel into a typed-evidence escalation path. The mapping:

  > When `block_on_critical` is true AND any `LiveFeedbackFinding` has `severity: "critical"`, the harness synthesizes an `EvidenceSignal` of label `"T3LiveCriticalFinding"` (carrying severity bucket + finding count + `receipt_id` reference + the highest-severity finding's category) and threads it into the session trajectory. The NEXT PreToolUse Cedar evaluation reads that signal as a strong prior; Cedar's policy bundle can then emit `block` / `ask` per its existing rules.

  This is the only way a non-Cedar prose channel becomes Cedar-actionable, and it's the only path to a local block from live feedback. Default is off per `feedback_reluctance_to_push.md`. The supermodel itself does not autonomously act — it advises; the harness translates critical findings into synthetic Cedar evidence per the opt-in setting; Cedar decides whether the next call is blocked; the user decides whether to act on a warning.
- **Proposed module:** `src/harness/checks/tier3-live-feedback.ts` plus the cloud caller at `src/harness/cloud/supermodel.ts`, and the synthetic-evidence emitter at `src/harness/checks/tier3-evidence-bridge.ts`. Reuses the §6.4 redaction / data-class preflight, the §4.6 trust-class failover, and the receipt-store machinery from the typed-signal classifier infrastructure.
- **Reference:** Full design in `three-tier-architecture-v2.md` §5.1 (Surface 1 — what the supermodel does and does not do), §5.2 (default warn-only + opt-in escalations + the synthesized-evidence path described above), §5.4 (selective invocation policy — required to keep cost bounded since the supermodel is not a per-event call), and §12 step 12 (implementation order — sequenced after the typed-signal classifier infrastructure stabilizes).
- **Rollout:** Sequenced after the typed-signal classifier infrastructure (v2 §12 steps 1–11) since the two channels share the redaction / preflight / trust-class machinery, the receipt model, and the `additional_context` delivery channel. See Phase E bullet 7 in §12 for placement in the rollout phases.

---

## 10. Failure modes

### 10.1 Gaming via cheap-signal optimization

**Risk:** An agent learns "keep the TypeScript compiler green and don't write to high-impact paths" and systematically avoids deep gates while doing bad things.

**Mitigation:**
1. Random sampling per §6 (`P_sample` default 0.05 for Stage 5)
2. confidence_delta caps per source — no single signal can drive confidence above ~0.30, so a single faked-clean check can't suppress all gates
3. Calibration loop: when a `was_overridden=true` skip-receipt produces a real finding, the calibration job raises the threshold or `P_sample` for that check class

### 10.2 Over-suppression on fresh sessions or repos

**Risk:** Empty recurrence logs and no accumulated trust → confidence_score starts at 0 → every gate fires → false-positive noise on a clean repo.

**Mitigation:** This is the intended behavior. New repos and new sessions *should* get more scrutiny. The pessimistic-by-default design is load-bearing. Document this in user-facing onboarding so it's not surprising.

### 10.3 Calibration-log poisoning

**Risk:** If `.interlinked/skip-decisions.jsonl` is written by the harness but consumed by an LLM-tuned threshold-updater, an adversary could inject entries to drive thresholds in a harmful direction.

**Mitigation:**
1. Calibration runs deterministically — no LLM in the loop per `feedback_harness_deterministic_only.md`.
2. Threshold updates require a deterministic minimum-evidence rule (e.g., "raise threshold by 0.05 only after 10 `was_overridden` events in 30 days").
3. The skip-decisions log is append-only, and each record carries a per-receipt HMAC plus the `key_id` that signed it — per the receipt format in §6 of this doc and `three-tier-architecture-v2.md` §6.1 / §6.4. The calibration loop refuses to ingest any record whose HMAC does not verify against the named key (or whose `key_id` has been purged past retention). This defeats single-record forgery; whole-log tampering (re-ordering or wholesale removal of valid rows) is out of scope at the local tier and is a Guardrails-tier concern per `three-tier-architecture-v2.md` §6.1 (line 722) and `docs/plans/free-cli-adoption/17-replay-testing-and-decision-receipts.md:31-38`. The threat model is "a writer in `.interlinked/` already has worse options than tampering this log," so adding a chained ledger here doesn't move the security needle locally — it just duplicates Guardrails infrastructure.

### 10.4 Stage 4/5 cascade on a degraded cloud

**Risk:** Cloud unreachable → Stage 4-Post collects a `failed` or `timeout` receipt → confidence stays low → every subsequent PreToolUse also spawns → cascade of failed cloud calls and pending-receipt noise.

**Scoping note.** This subsection is the canonical fail rule for Stage 4's **language-model subchannels** — the typed-signal classifier and the Tier 3 live-feedback supermodel. `cloud-local-disagreement-policy.md` §6 ("fail-degraded" with automatic sensitivity bump on cloud outage) is explicitly scoped to the deterministic cloud-mirror layer per its newly-narrowed §1 scope statement and its §6 "Scope" paragraph; the two docs are not contradictory. The split is intentional: parity-mirror failure is a meaningful absence (same rule pack didn't run in both places, so the local verdict is the only verdict and should be ratcheted), while language-model channel failure produces no parity-mirror verdict to compare against and falls through to the deterministic floor that T1 already enforced at PreToolUse.

**Mitigation:** per-check failover, not a cohort-level circuit breaker. Suppressing Stage 4/5 wholesale would treat a cloud secret-scanner the same as a cloud taste-check, which is exactly the conflation `three-tier-architecture-v2.md` §6.3 is written to prevent.

1. **Stage 4-Pre's typed-signal spawn is fire-and-forget on the local process.** Its on-process cost is bounded at ~10–50ms regardless of cloud health; the receipt write is what matters. Stage 4-Pre never blocks waiting for the cloud. The Tier 3 live-feedback spawn lives at Stage 4-Post (its input includes the landed tool output, per §9.13), so it does not factor into Pre-side cloud-health behavior.
2. **Failed Stage 4-Post collections produce `verdict: null` with `confidence_delta: {}` (no trust, no caution — neutral)** and the original tool call is unaffected because T1 already passed. This is *analogous to* Category D in `cloud-local-disagreement-policy.md` §2 (infrastructure failure, not a verdict) — but per the scoping in that doc's §1 / §6, the canonical fail-degraded rules there govern the deterministic cloud-mirror layer only, not the Stage 4 language-model channels covered here. Stage 4 LM-channel failures are governed by this subsection (§10.4) end-to-end; the cross-reference to Category D is meant to surface the failure-class taxonomy, not import the disagreement-policy doc's fail-degraded posture.
3. Per `pre-post-pipelined-cloud-checks-and-failure-recovery.md`, the cloud check pipeline is never load-bearing for tool latency; the receipt store at `.interlinked/checks/<receipt_id>.json` carries the durable state.
4. **Per-check failover, scoped to the canonical failure split.** Each cloud check is tagged `safety_critical: true | false` at registration (same annotation surface as the Cedar `@safety_critical("true" | "false")` policy meta in `three-tier-architecture-v2.md` §6.3, lines 763–766). The harness reacts to failure on a per-check basis, but *which* fail-rule applies depends on where the failure happened — the local preflight that decides whether to call the classifier at all, or the remote classifier itself. This is the same split the Stage 4 invariants block in §3 now spells out, and it is canonical per `three-tier-architecture-v2.md` §6.3 (lines 752–766) and §6.4 (lines 838–853).
   - **Local preflight failure — fail-conservative (always; never suppressed).** When the PII/secret scanner errors or the redactor cannot produce a redacted form, the harness has no safe basis to decide what backend the input should reach. Per `three-tier-architecture-v2.md` §6.4 (lines 842–853): scanner failure ratchets the routing data class to `HighlyConfidential` and restricts eligibility to `local_private` backends only; redactor failure aborts the affected channel's cloud call entirely on every backend including `local_private`. This is the only path in Stage 4 that fail-classifies-as-conservative. **Preflight runs once per cloud call, at the stage that issues that call** (per the §3 invariants block): the typed-signal classifier's preflight runs at **Stage 4-Pre**, the Tier 3 live-feedback supermodel's preflight runs at **Stage 4-Post** (its input includes the landed tool output and is not assembled until Post). A preflight failure therefore aborts only the channel whose call it gates — a Pre-side scanner/redactor failure suppresses the typed-signal channel, a Post-side scanner/redactor failure suppresses the live-feedback channel; the other channel is unaffected. It is **never** suppressed by repeated failure: a scanner that keeps crashing keeps producing `HighlyConfidential` routing, and a redactor that keeps crashing keeps aborting the affected channel's call. The hook return is unaffected (T1 already applied and the tool proceeds — at PreToolUse for the typed-signal channel, at PostToolUse for the live-feedback channel, where the tool has already run regardless); the conservative rule protects only the routing layer's privacy boundary, not the tool's go/no-go.
   - **Remote cloud-call infrastructure failure — fail-open (applies to BOTH Stage 4 subchannels; per `three-tier-architecture-v2.md` §6.3, lines 757–758).** For either the typed-signal classifier OR the Tier 3 live-feedback supermodel: backend unreachable after trust-class-and-data-class failover, call timeout, malformed schema-constrained response, or §4.11 budget exhaustion all produce a null verdict on that subchannel with `confidence_delta: {}` and no Cedar decision from that call. This applies uniformly to safety-critical and advisory checks — the canonical fail-mode matrix does not distinguish "safety-critical classifier infrastructure outage blocks the tool" from "advisory classifier infrastructure outage skips the check." Both subchannel failures are logged to `.interlinked/policy-misses.jsonl` per `three-tier-architecture-v2.md` §6.1, tagged with the subchannel id (`typed_signal` or `tier3_live`). **When a `typed_signal` collection fails at Stage 4-Post, Stage 4-Post immediately schedules a Tier 3 live-feedback invocation for the same event** as the T2-fail-open fallback (per §9.13 Trigger). The Tier 3 receipt is minted at Post (same flow as the periodic path), input is composed from this event's `pre_event + tool_output + landed_diff + recent_trajectory`, and the supermodel reviews the just-failed event — not a next event. The fallback bypasses the §6 prose-lane skip algebra (prose confidence is unrelated to classifier-availability gaps); see §6's two split rows for "T3 live feedback supermodel (periodic)" vs "T3 live feedback supermodel (T2 fail-open fallback, unskippable)". T1's deterministic floor — which already passed at PreToolUse for the current event to have reached Stage 4 — remains the safety contract; cloud infrastructure outages on either channel do not retroactively undo that decision, and the Stage 4-Post verb-scoping rule in §3 means there is no Cedar verb at Post-side that could block the call that just ran. The "safety-critical fail-classify-conservative" rule applies to local preflight, not to remote infrastructure outages. Per-channel SLOs and budgets are tracked independently — a typed-signal classifier outage does not suppress live-feedback invocations and vice versa.
   - **Advisory-check repeated-failure suppression — bounded, reversible, and orthogonal to the above.** An advisory check (`safety_critical: false`) — e.g., the cloud taste/style/architectural-smell reviewer, the cloud diff-mutation tester, cloud naming-convention probes — that fails N consecutive times for infrastructure reasons within a session (default N = 3, configurable per check) is suppressed for the remainder of that session. On suppression, the harness emits one user-visible warning (`[interlinked:cloud-degraded] check <id> suppressed after N failures — advisory only, safety checks still active`) and a single `policy-misses.jsonl` entry per `three-tier-architecture-v2.md` §6.1. Safety-critical checks are **never** suppressed by repeated failure — even when their backend is unreachable, the harness keeps attempting them on every event so that recovery is automatic the moment the backend returns. No further warnings until session end or `interlinked verify --resume-cloud-checks <id>` per the existing override surface. The suppression is "skip the attempt"; the canonical fail-open behavior already applies on the underlying failures, so suppression does not change the verdict shape, only the noise.
5. **No cohort-level kill switch.** The "shut down a whole tier after N failures" mechanic is explicitly out of scope — both `feedback_safety_continuity.md` ("no circuit breakers on safety layers") and the §9 disclaimer of `cloud-local-disagreement-policy.md` ("Not a circuit breaker. No 'stop calling cloud after N failures' mechanic… safety layers fail-open on infra problems but stay alive — they don't get shut down") rule it out. Per-check suppression of advisory checks is bounded and reversible; tier-level suppression of safety checks is not on the table.
6. Trajectory-sensitivity escalation from `cloud-local-disagreement-policy.md` §5b still applies when a safety-critical check fail-classifies-conservatively without an authoritative cloud verdict: the session's `sensitivity_level` bumps one tier, raising scrutiny on the next destructive operation.

---

## 11. Open questions

1. **Where does `StageOutput` live in the source tree?** Proposal: `src/harness/check-engine/types.ts`. Alternatives: `src/harness/types.ts` (current home for shared types). Decision needed before §5 schema lands.
2. **Skip threshold config: per-check or per-tier?** Proposal: per-check with optional per-tier defaults. Alternative: per-tier only, simpler but coarser.
3. **What is the canonical `cohort_healthy` signal source?** Proposal: `src/harness/cohort.ts` exposes a derived health score from recent failure rate + heartbeat regularity. Needs spec.
4. **`P_sample` default values.** Proposal: 0.02 (Stage 4), 0.05 (Stage 5). Tune from observed miss rate over the first month of operation. Worth pre-registering tuning thresholds.
5. **Coverage-manifest format and refresh cadence for Change-Risk-Anti-Patterns composite.** Proposal: refreshed by `interlinked coverage refresh` (manual or CI-triggered), not on hook. Schema in §9.3 is a starting point.
6. **Should PreToolUse `HARNESS_PRE_TIMEOUT_MS` grow from 5s to align with the 30s portable target?** Open question — depends on cross-provider variance. PostToolUse is mode-based 30/50/60s already; PreToolUse staying at 5s forces Stage 2 to be tighter than Stage 3, which is the intended design.
7. **Per-stage caching strategy.** The existing `check-engine/` has caching; integrating with `StageOutput` and `confidence_delta` may require schema changes. Out of scope for this doc; flag for a follow-up.
8. **How does the user disable the entire skip-logic system?** Proposal: `INTERLINKED_NO_SKIP=1` env var forces all triggered checks to run. Useful for debugging and CI parity.

---

## 12. Rollout phases

Sequenced so each phase is independently shippable and reversible.

**Phase A — Per-stage output schema (no behavior change)**
1. Add `StageOutput`, `SignalSummary` types at `src/harness/check-engine/types.ts`
2. Wire existing aggregation to produce `confidence_delta: {}` (empty per-lane map) and `signal_summary: {}` for every Stage 0–5 (no skip logic yet). Stage 6 is outside this per-event stage aggregator and emits dedicated outputs separately — `Tier3ReviewOutput` per §5a, the multi-agent synthesis output owned by `multi-agent-pre-push-review.md` (§9.9), and the per-scanner adapter outputs proposed in §12 Phase G.
3. Land schema validation tests under `src/harness/__tests__/stage-output.test.ts`

**Phase B — Confidence accumulation (shadow only)**
1. Implement `confidence_score` per §6 — pure function, deterministic
2. Each existing check declares its `confidence_delta` contribution per §6 table
3. Emit confidence to `.interlinked/skip-decisions.jsonl` but do NOT skip yet
4. Add `interlinked confidence show` command to inspect current session score

**Phase C — Skip logic for Stage 4 (cheap escalations)**
1. Wire `needs_check` per §6 for Stage 4 checks only
2. Skip receipts emitted to agent and logged
3. Random sampling (`P_sample = 0.02`) enabled
4. Calibration loop runs out-of-band (weekly batch) to surface "we should have run it" misses

**Phase D — Skip logic for Stage 5 (deep gates)**
1. Extend skip logic to Stage 5 checks
2. `P_sample = 0.05` for sampled-in runs
3. Per-project `.interlinked/skip-thresholds.json` overrides supported

**Phase E — Proposed new checks, one at a time**
1. Cross-agent prediction (§9.1) — Stage 1
2. Test-outcome prediction (§9.2) — Stage 2
3. Change-Risk-Anti-Patterns composite (§9.3) — Stage 2
4. Surprise score (§9.5) — Stage 3
5. Diff-mutation testing (§9.6) — Stage 5 (rollout caps at `ack_required`; no `enforced` mode at Stop per `stop-event-checks.md:5-15`)
6. Remaining Stage 5 checks: counterfactual Graph Prediction (§9.7), property-based testing (§9.10), patch-level cloud review (§9.11), transitive prediction K hops (§9.12)
7. Tier 3 live feedback supermodel (§9.13) — Stage 4-Post, sequenced after the typed-signal classifier infrastructure (Phase B/C, plus the implementation steps in `three-tier-architecture-v2.md` §12 steps 1–11) so the two channels share the redaction / preflight / trust-class machinery, the independent receipt model, and the `additional_context` delivery channel. Lands before pre-push Tier 3 (next bullet) so the Tier 3 implementation track lands in dependency order.
8. Tier 3 prose-policy review at pre-push (§9.8) — Stage 6, sequenced after the Tier 3 live feedback work (above) so the Tier 3 implementation track lands in dependency order; see `tier-3-async-deep-review.md` "Implementation order" at the bottom of that memo.
9. Multi-agent debate / synthesis at pre-push (§9.9) — Stage 6, sequenced after the Tier 3 prose review work since they share the pre-push fan-out infrastructure (per-user Sandbox, `.interlinked/reviews/` output store, warn-only contract). See `multi-agent-pre-push-review.md` for the canonical pre-push design.

Each new check lands in `shadow` mode behind a flag in `.interlinked/feature-flags.json`. Promotion to `soft_gate` requires explicit go/no-go from observed shadow-mode data. Promotion to `enforced` for Stages 0–4 (and to `ack_required` for Stage 5) requires a regression test that exercises the gate. Stage 6 checks are **default warn-only**; the local opt-in `block_on_critical` setting (per `tier-3-async-deep-review.md:341`) is the only path to a local block on critical findings, and the Agent CI hard gate (per `multi-agent-pre-push-review.md`) is a separate product surface — not a promotion of the local Stage 6 mode. Canonical phrasing throughout: "default warn-only; local opt-in `block_on_critical`; Agent CI hard gate is a separate surface."

**Phase F — Calibration automation**
1. Periodic batch job analyzes `.interlinked/skip-decisions.jsonl` for `was_overridden=true AND override_finding_severity in {error, block}`
2. Auto-proposes threshold or `P_sample` updates as a PR-shaped diff against `.interlinked/skip-thresholds.json`
3. Human reviews and merges; no auto-apply

**Phase G — External scanner adapters (deferred; scope TBD)**
1. External-scanner integrations (CodeQL, OSV-Scanner, OWASP Dependency-Check, Trivy, etc.) as a separate Stage 6 output stream rather than wedged into Stage 5. Scanner outputs are richer and noisier than `Tier3ReviewOutput` and benefit from per-scanner adapters — output schema is per-scanner; design needs its own memo before implementation.
2. Sequenced after Tier 3 prose review (§9.8), multi-agent synthesis (§9.9), and Phase F calibration. The Stage 6 surface (pre-push hook + on-demand) is the natural home — same warn-only contract at the Free CLI surface, same hard-gate option at the Agent CI surface.
3. Out of scope for the multi-round handoff; tracked here so implementors don't try to fit scanner adapters into the Stage 5 deep-gate slot or into the `Tier3ReviewOutput` shape.

---

## 13. What's explicitly out of scope

- **The Tier 2 cloud architecture itself.** This doc references Stage 4 but the cloud worker, AI Gateway proxy, prompt design, etc. are in `three-tier-architecture-v2.md` (the v2 spec — typed-signal classifier + Cedar adjudication). The earlier `tier-2-llm-policy-gate.md` draft is historical and is superseded by v2; see §1.
- **The Tier 3 prose-policy review architecture.** Referenced as a Stage 6 pre-push and on-demand check (default warn-only with opt-in `block_on_critical` for critical findings); full spec in `tier-3-async-deep-review.md`. Previous drafts of this doc placed Tier 3 under Stage 5 / Stop; that placement was corrected in the 2026-05-20 second-round review.
- **The Pre → Post receipt-threading mechanism.** Used by Stage 4 but specified in `pre-post-pipelined-cloud-checks-and-failure-recovery.md`.
- **The deterministic escalation evaluator's rule format.** Used in Stage 3; specified in `escalation-rules.md`.
- **The cloud-local disagreement policy.** Specified in `cloud-local-disagreement-policy.md`. Per its newly-narrowed §1 / §6 scope statement, the doc covers the **deterministic cloud-mirror layer only** — the same rule pack (tsc / biome / semgrep / structural checks) executed in both places against the same diff. The policy does **not** govern Stage 4's language-model channels (typed-signal classifier and Tier 3 live-feedback supermodel); their fail / disagreement semantics live in §10.4 of this doc and `three-tier-architecture-v2.md` §6.3. Use the disagreement-policy doc for parity-mirror logic, this doc's §10.4 for Stage 4 LM-channel logic.
- **Stage 6 async checks.** Listed for completeness; not specified here. Belong in CI / push-hook design.
- **The `interlinked deep-gate --force` override command implementation.** Mentioned in §6 skip receipts; command surface needs its own spec.

---

## 13a. Reconciliation notes — considered and out of scope

Ideas explored while drafting this synthesis that conflict with a canonical
design memo. Recorded here so they don't re-surface as fresh proposals.

### 13a.1 Heuristic-oracle bootstrap for Graph Prediction Protocol Cases B/D

**The idea.** Earlier drafts of this doc proposed a Stage 2 check that, when
the authoritative Supermodel shard is missing (Case B — unindexed) or stale
(Case D — shard predates source), would synthesize a "tier-C" shard via
tree-sitter parse + `src/harness/project-graph.ts` import resolution. The
synthetic shard would feed the predict → reveal → reconcile loop on every
edit instead of only on Case E-fresh, dramatically widening calibration
coverage. Even with the synthetic oracle flagged tier-C, agents would still
receive predict/reveal/reconcile signal across the long tail of files the
daemon hasn't indexed yet.

**Why it's appealing.** Predict/reveal/reconcile coverage in the current
shipping design is gated on a fresh authoritative shard. On a cold or
partially-indexed repo, that gate is closed for most edits — the calibration
substrate is sparse. A synthetic oracle would fill that substrate cheaply,
using infrastructure the harness already depends on.

**Why `graph-prediction-protocol.md` v1.2 rejected it.** The canonical Graph
Prediction Protocol design (see `graph-prediction-protocol.md:25-34` for the
v1.2 changelog and `graph-prediction-protocol.md:118-129` for §3.4 and its
rationale paragraph) explicitly narrowed the protocol to Case E-fresh ONLY,
demoting Cases B, D, and E-stale to silent observation. The rationale is
load-bearing, not stylistic: "PreToolUse can't ask for a prediction without
blocking — we either run the full protocol or none of it. Running it against
non-authoritative oracles trains the wrong reflex." A tier-C synthetic shard
is, by definition, a non-authoritative oracle. Even shadow-mode-only
rollout — the soft escape hatch proposed in earlier drafts of §9.4 — still
trains the agent's calibration against a fabricated oracle whenever the
agent reads the reconciliation output, which defeats the canonical doc's
narrowing decision.

**Why "tier-C, shadow only initially" doesn't reconcile the conflict.** The
canonical doc rejected the scope expansion itself, not just the enforcement
mode. Shadow mode controls whether the harness blocks; it does not control
whether the agent calibrates against the signal. The canonical doc's
position is that the calibration target must remain authoritative-only, full
stop.

**Related failure mode now also out of scope.** An earlier §10.5 documented
"synthetic-oracle drift" — the failure mode where agents calibrate against a
synthetic shard, build a wrong world model, and then fail when the
authoritative shard arrives. That failure mode was specific to the
heuristic-oracle bootstrap and is removed alongside it.

**What would have to change in the canonical doc before this could be
revisited.** Either (a) `graph-prediction-protocol.md` §3.4 retracts the
"authoritative-only" rule, or (b) a separate canonical memo establishes a
read-only calibration channel that surfaces tier-C signal to the
reconciliation log without surfacing it to the agent's PreToolUse / PostToolUse
context — i.e., the synthetic oracle would feed `.interlinked/graph-reconciliations.jsonl`
for offline analysis only, with no per-edit reveal. (b) is the more tractable
path; it would need its own design memo before any work here.

**Pointer.** Canonical narrowing decision: `graph-prediction-protocol.md`
v1.2 changelog item 1 (line 26) and §3.4 (lines 118-129).

---

## 14. Cross-references

### Existing design memos this composes with

- `three-tier-architecture-v2.md` — backbone tier model
- `pre-post-pipelined-cloud-checks-and-failure-recovery.md` — Pre → Post pipelining contract, receipts
- `three-tier-architecture-v2.md` — Stage 4 typed-signal classifier plus Cedar adjudication (supersedes `tier-2-llm-policy-gate.md`)
- `tier-3-async-deep-review.md` — Stage 6 prose-policy review at pre-push (auto) and on-demand (`/review`, `/security-review`, `/ultrareview`); default warn-only with opt-in `block_on_critical`; Agent CI hard gate as separate surface
- `escalation-rules.md` — Stage 3 deterministic synthesis
- `cloud-local-disagreement-policy.md` — deterministic cloud-mirror verdict merging (the same rule pack run locally and in cloud; does not govern Stage 4 LM channels — see §13)
- `graph-prediction-protocol.md` — Stage 2 predict-reveal-reconcile
- `graph-prediction-verification-status.md` — current state and probes
- `stop-event-checks.md` — Stage 5 backlog
- `incremental-posttooluse.md` — Stage 3 latency optimization
- `multi-agent-pre-push-review.md` — related multi-agent architecture (§9.9)
- `decision-surface-metric.md` — related metrics framework

### Source files referenced

- `src/harness/server.ts` — Unix socket entry, dispatches to evaluator and stage logic
- `src/harness/evaluator.ts` — re-export root module for guard evaluator functions
- `src/harness/evaluator/pre-tool.ts` — guard evaluator for PreToolUse events; exports `evaluatePreToolUse`
- `src/harness/evaluator/post-tool.ts` — guard evaluator for PostToolUse events; exports `evaluatePostToolUse`
- `src/harness/server/pre-tool-pipeline.ts` — PreToolUse orchestration pipeline (entry: `runPreToolPipeline`); runs Stages 0, 1, 2 deterministic checks plus the Stage 4-Pre typed-signal classifier spawn (fire-and-forget receipt mint when in scope) and Tier 3 live-feedback eligibility evaluation (periodic-trigger check only — no spawn here, eligibility flag forwarded to Post per §3 / §9.13)
- `src/harness/server/post-tool-pipeline.ts` — PostToolUse orchestration pipeline (entry: `runPostToolPipeline`); runs Stages 1, 2 (re-run for the Post surface — Stage 0 instant-disqualifiers are PreToolUse-only per §3, since they gate an action that has already happened by Post), Stage 3 (local expensive deterministic), and Stage 4-Post (typed-signal classifier collect + Cedar evaluation against the Pre-side classifier receipt, AND Tier 3 live-feedback mint + scanner+redactor preflight + supermodel spawn + collect when the eligibility flag is set from Pre OR T2 fail-open is detected on typed-signal collection)
- `src/harness/server/post-tool-file-checks.ts` — per-file check body for the PostToolUse orchestration
- `src/harness/server/lifecycle-events.ts` — Stop / SubagentStop / SessionEnd handler (entry around line 185); runs Stage 5 deep gates (when configured) and the stop-event reflection helpers from `verification-stop-checks.ts` / `commit-cadence.ts`
- `src/harness/check-engine/` — caching layer; new home for `types.ts` per §5 and for the shared `stage-aggregator.ts` proposed below
- `src/harness/quality-checks.ts` — Stage 3 tool wrappers (TypeScript compiler, biome, etc.)
- `src/harness/checks/tier3-live-feedback.ts` (proposed, Phase E bullet 7 per §12; §9.13) — Tier 3 live-feedback check entry point: periodic-trigger evaluation at Stage 4-Pre (no spawn); at Stage 4-Post, compose input (`pre_event + tool_output + landed_diff + recent_trajectory`), run preflight, mint receipt, spawn supermodel, bounded wait, render `LiveFeedbackOutput` to `additional_context`. Same-event T2-fail-open fallback path also lives here
- `src/harness/cloud/supermodel.ts` (proposed, Phase E bullet 7; §9.13) — cloud caller for the Tier 3 supermodel (Sonnet 4.6 default; Opus 4.7 on opt-in); reuses the shared `ClassifierBackend` trust-class failover and the §6.4 preflight
- `src/harness/checks/tier3-evidence-bridge.ts` (proposed, Phase E bullet 7; §9.13) — synthetic-evidence emitter: maps `LiveFeedbackFinding` with `severity: "critical"` to a typed `EvidenceSignal` (`T3LiveCriticalFinding`) for the next PreToolUse Cedar evaluation when `tier3.live_feedback.block_on_critical: true`
- `.interlinked/classifier-log/<session-id>.jsonl` (proposed, runtime artifact) — per-session typed-signal classifier output log (`ClassifierResult` rows; cache-observability auditing)
- `.interlinked/live-feedback-log/<session-id>.jsonl` (proposed, runtime artifact; §9.13) — per-session Tier 3 live-feedback output log (`LiveFeedbackOutput` rows); distinct from `classifier-log/` because the two channels produce different output shapes
- `src/harness/structural-checks.ts` — 25 Stage 3 checks
- `src/harness/checks/<family>.ts` — 50+ inline Stage 3 checks
- `src/harness/rules-loader.ts` — Stage 0/1 guard rules (110 built-in)
- `src/harness/reservations.ts` — Stage 0 file reservations; will carry predicted-post-state for §9.1
- `src/harness/large-file-policy.ts` — Stage 0 line-cap policy
- `src/harness/cohort.ts` — multi-agent session tracking; canonical source for cohort_healthy signal
- `src/harness/recurrence.ts` — recurrence aggregator; feeds confidence score
- `src/harness/grep-accelerator.ts` — Stage 1 trigram grep
- `src/harness/project-graph.ts` — composed by Stage 2 test router and existing graph-prediction modules
- `src/harness/verification-stop-checks.ts` and `src/harness/commit-cadence.ts` — existing Stage 5 stop-event nudges
- `.interlinked/graph-reconciliations.jsonl` — Stage 2 observation log; consumed by §9.5 surprise score
- `.interlinked/recurrences.jsonl` — Stage 3 recurrence log
- `.interlinked/skip-decisions.jsonl` — NEW; written by skip logic per §6
- `.interlinked/skip-thresholds.json` / `.interlinked/skip-thresholds.local.json` — NEW per-project config
- `.interlinked/mutation-log.jsonl` — NEW for §9.6
- `.interlinked/mutation-config.json` — NEW for §9.6
- `.interlinked/coverage-manifest.json` — NEW for §9.3
- `.interlinked/feature-flags.json` — NEW for §12 rollout

### User-facing commands proposed

- `interlinked confidence show [--session <id>]` — display current confidence score and signal breakdown
- `interlinked deep-gate --check <id> --force` — override a skip and run the named Stage 5 check
- `interlinked deep-gate --check <id> --skip` — manually skip the named Stage 5 check (for testing or known-good edits)
- `interlinked coverage refresh` — refresh `.interlinked/coverage-manifest.json` for Change-Risk-Anti-Patterns
- `interlinked checks show <receipt_id>` — already in `pre-post-pipelined-cloud-checks-and-failure-recovery.md`; referenced here for Stage 4 receipt fetching

---

## 15. Implementation checklist for the handoff agent

Concrete entry points for someone picking up this work:

- [ ] Read §5 schema. Implement `StageOutput`, `SignalSummary` at `src/harness/check-engine/types.ts`.
- [ ] Introduce a shared stage-aggregator at `src/harness/check-engine/stage-aggregator.ts` that builds `StageOutput` from `CheckResult[]`. The aggregator is the single per-event stage-output path called from **all three** Stage 0–5 surfaces:
  - `runPreToolPipeline` (`src/harness/server/pre-tool-pipeline.ts`) for Stages 0/1/2 + Stage 4-Pre
  - `runPostToolPipeline` (`src/harness/server/post-tool-pipeline.ts`) for Stages 1/2/3 + Stage 4-Post (Stage 0 is PreToolUse-only per §3 — its disqualifiers gate an action that has already executed by Post)
  - Stop / SubagentStop / SessionEnd handler in `src/harness/server/lifecycle-events.ts` for Stage 5

  Produce neutral `confidence_delta: {}` (empty per-lane map) for every Stage 0–5 at first; no behavior change yet. Stage 6 is outside the per-event stage aggregator; its dedicated outputs — `Tier3ReviewOutput` per §5a, the multi-agent synthesis output owned by `multi-agent-pre-push-review.md`, and the per-scanner adapter outputs deferred to §12 Phase G — are emitted by the pre-push surface and consumed by the `.interlinked/reviews/` filesystem store rather than by this aggregator.
- [ ] Add `confidence_score` pure function at `src/harness/check-engine/confidence.ts`. Tests cover the per-lane algebra in §6 and the per-lane clamping at `[0, 1]`.
- [ ] Add `.interlinked/skip-decisions.jsonl` writer. Append-only, never read back in the same process (read by `interlinked confidence show` only).
- [ ] Implement `interlinked confidence show` command at `src/commands/confidence.ts`.
- [ ] Run the test suite. The existing suite should all still pass — Phase A is schema-only and should not change behavior. (Run `npx vitest run` for the current pass count rather than relying on a number quoted here; counts drift as checks land.)
- [ ] Open a PR titled `feat(harness): per-stage output schema (Phase A)` and request review before proceeding to Phase B.

The doc is intended to be self-contained for Phase A; Phase B and beyond should each get their own design discussion or worked example before implementation.
