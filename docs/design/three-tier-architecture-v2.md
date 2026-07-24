# Three-Tier Policy & Quality Architecture — Revision 2

**Status:** Draft (2026-05). Captures decisions from conversation on 2026-05-12. Supersedes major sections of `tier-2-llm-policy-gate.md` and expands `tier-3-async-deep-review.md`. Net effect: a single canonical doc that captures the architecture we actually want to build, with attribution to where each decision came from.

**Revisions:**
- **Patch 2026-05-12 (post-critique):** added §3.2 "Existing surfaces — reference, don't duplicate"; §4.10 PostToolUse matcher constraint callout; §5.6 T3 reliability backoff; §6.1 deferral to doc 17 for receipt mechanics; §10 CanonicalMessage IR + golden tests; §14 open decision 11; §15 "Preserves scope from" subsection; new §18 RFC on typed classifier backends. Bayesian per-event classifier split routed to RFC, not adopted — see §18 for the five obstacles to adoption.
- **Patch 2026-05-12 round 2 (security/safety review):** added §4.2a logging-vs-evaluation invariant + deterministic low-risk predicate; §4.4 prompt-cache observability requirement; §4.6 backend trust classes + failover policy; §4.9 LLM-as-action split into advisory-default and authoritative-opt-in; §6.1 retention tiers; §6.3 Cedar fail-mode split (safety-critical vs non-critical); new §6.4 secret-safe telemetry contract; new §7.5 deterministic-vs-semantic blocking criteria for quality findings; §14 open decisions 12-13. No prior section content removed; net additive.
- **Patch 2026-05-12 round 3 (consistency review):** internal contradictions fixed — §4.3 trajectory entries are now redacted + `raw_ref` not verbatim (was contradicting §6.4); §4.9 first config example no longer lists `halt_session` as a `direct` advisory verb (was contradicting the L405+ tightened contract); §6.4 span hashes upgraded to keyed HMAC-SHA256 with explicit equality scope (raw SHA-256 was dictionary-attackable on small spaces like emails / phone numbers); §6.4 data-class routing pinned to a deterministic preflight order (content scanner → file sensitivity → path rules → session taint), with LLM allowed to ratchet up only after the routing decision is locked. Code-citation drift fixed — §4.10 PostToolUse matcher claim aligned to actual `src/lib/hook-installers.ts` state (empty matcher = every tool; `postToolUseFailure` registered for Cursor); §10 Codex `additional_context` claim corrected (Codex routes to stderr, not a model-visible JSON channel); §3.2a `WebFetchOutput` corrected to actual extractor coverage (`WebFetch / web_fetch / WebSearch / mcp__*`). Cedar idiom fixed — warn/feedback examples in §4.8, §4.10, §7.5 converted from `permit` to annotated `forbid` per `interlinked-cedar-extensions.cedarschema:72` (annotation extends forbid semantics). §4.2a low-risk predicate tightened — Bash file-reading dropped from skip-eligibility since the OPF post-scan only covers `Read`/`Grep`/`Glob` and not Bash output. §15 AGENTS.md:35 callout adjusted with the same correction. Net additive in fixes, net reductive in stale claims.
- **Patch 2026-05-12 round 4 (schema/interface hardening):** §3.1 T1 latency target scoped to PreToolUse deterministic gate (was overstated against PostToolUse 14-45s/Edit per `docs/design/incremental-posttooluse.md:5`). §4.6 `ClassifierBackend` interface expanded with `trust_class`, response metadata (cache-hit, actual tokens / latency / cost), and `supported_data_classes` so backend selection can enforce the §6.4 routing contract. §6.4 scanner/redactor failure policy made explicit (conservative: fail-classify-as-HighlyConfidential, never silently as Public). §12 implementation order: new step 4 inserts redaction + HMAC span IDs + data-class preflight + backend eligibility check BEFORE any hosted-endpoint classifier spike, so raw content can't ship to remote inference before the secret-safe contract exists. Cedar annotation vocabulary unified: §4.8 / §4.10 / §12 / `interlinked-cedar-extensions.cedarschema` all use one canonical shape — `@action_on_violation("warn" | "block" | "ask" | "inject_feedback" | "halt_session")` for action semantics, separate `@safety_critical("true" | "false")` for fail-mode meta. Schema file updated to document both. §7.5 last quality example: warn-shaped rule converted from `permit` to annotated `forbid`; "Relax CQ4-in-tests" rewritten using `unless` clause inside the forbid predicate (a permit can't override a matching forbid under Cedar's deny-overrides-permit semantics). §4.10 feedback delivery: framing tightened to "model-visible where supported, stderr otherwise" (matches §10's per-runner reality).
- **Patch 2026-05-12 round 5 (residual consistency review):** §6.4 redactor-failure resolution unified — redactor failure means **no classifier call at all** (verdict is null, trajectory still logs with `raw_ref`, T1 still applies); the prior "restricts to local_private" wording at §12 step 4 was reconciled to the same rule. §4.8 stray `@halt_session` annotation reference removed (the annotation is now `@action_on_violation("halt_session")` per the schema). §4.8 `rewrite | soft_block` removed from the Sondera-differences list — those are runner-side decision primitives, not Cedar `@action_on_violation` vocabulary; only `warn | block | ask | inject_feedback | halt_session` is canonical now. §4.4 `ClassifierResult.metadata` split into a discriminated union: per-event classifiers emit `{kind: "per_event", content_hash, ...}`; trajectory classifiers emit `{kind: "trajectory", prefix_hash, delta_hash, ...}`. Per-event implementers no longer need to fabricate a "prefix" field. §6.4 HMAC key rotation contract specified: rotation issues a new `key_id`; old keys retained for a configurable window (default 90 days) so log rows keyed with the old id stay correlatable; log rows always include `key_id`. §4.6 default-failover wording corrected to "next *eligible* backend after trust-class and data-class filtering"; the prior phrasing read as if any configured backend could be a failover target. §5.1 supermodel feedback delivery mirrors the §10 caveat (next-turn JSON visibility only on Claude Code / Cursor; stderr fallback otherwise). §4.4 compaction language: "keeps the recent **redacted** events verbatim" — no raw event content is preserved verbatim anywhere outside `.interlinked/audit-raw/` per §6.4.
- **Patch 2026-05-12 round 6 (evidence-ledger consistency):** fixed remaining stale references around classifier metadata logging, backend failover eligibility, audit-key storage, T3 cloud input redaction, and LLM-as-action authority. Adopted Jeffrey's negative-evidence ledger family as a local v2 primitive: valence-tagged signals in Cedar context, explicit `InsufficientEvidence` classifier outcome, absence-as-evidence Tier 1 signals, `.interlinked/rule-outcomes.jsonl`, and user-invoked `/enforce outcomes` / `auto-demote` / `auto-invert` lifecycle commands. The implementation plan now points to `docs/plans/free-cli-adoption/20-negative-evidence-ledger.md`.

**Audience:** Future-you sitting down to build any of this. Whoever picks this up should be able to read this one doc and have the full picture.

**Replaces / supersedes (see §15 for line-by-line):**
- `docs/design/tier-2-llm-policy-gate.md` — fundamental redesign (LLM-as-adjudicator → LLM-as-classifier). Most of the old doc is contradicted.
- `docs/design/tier-3-async-deep-review.md` — expanded scope. The pre-push surface stays; we add a live cloud-feedback surface.
- `skills/enforce/SKILL.md` §15 routing table — needs revision once this lands; Pass 2 entries change shape from "policy.md as adjudication prose" to "policy.md as classification taxonomy".
- `~/.claude/projects/-Users-quentincody-interlinked-cli/memory/project_three_tier_policy_enforcement.md` — update summary to reflect new framing.
- `~/.claude/projects/-Users-quentincody-interlinked-cli/memory/project_llm_policy_enforcement.md` — framing shift from "policy escalation layer" to "typed-label classifier feeding Cedar".

**Companion docs (still valid):**
- `docs/design/cloud-local-disagreement-policy.md` — parity invariant + sync/async regime, applies regardless of T2 design.
- `docs/design/harness-active-when-scoping.md` — trajectory-axis scoping is in scope for T2 trajectory classifier.
- `docs/design/interlinked-cedar-extensions.cedarschema` — Cedar extensions, keep.
- `~/.claude/projects/-Users-quentincody-interlinked-cli/memory/reference_sondera_products_two_repos.md` — Sondera's two repos and architectural distinction.
- `docs/design/runtime-pipeline-staging.md` — names the explicit seven-stage pipeline (Stages 0 through 6) + confidence-based skip logic; Tier 2 corresponds to Stage 4 (split across PreToolUse Stage 4-Pre and PostToolUse Stage 4-Post). Tier 3 has **two runtime surfaces** per v2 §5.1: (a) **live-feedback Tier 3 (Surface 1)** corresponds to **Stage 4-Post** — the supermodel runs alongside the typed-signal classifier on the v2 §5.4 selected subset, emits typed prose findings (`LiveFeedbackOutput` per `runtime-pipeline-staging.md` §9.13), and surfaces them as PostToolUse `additional_context` during agent work; (b) **pre-push Tier 3 (Surface 2)** corresponds to **Stage 6** (git pre-push hook auto-invocation plus on-demand `/review`, `/security-review`, `/ultrareview`; warn-only by default per `tier-3-async-deep-review.md`). The Stage 5 placement in earlier drafts was for the pre-push Surface only and was relocated to Stage 6 per `tier-3-async-deep-review.md:29` ("less frequent (per push, not per tool call), warn-only output") and `tier-3-async-deep-review.md:52` ("The natural integration point is the git pre-push hook"). Surface 1 was never a Stage 5 placement; it landed at Stage 4-Post in round 9 of the runtime-staging reconciliation cycle.

---

## 1. Why this revision exists

The original Tier 2 design (`tier-2-llm-policy-gate.md`, 2026-05 early) assumed the LLM would *directly adjudicate* — given (policy.md, trajectory, current call), return `decision: block | warn | allow`. The policy.md was a prose policy the LLM evaluated against, the same way OpenAI's gpt-oss-safeguard guide demonstrates.

A deep read of Sondera's `sondera-coding-agent-hooks` (Rust, ships gpt-oss-safeguard-20b via Ollama) showed a meaningfully better pattern: **the LLM classifies content into a typed taxonomy, and deterministic Cedar policies decide what to do with the classification.** The decision boundary stays in deterministic territory; the LLM's job is bounded to multi-class classification with JSON-schema-constrained output.

That shift is the spine of this revision. Everything else (trajectory caching, pluggable backends, code-quality extension, T3 live feedback) follows from adopting that pattern and pushing it further than Sondera does.

**Decision (user):** redesign Tier 2 around detection/decision separation. The user's exact framing: *"For the trajectory analysis, I was wondering whether or not it would be a good idea to record those types of attempts anyway and then feed all of those Tool calls and other logs into the trajectory list, and an LLM can use the full state or a subset of the logs to make another evaluation decision about whether or not a tool call should be allowed to proceed."* That trajectory-aware idea is the load-bearing addition over Sondera, who doesn't feed the sequence into their classifier.

---

## 2. Core principle: detection/decision separation

Every layer in this system maps to one of two jobs:

| Job | What it does | Examples |
|---|---|---|
| **Detection** | Take raw content/state and produce typed signals | YARA rule matches; tsc errors; LLM emits `Label::"HighlyConfidential"` or `SC8` |
| **Decision** | Take a constellation of signals and decide allow/warn/block/halt | Cedar `forbid` rules; ratchet check on metric increase; threshold composition |

**Binding rule:** Cedar / JSON GuardRule is the default final decision point. Detectors emit typed signals that flow into the decision layer; they do not directly emit final decisions. The only exception is explicitly configured authoritative LLM-as-action mode (§4.9), where the LLM emits an action only because the user granted that authority and the decision receipt records the delegation. Reason: detectors can be swapped/upgraded/retrained without changing the decision boundary; decision logic stays auditable and version-controlled, while advanced users still get an intentional fallback channel for recommendations or actions that do not fit a Cedar predicate cleanly.

This is Sondera's pattern, generalized. We apply it not just to LLM output but to every signal:
- YARA-X scan → typed `SignatureContext`
- tsc/biome/oxlint/cargo run → typed error/warning sets
- Structural checks (cycles, dead exports, blast radius) → typed graph facts
- Per-event LLM classifier → typed `Label` / category
- Trajectory LLM classifier → typed intent label
- Pre-push LLM reviewer → typed findings array

All of these feed Cedar (or our JSON GuardRule successor — see §11). Cedar decides by default; explicitly authorized LLM-as-action is the exception path.

Signals may carry an evidence envelope when the source can support it:

```ts
type EvidenceValence = "positive" | "negative" | "neutral";

type EvidenceSignal<T> = {
    id: string;
    value: T;
    valence: EvidenceValence;
    confidence: number; // 0..1 in TypeScript; basis points in Cedar context
    source: "t1" | "t2" | "t3" | "rule-outcome";
};
```

This adopts the useful part of Jeffrey's negative-evidence ledger pattern without making the LLM the judge. Cedar can compose positive evidence (tests passed, clean lint, prior fixes), negative evidence (blocked credential reads, missing verification, repeated suppressed findings), neutral observations, and `InsufficientEvidence` outcomes in one deterministic request.

**Why this matters for v2:** the original Tier 2 framing collapsed detection and decision. Re-separating them buys us composability (one classification → N rules), auditability (every decision points to a Cedar `@id`), and pluggability (any classifier that honors the JSON schema works as a drop-in).

---

## 3. Tier 1: Local Deterministic Floor

### 3.1 What's shipped (2026-05)

Per CLAUDE.md and `project_three_tier_policy_enforcement.md`:
- 110 built-in guard rules (`src/harness/rules-loader.ts`)
- 31 PostToolUse quality checks (tsc, biome, cargo, mypy, oxlint, etc.)
- 25 structural checks (export surface, import resolution, cycles, blast radius)
- 50+ inline code analysis checks across `src/harness/checks/<family>.ts`
- Trigram index for grep acceleration
- Diff-aware filtering (`incremental-posttooluse.md`)
- `SessionTrajectory` state: `tool_call_count`, `files_read`, `commands_run`, `tool_sequence`, `test_runs`, `consecutive_tool_failures`, `tdd_cycles`, `active_skills`
- Six typed `active_when` axes wired (`evaluator/active-when.ts:54`): `skill`, `phase`, `after_command`, `file_scope`, `overlay`, `agent_source`
- Distilled rules from `/enforce` Pass 1 (`distilled-rules.json` + overrides)

Target latency: sub-10ms for PreToolUse deterministic gate checks (guard rules, structural pattern matches, reservations, trigram-accelerated grep). PostToolUse quality checks (tsc / biome / oxlint / cargo / mypy, structural-graph deltas, project-graph cache lookups) have a separate budget documented at `docs/design/incremental-posttooluse.md:5` (currently 14-45s per Edit, working toward an incremental tighter budget). The sub-10ms claim applies only to the gating path, not the post-execution validation path — confusing the two leads to bad design decisions.

### 3.2 Refinements proposed (low-cost, high-value)

These don't change the architecture but tighten T1 ahead of T2 work:

1. **Promote the stubbed `predicate` escape hatch to a real dispatcher.** Per the prior conversation about deterministic trajectory analysis: `active-when.ts:70-79` currently returns dormant for any unknown predicate. Wiring the seven documented predicates (`tests_passed_recently`, `tests_run_in_session`, `last_command_was`, `file_read_in_session`, `consecutive_failures`, `last_event`, `after_command`) unlocks rules already documented in SKILL.md §6.5 without any cloud dependency. **Estimated:** ~150 lines TS + tests. Worth doing before T2 starts.

2. **Adopt YARA-X for pattern detection in the harness.** We currently use hand-rolled TypeScript regex in `src/harness/checks/<family>.ts` (50+ detectors). YARA-X is faster on large content, has a richer pattern language, and has a public rule ecosystem we can borrow from (Mandiant, Florian Roth). Replacement, not addition: deprecate TS regex detectors for new families; keep existing ones until parity proven. **Decision (Claude proposal, user agreed):** worth doing but not urgent; sequence after T2 spike.

3. **Expose richer trajectory state in Cedar context.** Sondera exposes `Trajectory.{step_count, label, taints}`. We have 8+ trajectory primitives. Building the Cedar request transform to populate ALL of them lets Cedar policies reason over trajectory state that Sondera can't:
   ```cedar
   forbid when context.tool_call_count > resource.last_test_pass_step + 10
   ```
   This is a strict superset of Sondera's expressiveness on the deterministic side.

4. **Formalize absence-as-evidence as typed Tier 1 signals.** Several shipped checks already infer risk from missing expected evidence ("tests not run", "no verification after edit", "UI not interacted with after frontend change"). Treat those as first-class negative-evidence signals instead of free-text warnings: `NegativeEvidence::"tests_not_run"`, `NegativeEvidence::"no_recent_commit"`, `NegativeEvidence::"ui_not_interacted"`, `NegativeEvidence::"stubs_introduced"`, `NegativeEvidence::"no_verification_after_edit"`. Cedar can then express deterministic composition such as "block push when negative-evidence count exceeds threshold across categories" while keeping the detectors local and auditable.

### 3.2a Existing surfaces — reference, don't duplicate

Several T1 capabilities that surfaced under external-pulse review already exist or are planned. v2 inherits them; do not propose parallel mechanisms.

- **Egress detection + taint attribution is already shipped.** `src/harness/content-scanner/extractor.ts:40-41` routes the web-fetch family (`WebFetch`, `web_fetch`, `WebSearch`) plus `mcp__*` external MCP tools through the `external_egress` scan point. `docs/harness.md:585-590` documents the full bidirectional model: outbound writes/commands/fetches are scanned for PII before send, and inbound `Read`/`Grep`/`Glob` results ratchet `session.sensitivity_level` so subsequent network calls are blocked by `network_block_at: Confidential` — without needing the outbound payload to re-detect anything. **Decision:** the taint-tracker is the integration point for any new "egress-aware" rule; do not introduce a separate `context.egress` Cedar field competing with `session.sensitivity_level`.

- **Heredoc / inline-script body scanning is planned with explicit AST non-goal.** `docs/plans/free-cli-adoption/01-evaluator-architectural-upgrades.md:33-40` plans span-classification (`Executed | Argument | Quoted | Comment | Heredoc`) plus best-effort heredoc-body scanning. Critically, line 35: *"**No full Bash AST parser.** DCG has one; we don't need it. Spans + regex covers ~95% of FPs at a fraction of the maintenance cost. We document heredoc bodies as 'best-effort scanned only' for v1."* **Decision:** DCG's tree-sitter approach (cluster analysis item 1) is rejected; v2 inherits the existing span-based plan.

- **Outcome marking for recurrence already has a public API.** `src/harness/recurrence.ts:363-380` exports `markOutcome({check_id, file, session_id, signal, …})`. The negative-evidence ledger in §6.5 does not replace that recurrence primitive; it is the append-only per-rule valence companion that lets `/enforce` show outcomes, propose demotion, and user-invoke PITFALL-style inversion.

### 3.3 The T1 fail contract (binding)

**Fail-closed on T1.** If a deterministic rule says block, block. Do not wait on any cloud layer. This is the safety floor. Matches `feedback_safety_continuity.md` (no circuit breakers on safety) and `feedback_harness_deterministic_only.md` (no LLM in the deterministic path).

T1 short-circuit applies to T2 too: if T1 blocks, T2 is never invoked. Saves cost and respects fail-fast.

---

## 4. Tier 2: Classifier-Driven Semantic Layer

### 4.1 Shape: LLM as classifier, Cedar as adjudicator

Every LLM call in T2 returns a **typed label**, not a decision. The decision layer (Cedar, or our extended JSON GuardRule successor) reads those labels and emits allow/warn/block.

```
                    ┌── Tier 1 (deterministic, ms) ──┐
                    │                                 │
event ──────────────┼─→ guard rules + checks + YARA   │
                    │                                 │
                    └─────── if block: return ────────┘
                                    │
                                    │ (else)
                                    ▼
                    ┌── Tier 2 detectors (parallel) ───────────────────────┐
                    │                                                       │
                    ├─→ per-event classifier (cached on content hash)       │
                    │   → typed label (e.g. Label::"HighlyConfidential")    │
                    │                                                       │
                    ├─→ trajectory classifier (cached on trajectory prefix) │
                    │   → typed label (e.g. Intent::"exfiltration")         │
                    │                                                       │
                    └─→ (any other classifier we add later)                 │
                                    │
                                    ▼
                       Cedar request: all signals as typed context fields
                                    │
                                    ▼
                       Cedar evaluator: ALLOW / WARN / BLOCK
```

**Binding contract:**
- Classifier output schema is fully JSON-schema-constrained (no free-form text in the decision path).
- In default `attribute_only` mode, classifier output never includes `decision`, `allow`, `block`, or any action verb. Only labels and evidence signals.
- In `annotated` or explicitly authorized direct-action modes (§4.9), action-shaped outputs are allowed only inside the configured action envelope and every invocation is logged as an LLM-as-action delegation.
- Cedar (or successor) is the default point that produces a decision; LLM-as-action is an opt-in escape hatch, not the baseline architecture.

### 4.2 Two classes of classifier call

There are exactly two T2 call shapes:

**Per-event classifier** — Sondera's pattern, lightly adapted.
- Input: the event's content + a small classification taxonomy.
- Output: one or more typed labels (`Label`, `PolicyContext { compliant, violations[] }`) or `Label::"InsufficientEvidence"` when the classifier cannot support a confident label.
- Caching: content-hash keyed. Same content → same label, cache hit, no LLM call.
- Trigger: when T2 is enabled AND T1 didn't block AND a pre-filter says this event is in-scope.

**Trajectory classifier** — the user's addition over Sondera. This is the new primitive.
- Input: the full session trajectory up to and including the current candidate event, plus the trajectory taxonomy.
- Output: a typed trajectory label (e.g. `Intent::"benign" | "exfiltration" | "credential_harvesting" | "evidence_tampering" | "InsufficientEvidence"`), plus optional sub-signals (`confidence`, `escalation_pattern`).
- Caching: prefix-cached on the trajectory log up to the last successful tool call.
- Trigger: every non-T1-blocked tool call (decision per §4.4).

**Low-confidence contract.** A classifier that cannot support its label above the configured confidence threshold emits `InsufficientEvidence`; it does not silently default to benign. Cedar routes that outcome explicitly, usually to "log + observe", "ask for more context", or "escalate to T3" depending on policy and budget. This gives fail-open degradation a typed signal the policy layer can reason about.

**Decision (user):** run the trajectory classifier on *every* non-blocked tool call, not just suspicious ones. The user's reasoning: *"A tool call might look good and safe independently of all the other tool calls, but in the context of what it was... what the agent was trying to do for the three or thirty tool calls before that, it might be unsafe."* The per-event pre-filter pattern from the original T2 design (~1.5-2.5% of calls hit LLM) doesn't apply to the trajectory classifier; trajectory context only matters if you build it on every call.

### 4.2a Logging-vs-evaluation invariant (binding, round-2 review)

The two contracts in §4.2 + §4.3 cleanly split into a *logging* invariant (always on) and an *evaluation* invariant (best-effort under budget):

- **Logging is always-on.** Every event — including T1-blocked, including budget-degraded paths, including fail-open events — goes into the trajectory log per §4.3 + §6.4. No budget pressure, no failure mode, no degradation mode reduces logging. Logging is local; it doesn't cost backend calls.
- **Classifier *evaluation* is best-effort under budget.** When budget permits, classify every non-T1-blocked event. Under budget pressure (§4.11), the harness MAY skip classifier evaluation on events that satisfy a deterministic *low-risk predicate*.

**Low-risk predicate (must be fully deterministic — vibes don't qualify).** An event is "low-risk enough to skip trajectory classification under budget pressure" iff ALL of the following hold:

1. T1 allowed with zero warnings emitted.
2. Tool is read-only AND scoped to repo files via a tool that the PII post-scanner covers (`Read`, `Grep`, `Glob`). `Bash` reads (`cat`, `rg`, `head`, `git show`) are NOT skip-eligible because the existing OPF post-scan only runs on `Read`/`Grep`/`Glob` tool events — Bash output gets signature-style secret scanning only, not the full label classifier (`src/harness/content-scanner/post-scan.ts:33`). Skipping a Bash-read on the low-risk predicate would short-circuit the very classifier that's supposed to label the content. Either remove Bash file-reading from skip-eligibility (current decision) or route Bash output through the same PII taint scanner before this predicate becomes valid for it.
3. No file write/edit/delete in this event.
4. No external egress (no `WebFetch`, no `Bash` invoking `curl` / `wget` / `nc` / `ssh` / `scp`, no `mcp__*` tool, no package publish, no `git push`).
5. Session trajectory is not currently tainted (`session.sensitivity_level <= Internal`; no `pii_detected_steps` entry in the last 10 calls).
6. No recent T1 blocks, no failed bypass attempts, no repeated destructive-command attempts, no reservation conflicts in the last 10 calls.
7. Previous trajectory classifier label was `benign` with confidence ≥ 0.9 AND no new risk signal since.

All seven gates are evaluated locally; none requires an LLM. Failing ANY gate disqualifies the event from skip-eligibility — degraded mode still classifies it.

This is a **degradation behavior, not a default optimization**. The default is: every non-blocked tool call is classified. Budget controls (§4.11) flip degradation on; the statusline indicates when degradation is active. Both the predicate-pass and predicate-fail decisions are themselves logged so we can measure how often the predicate is firing in production.

### 4.3 Capture-all-attempts contract

**Decision (user):** every tool call gets logged into the trajectory, including ones blocked by T1. Specifically (the trajectory entry shape preserves the secret-safe contract from §6.4 — no raw payloads land in trajectory entries):

- Successful tool calls (T1 + T2 allowed) → trajectory entry with `result: "ok"`, **redacted** tool input + output summary, and `raw_ref: ".interlinked/audit-raw/<session>/<event>.json"` pointing at the raw bytes (local-only, mode 0600, 7-day TTL).
- T1-blocked attempts → trajectory entry with `result: "blocked"`, `blocked_by: [rule_id, ...]`, **redacted** attempted input, plus `raw_ref` pointing at the raw payload in the audit-raw store. Inline JSON also carries `input_hash` (per-workspace HMAC, see §6.4) so the trajectory classifier can detect repeated identical-shape blocked attempts ("same `~/.ssh/id_rsa` exfil command tried 4 times") without ever holding the raw spans.
- T2-warned (PostToolUse warning channel) → trajectory entry with `result: "ok"` plus `warnings: [policy_id, ...]`.

Why: a series of blocked exfiltration attempts is *itself* the strongest evidence of exfiltration intent. The Nth call may look benign in isolation but rightly blocked because the trajectory shows escalating attempts. The trajectory classifier needs to see the *shape and repetition* of the blocks — which the redacted form + `input_hash` deliver — not the raw bytes the agent tried to exfiltrate.

### 4.4 Trajectory classifier cache design (the cost-control primitive)

**Decision (user):** the trajectory classifier should run on every non-blocked tool call but be cheap via prompt caching. The cache layout is what makes this affordable.

Conceptual layout:

```
┌── Cached prefix ──────────────────────────────────────────────┐
│ System prompt: "You are a trajectory intent classifier. ..."  │
│ Taxonomy: <verbatim intent taxonomy>                          │
│                                                               │
│ Trajectory steps 1..K (all calls up to and including the      │
│ last *successful* call the classifier already evaluated)      │
│                                                               │
│ This prefix is byte-identical to the cached prefix from the   │
│ previous call. Prompt-cache hits on 100% of input tokens here.│
└───────────────────────────────────────────────────────────────┘
┌── Delta (appended each call) ─────────────────────────────────┐
│ Recent blocked attempts (since step K, if any):               │
│   [step K+1] BLOCKED: <input>                                 │
│   [step K+2] BLOCKED: <input>                                 │
│   ...                                                         │
│                                                               │
│ Current candidate (step N, currently passing T1):             │
│   <event details>                                             │
│                                                               │
│ Classify the trajectory's overall intent given this sequence. │
└───────────────────────────────────────────────────────────────┘
```

Cache key: hash of the cached-prefix section. As long as that section is byte-identical, prompt-cache hits.

**Rollover rule:** when the classifier evaluates a successful call N, that call gets absorbed into the prefix for future calls. The new prefix = old prefix + (any intermediate blocks) + call N. Next call's delta starts from N+1.

**What this buys us cost-wise:**
- Cached prefix billed at ~5-10% of fresh tokens (provider-dependent — Anthropic 5-min TTL, OpenAI auto-caching for >1024-token prefixes, Cloudflare's gpt-oss endpoints caching is still being verified).
- Delta is small (just blocks since last successful call + the current candidate) → fast TTFT.
- Avoids re-encoding 50+ KB of trajectory text on every call.

**Worked example.** Agent runs 30 tool calls. Calls 5, 12, 18 are T1-blocked; everything else passes T1. Each non-blocked call also goes to the trajectory classifier.
- Call 1 (clean): no prefix, full encode. LLM evaluates → caches.
- Call 2 (clean): prefix = [call 1]. Delta = [call 2]. Cache hit on prefix.
- ...
- Call 5 (T1-BLOCKED): no classifier call, just a trajectory entry. Cache state unchanged.
- Call 6 (clean): prefix = [call 1, call 2, call 3, call 4]. Delta = [call 5 (blocked), call 6 (candidate)]. Cache hit on prefix.
- Call 7 (clean): prefix = [call 1..call 4, call 5 (blocked), call 6 (successful)]. Delta = [call 7 (candidate)]. Cache hit.
- ...

So the prefix grows monotonically with successful calls; the delta is bounded to (recent blocks + current candidate). This keeps the trajectory classifier viable on every event without compounding token cost.

**Compaction at rollover.** Decision (open, leaning toward simple): when the prefix exceeds ~50 events or ~32K tokens, the harness compacts events 1..M into a synopsis ("steps 1-30: agent read 12 files, ran 8 bash commands, no security-relevant signals") and keeps the recent events **verbatim in their already-redacted trajectory form** (raw event content is preserved verbatim ONLY in `.interlinked/audit-raw/` per §4.3 + §6.4; the trajectory log and therefore the classifier prefix sees only redacted entries). This invalidates the prompt cache once per rollover. The user's framing accepts this: *"You could just cash the first x number of logs, and you'd only need to append a couple of more logs every time the LLM does eventually get invoked."*

**Cache observability (binding, round-2 review).** Prompt caching is treated as *available* across backends — Anthropic explicit `cache_control`, OpenAI auto-cache for >1024-token prefixes, Cloudflare gpt-oss endpoints (cache behavior treated as available per user direction; instrumented per call). But cache hits are *verified per call*, not assumed. Every classifier call appends to `.interlinked/classifier-log/<session-id>.jsonl` with the discriminated metadata from §4.6:

- Per-event calls log `kind: "per_event"`, `content_hash`, `tokens_in`, `tokens_out`, harness `cache_hit`, `provider_cache_hit` when exposed, actual latency/cost, backend id, and backend trust class.
- Trajectory calls log `kind: "trajectory"`, `prefix_hash`, `delta_hash`, `tokens_in_prefix`, `tokens_in_delta`, `tokens_out`, `provider_cache_hit`, actual latency/cost, backend id, and backend trust class.

Unexpected cache misses (the harness expected a hit, but the provider charged for full prefix or returned a latency consistent with cold encode) become an observability signal: a statusline indicator, an entry in `.interlinked/cache-anomalies.jsonl`, and a candidate for backend reclassification per §4.6 trust classes. Pattern: a sudden run of misses on a previously-stable backend suggests either provider-side eviction policy change, network reroute through a different cache region, or — the case worth flagging — that the cache layer at the provider returned a *stale or mismatched* response. The third case is its own risk class (response-vs-prefix mismatch can mean the classifier verdict isn't about the content the harness thinks it sent); tracked as **open decision 12** in §14.

### 4.5 Stateless reasoning per call (decision)

**Decision (user asked, Claude recommended, decision: stateless):** the LLM does NOT carry forward its own reasoning between calls. Each trajectory classifier call regenerates its reasoning from the trajectory log + taxonomy. The trajectory log IS the persistent state; the LLM doesn't need its prior chain-of-thought.

Reasons:
1. **Cache-friendlier.** If we cached prior reasoning, the prefix grows with each call, defeating the prompt-cache mechanism.
2. **Auditability.** Every call's reasoning is reconstructible from inputs alone. No hidden state.
3. **No confirmation bias.** The classifier doesn't compound earlier interpretations. A trajectory that *looked* like exfiltration after 10 events but turned out benign by event 30 gets reassessed fresh.
4. **Failure-isolation.** A bad classification at step N doesn't poison step N+1.

The trade-off: we lose the small efficiency of "model already decided this trajectory is benign, just confirm the latest event fits." That cost is acceptable given the auditability and cache wins.

**Decision (user):** *"That would certainly be the most cost effective measure but quality/security are the primary uses cases of this product."* — confirming that stateless reasoning is the right call even if slightly more expensive.

### 4.6 Pluggable backends

**Decision (user):** ship a cloud endpoint for gpt-oss-safeguard 20b AND 120b (operated by us), AND allow user-provided local/cloud endpoints AND allow eventual "BYO model" support.

Backend interface (single trait, all implementations honor). Round-4 expansion: every field downstream sections rely on is now in the interface, so an implementation that satisfies the type signature actually carries enough metadata to enforce the security model.

```typescript
type TrustClass =
  | "local_private"
  | "interlinked_managed"
  | "org_managed"
  | "user_byo"
  | "third_party_public";

type DataClass = "Public" | "Internal" | "Confidential" | "HighlyConfidential";

interface ClassifierBackend {
  /** Stable id used in config, logs, statusline: "interlinked-cloud", "ollama-local", etc. */
  name: string;

  /** Privacy envelope of this backend per §4.6. Used by the failover-policy
   *  evaluator AND the §6.4 data-class router. Required — no default. */
  trust_class: TrustClass;

  /** Maximum data class this backend is permitted to classify, given the
   *  user's `remote_inference_allowed_for_data_class` config (§6.4). The
   *  backend itself ALSO publishes the data classes it is willing to accept
   *  (e.g., a vendor endpoint may refuse `HighlyConfidential` content even
   *  when the local config would allow it). Effective ceiling = min of the
   *  two. */
  supported_data_classes: DataClass[];

  /** Pre-call cost estimate (used by §4.11 budget controls). Optional;
   *  backends without metering use a flat estimate. */
  costEstimate?(input: ClassifierInput): { tokens_in: number; tokens_out: number };

  /** The classify call. Returns BOTH the structured verdict AND the
   *  observability fields the harness logs to .interlinked/classifier-log/
   *  per §4.4 cache-observability requirements. */
  classify(input: ClassifierInput, schema: JSONSchema): Promise<ClassifierResult>;

  /** Liveness check used by the failover chain. */
  healthCheck(): Promise<boolean>;
}

interface ClassifierResult {
  /** The schema-constrained verdict — the only field downstream consumers
   *  read for decision-making. */
  output: ClassifierOutput;

  /** Observability fields (logged to .interlinked/classifier-log per §4.4).
   *  Discriminated by call shape so per-event implementers don't fabricate
   *  trajectory-specific fields (and vice versa). All token / cost / latency
   *  fields are null when the provider doesn't expose them — never zero,
   *  never fabricated. */
  metadata: ClassifierMetadata;
}

type ClassifierMetadata =
  | {
      // Per-event classifier (§4.2 per-event call shape). Caching is keyed
      // on content_hash; there is no prefix / delta concept.
      kind: "per_event";
      content_hash: string;                       // sha256 of the (redacted) input bytes
      tokens_in: number | null;
      tokens_out: number | null;
      cache_hit: "hit" | "miss" | "unknown";      // harness-side cache (content-hash keyed)
      provider_cache_hit: "hit" | "miss" | "unknown" | "not_applicable";
      actual_latency_ms: number;
      actual_cost_usd: number | null;
      backend_used: string;
      backend_trust_class: TrustClass;
    }
  | {
      // Trajectory classifier (§4.2 trajectory call shape, §4.4 cache design).
      // Provider prompt-cache hit metadata is the load-bearing observability
      // here; mismatch is a §14 open-decision-12 risk class.
      kind: "trajectory";
      prefix_hash: string;                        // sha256 of the prefix bytes sent
      delta_hash: string;                         // sha256 of the appended delta
      tokens_in_prefix: number | null;
      tokens_in_delta: number | null;
      tokens_out: number | null;
      provider_cache_hit: "hit" | "miss" | "unknown";
      actual_latency_ms: number;
      actual_cost_usd: number | null;
      backend_used: string;
      backend_trust_class: TrustClass;
    };
```

Default chain:
1. **Hosted Interlinked cloud endpoint** (default for users with an Interlinked account). Routes to gpt-oss-safeguard-20b unless escalated. Authentication via the existing OAuth flow in `src/lib/auth.ts`. Hosted by us (Workers AI or equivalent) so users don't manage API keys.
2. **User-configured local endpoint** (Ollama on localhost). For air-gapped or privacy-sensitive deployments.
3. **User-BYO endpoint** (HTTPS URL + auth header). For users who want their own classifier (e.g. self-trained, fine-tuned for their domain).
4. **Failover**: if the active backend fails its health check or returns an error, fall through to the **next eligible backend** after applying trust-class filtering (per the policy below) and data-class filtering (per §6.4). "Eligible" is binding: a backend the user hasn't authorized for the event's trust envelope or data class is NOT a candidate, regardless of liveness. If no eligible backend exists after filtering, the harness fails open with a logged event (T2 classifier verdict is null; T1 still applies).

**Why open-weight models specifically (user reasoning):** *"open weight models, not just for the cost, but for the fact that they're a little bit more composable and cheaper to run-in the cloud."* gpt-oss-safeguard is open-weight, runs on commodity GPUs, deployable across providers. Avoids vendor lock-in.

**Why a hosted endpoint we operate:** Interlinked's hosted endpoint lets users with no GPU and no API-key wrangling get the experience working with zero setup. We absorb the inference cost as part of the subscription, get telemetry to improve our classifier prompts/templates, and have a clean upgrade path to fine-tuned models when Cloudflare Artifacts ships (§12).

**Backend trust classes + failover policy (binding, round-2 review).** Backend failover is not just a reliability question — it can move sensitive data across a privacy boundary the user did not accept. To prevent silent exfiltration via failover, every configured backend is tagged with a trust class:

| Trust class | Example backends | Privacy contract |
|---|---|---|
| `local_private` | Local Ollama, local sidecar process | Data never leaves the machine. User picked this for privacy. |
| `interlinked_managed` | Our hosted Cloudflare / Workers AI endpoint | Our published privacy contract; subject to our retention + no-share policy |
| `org_managed` | Customer-controlled endpoint (org's own Workers AI, self-hosted vLLM, etc.) | Customer-defined contract; data stays within the customer's tenancy |
| `user_byo` | Arbitrary HTTPS URL configured per user | User-defined; no platform privacy guarantee |
| `third_party_public` | Direct provider endpoint (Groq, OpenAI, Anthropic API, etc.) | Third-party privacy policy applies; data leaves the user's and our boundary |

**Failover policy:**

1. Failover happens **only within an explicitly-allowed trust class set**, per `policy_engine.allowed_failover_classes` in `.interlinked/config.local.json`. **Default: no cross-class failover.** If your `local_private` Ollama dies, the harness fails open (logged) rather than silently routing to `interlinked_managed`.
2. **Privacy trust is separate from capability trust.** A `local_private` Ollama may be lower-capability than `interlinked_managed`, but the user picked it because their code must not leave the machine. The harness MUST NOT use capability-equivalence to justify failover across trust classes.
3. The active backend's trust class is surfaced in the statusline so the user always knows which envelope their classifier traffic is in (`tier-2: local_private/ollama-20b ✓` vs `tier-2: interlinked_managed/safeguard-20b ⚠ failover from local`).
4. Health-check failures *within* a trust class do failover within that class (e.g., two `interlinked_managed` regions can fail between each other; two `user_byo` URLs configured by the same user can fail between each other; etc.).
5. Composes with §6.4 data-class config: even if cross-class failover is allowed, an event whose classified data class is `HighlyConfidential` is restricted to the data-class allowlist (which may exclude the failover target).

This is the answer to the obvious risk: *user configures local Ollama because their proprietary code must not leave the machine; local Ollama crashes during a sensitive edit; harness silently routes the file content to our cloud endpoint.* That's a privacy boundary violation, not graceful degradation.

### 4.7 Safeguard models vs. general open-weight models — clarification

The user asked whether the distinction matters. Captured here for posterity:

| Property | gpt-oss-safeguard | General OSS model (Llama 3.1, Qwen, etc.) |
|---|---|---|
| Base | gpt-oss-20b / -120b reasoning models | Various |
| Specialization | Reinforcement fine-tuned on policy-labeling tasks; rewarded for *consistency* and faithful policy-following | None beyond base instruction-tuning |
| Policy at inference vs. baked in | Trained to follow a NEW policy that arrives at inference time | Drifts to training priors when policy is novel |
| Adversarial examples in RFT | Yes | No |
| Calibration | Reasonably calibrated for classification | Not specifically |
| Practical impact | Lower variance run-to-run, less prompt engineering needed | Works, but needs more careful prompts |

OpenAI's own caveat: *"Classifiers trained on tens of thousands of high-quality labeled samples can still perform better at classifying content than gpt-oss-safeguard does when reasoning directly from the policy."* So safeguard isn't the ceiling — a dedicated fine-tuned classifier on labeled task data beats it. But safeguard is the right starting point: general-purpose + policy-following + consistent + no per-task training required.

Our architecture supports all three (safeguard → general OSS → user fine-tune) via the pluggable backend interface.

### 4.8 Cedar as the decision substrate

**Decision (Claude proposal, agreed by user with caveats):** Cedar is the long-term language for T2 decision logic, but we don't migrate JSON GuardRule wholesale. Path: hybrid (§11).

Cedar wins here because the decision logic IS predicate composition over typed attributes — Cedar's exact wheelhouse. Examples:

```cedar
// Block: classifier said exfiltration intent, AND prior calls had blocks
@id("forbid-on-exfil-intent-with-history")
forbid (principal, action, resource)
when {
    context.trajectory_intent == Intent::"exfiltration" &&
    resource.blocked_count > 2
};

// Warn: per-event classifier flagged credential leak, but in test code
// Note: warn is expressed as `forbid` + `@action_on_violation("warn")` per
// `docs/design/interlinked-cedar-extensions.cedarschema:72`. The annotation
// extends forbid semantics — the policy matches (violation), but the harness
// downgrades the response to a PostToolUse advisory rather than a block.
@id("warn-cred-leak-in-test-code")
@action_on_violation("warn")
forbid (principal, action == Action::"FileEdit", resource)
when {
    context.policy.violations.contains("SC3") &&
    context.risk_tier == RiskTier::"Test"
};

// Halt: trajectory shows repeated exfiltration attempts despite blocks
@id("halt-session-on-repeated-exfil-blocks")
@action_on_violation("halt_session")
forbid (principal, action, resource)
when {
    context.trajectory_intent == Intent::"exfiltration" &&
    resource.blocked_count > 5
};
// The harness recognizes the annotation and ends the agent run. See the
// schema for full vocabulary.
```

**Adopted by reference:** Sondera's `base.cedarschema` action vocabulary and entity model is a strong starting point for our schema. Differences we'd want:
- Add our richer SessionTrajectory entity (with the 8+ primitives, not just label+taints+step_count).
- Canonical Cedar `@action_on_violation` vocabulary (single annotation per policy, applied to `forbid` rules): `"warn" | "block" | "ask" | "inject_feedback" | "halt_session"`. This is the complete set per `interlinked-cedar-extensions.cedarschema`. Runner-side decision primitives like `rewrite` / `soft_block` are harness-internal action types (how the *runner* surfaces a decision to the agent), not Cedar `@action_on_violation` vocabulary — they don't appear in policy source.
- Separate `@safety_critical("true" | "false")` meta-annotation for the §6.3 fail-mode matrix. Distinct from `@action_on_violation` because it governs the *eval-error* path, not the *match* path. Documented in the schema per round-4 patch.

### 4.9 LLM-as-attribute vs. LLM-as-action (user-configurable)

**Decision (user, undecided initially, resolved as configurable):** default is LLM-as-attribute (the LLM emits typed labels, Cedar decides). Advanced users / advanced policies can opt the LLM into LLM-as-action mode where the classifier output schema includes action verbs (`halt_session`, `escalate_to_tier3`, `inject_feedback`).

Configuration shape (`.interlinked/config.local.json`):

```jsonc
{
  "policy_engine": {
    "llm_action_mode": "attribute_only",     // default
    // OR:
    "llm_action_mode": "annotated",          // labels + permitted Cedar-annotated actions
    // OR:
    "llm_action_mode": "direct",             // LLM may produce *advisory* action verbs directly (see L405+ tightening)

    "allowed_direct_actions": [              // advisory verbs only — block/halt require allowed_authoritative_actions
      "inject_feedback"
    ]
  }
}
```

In `attribute_only` mode (the default and recommended): LLM output schema strictly forbids action verbs. Cedar makes all decisions.

In `annotated` mode: LLM output may include action-recommendation labels (e.g. `recommended_action: "halt_session"`), but those labels still flow through Cedar — Cedar can choose to honor or override the recommendation. This is the middle ground.

In `direct` mode (**tightened, round-2 review**): LLM may emit *advisory* verbs that take effect without Cedar adjudication, BUT advisory verbs are limited to actions that *augment* the agent's experience while *allowing the underlying tool call to proceed*. Block / halt / deny / override-Cedar verbs are NOT in the default direct-mode set — they remain Cedar's job unless the user explicitly grants the LLM authoritative authority (a separate config flag below).

Default advisory verbs (allowed in `direct` mode out of the box):
- `inject_feedback` — place text into the agent's next PostToolUse `additional_context` (subject to §4.10 matcher constraints; rate-limited per §14 open decision 6).
- `recommend_escalation` — signal to T3 (§5.1) that this event warrants supermodel attention; T3 invocation policy decides whether to honor.
- `ask_for_human` — surface a one-line summary to the user via the statusline / next prompt; the agent's call continues.
- `suggest_followup` — emit a typed followup task for the agent's planner consumption (where the runner supports a planner channel).

Authoritative verbs (block / halt / deny) require an explicit opt-in beyond `direct` mode. Updated config shape:

```jsonc
{
  "policy_engine": {
    "llm_action_mode": "attribute_only",     // default
    // OR:
    "llm_action_mode": "annotated",          // labels + permitted Cedar-annotated actions
    // OR:
    "llm_action_mode": "direct",             // LLM may emit advisory verbs directly

    "allowed_direct_actions": [              // advisory verbs LLM may emit in direct mode
      "inject_feedback", "recommend_escalation",
      "ask_for_human", "suggest_followup"
    ],

    "allowed_authoritative_actions": []      // empty by default; populating grants LLM override-Cedar authority
  }
}
```

If a user wants the LLM to halt sessions or block tool calls directly without Cedar adjudication, they add the verb to `allowed_authoritative_actions` — explicitly. The harness logs every authoritative-action invocation loudly and surfaces it in the statusline + the `.interlinked/decisions/` audit log.

**User framing:** *"In the interest of composability, it might make sense to simply let the user choose what the LLM can do and whether it needs to go through Cedar or not."* — adopted, with the round-2 refinement that *advisory* (the safe default) and *authoritative* (override-Cedar) are split so users don't accidentally grant the LLM block/halt authority while only intending to enable feedback injection.

**User framing on advisory specifically (round-2):** *"I want to keep LLM as action, at least as a fallback, for recommendations the cloud LLM could make to the coding LLM that don't fall neatly into the Cedar policies when the LLM decides to explicitly allow the tool call to proceed."* — this is exactly the advisory-direct case. Default-allowed.

### 4.10 PostToolUse feedback injection (new action type)

**Decision (user):** broader use of the PostToolUse feedback channel — not just for blocked tool calls, but for advisory feedback during normal operation. *"Maybe it should know something else and be given some feedback as a part of the post tool use hook."*

**Matcher constraint (re-grounded from actual code, round-3 review).** The PostToolUse matcher and the per-client `PostToolUseFailure` registration vary by runner and are NOT uniform across all clients. Verified state as of `src/lib/hook-installers.ts`:

- **Claude Code**: `POST_TOOL_USE_MATCHER = ""` (empty matcher = every tool fires the hook; see `src/lib/hook-installers.ts:66`). `PostToolUseFailure` is intentionally omitted at install time (`src/lib/hook-installers.ts:32-34`) because registering it produced duplicate hook-count/output issues — see `docs/investigation-posttooluse-hook-count.md`.
- **Cursor**: registers `postToolUseFailure` (`src/lib/hook-installers.ts:144`). So `PostToolUseFailure` IS reachable on Cursor; doc shouldn't claim it's universally absent.
- **The hook script itself** handles `PostToolUseFailure` if it's invoked (`src/lib/hook-installers.ts:34`), regardless of whether the runner registers it.

**`AGENTS.md:35` (which says "PostToolUse is intentionally scoped to mutating tools") describes the original Claude Code installation intent, not the current cross-runner reality.** Feedback-injection design must respect the per-runner matrix: assume `PostToolUse` fires on every tool on Claude Code (work within that), assume `postToolUseFailure` is reachable on Cursor (handle it gracefully), and do NOT propose a fan-out narrower than what the runners already deliver.

If the desired surface is *broader* than PostToolUse (e.g., a new lifecycle event after Bash or Read that doesn't exist today), that's a separate hook design — not a PostToolUse extension.

Pattern:
- LLM (Tier 2 trajectory classifier, or Tier 3 supermodel — see §5) emits a `feedback` field in its structured output.
- Cedar policy decides whether to inject the feedback into the agent's context.
- The harness routes the feedback through the runner's PostToolUse channel: **`additional_context` JSON envelope where supported (Claude Code, Cursor); stderr fallback otherwise (Codex, Copilot CLI, Gemini CLI per §10)**.
- On runners with the JSON channel, the agent sees the feedback on its next turn as system-reminder content. On stderr-fallback runners, the feedback appears in the agent's stderr stream, which is surfaced to the user / transcript but may or may not enter the agent's next-turn context depending on how the runner forwards stderr (per `project_posttooluse_visibility.md` — known cross-runner gap).

Example Cedar rule (`forbid` + `@action_on_violation` per the extension schema; the policy "matches" when the trajectory hits the named intent, and the annotation downgrades the response from block to feedback-injection):

```cedar
@id("post-tool-feedback-on-warn")
@action_on_violation("inject_feedback")
forbid (principal, action, resource)
when {
    context.trajectory_intent == Intent::"benign_but_inefficient" &&
    context.feedback != ""
};
```

The harness reads `context.feedback` from the classifier output and routes it through PostToolUse. The agent gets gentle steering ("you might consider X instead") without being blocked.

This is the same channel `feedback_dogfood_harness_from_errors.md` references for harness improvement: a way to tell the agent something without halting it.

### 4.11 Budget controls

T2 will burn money if uncapped. Required controls:

| Control | Default | Purpose |
|---|---|---|
| Per-session LLM call budget | 200 calls (soft) / 1000 (hard) | Cap runaway sessions |
| Per-session $ budget | $0.50 (soft) / $2.00 (hard) | Independent dollar cap |
| Per-user daily $ budget | $5.00 (soft) | Prevent runaway across sessions |
| Cooldown between cache misses | 100ms | Smooth burst patterns |
| Failover degradation | After 2 consecutive backend failures, switch to the next eligible backend after trust-class and data-class filtering | Self-healing without crossing privacy boundaries |

When soft caps hit: degrade — tighten pre-filtering, prefer cached labels, skip trajectory classifier only on events that satisfy the deterministic low-risk predicate (§4.2a).
When hard caps hit: disable T2 for the rest of the session, log loudly, surface in statusline.

**Surfacing:** the statusline shows `tier-2: enabled` / `tier-2: degraded` / `tier-2: disabled (budget)` so users see when they're operating with degraded T2.

### 4.12 Failure model

**Binding: fail-open on T2.** If T2 fails for any reason (timeout, backend unreachable, malformed response, parse error), the tool call proceeds. T1 already passed; T2 was an extra layer.

This matches `feedback_safety_continuity.md`: no circuit breakers; fail-open > fail-closed for safety availability. The trajectory still records that T2 fail-opened the call; T3 can flag sessions with high fail-open rates.

| Failure | Detection | Handler |
|---|---|---|
| Hard 30s timeout | AbortController fires | Fail-open. Log to `.interlinked/policy-misses.jsonl`. |
| Backend unreachable | fetch error | Failover to the next eligible backend after trust-class and data-class filtering. If none exists: fail-open + log. |
| 4xx (auth) | response status | Disable T2 for this session. Loud log. Continue T1-only. |
| Malformed JSON | parse error | Fail-open. Log raw response. (Should never happen with schema-constrained output — but defense in depth.) |
| Budget exhausted | counter | Disable T2 for the rest of the session. Statusline indicator. |
| Cache corruption | deserialization error | Drop cache, re-run inference, overwrite. |

---

## 5. Tier 3: Supermodel Cloud Review (Expanded)

The original T3 design (pre-push only, Claude Sonnet/Opus reviewer on staged commits) is retained but **expanded with a live-feedback surface** that operates during agent work.

### 5.1 Two surfaces

**Surface 1 — Live feedback channel (NEW).**

User framing: *"I could imagine something that would involve models that aren't just safeguard models, but are actually, like, super intelligent state of the art cloud models that are helping a locally run coding agent to do a better job, have higher quality or higher security code written by it."*

Architecture: a cloud-side supermodel (Sonnet 4.6, Opus 4.7, or larger) sits alongside the agent's session. It receives selected events (NOT every event — see §5.4 invocation policy) and emits structured feedback that flows through PostToolUse `additional_context`. **Delivery channel per §10:** model-visible in the agent's next-turn context on Claude Code and Cursor (JSON channel); stderr fallback on Codex, Copilot CLI, and Gemini CLI (where next-turn visibility depends on how the runner forwards stderr — see `project_posttooluse_visibility.md`). The feedback always reaches the user via the runner's transcript / statusline; whether the agent sees it on its next turn is a per-runner question.

What the supermodel does:
- Reviews tool call output for quality issues the local agent might not notice.
- Suggests alternative approaches.
- Catches subtle correctness issues (e.g. "the loop you just wrote has an off-by-one — consider X").
- Helps with architectural taste decisions ("this introduces an abstraction that doesn't pay for itself yet").

What it does NOT do by default:
- Block tool calls — Tier 3 does not block by default; local opt-in `block_on_critical` may block critical findings; Agent CI hard gate (per `multi-agent-pre-push-review.md`) is a separate surface.
- Act autonomously (it advises; the agent decides; the user decides).
- Override Cedar decisions.

**Surface 2 — Pre-push deep review (retained from original T3 design).**

Retained from `tier-3-async-deep-review.md`, with §6.4 redaction/data-class routing applied to cloud-bound inputs:
- Triggered on `git push` via pre-push hook.
- Loads active prose policies + **redacted/minimized** commit diff for the code reviewer. **The session trajectory is NOT a reviewer input** (amended 2026-07-20 — `tier-3-async-deep-review.md` §0, `adversarial-review-split-context.md`): it goes only to the separate *process auditor*, which never sees the diff contents. The reviewer sees the diff and nothing about how the implementer arrived at it. The input composer still runs the same §6.4 scanner/redactor/data-class router on the cloud-bound diff; if redaction fails, no cloud reviewer call is attempted and the review is recorded as skipped. (This is Surface 2 only; Surface 1's live-feedback supermodel is trajectory-native by design.)
- Reviewer agent (Sonnet default, Opus on demand) emits structured findings.
- Findings written to `.interlinked/reviews/<range-sha>.md`.
- **Default warn-only; local opt-in `block_on_critical` may block critical findings; Agent CI hard gate is a separate surface.** Per `feedback_reluctance_to_push.md`. The default-warn / opt-in-block split is canonical for the local pre-push surface; the canonical hard-gate semantics (unanimous-allow, audited bypass) live in `multi-agent-pre-push-review.md` and apply to the Agent CI / managed remote product, not the local CLI.

### 5.2 Defaults: warn-only, opt-in escalation

**Decision (consistent with `feedback_reluctance_to_push`):** Tier 3 is **default warn-only**. By default it surfaces findings and the push proceeds. The local opt-in `block_on_critical` settings (below) are the only path to a local block; the Agent CI hard gate (`multi-agent-pre-push-review.md`) is a separate product surface and is not a promotion of the local default — same reviewer architecture, two product contracts. Use one phrase everywhere in this doc and the synthesis: "default warn-only; local opt-in `block_on_critical`; Agent CI hard gate is a separate surface."

Opt-in escalations:
- `tier3.live_feedback.block_on_critical: true` — let live-feedback escalate to a block on critical findings. Default off.
- `tier3.pre_push.block_on_critical: true` — let pre-push block. Default off. User explicitly asked for this in `feedback_reluctance_to_push` to NOT be the default.

The principle: T3 helps you write better code. It's a senior engineer reviewing over your shoulder, not a manager who can fire you.

### 5.3 LLM-as-action for Tier 3 (composable with §4.9)

Same configurability as T2's LLM-as-action mode. Default: T3 emits typed findings; Cedar decides what to do with them. Advanced: T3 can be granted direct action capability (inject feedback, recommend halt) per user opt-in.

Cross-tier composition: T2 emits a trajectory label, T3 emits findings. Both flow into Cedar context. Cedar can write rules that compose both ("warn if T2 says risky AND T3 has any critical finding").

### 5.4 Invocation policy — when does the live-feedback supermodel fire?

The expensive question. Per-event invocation of a SOTA model is cost-prohibitive (~$0.10-1.00 per call). Some triggers worth considering:

| Trigger | Rationale | Estimated frequency |
|---|---|---|
| Every commit (`git commit`) | Natural checkpoint; agent has "finished" a thought | ~5-20 per session |
| Every N tool calls (e.g. every 25) | Periodic temperature check | ~5-20 per session |
| T2 fail-open events | T2 couldn't classify; T3 takes a look | 1-3 per session |
| T2 flagged borderline / low-confidence | Confirm with bigger model | 2-5 per session |
| User explicit invocation (slash command) | On-demand quality check | Ad hoc |
| Trajectory-shape signals (e.g. 5 consecutive edits to the same file) | Pattern of churn worth reviewing | Ad hoc |

**Decision (user, leaning):** invocation policy is a *user setting*. Default: every commit + every 50 tool calls + on T2 fail-open. Power users can crank it up; cost-conscious users can dial it down to commit-only.

### 5.5 Tenant-shared model use (cross-session, cross-user feedback)

User framing: *"Having a cloud model that serves as a sort of decision maker for coding agents across a large set of users or an organization might be really useful."*

Two flavors:
1. **Org-level shared classifier.** An organization has its own classifier (fine-tuned on the org's codebase). Every agent in the org calls the same endpoint. Cost: amortized across the org. Benefit: classifier learns the org's conventions and codebase idioms over time.
2. **Cross-session memory.** The pre-push reviewer can see prior reviews on the same files ("last time you reviewed this module, you flagged X. The new commits don't address X.").

**Decision (leaning):** ship single-user T3 first; tenant-shared mode in a later phase once we have an org account model. The single-user version requires no new infra beyond what T2 ships.

### 5.6 T3 reliability (backoff + convergence-stop)

**Adoption (apr pattern, external-pulse item 12).** The supermodel call uses exponential backoff `10s → 30s → 90s` on retryable failures (5xx, timeout, throttle), capped at three attempts. If three consecutive attempts produce structurally identical output, stop early — the model has converged and further retries waste tokens.

Backoff state is per-session; reset on session start. This is reliability-only and does not change the warn-only contract (§5.2) or the action-mode configuration (§5.3). Drops in cleanly alongside §5.4's invocation policy.

---

## 6. Cross-tier concerns

### 6.1 Audibility

**Decision (user):** improve audibility across tiers. Current state: we log a lot to `.interlinked/`, but the trail from "this decision happened" to "this prose imperative caused it" is fragmented.

Plan:
- Every T2 classifier call writes to `.interlinked/classifier-log/<session-id>.jsonl` with request ID, input hash, output, latency, cost estimate.
- Every Cedar decision writes to `.interlinked/decisions/<session-id>.jsonl` with policy `@id`, matched annotations, redacted input request, `raw_ref` when local raw reconstruction exists, and HMAC input hashes. Long-lived decision logs never store raw payload bytes.
- Every T3 review writes to `.interlinked/reviews/<range-sha>.md` as today.
- A cross-reference tool: `interlinked audit <session-id>` produces a unified timeline of detector outputs + decisions + the source markdown lines that contributed to each rule.

Storage: same `.interlinked/` directory layout; logs are gitignored.

**Retention tiers (binding, round-2 review).** Per-tier retention reflects what each file may contain, who reads it, and what envelope it stays in:

| File | Contents | Retention | Mode | Permitted readers |
|---|---|---|---|---|
| `.interlinked/audit-raw/<session-id>/*.json` | Raw attempted input, including any blocked-attempt content that may hold secrets/PII | 7 days, auto-purged | 0600 | Local debugger only. Never read by any backend; never sent remote. |
| `.interlinked/trajectories/<session-id>.jsonl` | Trajectory entries, **redacted** per §6.4 | 30 days | 0644 | Local + permitted backends per §6.4 data-class config |
| `.interlinked/classifier-log/<session-id>.jsonl` | Classifier request/response shapes, **redacted** inputs | 30 days | 0644 | Local; never re-sent remote |
| `.interlinked/decisions/<session-id>.jsonl` | Cedar decision records w/ redacted input refs (HMAC-signed per §6.1 / doc 17) | Indefinite | 0644 | Local audit; `interlinked replay` |
| `.interlinked/reviews/<range-sha>.md` | T3 review outputs (already redacted at compose time) | Indefinite | 0644 | Local + commit-scope sharable |
| `.interlinked/policy-misses.jsonl` | Fail-open events (no payload content, just signatures) | Indefinite | 0644 | Local + telemetry |
| `.interlinked/cache-anomalies.jsonl` | Cache-mismatch observability per §4.4 | 30 days | 0644 | Local + telemetry |
| `.interlinked/rule-outcomes.jsonl` | Per-rule outcome ledger with valence and evidence refs (§6.5) | Indefinite | 0644 | Local audit; optional redacted telemetry |
| `.interlinked/evidence-summary.json` | Derived aggregate of rule-outcome counts, ratios, and trends | Rebuildable cache | 0644 | Local audit; optional redacted telemetry |

The binding contract: anything that may leave the machine for a remote backend is **redacted first** per §6.4. Raw input persists only locally, only for debugging, only with strict permissions, only for 7 days.

**Receipt mechanics defer to `docs/plans/free-cli-adoption/17-replay-testing-and-decision-receipts.md`.** That doc commits to **per-receipt HMAC only — no hash chain** (line 36: *"franken_engine signs every receipt with a hash chain; we do per-receipt HMAC, no chain. Chained audit is Guardrails territory."*). Cross-machine deterministic replay and signed verifier services are also explicitly Guardrails-tier (lines 33-38). v2 inherits that scope split: the `.interlinked/decisions/` log uses per-event HMAC for tamper-evidence on individual records but does not link records into a chain. The verification surface is `interlinked replay <session-id>`, not `interlinked audit verify`. Promoting decisions to a chained ledger requires moving the work to Guardrails — out of scope for v2 local-harness.

### 6.2 Telemetry storage layout

```
.interlinked/
├── config.json                                # team-shared
├── config.local.json                          # personal
├── distilled-rules.json                       # T1 rules (from /enforce)
├── distilled-rules.overrides.json             # user mods
├── policies/                                  # T2 policy templates (from /enforce)
│   ├── <group_id>.policy.md                   # classification taxonomy (prose + examples)
│   ├── <group_id>.cedar                       # decision rules (Sondera-compatible)
│   ├── <group_id>.interlinked.cedar           # decision rules using our extensions
│   └── <group_id>.prose.md                    # T3 review context
├── classifier-log/<session-id>.jsonl          # NEW: every classifier call
├── decisions/<session-id>.jsonl               # NEW: every Cedar decision
├── audit-raw/<session-id>/<event-id>.json      # local-only raw refs, mode 0600, 7-day TTL
├── audit-keys/<key-id>.key                     # HMAC keys, mode 0600; active.txt optional
├── reviews/<range-sha>.md                     # T3 review outputs
├── trajectories/<session-id>.jsonl            # session trajectories (T2+T3 consumes)
├── policy-misses.jsonl                        # fail-open events
├── cache-anomalies.jsonl                      # prompt-cache mismatch observability
├── recurrences.jsonl                          # existing recurrence log
├── rule-outcomes.jsonl                        # per-rule evidence-valence ledger
└── evidence-summary.json                      # derived aggregate; safe to rebuild
```

The `.interlinked/` dir already exists for T1; T2/T3 extend it.

### 6.3 Fail mode matrix (composite)

| Layer | Failure | Action |
|---|---|---|
| T1 | Rule evaluation error | Fail-CLOSED on safety-critical rules (block by default); fail-open on advisory rules |
| T2 per-event classifier | Backend unreachable | Failover to next eligible backend after trust/data filtering; ultimately fail-open with log |
| T2 trajectory classifier | Same | Same |
| T2 budget exhausted | Counter trip | Degrade (skip classifier, use cache only); statusline indicator |
| T3 live feedback | Backend unreachable | Skip feedback for this event; log |
| T3 pre-push review | Backend unreachable | Skip review; log to `.interlinked/reviews/<range-sha>.skipped.md`; push proceeds |
| Cedar engine | Policy load error | Skip that policy; log; continue with other policies (per `cloud-local-disagreement-policy.md`) |
| Cedar engine | Eval error on safety-critical policy (annotated `@safety_critical("true")` or bundled-T1) | Block (fail-closed) — preserves the T1 safety floor on which the system depends |
| Cedar engine | Eval error on non-critical policy (semantic / quality / advisory) | Fail-open with log; warn at next event; mark policy as suspect for review |

**Safety-critical annotation rule (round-2 review):** by default, bundled-T1-equivalent Cedar rules (e.g., destructive-command guards, secret-write guards, prod-env-edit guards) carry `@safety_critical("true")`. User-distilled rules and quality/taste rules default to `@safety_critical("false")`. `/enforce` emits the annotation based on the rule's source: imperatives extracted from `MUST NOT`/`never`/`forbidden` lexical markers (§5a of `skills/enforce/SKILL.md`) default to critical; everything else doesn't. Override via overrides file (`distilled-rules.overrides.json`) per existing lifecycle ops.

### 6.4 Secret-safe telemetry contract (binding, round-2 review)

All trajectory entries, classifier-log entries, and audit log entries pass through a redaction / minimization layer before persistence or remote inference. Reuses the existing PII/secret scanner (`src/harness/content-scanner/`) — same engine, broader coverage.

**Pipeline:**

```
event content
   │
   ▼
PII/secret scanner (existing) → typed findings: {labels[], span_count, span_hashes[]}
   │
   ├─→ Raw audit (mode 0600, local-only, 7-day TTL)
   │     • Used only when debugging requires reconstruction
   │     • Never read by any backend; never sent remote
   │     • Path: .interlinked/audit-raw/<session-id>/<event-id>.json
   │
   └─→ Redacted form (matched spans replaced with `[REDACTED:<label>:<span-hash-prefix>]`)
         │
         ├─→ Trajectory log (30-day TTL)
         ├─→ Classifier prompt (sent to backend)
         └─→ Decision log (indefinite, HMAC-signed)
```

**What classifiers see:** the redacted text plus the typed findings as a structured field — `{secret_detected: true, labels: ["private_email", "secret"], span_count: 3, span_hashes: ["abc123def", ...]}`. The classifier never sees raw spans. This gives the LLM enough signal to classify intent ("agent is harvesting credentials") without persisting credentials to any remote endpoint or to the long-lived audit log.

**Span-hash invariant (round-3 review — keyed, not raw SHA-256).** `span_hashes` are **HMAC-SHA256 keyed with a local per-workspace secret** (auto-generated on `interlinked enable`, stored at `.interlinked/audit-keys/<key_id>.key` mode 0600, never persisted remote). Truncate to 12 hex chars after HMAC for the in-trajectory representation.

**Why keyed, not raw.** A raw SHA-256 of a redacted email/phone/date/URL/common-secret is dictionary-attackable — the input space for emails or phone numbers is small enough that an attacker who reads `.interlinked/trajectories/*.jsonl` (group-readable at 0644) can pre-compute hashes for billions of candidates and recover the redacted value. HMAC with a local secret breaks that attack — without the workspace key, the hash is uncorrelatable.

**Equality scope:** **per-workspace, within a key-rotation window.** Same secret seen across two sessions in the same workspace using the same active key → same hash. Cross-workspace / cross-machine → different hashes by construction. Across a key rotation → see the rotation contract below.

**Key-rotation contract (round-5 review).** Rotation is necessary occasionally (key compromise, periodic hygiene). To keep prior trajectory entries correlatable across a rotation, every log row that contains span hashes ALSO carries `key_id` — the id of the HMAC key that generated those hashes. Layout:

- `.interlinked/audit-keys/<key_id>.key` — one file per key, mode 0600. The active key is the lexicographically-newest, or the one named in `.interlinked/audit-keys/active.txt`.
- Old keys are **retained for a configurable window** (`policy_engine.audit_key_retention_days`, default 90 days) so the trajectory classifier and `interlinked audit` can still verify hashes from earlier sessions. After retention expires, the old key file is purged — older logs lose their HMAC equality, but the trajectory entries themselves remain (just no longer correlatable on span). `interlinked audit rotate-key [--retire-after Nd]` triggers rotation.
- Cross-rotation correlation: explicit. Within a key window, same secret → same hash. Across rotations, the harness MAY recompute hashes under the new key when ingesting old entries into a fresh classifier prefix, but the live log rows retain their original `key_id` for forensic stability. Rotation does NOT silently break equality on live logs — it WOULD break equality across rotations if `key_id` weren't tracked. Tracking `key_id` is the binding contract.

Two events containing the same redacted secret within the same workspace AND key window produce the same hash. Cross-event correlation ("same secret seen in event N and event N+3") works without revealing the secret value and without granting log readers a pre-image attack. This is the load-bearing primitive for trajectory intent classification on PII-touching content.

**Data-class config (`policy_engine.remote_inference_allowed_for_data_class`):**

```jsonc
{
  "policy_engine": {
    "remote_inference_allowed_for_data_class": {
      "Public":              ["local_private", "interlinked_managed", "org_managed", "user_byo"],
      "Internal":            ["local_private", "interlinked_managed", "org_managed"],
      "Confidential":        ["local_private", "org_managed"],
      "HighlyConfidential":  ["local_private"]
    }
  }
}
```

Cross-cuts with §4.6 trust classes: an event's classified data class plus the user's data-class allowlist determines which backends are eligible to classify that event. A `HighlyConfidential` event whose only configured backend is `local_private` Ollama (down) doesn't fail over to `interlinked_managed` — it fails open with a logged event. The privacy boundary is preserved over availability.

**Routing-decision preflight order (binding, round-3 review).** Backend selection must happen *before* any remote inference call. The data class used for routing therefore cannot itself depend on remote LLM classification — that's a circular dependency. The deterministic preflight that establishes the *initial* data class, in priority order:

1. **PII/secret scanner output** (`src/harness/content-scanner/`) — if the scanner finds any `secret` or `account_number` label, the initial class is `HighlyConfidential` immediately. Other labels (`private_email`, `private_phone`, etc.) start at `Confidential`. No scanner findings → start at `Public`.
2. **File-sensitivity rules** — explicit per-path sensitivity declarations from `.interlinked/config.local.json` (e.g., `**/.ssh/**` → `HighlyConfidential`, `**/secrets/**` → `HighlyConfidential`, `src/**` → `Internal`). Path matches ratchet the initial class up but never down.
3. **Path-pattern heuristics** — built-in patterns for well-known sensitive paths (`.env*`, `id_rsa*`, `*.pem`, `*.p12`, `~/.aws/credentials`, etc.) ratchet up to `HighlyConfidential`.
4. **Session taint** — `session.sensitivity_level` from the trajectory's running high-watermark (see `docs/harness.md:585-590` bidirectional model). Once the session has read HC content, every subsequent event inherits HC as the floor — this is how the existing taint-tracker protects against follow-up exfil.

The preflight is a max-of-all-sources: any source ratchets the class *up*. None ratchets it *down*. **No LLM is in the preflight path.** The class is locked before any remote backend is selected for inference.

**LLM-derived class ratcheting (only after preflight, only upward):** the per-event classifier (when it eventually runs, against the eligible backend determined above) *may* upgrade the trajectory's running data class going forward by emitting a higher sensitivity label. That higher label takes effect on the NEXT event's preflight, not retroactively on the current event. The current event's backend routing is decided by the preflight class and cannot be changed mid-flight.

This resolves the routing circularity surfaced under round-3 review: the deterministic preflight is the first authority; the LLM is a ratcheting source for the next decision, not the current one.

**Scanner / redactor failure policy (binding, round-4 review).** The preflight requires the PII/secret scanner to succeed before backend selection can lock. But the existing `src/harness/content-scanner/` is intentionally fail-open on errors — a scanner crash silently classifies content as having no findings. For local-only display and PreToolUse decisions that's defensible; for **remote-inference routing it is NOT** — a fail-open scanner silently classifies as `Public`, which would route HC content to a `third_party_public` backend.

Conservative rule for the remote-inference path:

| Stage outcome | Class for routing | Allowed backends | Classifier verdict |
|---|---|---|---|
| Scanner ran clean, no findings | `Public` (or higher if file-sensitivity / path / taint ratchets up) | per data-class config | normal classification |
| Scanner ran, found findings | escalated per finding labels (see preflight order above) | per data-class config | normal classification |
| **Scanner errored or timed out** | **`HighlyConfidential` (max)** | `local_private` only — never remote | classified by the local backend if available; otherwise null (fail-open) |
| **Redactor failed to produce a redacted form** | n/a — no routing decision | **none** | **null — no classifier call attempted, on ANY backend including `local_private`** |

So: scanner failure does NOT mean "default to safe permissive class." It means "default to the most restrictive class so the routing layer can't accidentally exfiltrate." If the scanner can't determine sensitivity, we treat the content as sensitive AND we restrict to local backends only.

If the **redactor** can't produce a redacted form, **no classifier call happens at all** — not even to `local_private`. The reasoning: every classifier call (local or remote) sees the *redacted form* per §6.4's pipeline; there is no "send raw to local backend" path in this architecture. If redaction fails, the classifier has no valid input. The trajectory still logs (with `raw_ref` pointing at the audit-raw store), and the tool call still proceeds (we're fail-open on T2 evaluation per §4.12), but the T2 verdict for that event is null. T1's deterministic floor still applies as always.

This is the binding contract for the routing layer. The earlier version of this doc carried inconsistent wording in §12 step 4 ("redactor failure restricts to local_private") that has been reconciled to this rule. There is no "local-only raw classification" path — both because it doesn't fit the secret-safe pipeline and because the §6.4 redaction is the load-bearing primitive that makes classifier inputs safe to log.

**Reuse:** the existing scanner at `src/harness/content-scanner/extractor.ts:74` already covers WebFetch / Bash / Write / Edit / MultiEdit / external MCP egress (the "outbound" leg of the bidirectional model documented at `docs/harness.md:585-590`). §6.4 widens its coverage to also pre-filter trajectory log writes and classifier prompts before they're persisted or sent remote. No new scanner; the same OPF backend produces the same eight labels (`account_number`, `private_address`, `private_date`, `private_email`, `private_person`, `private_phone`, `private_url`, `secret`).

### 6.5 Evidence valence and rule-outcome ledger

**Adoption (Jeffrey negative-evidence ledger family, local scope).** v2 adopts the common primitive across `franken_engine`, `process_triage`, `eidetic_engine_cli`, and the CASS confidence-decay pattern: evidence is not just "finding present." Evidence has valence, provenance, recency, and lifecycle impact.

Three source patterns map cleanly:

- **Per-entity counters:** `positive_count`, `negative_count`, `neutral_count`, most-recent timestamp/description, and a risk trend. We apply this per rule/check/policy id.
- **Absence-as-evidence:** "we looked and expected evidence was absent" is a typed negative signal, not a vague warning. Tier 1 emits this for missing verification, missing UI interaction, absent recent tests, and similar cases.
- **Evidence over vibes:** adaptive rules need source sessions, feedback, validation, artifact hashes, and replay status. A rule with no evidence remains low-confidence; a rule with harmful outcome history gets demoted or inverted only through an auditable command.

Append-only local ledger:

```json
{
  "schema_version": 1,
  "rule_id": "enforce-tdd-write-test-first",
  "session_id": "2026-05-12T18-42-11Z",
  "fired_at": "2026-05-12T18:44:02.137Z",
  "recorded_at": "2026-05-12T18:50:21.004Z",
  "agent_action": "addressed",
  "subsequent_evidence": "no_issue",
  "valence": "positive",
  "evidence_ref": {
    "decision_ref": ".interlinked/decisions/2026-05-12T18-42-11Z.jsonl#42",
    "review_ref": null,
    "artifact_hash": "hmac-sha256:..."
  }
}
```

Allowed values:

```ts
type RuleOutcomeAction = "addressed" | "suppressed" | "ignored" | "fix_recurred";
type SubsequentEvidence = "no_issue" | "ci_failed" | "reviewer_flagged" | "user_undid" | "unknown";
type EvidenceValence = "positive" | "negative" | "neutral";
```

Derived aggregate (`.interlinked/evidence-summary.json`, rebuildable):

```ts
type EvidenceSummary = {
    rule_id: string;
    positive_count: number;
    negative_count: number;
    neutral_count: number;
    fire_count: number;
    negative_ratio: number;
    most_recent_at?: string;
    most_recent_description?: string;
    risk_trend: "improving" | "stable" | "degrading";
    effective_severity: "block" | "warn" | "advisory" | "pitfall";
};
```

Confidence-decay policy:

- 90-day half-life for outcome weight.
- Harmful/negative outcomes receive a 4x multiplier.
- `negative_ratio > 0.5 && fire_count > 20` qualifies a rule for demotion review.
- Persistently harmful rules may be inverted to PITFALL-style warnings, but only by an explicit user command. No background job silently promotes, demotes, or rewrites a rule.

`/enforce` lifecycle surface:

- `/enforce outcomes <rule_id>` — show the append-only ledger and aggregate summary for one rule.
- `/enforce auto-demote [--dry-run]` — propose or apply demotions for rules above the negative-ratio threshold.
- `/enforce auto-invert [--dry-run]` — propose or apply PITFALL-style inversion for persistently harmful rules.

Integration points:

- Tier 1 absence-as-evidence checks emit `EvidenceSignal<NegativeEvidence>` into Cedar context.
- Tier 2 classifiers emit `InsufficientEvidence` instead of defaulting to benign; Cedar can combine that with negative evidence and trajectory state.
- Tier 3 review findings append outcomes when later addressed, suppressed, ignored, or contradicted by CI/reviewer/user evidence.
- Cross-tenant aggregation, Thompson-sampling global rankers, and community-tuned rule packs are Guardrails / Interlinked MCP Server product work. The local CLI only writes the deterministic, user-auditable substrate.

---

## 7. Code Quality Application

The classifier-feeds-Cedar pattern generalizes from security to code quality. Same architecture, different taxonomies.

### 7.1 Code Quality Category taxonomy (CQ0-CQ9)

Proposed classifier output (one of many policies, similar to SC0-SC8):

| Code | Name | Definition (one line) |
|---|---|---|
| CQ0 | Clean | Idiomatic, well-structured, no smells |
| CQ1 | Naming | Misleading/inconsistent names, abbreviations, mixed conventions |
| CQ2 | Complexity | High cyclomatic, deeply nested, long methods, cognitive load |
| CQ3 | Duplication | Copy-paste, near-duplicate logic, parallel structures |
| CQ4 | Abstraction | Premature abstraction, wrong-level abstraction, leaky abstraction |
| CQ5 | Type safety | `any`, `// @ts-ignore`, unsafe casts, missing return types |
| CQ6 | Error handling | Swallowed exceptions, broad catch, missing error context |
| CQ7 | Test coverage | Untested branch, test-only code in prod, mock leakage |
| CQ8 | Performance | N+1, unbounded loop, inefficient algorithm, large allocation |
| CQ9 | API design | Boolean trap, default export where named preferred, return-type widening |

Same TOML-style template structure as Sondera's `policies.toml`: prose definitions + labeled few-shot examples per category. Same JSON-schema-constrained output (`{violation: u8, policy_category: "CQ<n>"}`).

### 7.2 Risk Tier taxonomy

Separate classification axis covering "how high-stakes is this code path":

| Tier | Definition |
|---|---|
| `PublicAPI` | Module is part of the external contract; breaking changes affect downstream consumers |
| `Hotpath` | Frequently executed code path (render loop, request handler) |
| `Coldpath` | Rarely executed (boot scripts, migration runners, admin tools) |
| `InternalHelper` | Private utility; changes are isolated |
| `Test` | Test infrastructure; relaxed quality bar |

Two independent LLM calls per file edit (CQ + RiskTier), both schema-constrained. Both flow into Cedar context.

### 7.3 Composing with existing checks

Cedar gets a richer context for quality:

```
file edit content
  │
  ├─→ YARA-X scan (µs)                   → context.signature.{categories, severity}
  ├─→ tsc/biome/oxlint/cargo (existing)  → context.tsc.{errors_added, errors_existing}
  │                                       → context.biome.findings[]
  ├─→ structural checks (existing)       → context.structure.{dead_exports, cycles, blast_radius}
  ├─→ CQ classifier (NEW)                → context.code_quality.{category, violations}
  └─→ RiskTier classifier (NEW)          → context.risk_tier
                                                                            │
                              ┌─────────────────────────────────────────────┘
                              ▼
                  Cedar evaluates all signals together
                              │
                              ▼
                       Allow / Warn / Block
```

Example Cedar policies for quality:

```cedar
// Block: tsc errors increased AND biome flagged AND it's PublicAPI code
@id("forbid-public-api-degradation")
forbid (principal, action in [Action::"FileEdit", Action::"FileWrite"], resource)
when {
    context.tsc.errors_added > 0 &&
    context.biome.findings.containsAny([Finding::"NoExplicitAny", Finding::"NoNonNullAssertion"]) &&
    context.risk_tier == RiskTier::"PublicAPI"
};

// Warn: complexity smell in hotpath — annotated `forbid`, not `permit`,
// per the extension schema (annotation extends forbid semantics).
@id("warn-perf-smell-hotpath")
@action_on_violation("warn")
forbid (principal, action in [Action::"FileEdit", Action::"FileWrite"], resource)
when {
    context.code_quality.violations.contains("CQ2") &&
    context.risk_tier == RiskTier::"Hotpath"
};

// Ratchet: block if CQ5 count INCREASES (matches existing as-any ratchet)
@id("forbid-type-safety-ratchet")
forbid (principal, action == Action::"FileEdit", resource)
when {
    resource.prev_cq5_count < context.code_quality.cq5_count
};

// Warn on CQ4 (abstraction smell), EXCEPT in test code. The exception is
// encoded in the forbid predicate via `unless` — a separate `permit` rule
// would NOT override this `forbid` under Cedar's deny-overrides-permit
// semantics, so encoding the relaxation as a permit (the prior shape) was
// inert. `unless` is the right primitive: the policy fires only when `when`
// holds AND `unless` doesn't.
@id("warn-abstraction-smell-prod")
@action_on_violation("warn")
forbid (principal, action in [Action::"FileEdit", Action::"FileWrite"], resource)
when {
    context.code_quality.violations.contains("CQ4")
}
unless {
    context.risk_tier == RiskTier::"Test"
};
```

### 7.4 Quality vs. security — same architecture, different defaults

| Dimension | Security policies | Quality policies |
|---|---|---|
| Default action on violation | Block (high precision; FP cost > FN cost) | **Block on deterministic findings, warn/ratchet on semantic ones** (see §7.5) |
| Ratchet vs. absolute | Mixed | Almost always ratchet (don't block on pre-existing) |
| Risk-tier sensitivity | Less (security cares about absolute violations) | High (test code gets relaxed bar) |
| Classifier confidence threshold | Lower (false-positive cost is acceptable) | Higher (false blocks frustrate the agent); deterministic findings bypass classifier confidence |

The framework handles both via different Cedar rule sets and different classifier templates. Same machinery, different tuning.

### 7.5 Blocking criteria for quality findings (binding, round-2 review)

**User principle (round-2):** *"It's important for agents to know that the highest quality standards will be enforced deterministically, as they tend to ignore 'warnings' or otherwise neglect pre-existing quality issues that they themselves did not cause in their session."*

Corollary: quality blocks ARE appropriate when the standard is deterministic and the false-positive rate is verifiable. Quality blocks are NOT appropriate when the call is a taste judgment without a concrete predicate. The split:

**Eligible for block (deterministic standards — zero or near-zero FP, verifiable from tool output):**

- Introduced TypeScript suppression markers in this edit — `any` casts, `ts-ignore` directives, file-wide `ts-nocheck` pragmas, or `ts-expect-error` markers (each prefixed by an at-sign in source). Deterministic via tsc-diff over content.
- Introduced broad `catch (e) { ... }` without re-throw or contextualization (deterministic via AST match)
- Skipped tests (`it.skip`, `xit`, `describe.skip`, `test.skip`) introduced in this edit (deterministic via AST)
- Suppression directive (`eslint-disable`, `biome-ignore`, `// noqa`) added without an inline justification matching the repo's convention (deterministic via comment-text inspection)
- Public API complexity increased past a per-repo threshold (deterministic via cyclomatic / cognitive complexity counters)
- Default export added where the repo's lint config or `package.json` policy forbids it
- Abstraction violating a concrete declared rule like "single consumer for a wrapper class" (deterministic via callgraph + usage count — this composes with structural-check signals per §3.2 item 1's `dead_exports` / `blast_radius` primitives)

**Warn-only / ratchet-only (semantic — needs LLM judgment + non-zero FP risk):**

- "This abstraction doesn't pay for itself yet" (CQ4 — semantic taste; LLM judgment)
- "This test setup is fragile" (CQ7 — semantic; needs context understanding)
- "This API design has a boolean trap" (CQ9 — sometimes deterministic via signature inspection, sometimes semantic; the FP rate per pattern determines)
- Any finding without a concrete predicate the harness can mechanically check

**Ratchet semantics for blocks.** Deterministic-block rules block on *increase* of the metric within this edit, not on absolute count. The agent CAN edit a file with pre-existing `any` usages; they cannot introduce new ones. This is the existing pattern shipped at T1 for `non_null_assertion_ratchet` and `as any` ratchets — Cedar-expressed equivalents subclass that mechanism.

**Cedar rule shape (deterministic-quality block).** Note the `@safety_critical("false")` annotation: quality blocks are firm-but-not-safety-critical, so §6.3's fail-mode matrix treats Cedar eval errors here as fail-open (logged), not block.

```cedar
@id("forbid-introduced-any-in-edit")
@safety_critical("false")
forbid (
    principal,
    action == Action::"FileEdit",
    resource
)
when {
    context.tsc.any_count_after > context.tsc.any_count_before
};
```

**Compose with §6.4 PII filter for security-side controls.** The PII/secret scanner already covers the "no secrets in source" axis of quality (`secret` label feeds into Cedar context); quality rules consume the existing signal rather than re-detecting.

---

## 8. Cedar Adoption Path (Hybrid)

We don't migrate JSON GuardRule wholesale. Three-phase:

### 8.1 Phase A — Cedar for new T2 rules only (now)

- T1 stays on JSON GuardRule (unchanged).
- T2 rules are written in Cedar from day one (no JSON conversion needed since T2 doesn't exist yet).
- The harness `evaluator` learns to load both JSON GuardRule and Cedar policies, evaluate each in its native engine, combine results.

Concretely: the harness gains a Cedar evaluator alongside the existing JSON evaluator. `evaluatePreToolUse(event)` now does:
1. Run JSON GuardRule (T1) — fail-fast on block.
2. Run T2 classifiers in parallel.
3. Run Cedar policies (T2 decision layer) with classifier outputs as context.
4. Combine decisions per fail-mode matrix.

Cedar evaluator integration: use `cedar-wasm` from npm (`@cedar-policy/cedar-wasm`). Zero install for users, exact same validator and authorizer as the Rust impl.

### 8.2 Phase B — Promote selected T1 rules to Cedar (later)

Rules that benefit from Cedar's expressiveness (compound predicates, trajectory-aware conditions, cross-entity refs) get migrated. Rules that are simple regex-on-tool_input stay in JSON.

Migration criterion: a rule that needs `&&` across two patterns, OR references `SessionTrajectory` state, OR composes multiple typed signals, is a Cedar candidate. Otherwise leave it alone.

### 8.3 Phase C — Cloud Cedar tooling (deferred to Cloudflare Artifacts)

**Decision (user):** wait for Cloudflare Artifacts release before designing cloud-side Cedar tooling. Per the user: *"I think cedar-wasm could be useful at some point down the line with Cloudflare's Dynamic Workers / Facet DOs but I don't think we're there yet. I'd want to wait until the Artifacts product is released before designing too much for the cloud."*

When Artifacts ships:
- Cloud-side Cedar tooling for fleet-wide policy evaluation
- Per-tenant fine-tuned classifiers stored as Artifacts
- Cross-session policy state via DO facets

Until then: client-side cedar-wasm in the CLI is sufficient.

---

## 9. /enforce skill revisions

The `/enforce` skill at `skills/enforce/SKILL.md` §15 currently routes imperatives into a three-pass model:
- Pass 1: deterministic Cedar (`distilled-rules.json`)
- Pass 2: LLM-adjudicator policy (`<group>.policy.md` + Cedar files)
- Pass 3: prose for Tier 3 review

This needs to change once this architecture lands:

1. **Pass 2 reframes from "policy.md as adjudication prose" to "policy.md as classification taxonomy".** Same file format (markdown with category definitions + examples) but the *interpretation* shifts. The LLM uses it to classify, not to adjudicate.

2. **Add a "classifier schema" sibling file.** Each `<group>.policy.md` gets a `<group>.classifier-schema.json` declaring the JSON schema the LLM's output must conform to. The schema is derived from the policy's category list (similar to how `PolicyModelResult` is the Rust struct for the SC0-SC8 schema).

3. **Cedar files in `policies/<group>.cedar` become the decision layer.** They reference classifier output fields. The `interlinked-cedar-extensions.cedarschema` already supports this; we extend it with the new attributes (`context.code_quality.*`, `context.risk_tier`, `context.trajectory_intent`).

4. **Pass 3 prose.md format unchanged.** Still feeds T3 reviewer agent.

5. **New sibling file: `<group>.trajectory-taxonomy.md`.** When the policy is trajectory-aware (intent classification, etc.), this declares the taxonomy. Different file because it's a different classifier call shape.

6. **Add evidence-lifecycle commands.** `/enforce outcomes <rule_id>`, `/enforce auto-demote`, and `/enforce auto-invert` operate on `.interlinked/rule-outcomes.jsonl` and write any accepted lifecycle change through `distilled-rules.overrides.json` with provenance. This keeps adaptive behavior user-invoked and auditable.

`/enforce`'s outer loop is unchanged; only the artifact contents and the classifier wiring change.

---

## 10. Cross-Runner Concerns

Same as the prior tier-2 doc: T2/T3 logic lives in the harness, hook adapters (`src/harness/adapters/`) translate hook events from each runner (Claude Code / Cursor / Copilot CLI / Codex / Gemini CLI) into the harness's normalized Event shape. The harness emits decisions in the format each runner expects. No T2/T3 logic in the runner-specific code.

**`additional_context` channel (re-grounded, round-3 review):** model-visible JSON `additional_context` is supported on Cursor and Claude Code. **Codex** currently routes `additional_context` to **stderr**, not into a model-visible JSON channel (`src/harness/adapters/codex.ts:216-234`) — stderr-tailing surfaces the text to the user / agent transcript but doesn't deliver it through the structured PostToolUse JSON envelope Claude Code / Cursor agents see. Copilot CLI and Gemini CLI also fall back to stderr. The feedback-injection action (§4.10) uses the JSON channel where available and degrades to stderr-prefixed messages on Codex / Copilot / Gemini — `inject_feedback` produces a visible payload on every supported runner, but the *delivery channel* (and therefore the agent's prior-to-next-turn visibility) differs. Either treat Codex as a stderr-fallback adapter for this action, or land a Codex adapter change that promotes `additional_context` to the model-visible channel — the doc shouldn't paper over the gap.

**CanonicalEvent IR + golden tests (casr pattern, external-pulse item 6).** Define one canonical `Event` IR shape in `src/harness/types.ts` that every adapter normalizes into. Add a typed `decision: {tier, outcome, blocked_by?, warnings?, classifier_label?}` field so cross-tier composition is explicit in the record shape. Add a golden-file CI gate at `src/harness/adapters/__tests__/canonical-event.golden.jsonl`: known-good adapter inputs from each runner serialize to byte-identical normalized output. Schema drift breaks CI on the next adapter change. This catches a class of cross-runner regression the existing adapter tests miss (per-runner unit tests can pass while inter-runner contract drifts).

---

## 11. JSON GuardRule + Cedar Coexistence

Cedar covers compound predicates and typed signals; JSON GuardRule covers simple pattern matching and our action-type richness (block/warn/rewrite/soft_block/ask/additional_context).

**Decision (Claude proposal):** keep JSON GuardRule for the cases where Cedar buys nothing:
- Single-pattern rules (one regex on `command` or `file_path`).
- Rules that already have established `applies_to_roles` / `keywords` semantics that JSON expresses naturally.
- Rules from `/enforce` Pass 1 distillation (the existing distilled-rules.json output format).

Cedar takes over where it adds value:
- T2 decision rules (always Cedar).
- Compound predicates across multiple signals.
- Trajectory-aware rules.
- Quality rules using the CQ + RiskTier taxonomies.

The harness loads both and evaluates them sequentially. Rules in JSON evaluate first (cheaper); Cedar second (richer context, after T2 classifiers populate it).

---

## 12. Implementation Sequence

When you sit down to build this, here's the order:

1. **Stub the predicate dispatcher in `active-when.ts`.** Existing T1 work, unblocks trajectory-typed rules without any cloud dependency.

2. **Wire `cedar-wasm` into the CLI.** `npm i @cedar-policy/cedar-wasm`. Add a thin evaluator wrapper in `src/harness/cedar-evaluator.ts`. Validates `/enforce`-emitted Cedar files in-process; evaluates Cedar policies alongside JSON GuardRule.

3. **Define classifier output schemas.** Rust-style structs in TypeScript (or use TypeBox / Zod / @sinclair/typebox) for `PolicyModelResult`, `SensitivityModelResult`, `TrajectoryIntentResult`, `CodeQualityResult`, `RiskTierResult`. JSON schema codegen feeds Ollama/Workers AI's structured-output constraints.

4. **Land the secret-safe routing primitives BEFORE any hosted-endpoint spike.** This is the round-4 reordering. Implement, in order:
   - Per-workspace HMAC key generation + storage (`.interlinked/audit-keys/<key_id>.key`, mode 0600, optional `.interlinked/audit-keys/active.txt`, `interlinked audit rotate-key` command).
   - Redaction layer wrapping the existing `src/harness/content-scanner/` so it emits `{redacted_text, labels, span_hashes}` instead of just the live decision signal. HMAC the span hashes per §6.4.
   - Data-class preflight per §6.4 routing-decision preflight order (scanner → file-sensitivity rules → path heuristics → session taint). Result is a `DataClass` value attached to the event before any classifier runs.
   - `ClassifierBackend` registry honoring §4.6 trust classes + `supported_data_classes`. Backend selection function: `(event, dataClass, config) → eligible_backend | null`. Returns `null` when no backend in the allowed trust set covers the data class — the harness then fails open (T2 evaluation skipped, T1 still applies).
   - Scanner/redactor failure handler per §6.4's binding rule. **Scanner failure** (errored, timed out): force data class to `HighlyConfidential`; restrict to `local_private` backends. **Redactor failure** (raw content can't be safely redacted): no classifier call at all, on ANY backend — T2 verdict is null for the event. The remote-inference path never sees content the scanner couldn't classify, and the local backend never sees content the redactor couldn't redact (because the harness sends the redacted form to every classifier, not the raw bytes).
   - Audit-raw store writer (`.interlinked/audit-raw/<session>/<event>.json`, mode 0600, 7-day TTL) + redacted-trajectory writer (`.interlinked/trajectories/<session>.jsonl`).
   - Tests covering: scanner failure → HC routing, redactor failure → no remote, span-hash determinism within workspace, span-hash divergence across workspaces.

   No raw payload reaches a remote endpoint until this step is complete. The hosted-endpoint spike in step 6 consumes ONLY the redacted form.

5. **Land the negative-evidence ledger substrate.** Implement `docs/plans/free-cli-adoption/20-negative-evidence-ledger.md` before enforcing adaptive policy changes:
   - `.interlinked/rule-outcomes.jsonl` append-only writer and `.interlinked/evidence-summary.json` aggregate builder.
   - Cedar context fields for `EvidenceValence`, `NegativeEvidence`, and `InsufficientEvidence`.
   - Deterministic absence-as-evidence T1 signals for missing tests, missing verification, UI-not-interacted, stubs introduced, and no recent commit where applicable.
   - `/enforce outcomes <rule_id>`, `/enforce auto-demote`, and `/enforce auto-invert`, with dry-run default for bulk lifecycle changes.
   - Tests proving no background mutation occurs and every applied demotion/inversion records provenance into overrides.

6. **Implement the per-event classifier with hosted endpoint.** Spike against our Cloudflare cloud endpoint (gpt-oss-safeguard-20b), consuming the redacted-form output from step 4. Cache by content hash. Emit `InsufficientEvidence` below threshold. Measure latency, cost, accuracy. Verify in shadow mode that no event's raw bytes hit the network.

7. **Implement the trajectory classifier with prompt caching.** This is the new primitive. Build the trajectory log writer first (the trajectory needs to be stable + append-only for caching to hit). Then the classifier call with proper cache markers. Log cache-hit evidence and cache anomalies per §4.4.

8. **Land Cedar `interlinked-cedar-extensions.cedarschema` updates.** Schema changes coordinated in one PR:
   - New attributes for `context.code_quality.*`, `context.risk_tier`, `context.trajectory_intent`, `Trajectory.<8+ primitives>`.
   - New evidence context attributes for `context.evidence.positive_score`, `context.evidence.negative_score`, `context.evidence.neutral_count`, `context.evidence.insufficient_evidence`, and typed negative-evidence categories.
   - **`@action_on_violation` vocabulary expansion**: existing `warn | block | ask` plus new `inject_feedback` and `halt_session`. The annotation is the SINGLE canonical action-semantics surface; do not introduce parallel `@halt_session` / `@feedback` annotations.
   - **New `@safety_critical("true" | "false")` annotation** — meta about the rule, consumed by §6.3 fail-mode matrix. Default `"false"` (a Cedar eval error on this rule fails open). Bundled-T1-equivalent rules carry `"true"` (eval error fails closed). Distinct from `@action_on_violation` because it governs the *error path*, not the *match path*.

9. **Update `/enforce` to emit the new artifact set.** Per §9: classifier taxonomies, trajectory taxonomies, Cedar decision rules, and evidence-lifecycle commands from §6.5.

10. **Ship T2 in shadow mode.** Classifier runs, Cedar evaluates, decisions are logged but not enforced. Run against our own sessions for a week. Calibrate.

11. **Selective T2 enforce based on shadow data.** Per-rule enforcement toggle.

12. **T3 live feedback channel.** Add the supermodel cloud endpoint (Sonnet 4.6 default). Wire to PostToolUse `additional_context` (model-visible on Claude Code / Cursor; stderr fallback on Codex / Copilot / Gemini per §10). Default invocation policy per §5.4: every commit + every 50 tool calls + on T2 fail-open (same-event fallback when typed-signal classifier returns no usable verdict — see `runtime-pipeline-staging.md` §9.13 Trigger).

13. **T3 pre-push review.** Existing design from `tier-3-async-deep-review.md` — redacted session trajectory persistence + redacted/minimized diff composer + git note linkage + pre-push hook + Sonnet reviewer.

14. **Code quality taxonomies (CQ + RiskTier).** Once the classifier infrastructure is stable, add the quality classifier and write quality Cedar rules.

15. **Cloud-side Cedar (deferred).** Wait for Cloudflare Artifacts.

---

## 13. Decisions Made (Attribution)

For posterity — who decided what and why:

| Decision | Origin | Reason |
|---|---|---|
| Detection/decision separation as core principle | Conversation, Claude proposed from Sondera reading, user agreed | Composability + auditability + pluggability |
| LLM as classifier, not adjudicator | Sondera's pattern, user explicitly adopted | Bounded LLM job, JSON-schema constrained output, auditability |
| Cedar as decision substrate | Claude proposal, user agreed (hybrid) | Compound predicates Cedar expresses naturally |
| Two classifier call classes (per-event + trajectory) | User's idea (trajectory-aware) + Sondera's pattern (per-event) | Sequence patterns aren't catchable by per-event alone |
| Trajectory classifier on every non-blocked tool call | User's explicit framing | Sequence intent matters; can't pre-filter |
| Capture blocked attempts into trajectory | User's framing | Block-history is itself signal of intent |
| Prefix cache up to last successful tool call | User's idea | Cost control without sacrificing trajectory awareness |
| Stateless reasoning per call | User asked, Claude recommended, user agreed | Cache-friendlier, auditable, no confirmation bias |
| Pluggable backends (hosted + BYO + local) | User's framing | Privacy + cost + composability |
| Open-weight models preferred (vs proprietary like Claude/GPT for T2) | User's framing | Cost, deployability, no vendor lock-in |
| Hosted Interlinked cloud endpoint for default | Claude proposal, user agreed | Zero-setup user experience |
| Both 20b and 120b sizes via our cloud | User's framing | Cost vs accuracy trade-off; both have a place |
| LLM-as-attribute by default; LLM-as-action user-configurable | User's framing | Composability; default secure |
| PostToolUse feedback injection as new action type | User's framing | Steering not blocking; builds on existing additional_context |
| Tier 3 expanded to live feedback channel | User's framing | Supermodel cloud reviewer as an active participant, not just pre-push |
| Tier 3 warn-only by default; opt-in escalation | Existing decision per `feedback_reluctance_to_push` | Push-gating creates --no-verify pressure |
| Apply same architecture to code quality | Claude proposal, user agreed | Same pattern (taxonomies → Cedar) works for quality |
| CQ taxonomy (CQ0-CQ9) | Claude proposal | Mirrors Sondera's SC0-SC8 but for quality |
| RiskTier taxonomy | Claude proposal | Separate axis for context-sensitivity |
| Evidence valence in Cedar context | Jeffrey negative-evidence ledger analysis, user requested adoption | Compose positive, negative, neutral, and insufficient evidence inside one deterministic boundary |
| Absence-as-evidence Tier 1 signals | process_triage pattern, user requested adoption | Missing expected verification is a typed local signal, not free-text warning |
| Per-rule outcome ledger for `/enforce` lifecycle | franken_engine / eidetic / CASS patterns, user requested adoption | Static distilled rules need auditable outcome history before demotion or inversion |
| `InsufficientEvidence` classifier outcome | eidetic pattern, user requested adoption | Low-confidence classification should be explicit, not silently benign |
| Cedar-wasm client-side now | Claude proposal, user agreed | npm package, zero install, exact same validator |
| Cloud-side Cedar deferred to Cloudflare Artifacts | User's framing | Don't over-design for products that don't exist yet |
| Hybrid JSON GuardRule + Cedar coexistence | Claude proposal | Don't migrate wholesale; let each express what it's best at |
| Trajectory persistence to disk | Original T3 design, retained | Required for T3 pre-push review |
| Fail-closed on T1, fail-open on T2/T3 | Existing per `feedback_safety_continuity` | Safety availability vs strict gating |

---

## 14. Open Decisions Still

Things this doc doesn't resolve:

1. **Trajectory compaction threshold.** When do we roll over from verbatim to compacted? 50 events? 32K tokens? Both? Needs measurement.

2. **Cross-session trajectory.** Should T2's trajectory classifier see prior-session trajectories? Original tier-2 doc leaned no (in-session only). User hasn't weighed in.

3. **Cache scope: per-user only or per-org?** Per-user is privacy-safe. Per-org has higher cache hit rate. Per the user's "tenant-shared model" mention (§5.5), per-org has appetite but is a later phase.

4. **Classifier confidence threshold for "borderline".** Triggers escalation to 120b or T3. Default 0.7? Needs calibration.

5. **`@halt_session` action semantics.** When Cedar emits a session-halt, how does the harness implement it? Kill the agent process? Block ALL subsequent tool calls? Return a special error code that the runner interprets? Needs prototype.

6. **PostToolUse feedback inject — frequency / volume cap.** Too much feedback = noise the agent ignores. Need a cap (max 1 feedback per N tool calls? Or rate-limited per topic?).

7. **Tier 3 live-feedback invocation policy details.** Per-commit + every 50 tool calls is a starting point; needs tuning against real sessions.

8. **Tenant-shared classifier hosting model.** How do orgs configure their endpoint? Cloudflare Worker per org? Single shared cluster with per-org auth? Defer until we have an org account model.

9. **Cost attribution / billing.** If we operate the hosted endpoint, who pays for what? Free tier? Per-org subscription? Defer to product/business.

10. **Code quality LLM invocation policy.** Per-edit is expensive; quality changes slowly per file. Probably content-hash cache + only re-classify on file content change. Needs prototype.

11. **Typed classifier backends — LLM, trained/statistical, deterministic.** v2 currently uses the term "classifier" to mean specifically an LLM-detector with JSON-schema-constrained output (§4.1, §4.2). External-pulse review (process_triage pattern, item 5) raised whether some classifiers — specifically the per-event SC0-SC8 path — should be trained Bayesian / conformal classifiers on a closed feature space instead: microseconds, calibrated, deterministic. **Routed to RFC §18.** Five obstacles to adoption identified there; among them, vocabulary alignment across §2/§4.1/§4.2/§13/§16/§17, the conflict with /enforce's user-authored taxonomies, and the eval-corpus requirement before any blocking confidence threshold is defensible.

12. **Cache mismatch as a risk class.** When a prompt cache returns a response that doesn't correspond to the prefix the harness thinks it sent (provider-side eviction policy change, cross-region cache routing, prefix encoding mismatch, cross-tenant cache leak in a worst case), the classifier verdict may be based on different content than the harness intended to classify. This is its own risk class beyond simple cache-miss-as-cost. **User flagged for follow-up (round-2 review):** *"In its own way, a prompt cache not matching the expected input may be a risk in and of itself."* Outstanding work: catalog the realistic failure modes per provider, decide whether to verify response-vs-prefix per call (and how), and what to do when verification fails (re-issue with cache-disabled, fail open, escalate to authoritative-action mode). Likely promoted to RFC once the failure-mode catalog exists.

13. **Data-class config schema details (§6.4) — narrowed in round-3.** The routing-source question is now resolved in §6.4: deterministic preflight (scanner → file-sensitivity → path patterns → session taint), LLM ratchets up only on the next event. What remains open is the *schema* of the user-facing config:
    - Default value for users who don't configure it (lean: conservative — `Confidential` and above → local only; `HighlyConfidential` → never remote, always fail-open).
    - Override at the per-policy level (some policies may justify cross-class transmission with explicit user consent, e.g. "send `Internal` data to this BYO endpoint for *this specific* classification job only").
    - Whether the data class is itself an entity in Cedar context (so policies can branch on `context.data_class` directly without the harness pre-baking the routing decision).
    - File-sensitivity-rule schema: glob patterns to data-class mapping format and merge semantics across config files.
    Needs a working prototype against the existing content-scanner before locking the schema.

---

## 15. Contradictions With Prior Design Docs

Line-by-line where this doc supersedes specific sections of prior docs:

### `tier-2-llm-policy-gate.md` (major rewrite)

| Section in old doc | Status | What replaces it |
|---|---|---|
| §1 problem statement | Superseded | This doc's §1, §2 |
| §2 architecture diagram | Superseded — new diagram shows classifier→Cedar→decision instead of LLM→decision | This doc's §4.1 |
| §3 provider selection (Groq → Cerebras → Ollama) | Superseded by pluggable backend in §4.6 | Still valid as one possible backend chain; not THE chain |
| §4 inference path (LLM returns decision) | Superseded — LLM returns label, Cedar returns decision | This doc's §4.2, §4.4, §4.8 |
| §5 prompt structure (cached prefix = policies + early trajectory) | Partially valid — prefix-caching pattern stays, but suffix shape changes (taxonomy + content, no "current call decision request") | This doc's §4.4 |
| §6 trajectory format | Compatible | Retained, with capture-blocked-attempts addition (§4.3) |
| §7 verdict format (decision: block/warn/allow) | Superseded — replaced by typed-label output | This doc's §4.1 |
| §8 violation signature cache key | Superseded — replaced by content-hash (per-event) + prefix-hash (trajectory) | This doc's §4.4 |
| §9 pre-filter design | Partial — applies to per-event classifier, NOT trajectory classifier | This doc's §4.2 (trajectory runs on every call) |
| §10 fail modes (fail-open) | Retained | Compatible |
| §11 cost model | Superseded — needs recompute with trajectory classifier on every call | TBD; needs new estimate |
| §12 rollout cadence (shadow → enforce) | Retained | Compatible |
| §13 cross-runner contract | Retained | Compatible |
| §14 local-only fallback | Retained | Compatible with pluggable backend §4.6 |
| §15 human-in-the-loop opt-in | Retained | Compatible |
| §16 open decisions | Some resolved, some still open | See §14 |

### `tier-3-async-deep-review.md` (additive, not replaced)

| Section | Status | Note |
|---|---|---|
| §1-§4 (problem, position, trigger, scope) | Retained | Pre-push surface stays |
| §5 model selection (Sonnet/Opus) | Retained | Still default Sonnet, Opus on demand |
| §6 input format | Retained | Compatible |
| §7 output format | Retained | Compatible |
| §8 cache strategy | Retained | Compatible |
| §9 cost model | Retained for pre-push; live-feedback adds new cost line | TBD |
| §10 session log persistence | Retained | Required for both T3 surfaces |
| §11 integration with /review etc. | Retained | Compatible |
| §12 per-skill prose evaluation | Retained | Compatible |
| §13 warn-only contract | Retained | Compatible (extended to live-feedback surface) |
| §14 failure modes | Retained | Compatible |
| §15 verify/ultrareview integration | Retained | Compatible |
| §16 open decisions | Some resolved (e.g. live feedback is now in scope) | See §14 |

**Added by this doc:** §5.1 live feedback channel (the supermodel-during-agent-work surface), §5.3 LLM-as-action escape hatch, §5.4 invocation policy, §5.5 tenant-shared models.

### `skills/enforce/SKILL.md` §15 (needs follow-up update)

The three-pass routing model in §15.1 of `/enforce` needs updating:
- Pass 2 routing target: was "policy.md + cedar files" with the LLM as adjudicator. Now: "classification taxonomy .policy.md + classifier-schema.json + cedar decision files."
- Add Pass 2': "trajectory-taxonomy.md" for trajectory-aware imperatives.
- §15.2 (Pass 2 policy.md format) needs new field: `classifier_schema_ref` pointing to the JSON schema for output.
- §15.3 (Cedar transpilation) — the Cedar emission stays, but its predicates now reference classifier output fields rather than embedding the policy prose inline.

These changes don't break /enforce's current artifact emission; they reframe what the artifacts mean. Existing distilled artifacts can be re-run after the SKILL.md update lands.

### Memory entries (need updates)

`project_three_tier_policy_enforcement.md`: needs full rewrite to match this doc. Currently says: *"Tier 1 shipped 2026-05 (/enforce three-pass: deterministic + LLM-gate policy.md/Cedar + prose for Tier 3 review)"* — should reflect that Tier 2 is now classifier+Cedar, not LLM-gate alone.

`project_llm_policy_enforcement.md`: framing shift — this memory positioned T2 as "narrow classifier" originally, then was reframed as "policy gate". Now we're back to "narrow classifier" but with explicit detection/decision separation and a fixed taxonomy contract.

### Preserves scope from (verified, no contradictions)

The following docs/code define existing scope that v2 inherits unchanged. External-pulse review (Jeffrey Emanuel cluster analysis) surfaced candidates that conflict with these scopes; this revision keeps them on the right side of the line. Listed here so a future reader proposing one of these doesn't have to re-derive why it was rejected:

- **`docs/plans/free-cli-adoption/00-index.md:91-103`** — multi-agent peer approval (slb v2), cross-customer learning of finding fix-rates (meta_skill bandit), cross-repo PageRank, full LLM coordinator + specialists review, mutation testing, authoritative signature DB updates, compact-time memory ingest, and customer-SIEM logpush are ALL Guardrails / Agent CI tier, not free-CLI v2 core. Do not add these to v2 local-harness primitives. The corresponding external-pulse adoption candidates (items 8 slb peer-quorum, 10 meta_skill bandit) are out of scope for this doc.
- **`docs/plans/free-cli-adoption/17-replay-testing-and-decision-receipts.md:31-38`** — per-receipt HMAC only; no chained audit; no cross-machine replay; no verifier service. v2 §6.1 inherits unchanged. The corresponding external-pulse candidate (item 2 franken_engine signed receipts) is restricted to per-receipt HMAC at the local tier.
- **`docs/plans/09-local-runtime-quality-hooks.md:581`** — recurrence aggregator is propose-only (*"There is no automatic promotion — drop that claim from the plan"*); the user surfaces ratchets via `interlinked recurrence propose <id>` and decides manually. v2 preserves that no-silent-mutation rule. Round 6 adds a separate per-rule outcome ledger (§6.5; `docs/plans/free-cli-adoption/20-negative-evidence-ledger.md`) whose `auto-demote` / `auto-invert` operations are explicit user commands with dry-run review and provenance, not background promotion.
- **`docs/plans/free-cli-adoption/01-evaluator-architectural-upgrades.md:33-40`** — heredoc handling uses spans + regex; explicit non-goal: *"No full Bash AST parser. DCG has one; we don't need it."* v2 does NOT adopt DCG's tree-sitter approach. The corresponding external-pulse candidate (item 1) is folded as "span-based handling per existing plan", not as tree-sitter.
- **`src/lib/hook-installers.ts:32-66, 144`** — actual hook-matcher state, which differs from the older `AGENTS.md:35` claim that PostToolUse is uniformly "scoped to mutating tools" and that `PostToolUseFailure` is universally "intentionally not registered". Per-runner verified state: Claude Code uses `POST_TOOL_USE_MATCHER = ""` (every tool fires; `PostToolUseFailure` intentionally omitted to dodge duplicate-hook-count issues); Cursor registers `postToolUseFailure`. v2 §4.10 feedback injection respects this per-runner matrix rather than the older single-line constraint. The corresponding external-pulse candidate (item 11 pcr refinements) is folded as matcher-respecting refinements only.
- **`src/harness/reservations.ts:26-91`** — current reservation API is `reserveFile(filePath, agentName, ttlSeconds)`, single-holder, path-only, with a fully-specified transition state machine (`ReservationTxn` discriminated union, `applyTransition`, property-tested replay). Adding LeaseMode and task-ID is a real architecture change (server schema, conflict matrix, write-starvation handling, new property tests on the expanded transition set). The corresponding external-pulse candidate (item 9 mcp_agent_mail shared/exclusive) is NOT a §10 addendum and is out of scope for this v2 patch.
- **`src/harness/recurrence.ts:363-380`** — `markOutcome` public API already exists; producer paths land in Phase 2. v2 references this existing primitive rather than proposing parallel mechanisms.
- **`src/harness/content-scanner/extractor.ts:74` + `docs/harness.md:585-590`** — egress attribution + bidirectional taint is already shipped. v2 references this existing mechanism (see §3.2a) rather than proposing a duplicate `context.egress` Cedar field.

---

## 16. Glossary

For unambiguous reading:

| Term | Meaning here |
|---|---|
| **Detector** | A component that produces typed signals from raw input. YARA, tsc, LLM classifier, structural-check producer. |
| **Decision layer** | Cedar (or JSON GuardRule) — produces allow/warn/block/halt from signals. |
| **Classifier** | Specifically an LLM detector that classifies content/trajectory into a typed taxonomy. |
| **Adjudicator** | A component that produces decisions directly. We avoid putting LLMs in this role. |
| **Per-event classifier** | T2 classifier called per tool-call event on content (Sondera's pattern). |
| **Trajectory classifier** | T2 classifier called on the trajectory sequence (our addition). |
| **Supermodel** | T3's SOTA reviewer model (Sonnet 4.6 / Opus 4.7 / larger). |
| **Live feedback** | T3 supermodel surface that operates during agent work, not just pre-push. |
| **Taxonomy** | A fixed set of classes the LLM classifies into. Includes prose definitions + labeled examples. |
| **Cedar** | The policy language we use for decision logic. cedarpolicy.com. |
| **Cedar-wasm** | `@cedar-policy/cedar-wasm` npm package — in-process Cedar validator/evaluator. |
| **GuardRule** | Our existing JSON policy format from `src/harness/types.ts`. Coexists with Cedar (§11). |
| **Active_when** | Cedar/JSON predicate that gates whether a rule applies in the current context. |
| **Trajectory** | Append-only log of tool calls in a session. Persisted to `.interlinked/trajectories/`. |
| **EvidenceValence** | `positive`, `negative`, or `neutral` signal valence attached to a detector/rule outcome. |
| **NegativeEvidence** | A typed signal that risk increased or expected evidence was absent, such as `tests_not_run` or `no_verification_after_edit`. |
| **InsufficientEvidence** | Explicit classifier outcome when confidence is below threshold; not equivalent to benign. |
| **Rule outcome ledger** | Append-only `.interlinked/rule-outcomes.jsonl` history used by `/enforce outcomes`, `auto-demote`, and `auto-invert`. |
| **fail-open** | When a layer fails, allow the tool call to proceed. Logged for telemetry. |
| **fail-closed** | When a layer fails, block the tool call. Used for safety-critical T1 only. |

---

## 17. Quick reference — what changed from the original three-tier design

Five-sentence summary:

1. **Tier 2 used to be "LLM evaluates a prose policy and returns block/warn/allow."** Now: "LLM classifies content into a typed taxonomy; Cedar (or successor) evaluates predicates over the labels and returns the decision."
2. **Tier 2 used to invoke the LLM on ~1.5-2.5% of tool calls via aggressive pre-filtering.** Now: per-event classifier still uses pre-filtering, but the trajectory classifier runs on every non-T1-blocked tool call with prompt-cache amortization (prefix up to last successful call).
3. **Tier 3 used to be "pre-push deep review only."** Now: pre-push deep review PLUS a live-feedback surface during agent work where a supermodel injects feedback through PostToolUse `additional_context`.
4. **Architecture used to entangle detection and decision.** Now: every detector produces typed signals; Cedar is the default decision point, with `LLM-as-action` as an explicit opt-in escape hatch for advanced configurations.
5. **Code quality used to be entirely TS-coded inline checks.** Now: same pattern applies — CQ + RiskTier classifiers feed Cedar, which composes them with existing tsc/biome/oxlint/structural-check signals to make decisions.

That's the architecture. The rest is implementation order, attribution, and contradictions with prior docs.

---

## 18. RFC — Typed classifier backends

**Status:** Open question raised by external-pulse review of process_triage (Jeffrey Emanuel cluster, item 5). **Not adopted.** Promoted to RFC after review surfaced five obstacles to a §4.2 rewrite. Acceptance criteria + outstanding work below.

### 18.1 The proposal

v2's current §4.2 uses "classifier" to mean specifically an LLM-detector with JSON-schema-constrained output. The proposal: broaden "classifier" to mean any typed-label detector — including trained Bayesian / conformal classifiers on closed feature spaces — and route some classification jobs through non-LLM backends for cost/latency wins.

Specifically: the per-event classifier's job (classify content into the 8 fixed SC0-SC8 security categories) is a closed feature space. A calibrated Bayesian classifier with engineered features (command tokens, file paths, content patterns, AST shape) could run in microseconds with conformal confidence bounds. The trajectory classifier remains LLM-based (natural-language intent reading over sequences).

### 18.2 Why this is RFC and not adopted

Five obstacles surfaced under review:

1. **Vocabulary conflict.** v2 §2, §4.1, §4.2, §13, §16, §17 all use "classifier" specifically to mean LLM-detector. Broadening the term requires coordinated edits across the entire doc, not a §4.2 spot rewrite. Otherwise §4.2 would contradict §17's summary.

2. **Cost-model misread.** v2's existing cost-control story prefilters per-event classification + content-hash caches results (§4.4). Per-event LLM calls are NOT the every-call cost center; the **trajectory** classifier is. Replacing per-event LLM with Bayesian helps but does not address the dominant cost line.

3. **/enforce taxonomy conflict.** v2 §9 (and the existing `/enforce` skill at `skills/enforce/SKILL.md` §15) says `<group>.policy.md` and `<group>.classifier-schema.json` are derived from USER-AUTHORED policy categories. A pre-trained Bayesian classifier on the SC0-SC8 taxonomy specifically cannot serve arbitrary user taxonomies. The most this proposal supports is an **optional built-in detector** for the SC taxonomy, NOT a general per-event replacement.

4. **Conformal confidence is not block-safe without an eval corpus.** The proposed Cedar rule `forbid when context.per_event.confidence > 0.95` is only defensible with:
   - A labeled eval corpus (we don't have one)
   - Drift monitoring infrastructure (we have none)
   - OOD behavior characterization
   - Shadow-mode calibration over real sessions (multi-week minimum)
   Without all four, this violates the zero-FP discipline for blocking checks set in `AGENTS.md:33`: *"`pre_block` error checks must be fully deterministic. Heuristic smell/taste/coverage checks belong as warnings or in `verify --all-checks`."*

5. **No reference implementation.** process_triage uses BMA + Mondrian conformal for fraud detection. The *technique* generalizes; the specific 40-model ensemble is overkill for SC0-SC8. A smaller ensemble would have to be built, trained, evaluated, and OOD-tested before any claim of correctness.

### 18.3 Acceptance criteria (RFC → adopted)

Before promoting from §18 RFC to a real §4.2 change, this work must land:

- Vocabulary across §2, §4.1, §4.2, §13, §16, §17 broadened to "typed detector backends" with LLM, trained-statistical, and deterministic as parallel options. One coordinated edit pass.
- A labeled eval corpus of ≥1000 events per SC category, drawn from real `.interlinked/classifier-log/` traces. This implies T2 LLM-only ships first to generate the corpus.
- Shadow-mode parallel evaluation: Bayesian + LLM both classify each event for ≥2 weeks; agreement rate ≥90%, disagreement cases human-reviewed.
- Conformal coverage validated empirically within 5% of declared (e.g., 95% coverage region contains 90-100% of true labels on held-out data).
- An OOD detector that flags inputs outside the training distribution; OOD-flagged events fall back to LLM rather than blocking on Bayesian alone.
- Drift monitoring: weekly recomputation of accuracy/coverage on a held-out corpus. Alerting when accuracy degrades.
- A Cedar attribute model that distinguishes `context.per_event.{label, confidence, source: "llm" | "bayesian" | "deterministic"}` so policies can require LLM confirmation on high-stakes decisions even when Bayesian is the default detector.

### 18.4 Position relative to current v2

Until adoption: SC0-SC8 classification stays LLM-only in v2. The Bayesian backend, if it lands, is **one possible specialization** layered on later as an optional detector — NOT a wholesale replacement for the per-event classifier path. Code-quality CQ taxonomy (§7) stays LLM-only for the same reasons — and arguably forever, since several CQ categories (CQ4 abstraction smell, CQ7 test smell, CQ9 API design) are genuinely semantic and lack a closed feature space amenable to engineered features.

### 18.5 Related future work (RFC-adjacent, also not adopted)

The following external-pulse candidates were proposed in cluster analysis but conflict with existing scope per §15 "Preserves scope from". Listed here so future readers can find them rooted to their rejection rationale:

- **Signed hash-chain audit logs** (franken_engine pattern, item 2 full form) — Guardrails-tier per `docs/plans/free-cli-adoption/17-replay-testing-and-decision-receipts.md:31-38`. v2 keeps per-receipt HMAC at local tier only.
- **Background auto-inverting recurrence rules to PITFALL** (cass pattern, item 7 full form) — still rejected at `docs/plans/09-local-runtime-quality-hooks.md:581` (*"There is no automatic promotion — drop that claim from the plan"*). Round 6 adopts the safe subset: an append-only outcome ledger plus explicit `/enforce auto-invert [--dry-run]` command with provenance.
- **Peer-quorum approval action `@ask_with_quorum`** (slb pattern, item 8) — multi-agent Guardrails-tier per `docs/plans/free-cli-adoption/00-index.md:94`. Future enterprise multi-agent surface, not v2 local harness.
- **Thompson-sampling bandit for finding prioritization** (meta_skill pattern, item 10) — cross-customer learning, Guardrails-tier per `00-index.md:95`. Same disposition.
- **Shared/exclusive reservations with task-ID keying** (mcp_agent_mail pattern, item 9) — real architecture work (server schema change, conflict matrix, write-starvation handling, expanded property tests on `applyTransition`). Not a §10 addendum and not in v2 patch scope. Worth a separate RFC if/when multi-agent demand justifies the schema change.

Each of these can be promoted to its own RFC if/when the operational signal justifies the work. None of them belong in v2 today.
