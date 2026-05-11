# Agent Memory Architecture — Pull, Push, Predict

**Status:** Design / not yet implementation. Foundational document — every later memory-system change should align with the principles below.

**Origin:** Authored after a session in which the assistant repeatedly asserted "we don't have a Supermodel integration" / "we'd need to build a harness check that uses the on-disk graph" while a complete integration sat in the working tree (`src/harness/supermodel-graph.ts`, 342-LOC parser; `src/harness/evaluator/pre-tool.ts:160`, harness consumer; 625 LOC of tests; two doc files). The failure was not in the memory store, the index, or the agent's training — it was in **the absence of an architectural mechanism that forces the agent's claims to be checked against ground truth before they ship.** This document specifies that mechanism.

**Audience:** Engineers building this system. Anyone implementing should also have read `pre-post-pipelined-cloud-checks-and-failure-recovery.md` (failure-recovery pipeline, similar harness shape) and CLAUDE.md's `# auto memory` section (current memory-store contract).

**Iteration history.**
- **v1** used `predicted_relevant:` as the agent contract — a relevance forecast over the retrieval set. External review identified that the load-bearing primitive is **claim-evidence linkage**, not retrieval forecasting.
- **v2** replaced predicted_relevant with `claim_dependencies:` and added authority tiers, two-stage reveal, enforceable/advisory split, typed evidence records, and a shadow-evaluation phase. Did not yet bound agent-context-token cost.
- **v3** (this document) bounds the agent-context-token budget explicitly per regime, promotes context-efficiency mitigations from "implied levers" to design requirements (forecast cache, pointers-only Stage 2, claim-shape gating), names what's in and out of scope, sets false-block and true-block rate targets on shadow evaluation, refines authority tier A to handle dead-but-present code, reframes Sketch F's role, tightens concept-extraction strategy from "open question" to "concrete plan," and specifies a reproducible benchmark methodology.

---

## TL;DR

Six architectural primitives, all deterministic at the boundary, run inside dual budgets — **30s pre + 30s post wall-clock per tool call** for harness-side compute, and a **per-regime agent-context-token cap** (5–12% of window) for what reaches the agent:

1. **Push (pre-claim).** Every UserPromptSubmit and every PreToolUse fires deterministic concept-extraction + multi-modal joint retrieval. Surfaces *category counts only* to the agent. Caches forecast per turn — re-fires only on novel concepts.
2. **Authority tiers.** Retrieved candidates are typed by authority: working tree (active) > working tree (dead-but-present) > tests/docs generated from code > committed architecture docs > user-authored memory > git history > prior assistant transcripts. Retrieval is uniform; *trust is not*.
3. **Claim_dependencies contract (during claim).** The agent emits a structured `claim_dependencies:` block when its response makes existence/non-existence/state claims about indexed concepts. Trivial-action responses don't get the block. Non-existence claims declare their search scope.
4. **Two-stage reveal.** After the agent's claim_dependencies block is logged, the system reveals *pointers only* (path:line_range + one-line summary) — snippets are opt-in via an `expand` follow-up. Forecast is uncontaminated; bandwidth is preserved.
5. **Reconciliation (post-claim).** Stop hook computes: did the declared enforceable dependencies cover the actual enforceable evidence? If yes, response ships. If no, `decision: "block"` forces a re-grep + re-claim cycle. Only **enforceable** misses block; advisory misses warn.
6. **Bounded scope.** The design catches existence/non-existence/state claims about indexed concepts. It does not catch claims about runtime behavior, semantic correctness over correct evidence, or claims about un-indexed concepts. Naming the scope keeps the contract defensible.

The shape of the failure this catches: an agent with a wrong *model* of the codebase (its claims don't depend on evidence the system knows exists) is forced to confront the discrepancy before its claim ships. The agent's reading log is not measured; the agent's claim-evidence linkage is.

The system has no way to verify itself if its retrieval pipeline is bad. **Phase 0.5 — shadow evaluation against golden cases mined from prior sessions** — runs before any agent-visible surfacing lands. Enforcement is gated on both true-block rate ≥ 70% on positive golden cases AND false-block rate ≤ 5% on negative ones.

---

## 1. The failure case: Supermodel triple-miss

The motivating session is the canonical failure mode this design has to catch. Reproduced concisely:

| Turn | User prompt | Agent claim | Reality |
|---|---|---|---|
| 1 | "How would Supermodel `.graph.` files work for this type of system?" | "I'd build first... emitter + manifest + agent-facing query tool" | Complete integration exists. `src/harness/supermodel-graph.ts` parses `.graph.<ext>` shards; `evaluator/pre-tool.ts:160` surfaces HIGH/MEDIUM impact warnings on PreToolUse for every Write/Edit/MultiEdit/apply_patch. |
| 2 | "I thought we already had a harness check that uses the on-disk graph" | Found `graph-history.jsonl` + `structure-cache/`; argued the loop "isn't closed" | Loop was closed by the missed dedicated module; my grep was for the wrong terms. |
| 3 | "Don't we already have a full Supermodel integration?" | Direct grep for `supermodel` instantly returned 9 code files + 3 memory entries + 2 docs. | Should have happened on turn 1. |

Properties of the failure that any solution must address:

- **The relevant memories existed.** Three reference memories about Supermodel were on disk and would have appeared in any inverted-index lookup on the term.
- **The relevant code existed.** A 342-LOC dedicated module sat in the working tree.
- **The agent's reading log was not the problem.** The agent had read the memories. Reading logs measure behavior; they don't measure model accuracy.
- **The agent had explicit prior instructions** (`feedback_verify_against_codebase.md`, CLAUDE.md "Before recommending from memory" section) and ignored them. *Disposition cannot be the load-bearing layer.*
- **No tool-call gate fired**, because the failure was in assistant text, not in a tool call. The harness's existing PostToolUse and PreToolUse machinery never had jurisdiction over the failing surface.

The architectural conclusion: the agent's *claims* about the codebase have to be made checkable against ground truth before they ship. Tone-discipline ("be careful," "verify before claiming") is unenforceable from the harness side and demonstrably fails when the agent's prior is wrong.

---

## 2. Why the obvious solutions fail

### Skills (rejected)
A `/recall <concept>` skill delegates the verification decision to the agent. The agent that needs the verification is the same agent that decided not to verify. This reduces to "be more careful," which just failed twice.

### Pure embeddings (rejected as primitive)
Embeddings give *relevance*, not *identity*. A query about "Supermodel integration" pulls passages similar to that phrase; it doesn't necessarily surface the specific file `supermodel-graph.ts` higher than philosophically-related passages from prior sessions. Relevance is fuzzy where identity is sharp; the failure mode being addressed is identity-shaped.

Embeddings remain useful as a **re-ranker over an inverted-index candidate set**, never as the primitive.

### Always pushing the full identifier list (rejected)
If the push surfaces specific identifiers in `additional_context` *before* the agent declares dependencies, the agent copies them into its declarations and the reconciliation becomes vacuous. Push must reveal *categories + counts* during the forecast window.

### Hiding everything to preserve the test (rejected, was in v1)
The v1 design hid identifiers entirely to keep the forecast uncontaminated. This withholds context the system already spent compute computing. v2 fixed this with a **two-stage reveal**: forecast on counts only; reveal pointers (and on-demand snippets) *after* the forecast is logged.

### Predicting the retrieval set (rejected, was in v1)
The v1 contract was `predicted_relevant:` — an enumeration of identifiers the agent expects retrieval to surface. The actual failure mode is whether the agent's *claims* are supported by retrieved evidence. The two are correlated but not identical; the v2 contract directly measures claim-evidence linkage, which is what fails.

### Single-tier authority across retrieved candidates (rejected)
Retrieval is uniform: pull from everywhere in parallel. *Trust is not uniform*. A claim "Supermodel exists" supported by `src/harness/supermodel-graph.ts` (current working tree) is a different epistemic kind from one supported by "the assistant said in a prior session that Supermodel was being built." Treating them equivalently lets stale assistant claims pollute current ground truth. Authority tiers gate which retrieved evidence can support an enforceable claim.

### Always-on heavy retrieval at unbounded context cost (rejected)
Initially appeared too expensive on wall-clock — the harness already owns a 5-second PreToolUse budget and a 30/50/60-second PostToolUse budget. The 30-second pre-budget extension gives 60 seconds total per tool-call window. **At that wall-clock budget, vector retrieval over the full corpus, LLM rerank, and graph-walk are all in scope.** *But* at unbounded agent-context-token cost, the design eats up to 28% of the window per session. The agent-context-token budget (§8) is the second constraint, equally load-bearing.

---

## 3. Scope: what this design catches and doesn't

The contract is structural — claim-evidence linkage. It can enforce that claims about project state cite evidence the system can verify. It cannot enforce semantic correctness over verified evidence.

### Catches

- **Existence claims about indexed concepts** where evidence exists and the agent claims it doesn't. (The Supermodel triple-miss is this category.)
- **Non-existence claims** where the agent's declared search scope misses indexed concepts that resolve to evidence.
- **State claims** about specific files/symbols where the cited evidence doesn't resolve, or where actual_enforceable items the agent didn't cite contradict the claim.
- **Stale-memory contamination**: claims supported only by tier-E (transcripts) or stale tier-C (memory) evidence get downgraded to advisory and don't enforce.

### Does not catch

- **Claims about un-indexed concepts.** Concept extraction returns zero hits → no forecast → no calibration signal. The agent operates without the ratchet. (Out-of-scope by design; would require LLM-based concept extraction at the trigger, which violates principle 1 — boundaries deterministic.)
- **Claims about runtime behavior.** "This function returns the correct result" / "this is performant" / "this has no race conditions." Only static evidence is checkable; behavioral correctness requires test execution, which is a different system.
- **Behavior claims about evidence that exists.** "This implementation handles edge case X" — passing-test status is verifiable, but correctness-of-implementation generally is not. The most this design does is detect when the agent's *cited test* doesn't actually exist; whether the test covers the claimed behavior is out of scope.
- **Subtle wrong reasoning over correct evidence.** The agent cites the right files but draws the wrong conclusion from them. The contract checks linkage (claim → evidence), not inference (evidence → conclusion). The reviewer's framing in the v2 transition was sharp on this: we measure dependency, not deduction.
- **Hallucinated evidence that happens to exist.** An agent that names `src/harness/supermodel-graph.ts` to support a claim it didn't read passes precision; the system can't tell whether the agent actually consulted the file. Mitigation is the reading-log telemetry in §11, but it's diagnostic, not enforceable.

### Why the scope is bounded this way

Out-of-scope failure modes need different mechanisms — test-execution coverage, mutation testing, code review, semantic-correctness oracles. Trying to extend this contract to cover them either (a) introduces stochastic scoring at a boundary (violates principle 2) or (b) requires LLM judgment in the enforcement loop (violates principle 1). Both compromises are worse than honest scoping.

The Supermodel-class failure — the canonical case this design catches — is the most common high-impact failure mode in transcripts of agent-on-existing-codebase work. Catching it well is more valuable than catching everything badly.

---

## 4. Authority tiers

Retrieved candidates carry an `authority` field. Reconciliation rules consult this field; not all retrievals are equal evidence.

| Tier | Examples | Authority | Enforceable? |
|---|---|---|---|
| **A1 — current and active** | Working-tree files with active callers / recent commits / generated indexes referencing them; passing tests; currently-running harness checks | Highest. *What the codebase IS now and is being used.* | Yes |
| **A2 — current but stale** | Working-tree files with zero callers, no recent commits (default threshold: no edits in N=180 days), not referenced by structure-cache | Lower. *Technically present, functionally absent.* | Advisory by default; enforceable for existence claims with explicit caveat |
| **B — code-derived** | Tests (currently passing), docs auto-generated from code (e.g. typedoc, structural-checks output), committed architecture docs that pin to specific files/symbols | High. *What the code claims to be*, encoded by tooling. | Yes (passing tests) / Advisory (other) |
| **C — user-authored memory** | `MEMORY.md` entries, durable user preferences, `CLAUDE.md` rules, hand-written `docs/design/*.md` | Medium-high. *What the user claimed to be load-bearing*. Subject to staleness. | Yes if `resolution_status: current`; else advisory |
| **D — git history** | Commit subjects, PR titles, commit-attached file changes | Medium. *What the project did*, not what it currently is. | Advisory |
| **E — prior assistant transcripts** | Anything an assistant said in a prior session | Low. *Contaminated with prior wrong beliefs*. | Advisory only — never enforceable for any claim type |

### Derived rules

1. **Existence claims are enforceable only against tier A1, A2, or passing-test tier B.** A user-written memory entry saying "Supermodel exists" doesn't make a Supermodel-existence claim enforceable on its own; the working-tree file is what makes it enforceable. The memory is supporting context.

2. **Failing tests and stale memories drop tier.** A failing test in tier B drops to tier D (history, not authoritative). A user memory whose `stillExists()` check fails (it names a path that no longer exists) drops to tier E.

3. **Tier A1/A2 distinction handles dead-but-present code.** A claim "we have feature X" supported by a tier-A2 file (present but never called) passes existence reconciliation but the response should hedge: "feature X has an implementation at `src/foo.ts`, but it has no callers and was last touched 240 days ago — verify it's still wired up before relying on it." The dead-code detection logic from `src/harness/structural-checks.ts` already produces the signal needed to assign A1 vs A2.

4. **A2 promotion rule**: if structure-cache, project-graph, or any harness check actively consumes the A2 file, it promotes to A1. The classifier is a one-pass query over project-graph, not a static field.

Authority is computed at retrieval time. Cached values would re-introduce the staleness the field exists to solve.

---

## 5. The three primitives in detail

### 5.1 Push: deterministic pre-claim context surfacing

**Trigger.** Two surfaces:
- `UserPromptSubmit` event in `src/harness/server.ts:764` (already received; currently used only for PII redaction).
- `PreToolUse` event for every Write/Edit/MultiEdit/apply_patch (already received; budget extends from 5s → 30s under wide regime).

**Forecast cache per turn (REQUIREMENT, not optional).** The same prompt produces the same concept extraction every PreToolUse. The forecast for tool call N=5 of turn 12 carries identical information to the forecast for tool call N=4 unless tool input introduces novel concepts. The push fires on:
- Every UserPromptSubmit (full forecast)
- The first PreToolUse of a turn (full forecast)
- Subsequent PreToolUse calls only when concept extraction returns a novel set vs the cached set for the current turn

The cache key is the turn id (already tracked in session-state); cache lifetime is one turn. This is the single most important context-efficiency requirement — without it, a heavy session multiplies forecast surface by 5–10×.

**Concept extraction.** Deterministic, in two layers.

*Phase 0 baseline (regex):*
- Identifier-shaped tokens: `/[A-Z][a-zA-Z0-9_]*/`, `/[a-z][a-z0-9_]*_[a-z0-9_]+/`
- File-path-shaped strings: `/\b[\w./-]+\.[a-z]{1,5}\b/`
- Backtick-quoted spans
- Capitalized multi-word terms (proper nouns)
- Quoted strings that look like values, paths, or names

*Phase 0.5 measurement:* concept-extraction recall on golden cases (§11). If recall < 0.9, advance to Phase 0.6.

*Phase 0.6 if needed (tree-sitter):* parse the prompt for code blocks and quoted code-mention patterns; extract identifiers from inside them. Same shape works for TS, Python, Rust, Go via the existing tree-sitter infrastructure.

LLM-based extraction at the trigger is explicitly *out of scope* — it would violate principle 1 (boundaries deterministic). If regex + tree-sitter can't clear 0.9 recall on a representative golden corpus, we re-evaluate the trigger choice rather than introduce stochasticity at the boundary.

**Multi-modal joint retrieval.** Under the wide regime (30s pre), the system runs in parallel:

| Source | What it catches |
|---|---|
| Trigram index (codebase) | Exact identifier hits |
| Trigram-style index (memory entries) | Exact concept hits in memory |
| Embedding similarity over codebase + docs | Conceptual / paraphrased mentions |
| Project-graph 1-hop neighbors | Structural blast-radius |
| Git-log subject + body search | Historical context |
| Recurrence-row signature match | Patterns that have repeated before |
| Decision-graph walk | Causally-linked prior decisions |

Each retriever returns a candidate list with `{authority, confidence, source}` per item. Rank fusion (reciprocal-rank or learned-weights) combines into a unified ranking. Each candidate is a typed evidence record (§6).

**Surfacing — Stage 1: forecast channel.** The push returns to the agent's `additional_context`:

```
[interlinked:concept-index] Your prompt mentions:
  Supermodel    → 9 code (A1: 6, A2: 1, B: 2) · 3 memory (C: 3) · 2 docs (B: 2)
  .graph        → 4 code (A1: 4) · 1 doc (B: 1)
```

Categories, counts, and authority distribution. **No identifiers in the forecast channel.** Identifiers are kept server-side for reconciliation (§5.3).

**Surfacing — Stage 2: working-context channel — POINTERS ONLY by default (REQUIREMENT).** After the agent emits its `claim_dependencies:` block (§5.2), the harness logs the forecast-vs-actual diff and reveals pointers:

```
[interlinked:bundle] Top evidence for your prompt:
  src/harness/supermodel-graph.ts                 (A1 · code, 342 LOC)
  src/harness/evaluator/pre-tool.ts:155-194       (A1 · code · consumer)
  src/harness/__tests__/supermodel-graph.test.ts  (B · test, passing)
  docs/integrations/supermodel.md                 (B · doc)
  reference_supermodel_thesis.md                  (C · memory · superseded_by → src/harness/supermodel-graph.ts)
```

Path + line range + tier + one-line summary. No bytes. The bundle is the compute the system already paid for, surfaced compactly.

**Snippets are opt-in.** The agent requests them with a follow-up:

```
[interlinked:bundle] expand src/harness/supermodel-graph.ts:1-50
```

Which then surfaces (in `additional_context` on the next turn) the actual byte content. This makes snippet retrieval visible as an explicit context-cost choice, not a passive injection.

**Cost envelope (wall-clock).** Concept extraction is microseconds. Index lookups under wide regime are ~100ms parallel. Embedding rerank ~1–5s on CPU (bge-small / bge-reranker-base scale). Total wall-clock under 10s — fits in the 30s pre-budget with headroom for slow paths.

**Cost envelope (agent context).** Stage 1 forecast: ~80–120 tokens per fire. Stage 2 pointer bundle: ~30–80 tokens per pointer × 5–10 pointers = 150–800 tokens. Snippet `expand` requests: agent-elective, billed only when used. See §8 for per-regime totals.

### 5.2 Pull-as-forecast: the claim_dependencies contract

**Convention.** The project's CLAUDE.md gains a section requiring the agent emit a `claim_dependencies:` block when the response makes claims subject to enforcement. The block format (schema + examples) lives below.

**When the block is required (claim-shape gating, REQUIREMENT).** The block is required when BOTH conditions hold:

1. The prompt produced ≥1 concept-extraction hit
2. The response contains shape-of-claim language for the indexed concepts — specifically existence ("we have", "X exists"), non_existence ("we don't have", "X doesn't exist", "we'd need to build"), or state ("X currently does Y", "X is configured as Z") assertions about the concept

The block is NOT required for:

- Trivial-action responses ("I'll write a function that does X", "running grep for Y now") — no enforceable claim about project state
- Causal / capability / comparison / prescription claims — the block is recommended for telemetry but not enforced
- Responses where concept extraction returned zero hits — there's nothing to enforce against

**Why the gate matters for context cost.** v2 required the block on any concept-rich response. v3 narrows to claim-shape responses. Most concept-rich agent turns are action-shaped ("I'm going to read X then edit Y"), not claim-shaped. Restricting the block to claim-shape responses cuts its frequency roughly in half, which translates directly to a smaller per-session token tax.

**Schema:**

```yaml
claim_dependencies:
  - id: c<n>
    claim: <free text — the actual assertion>
    claim_type: existence | non_existence | state | causal | capability | comparison | prescription
    subject:
      kind: file | symbol | system | feature | config | decision | pattern | test
      name: <canonical name; trigram-index-keyable>
    self_confidence: high | medium | low
    refs: [<claim ids this depends on>]
    depends_on:
      enforceable:
        code: [{ path, line_range?, evidence_kind, tier? }]
        tests: [{ path, evidence_kind }]
        memory: [{ id, resolution_status }]
        config: [...]
      advisory:
        docs: [{ path }]
        git: [{ sha_prefix }]
        recurrences: [{ signature }]
    searched:                  # required for non_existence claims
      - patterns: [<regex>...]
        scope: <repo-relative dir>
        result_count: <int>
        result_kind: code | docs | memory | git | symbol
```

**Worked example — existence claim** (the response I should have emitted on turn 1 of the Supermodel session):

```yaml
claim_dependencies:
  - id: c1
    claim: "A Supermodel integration already exists in this codebase."
    claim_type: existence
    subject:
      kind: system
      name: Supermodel integration
    self_confidence: high
    depends_on:
      enforceable:
        code:
          - path: src/harness/supermodel-graph.ts
            evidence_kind: implementation
            tier: A1
          - path: src/harness/evaluator/pre-tool.ts
            line_range: [155, 194]
            evidence_kind: call_site
            tier: A1
        tests:
          - path: src/harness/__tests__/supermodel-graph.test.ts
            evidence_kind: test
      advisory:
        docs:
          - path: docs/integrations/supermodel.md
          - path: docs/plans/07-supermodel-graph-integration.md
        memory:
          - id: reference_supermodel_thesis.md
            resolution_status: superseded_by_implementation

  - id: c2
    claim: "The consumer fires on PreToolUse for every Write/Edit/MultiEdit/apply_patch and surfaces HIGH/MEDIUM impact warnings."
    claim_type: state
    subject:
      kind: feature
      name: PreToolUse impact warnings
    self_confidence: high
    refs: [c1]
    depends_on:
      enforceable:
        code:
          - path: src/harness/evaluator/pre-tool.ts
            line_range: [747, 752]
            evidence_kind: implementation
            tier: A1
```

**Worked example — non-existence claim** (the failure-mode-relevant variant):

```yaml
claim_dependencies:
  - id: c1
    claim: "We do not yet have a harness check that uses the on-disk graph."
    claim_type: non_existence
    subject:
      kind: feature
      name: "harness check using on-disk graph"
    self_confidence: high
    depends_on:
      enforceable: {}            # no positive evidence — see `searched`
    searched:
      - patterns: ["graph-history", "structure-cache"]
        scope: src/
        result_count: 2
        result_kind: code
```

**Why non-existence is load-bearing.** This is the failure-mode case. Without the `searched:` block, the agent can hide behind "I checked and didn't find" with no record of *what* it checked. With `searched:`, the reconciliation runs the broader concept-extracted search independently. If the system would have searched for `supermodel` (via concept extraction) and the agent didn't, the non-existence claim is bounded:

`max_confidence(non_existence) ≤ |agent_searched_patterns ∩ system_extracted_concepts| / |system_extracted_concepts|`

This means: the agent must declare a search scope that covers the system's concept extraction. Failing to search for an extracted concept caps confidence below the block threshold and forces a re-turn.

**Compliance enforcement.** Stop-hook regex check: if the prompt produced N>0 concept hits AND the response prose contains shape-of-claim language for indexed concepts, AND `claim_dependencies:` block is missing or empty, Stop hook returns `decision: "block"` with reason "claim-shape response on indexed concept requires claim_dependencies; emit and resubmit."

Same enforcement primitive as the reconciliation itself — one mechanism, not two.

### 5.3 Reconciliation: the dial-back loop

**Trigger.** Stop hook fires when the agent finalizes its response. Existing infrastructure (`src/harness/server.ts`); already returns decisions that can interrupt the stop and force a re-turn (`stop_hook_active` mechanism).

**Per-claim algorithm.** For each claim in `claim_dependencies:`:

1. Look up subject via concept index → returns the *actual* enforceable + advisory evidence sets the system found.
2. Compute, per tier:
   - `under_declared = actual_enforceable − declared.enforceable` (claim missed enforceable evidence)
   - `over_declared = declared.enforceable − actual_enforceable` (claim cited evidence that doesn't exist)
3. Resolve each entry in `declared.enforceable` against the appropriate oracle:
   - code path → file existence check + A1/A2 classification
   - symbol → grep / project-graph resolution
   - test → file existence + recent-pass status
   - memory id → `stillExists()` returns true AND `resolution_status` is current or superseded_by_implementation
4. Compute claim-level scores:
   - `claim_recall = |declared.enforceable ∩ actual_enforceable| / |actual_enforceable|`
   - `claim_precision = |declared.enforceable ∩ actual_enforceable| / |declared.enforceable|`
   - `claim_confidence_ceiling = min(recall, precision)`

**Decision per claim:**

- All declared.enforceable items resolve AND `claim_recall ≥ 0.8` AND no high-relevance items in `under_declared` → **claim ships**.
- Any declared.enforceable item fails to resolve → **block** (claim cited non-existent evidence).
- High-relevance item in `under_declared` AND claim_type ∈ {existence, non_existence, state} → **block** (claim missed enforceable evidence the system found).
- claim_recall ∈ [0.5, 0.8) → **warn** (advisory; calibration logged but not blocking).
- claim_type ∈ {causal, capability, comparison, prescription} AND any miss → **warn only**, regardless of severity.
- All declared evidence is tier A2 (dead-but-present) AND claim is existence → **ship with advisory injection**: append `[interlinked:tier-A2] Cited evidence is present but functionally inactive (no callers, no recent activity). Verify wiring before relying on this.` to the response. Doesn't block, but the agent's response is annotated with the caveat.

**Non-existence claim reconciliation (special case):**

1. Compare `searched.patterns` against system-extracted concepts from the prompt.
2. If `system_concepts − searched_patterns` is non-empty AND any of those un-searched concepts has actual_enforceable > 0 → **block**. The agent claimed non-existence on a scope that didn't include the un-searched concept; the un-searched concept resolves to actual evidence.
3. Otherwise re-run the agent's declared search. If `actual_count ≠ declared.result_count` → **block** (search-error in declaration).

**Block behavior.** Stop hook returns:

```
decision: "block"
reason: "<calibration message describing the specific gap>"
```

Example reason for the Supermodel turn 1 case under this design:

```
[interlinked:reconciliation] Claim c1 ("We do not yet have a harness check
that uses the on-disk graph") cited searched.patterns ["graph-history",
"structure-cache"] but the prompt's concept extraction surfaced
["Supermodel", ".graph"]. Re-running the system's search returned 9 code
hits in tier A1 — including src/harness/supermodel-graph.ts and
src/harness/evaluator/pre-tool.ts:155-194 — which contradict the non-
existence claim. Re-grep for the un-searched concepts and re-emit.
```

**Re-turn budget.** Capped at 2. After 2 failed reconciliations, the harness surfaces the un-resolvable mismatch to the user as a warning and lets the response through (degrade open).

**Asymmetric updating.** Confidence drops *without context expansion*. The agent doesn't have to read every un-declared item; the *existence of an un-declared enforceable hit* is the bound on confidence. A response that hedges sufficiently ("I see X but I'm not sure of its current state — confirm against `supermodel-graph.ts:foo`") can pass with lower recall because the *claim shape* matches the calibration ceiling.

**Cost envelope.** Set-difference on a ~50-item set is microseconds. Oracle resolution per item (file-existence check, symbol grep) is ~10ms each. Total per-claim ~500ms; per-response total under 5s. The 30s post-budget covers comfortably.

---

## 6. Typed evidence records

Every retrieval candidate is a typed evidence record. The schema is the boundary contract between retrieval and reconciliation:

```yaml
id: <stable id — usually the path or memory entry id>
kind: code | test | doc | memory | git_commit | decision | recurrence | symbol
source: working_tree | structure_cache | trigram_index | embedding | project_graph
        | git_log | memory_store | recurrence_log
authority: A1 | A2 | B | C | D | E      # see §4
confidence: <0.0..1.0>             # retriever's own confidence
observed_at: <iso8601>             # when the index entry was created
commit_sha: <git ref or null>      # what version of the code this references
still_exists: <function — computed at retrieval time, not cached>
superseded_by: <id of the resolving evidence, or null>
metadata:
  path: <repo-relative if applicable>
  line_range: [a, b]               # if applicable
  signature: <recurrence signature if applicable>
  resolution_status: current | superseded_by_implementation | stale  # for memory entries
  caller_count: <int>              # for code; drives A1/A2 classification
  last_modified: <iso8601>         # for code; drives A1/A2 classification
```

**still_exists is a function, not a field.** Computed at retrieval time by checking the relevant oracle (file system for code/test/doc; memory store for memory id; git for commit refs). Caching the value would re-introduce the staleness the field is supposed to solve.

**superseded_by closes the loop on proposal-shaped memories.** A memory entry that proposed work which has since shipped gets a `superseded_by` link to the implementing file. The retrieval pipeline surfaces both the proposal and the resolution; the agent sees "this was proposed; this is what it became." This is the structural fix for the failure mode where the agent sees "we should build X" memories and concludes X doesn't exist.

**authority is computed, not declared.** A memory entry saying "Supermodel exists" is authority C. A working-tree file `src/harness/supermodel-graph.ts` with active callers is A1. The same file with zero callers in 240 days is A2. The retrieval pipeline assigns authority based on source + tier rules (§4); the records themselves don't claim it.

---

## 7. Bitter-lesson alignment + 30s budget regimes

The 30s pre + 30s post per tool call isn't a constraint to economize against — it's a budget to *spend on general computation that obsoletes hand-curation*.

### What hand-curation gets replaced by compute

| Hand-curation tempting solution | Bitter-lesson replacement | Why |
|---|---|---|
| Synonym table mapping "the dead-code system" → `dead-code` | Embedding rerank over identifier candidates from inverted index | Generalizes to terms we haven't enumerated |
| Manually-tuned regex for concept extraction per language | Tree-sitter parse + identifier extraction across languages | Same shape works for TS, Python, Rust, Go, etc. |
| Curated list of "this is a high-relevance file" weights | Learned ranker trained on (forecast, claim_dependencies, outcome) tuples from this project's history | Adapts per-project; updates as project evolves |
| Hand-coded prediction-format parser | Structured-output mode (LLM emits YAML/JSON-shaped claim_dependencies; we parse) | Removes regex brittleness on response shape |
| Static priority of memory categories | Per-turn relevance score = ranker output; categories are tags on tiered records | Removes special-casing; everything is a candidate with declared authority |

### What stays deterministic regardless

- **The trigger.** Every UserPromptSubmit and every PreToolUse fires the push pipeline. No agent decision; no skill invocation; no probabilistic gate.
- **The contract.** `claim_dependencies:` block is required when claim-shape gating fires. The format is structured; parsing is deterministic.
- **Authority assignment.** Authority is computed deterministically from source + tier rules. No learned authority signal.
- **The reconciliation decision.** Set-arithmetic on enforceable identifiers. No fuzzy matching at the comparison step. Block triggers only on enforceable misses.

The compute lives in the *middle*: building the index, ranking candidates, scoring relevance. The boundaries (trigger, contract, authority, decision) stay deterministic so behavior is grep-checkable in production.

### The 30s budget sets the wall-clock regime

Three regimes, each implies a different retrieval pipeline. The architecture must declare which regime it operates in:

| Regime | Pre budget | Retrieval pipeline | What it catches |
|---|---|---|---|
| **Minimal** | 5s (current default) | Trigram-index lookup only. Embeddings optional if local CPU model is fast enough. No LLM rerank. No multi-hop graph. | Exact identifier matches. High precision; loses recall on synonyms / paraphrase. Sufficient for the Supermodel-class case (concept extraction alone would have flagged it). |
| **Standard** | 15s | Trigram + embedding similarity + 1-hop project-graph. CPU reranker over the union. No LLM rerank. | Synonyms within the same codebase; structural blast-radius for symbol changes. |
| **Wide** | 30s (proposed) | Multi-modal ensemble (trigram + embeddings + 2-hop graph + git-log + recurrence-match + memory-direct). Reciprocal-rank fusion. Optional small-LLM rerank on top-K. | Cross-session pattern recognition; historical decisions; conceptual paraphrase across the entire project history. |

The regime is a deployment-time config:

```json
{
  "harness": {
    "memory_regime": "standard",
    "pre_timeout_ms": 15000,
    "agent_context_budget_pct": 8,
    "...": "..."
  }
}
```

Under each regime, the architecture is the same up to retrieval — same trigger, same forecast contract, same reconciliation. The retrieval mode is the swappable middle.

---

## 8. Context budget

The wall-clock budget (§7) governs harness-side computation. The **agent-context-token budget** governs how much of the agent's window the memory system consumes per session. Both are bounded; both are equally load-bearing constraints.

This was unbounded in v1 and v2. v3 makes it explicit.

### Per-regime token-budget targets

Targets are expressed as a percentage of the agent's context window, evaluated over the worst-case heavy session (50 turns, 5 tool calls per turn, half concept-rich, half claim-shape).

| Regime | Stage 1 forecast | Stage 2 pointer bundle | claim_dependencies | Stop-hook reasons | Fixed (CLAUDE.md) | Total |
|---|---|---|---|---|---|---|
| Minimal | ≤2% | ≤1% | ≤1% | rare (<0.5%) | ≤0.5% | **≤5%** |
| Standard | ≤2.5% | ≤2.5% | ≤1.5% | rare (<0.5%) | ≤0.5% | **≤7.5%** |
| Wide | ≤3% | ≤4% | ≤2% | rare (<0.5%) | ≤0.5% | **≤10%** |

On a 200k window: Minimal caps at ~10k tokens of memory overhead per session, Standard at ~15k, Wide at ~20k.

### Per-surface allocation

**Stage 1 forecast (per-fire ~80–120 tokens).** Capped by the forecast-cache requirement (§5.1) — fires only on novel concept sets, not every PreToolUse. Realistic firing frequency per session: 30–80 fires (UserPromptSubmit × turns + PreToolUse on new-concept tool inputs). Token cost: 2.4k–9.6k.

**Stage 2 pointer bundle (per-claim-shape-response ~150–800 tokens).** Capped by pointer-only requirement — bytes are only fetched on agent-elective `expand` requests (which the agent pays for explicitly). Realistic firing frequency per session: 10–25 claim-shape responses. Token cost: 1.5k–20k. The wide upper bound is pessimistic; standard sessions land in the 5–10k range.

**claim_dependencies block (per-claim-shape-response ~150–500 tokens).** Capped by claim-shape gating (§5.2) — fires on shape-of-claim responses, not all concept-rich ones. Realistic firing frequency per session: 10–25. Token cost: 1.5k–12.5k. Multi-turn compounding is mitigated by the compaction policy below.

**Stop-hook reasons (per-block ~150–250 tokens).** Only on calibration miss. Cap at 2 re-turns per response means at most 2 reason payloads per blocked response. Expected frequency per session: 0–5. Token cost: 0–1.25k.

**Fixed CLAUDE.md convention (~500–1500 tokens).** Loaded once per session. The convention text MUST stay under 1500 tokens. The full schema and examples live in this design doc, which is not loaded into agent context. The convention is the minimal teaching surface needed for the agent to emit valid claim_dependencies blocks.

### Compaction interaction

claim_dependencies blocks emitted in turn N become input tokens on turn N+1 (and onward, until compaction). On a 50-turn session, naive accumulation of all blocks contributes ~10k tokens of structural overhead the agent re-reads on every generation.

**Compaction policy requirement.** The compaction layer (Claude Code's automatic context management) should preferentially elide old `claim_dependencies:` blocks — they are transient artifacts of past reconciliations, not durable state. The reasoning behind a past block (the actual response content) is durable; the structured dependency declaration is not. Implementation: claim_dependencies blocks tagged with a stable comment marker (`# interlinked:claim_dependencies:<turn_id>`) so the compactor can target them for removal independently of the response prose.

This requirement is outside the harness's enforcement scope — it's a Claude Code (or equivalent runtime) configuration concern. The doc records it so implementers know to surface the requirement to the runtime layer.

### Budget exhaustion behavior

If the per-regime budget is approached (telemetry tracks running session totals), the system degrades gracefully, in order:

1. **Drop snippet content** from any future Stage 2 fires (already pointer-only — this is no-op under the v3 default).
2. **Truncate Stage 2 bundles** to top-3 pointers instead of top-5.
3. **Skip Stage 1 forecasts** on PreToolUse for the rest of the session (UserPromptSubmit forecasts continue).
4. **Skip Stop-hook reasons' detail**, keeping only `decision: block` + a one-line summary.
5. **Disable the system entirely for the session** — degrade open. Log the budget exhaustion as a calibration row for later analysis.

Budget exhaustion should be rare. If it's common in real sessions, the regime config is wrong for the workload; recommend stepping down to Minimal.

### What this section does NOT specify

Specific implementation of the budget tracker (where the running total lives, how it's enforced) is implementation detail. The contract is: each surface has a per-regime cap; surfaces shed work in defined order when caps approach.

---

## 9. Architecture sketches

Design alternatives must be evaluated against the alignment principles in §12. Sketches here are *candidates*; they are not final.

### Sketch A — Inverted index + multi-modal retrieval + structured forecast (baseline)

The default under the standard regime. Trigram + embedding + graph for candidate generation; small reranker for ordering; tier assignment per record; categories+counts forecast channel; agent emits claim_dependencies; reconciliation enforces calibration.

### Sketch B — Multi-agent retrieval ensemble (wide regime baseline; early-phase shape)

Run N lightweight retrieval agents in parallel during the 30s pre-budget. Each returns a ranked candidate list with authority tier. Ensemble = union with rank fusion (reciprocal-rank or learned weights). Robust to single-source failure. Adding a new retrieval mode is additive, not requiring redesign.

### Sketch C — Predictive context cache

In the 30s post-budget after every tool call, the system speculatively computes the push set for the *next likely* tool calls (based on session trajectory + project-graph). Caches the result. When the next prompt actually arrives, the pre-budget can spend on rerank refinement instead of cold lookup. Buys ~2× effective compute at the next pre-budget without expanding clock time.

### Sketch D — Causal evidence graph

Every prior decision, claim, recurrence row, and resolution is a node. Edges are causal/contradictory/superseded. PreToolUse query: walk the graph from concepts in the user prompt, surface nodes with high causal centrality + recency. Captures "this was discussed before; resolution was X" without requiring the agent to grep for the prior conversation. Supersedes the simpler resolution-link mechanism in §6 with a richer graph traversal.

### Sketch E — Online-learning relevance signal

Every Stop-hook reconciliation emits a row to `prediction_calibration.jsonl`. Periodically (nightly?), train a lightweight ranker on (forecast, declared_dependencies, actual_evidence, outcome) tuples. The ranker learns repo-specific patterns: "when prompts mention `harness`, files matching `src/harness/` are 3× more relevant than the global prior." Replaces hand-curated relevance heuristics with online-learned ones.

### Sketch F — Project-specific candidate-proposer (long-run efficiency play)

A small model (1B–3B parameters) fine-tuned periodically on the project's full state — code, history, transcripts (PII-redacted), decisions, calibration outcomes. Query at PreToolUse: structured prompt → structured candidate list. **The model proposes candidates; the deterministic inverted index + project graph remain the oracle.** The model is allowed to be black-box only because its outputs are checkable against transparent ground truth.

**Trajectory framing (changed in v3).** v2 demoted Sketch F to "candidate-proposer with deterministic oracle" — correct for the *correctness* concern. v3 adds: Sketch F is also likely the *more context-efficient long-run shape*. One forward pass replaces multi-modal ensemble + reranker on every turn. Wall-clock and compute move from per-turn parallel retrieval (Sketch B) to per-turn forward pass (Sketch F).

The framing is therefore:
- **Early phases (Phase 1–3):** Sketch A or B is the baseline. Multi-modal robustness matters more than efficiency while the system is being calibrated.
- **Long run (Phase 4+):** Sketch F is the efficiency play *once shadow-eval shows quality parity AND latency advantage*. Switching is gated on calibration data, not aspiration.

Risks the deterministic-oracle constraint addresses:
- Secrets memorization from transcripts (training data filtered through PII redaction)
- Stale-claim encoding (model trained on transcripts learns wrong assistant assertions — mitigated by tier-E exclusion from training data)
- Opacity (hard to diff what the model "knows" — mitigated by transparent oracle on every output)
- Plausible-but-unverifiable candidates (must be checked against the deterministic index)

The candidate-proposer never bypasses the authority tier system or the reconciliation decision.

---

## 10. Golden-case mining

Phase 0.5 (§14) cannot complete without a corpus of labeled examples. Manual labeling is the bottleneck; we don't do it. Instead we mine from existing session transcripts.

### Detection patterns

**Strong signals** (single-pattern match → candidate):
- `\b(?:we|you)\s+(?:already|actually|do)\s+(?:have|do|did)\b`
- `\bdon't\s+we\s+(?:already|just)\b`
- `\b(?:that|it)\s+(?:exists|is\s+already|does\s+exist)\b`
- `\b(?:no,|wait,)\s+(?:check|look\s+at|read|grep)\b`
- `\bI\s+thought\s+we\s+(?:had|did|already)\b`
- `\byou\s+(?:missed|are\s+wrong|got\s+that\s+wrong)\b`
- `\b(?:check|read|look\s+at)\s+(?:`[^`]+`|<file-path-shape>)`
- `\bactually,?\s+(?:we|that|there)\b`

**Weak signals** (need confirmation by a strong-signal co-occurrence in the same turn):
- `\bwrong\b` (too common alone)
- `\bcheck\s+again\b` (could be "check the build again")
- `\bnot\s+quite\b` (could be partial agreement)

**False-positive filters** (reject even on strong-signal match):
- "we're already at X" (state, not correction)
- "I already X" (action, not correction)
- "we have to" (modal, not assertion)
- corrections inside code blocks or quoted strings

### Pairing algorithm

```
for each turn t in transcript:
  if t.role != "user": continue
  if not detect_correction_signal(t.text): continue

  bad_turn = most_recent_assistant_turn_before(t)
  if not bad_turn: continue

  expected_concepts = extract_concepts(t.text)
  declared_concepts = extract_concepts(bad_turn.text)
  missed = expected_concepts - declared_concepts
  if not missed: continue

  emit_candidate(prompt, bad_turn, t, expected_evidence=missed)
```

The pairing only emits when the user's correction names *specific evidence pointers* (file paths, identifier-shaped tokens, backtick-quoted spans). Vague disagreement ("you're wrong about that") doesn't generate a golden case because there's no labelable evidence.

### Negative golden-case mining (v3 addition)

Positive cases (Supermodel-class misses) come from corrections. Negative cases (where the agent's claim was correct and shouldn't have been blocked) need a different mining heuristic. The shape:

- Agent emitted a claim_dependencies block (in the post-Phase-2 era; pre-Phase-2 transcripts can't generate negative cases of this kind)
- Block had `claim_recall ≥ 0.9` against system-computed actual evidence
- Next user turn either accepted the response (no correction signal) OR moved on to an unrelated topic
- The (prompt, response, claim_dependencies, actual_evidence) tuple becomes a confirmed-negative golden case

Negative case mining is enabled in Phase 2+ (when claim_dependencies blocks start landing). Phase 0.5 shadow eval bootstraps with positive cases only and supplements with simulated negatives (golden-case prompts where the *correct* response would have produced a passing claim_dependencies block).

### Confirmation rules (positive cases)

A candidate is **confirmed** when at least *two independent* of these hold (single-rule confirmation accepts user-side mistakes):

1. File-existence: every path in `expected_evidence.code` exists in the current working tree
2. Symbol-existence: every symbol in expected evidence resolves via grep / project-graph
3. Memory-resolution: a memory entry referenced by id has `resolution_status: superseded_by_implementation` linking to expected files
4. Commit-trace: `git log --all -- <path>` returns at least one commit (the file was real at some point)
5. Test-existence: a test file matching the path pattern exists

A candidate is **invalidated** when files in `expected_evidence` no longer exist (renamed/deleted) → re-mine on next pass; OR when a later turn shows the user's correction was itself wrong.

A candidate is **evicted** after 90 days unconfirmed.

### Storage

```
.interlinked/golden-cases/
  manifest.json                      # index: {id, status, prompt_hash, last_revalidated}
  candidates/<id>.json               # full golden case, status=candidate
  confirmed/<id>.json                # full golden case, status=confirmed
  invalidated/<id>.json              # kept for audit; not used for shadow-eval
  negatives/<id>.json                # confirmed-negative cases (Phase 2+)
```

### Schema (one record)

```yaml
id: gc_<uuid7>
status: candidate | confirmed | invalidated | evicted
case_kind: positive | negative
detected_at: <iso8601>
last_revalidated_at: <iso8601 | null>

source:
  transcript_path: <path>
  session_id: <string>
  bad_turn_idx: <int>
  correction_turn_idx: <int>

prompt:
  text: <redacted via existing PII pipeline>
  extracted_concepts: [<string>...]

bad_claim:
  text: <string>
  claim_type: <enum or null>
  declared_dependencies: <claim_dependencies block | null>

correction:
  text: <string>
  extracted_evidence_pointers: [<string>...]

expected_evidence:
  code: [<path>...]
  tests: [<path>...]
  memory: [<entry_id>...]
  docs: [<path>...]
  symbols: [<string>...]

confirmation:
  rules_matched: [<rule_id>...]
  confirmation_evidence: [<string>...]
  confirmed_at: <iso8601 | null>
```

### Privacy

Mining runs entirely locally. Prompts go through the existing PII redaction at `server.ts:764` before being stored. No transcript data leaves the machine. The mining job is opt-in per workspace (config flag `golden_case_mining: true`). The directory is gitignored by default.

### Adversarial protection

Mining only considers turns with role="user" (verified by transcript role field), not from assistants or sub-agents. Synthetic transcripts from automated testing should be excluded by a session-id allowlist.

---

## 11. Shadow evaluation + benchmark methodology

Before any agent-visible surfacing lands, the retrieval pipeline must be measured against the golden-case corpus. This is Phase 0.5 (§14).

### Per-case evaluation

For each confirmed golden case:

1. Take the original prompt
2. Run the current retrieval pipeline at each of {minimal, standard, wide} regimes
3. Compute, per regime:
   - `expected_evidence_recall = |retrieved ∩ expected_evidence| / |expected_evidence|`
   - `expected_evidence_precision = |retrieved ∩ expected_evidence| / |retrieved|`
   - `tier_distribution`: of retrieved, how many were tier A1 / A2 / B / C / D / E?
   - Did the retrieval surface evidence for both the bad_claim's negation AND the correction's pointers?

### Aggregate metrics per regime

- **Concept-extraction recall**: fraction of golden cases where the extracted concepts include at least one term that matches expected_evidence
- **Retrieval recall@K**: fraction where expected_evidence is in top-K retrieved candidates
- **Authority-correctness**: fraction where retrieved evidence has the expected authority tier (e.g. tier A1 for active-feature existence-claim cases)
- **Simulated true-block rate**: fraction of *positive* golden cases where the reconciliation algorithm would have blocked the bad_claim if it were emitted with a hypothetical claim_dependencies block matching the bad assertion
- **Simulated false-block rate**: fraction of *negative* golden cases where the reconciliation algorithm would have blocked the (correct) response anyway

### Threshold to advance to Phase 1

The retrieval pipeline must clear (per regime, all required):

- Concept-extraction recall ≥ 0.9
- Retrieval recall@10 ≥ 0.8
- Authority-correctness ≥ 0.95 on tier A1 items
- **True-block rate ≥ 70%** on positive golden cases (existence/non_existence)
- **False-block rate ≤ 5%** on negative golden cases

The false-block rate threshold is the v3 addition. Without it, we'd advance a system that catches Supermodel-class misses but blocks legitimate responses 30% of the time — users would disable it within a week. Both thresholds gate advancement.

If any threshold is missed, Phase 0 (index foundations) is not done; iterate retrieval (add modes, tune ranker, expand concept extraction) until thresholds clear.

### Continuous re-evaluation

Shadow eval runs nightly on the current golden-case corpus. Calibration declines (e.g. recall drops because the project structure changed; false-block rate rises because new code creates spurious matches) trigger an alert + re-index.

### Reproducible benchmark methodology

Beyond shadow evaluation (which is internal), the design's value should be measurable against an external benchmark. Modeled on Supermodel's `reference-repos/supermodel-cli/benchmark/` shape:

**Setup:**
- Pick a representative target codebase (something analogous to django/django @ 5.0.6, ~270k LOC)
- Define a representative task that exercises the failure mode this design catches (a concept-rich question whose correct answer requires acknowledging existing implementation, where naive agents miss)
- Define a control prompt that strips memory architecture out (baseline agent behavior)

**Measurement:**

| Metric | Without architecture | With architecture (per regime) |
|---|---|---|
| Total tokens (input + output) | baseline | measure |
| Total turns | baseline | measure |
| Total wall-clock | baseline | measure |
| Wrong-claim rate (bad assertions in transcript) | baseline | measure |
| Forced re-turn rate (only meaningful with-architecture) | n/a | measure |
| User-pushback turns (corrections in transcript) | baseline | measure |

**Reproducibility:**
- Dockerfiles for each condition (with-architecture × regime, without-architecture, baseline)
- Entrypoint scripts that exercise the task end-to-end
- Run script that executes all conditions and summarizes
- Results directory with raw transcripts + summary.md, gitignored from the user's repo, but the methodology files are checked in

**Acceptance criteria for publishing the result:**
- Architecture must show ≥ 30% reduction in wrong-claim rate vs. baseline (the catch-rate floor — corresponds to the 70% true-block target with 100% remediation on block)
- False-block-induced extra turns must add ≤ 10% to total turns (the cost ceiling — corresponds to the 5% false-block rate with up to 2 re-turns each)
- Total token cost may be higher OR lower than baseline; we don't promise both correctness AND token savings, only correctness AND bounded overhead

This is more conservative than Supermodel's "40%+ fewer tokens" framing — we're claiming correctness improvement at bounded overhead, not unconditional token savings. Honesty about what's measured is more defensible than aspirational headline numbers.

---

## 12. Alignment principles (the document's load-bearing claim)

Every later memory-system change should be checkable against these. If a proposal violates one, it should require explicit justification in the proposal's design doc — not silent drift.

1. **Triggers are deterministic.** Push fires on every UserPromptSubmit and every PreToolUse (subject to forecast-cache deduplication). The agent never decides whether the trigger fires. No skill, no invocation, no judgment.

2. **Contracts are structured.** The agent's claim_dependencies block is identifier-level on the enforceable tier, not prose-level. The decision rule is set-arithmetic, not similarity scoring. Probabilistic methods live in the *middle* of the pipeline (ranking, scoring), not at the boundaries.

3. **Confidence is bounded by claim-evidence linkage, not retrieval coverage.** An agent with a perfect reading log but a wrong claim gets blocked. An agent with no reading log but a hedged response that matches its evidence gets through. The thing being measured is the agent's claim's support, not its behavior.

4. **Push reveals categories first; pointers second; bytes only on demand.** Stage 1 (forecast channel) surfaces categories + counts only. Stage 2 (working-context channel) reveals pointers + tier + one-line summaries. Snippets are agent-elective `expand` requests. Each stage is a first-class channel; bandwidth is conserved at every layer.

5. **The dial-back is asymmetric.** Confidence drops without context expansion. The agent does not need to read every un-declared item; the existence of an un-declared enforceable hit is itself the bound.

6. **Cost goes into compute, not curation.** Hand-curated synonym tables, hand-tuned weights, hand-coded category priors — all should be replaceable by learned components when the budget allows. The 30s-per-side wall-clock budget allows.

7. **Bounded context cost.** Per-regime token budgets (§8) are equally load-bearing as wall-clock. The system degrades gracefully when budget caps approach; never silently exceeds.

8. **The system stays observable.** Every claim_dependencies block, every push set, every reconciliation diff lands in `prediction_calibration.jsonl` with the same shape as `recurrence.jsonl`.

9. **Failures degrade open.** A push system that times out, a reranker that crashes, an inverted index that's stale — none of these should block the agent. The fallback is "no push fires; the agent operates as today."

10. **The contract is the API.** The `claim_dependencies:` block, the typed evidence record, the push-set JSONL format, the inverted-index file layout — these are the system's external interface. Internal implementations of ranking, retrieval, and indexing can be swapped freely as long as they preserve the boundary contracts.

11. **Retrieval is uniform; authority is tiered.** All sources contribute candidates to retrieval. *Trust is not uniform.* Authority tiers (§4) gate which retrieved evidence can support enforceable claims. Prior assistant transcripts are tier E and are never enforceable for any claim.

12. **Only enforceable misses block; advisory misses warn.** The zero-FP contract from the existing harness propagates here.

13. **Non-existence claims must declare their search scope.** A claim of absence is bounded by the completeness of the declared search. Un-searched concepts that resolve to actual evidence cap confidence below the block threshold.

14. **Memory entries with proposal status get resolution links.** A memory that proposed work is not the same fact as "that work shipped." The `resolution_status` and `superseded_by` fields make this distinction first-class.

15. **The retrieval pipeline must be measured before it is enforced.** Shadow evaluation against golden cases (§11) gates Phase 1 advancement. Both true-block rate AND false-block rate thresholds must clear.

16. **Scope is bounded explicitly.** The contract enforces claim-evidence linkage on indexed concepts. It does not enforce semantic correctness, runtime behavior, or claims about un-indexed concepts. Out-of-scope failure modes need different mechanisms; trying to extend this contract to cover them compromises the boundaries it depends on.

---

## 13. Open questions

- **Synonym handling without hand-curation.** When the user says "the dead-code system" and the codebase calls it `dead-code-detector`, identifier match misses. A reranker can resolve this if the embedding space encodes the synonym, but training data has to come from somewhere. Candidate sources: project's own commit messages, prior agent transcripts (tier E — careful), docs glossary. Open: which is the right substrate.

- **Compute placement: client vs server vs daemon.** The harness daemon is local; running a small reranker model in the daemon adds RAM cost (200MB–2GB depending on model). Alternative: the cloud receipt path from `pre-post-pipelined-cloud-checks-and-failure-recovery.md` could host the ranker. Open: which is right for which user tier.

- **Re-turn budget UX.** A Stop-hook re-turn is one extra LLM call the user observes (latency + tokens). Budget cap of 2 prevents loops, but the first re-turn is still visible. Acceptable for the calibration win? Calibrate from Phase 3 telemetry.

- **Multi-turn coherence.** A claim made in turn 5 might contradict a claim made in turn 3 (the agent's model has updated). The system currently scores per-turn independently. Open: should we track claim-trajectory across the session?

- **Claim extraction enforcement.** The Stop-hook regex check catches the obvious case (response prose contains shape-of-claim language AND block missing). Less obvious case: agent emits a block but it doesn't cover all claims in the prose. Mitigation requires prose-level claim extraction, which introduces stochasticity at a boundary. Currently deferred; the assumption is that agents trained on the contract will emit complete blocks.

- **Adversarial prediction (gaming).** An agent that always declares a giant superset of dependencies will satisfy enforceable recall trivially but fail precision. Symmetric scoring (precision penalty equal to recall penalty) blocks this. Open: how aggressive the precision penalty needs to be in practice; calibrate from telemetry once Phase 2 lands.

- **Golden-case false confirmations.** A correction that was itself wrong (user thought we had X; we don't) gets confirmed by file-existence rules incorrectly. Mitigation: require *two independent* confirmation rules. Reduces false-confirmation but also reduces total confirmed cases. Open: whether the precision/recall ratio is favorable in practice.

- **Compute budget for ranker training.** Sketch E (online-learning relevance signal) requires nightly training. Where does the compute come from? Local CPU during idle, or scheduled cloud job tied to the receipt path? Open.

- **Sketch F's training data hygiene.** A project-specific candidate-proposer trained on transcripts (tier E) risks encoding wrong assistant claims. Mitigation: training data filtered through PII redaction + restricted to tier A1/A2/B/C content. Open: whether the resulting model has enough signal to be worth the complexity, or whether Sketch B (multi-agent ensemble) suffices.

- **Cross-workspace privacy.** Golden cases mined per-developer are useful per-developer. Aggregating across developers (within a team) requires explicit opt-in and PII review. Out of scope for this document.

- **Compaction policy enforcement.** §8 specifies that the runtime should preferentially elide old claim_dependencies blocks. This isn't enforceable from the harness; it's a runtime configuration concern. Open: how to surface the requirement to runtime layers, and whether degradation when ignored is acceptable.

- **Reading-log telemetry as anti-hallucination signal.** The contract checks claim-evidence linkage but not whether the agent actually consulted the cited evidence. A diagnostic telemetry layer (compare claim_dependencies entries against the agent's per-turn Read tool log) could surface "you cited X but didn't read it" as a soft signal. Open: whether this is worth implementing as advisory telemetry or whether the inferential gap is acceptable.

---

## 14. Phasing

Phase 0–3 ships the architecture. Phase 4 is the long tail of compute leverage that the 30s budget unlocks.

### Phase 0 — index foundations (~1 week)

- Extend the trigram index at `src/harness/trigram-index.ts` to memory entries.
- Build the joint inverted index over codebase + memory + git-log subjects.
- Implement typed evidence records (§6) including the `still_exists()` runtime function and the `superseded_by` field.
- Wire authority tier assignment (§4) at retrieval time, including A1/A2 classification via project-graph caller-count + last-modified queries.

No agent-visible changes. Index is reachable from the harness but not surfaced.

### Phase 0.5 — golden-case mining + shadow evaluation (~1 week)

- Implement the golden-case mining pipeline (§10). Backfill on existing transcripts.
- Implement shadow evaluation (§11). Run against confirmed golden cases at each regime.
- Iterate retrieval (add modes, tune ranker, expand concept extraction) until thresholds clear:
  - Concept-extraction recall ≥ 0.9
  - Retrieval recall@10 ≥ 0.8
  - Authority-correctness ≥ 0.95 on tier A1 items
  - True-block rate ≥ 70% on positive golden cases
  - False-block rate ≤ 5% on negative golden cases

**Phase 1 is gated on these thresholds.** No agent-visible surfacing lands until shadow eval clears.

### Phase 1 — push without enforcement (~1 week)

- Wire `UserPromptSubmit` and `PreToolUse` handlers to surface category + count + tier-distribution to `additional_context` (Stage 1 forecast channel only).
- Implement forecast cache per turn (§5.1).
- No claim_dependencies contract yet.
- Observe whether agent behavior changes from passive surfacing alone.
- Track session-level token consumption against the per-regime budget targets (§8).

### Phase 2 — claim_dependencies contract (~1–2 weeks)

- Add CLAUDE.md convention for `claim_dependencies:` blocks (§5.2). Convention text under 1500 tokens.
- Implement Stop-hook regex check that detects claim-shape responses missing the block (§5.2 claim-shape gating).
- Log claim-vs-evidence diffs to `prediction_calibration.jsonl`.
- Implement Stage 2 working-context channel reveal (pointers only) after the block is logged.
- Begin negative-golden-case mining (§10).
- No enforcement yet — only telemetry. Observe calibration baselines per regime.

### Phase 3 — reconciliation enforcement (~1 week)

- Enforce dial-back via Stop-hook re-turn on enforceable miss (§5.3).
- Cap at 2 re-turns; degrade open after.
- Advisory misses log but don't block.
- Run for a week; observe re-turn frequency, false-block rate, user friction.

### Phase 4 — bitter-lesson layers (ongoing)

Each is independently shippable with rollback criteria; none is required for the architecture to land:

| Sub-phase | Sketch | Rollback signal |
|---|---|---|
| 4a | Sketch C — predictive context cache | Cache hit rate < 30% on next-prompt prediction |
| 4b | Sketch B → wide regime baseline | Concept-extraction recall regression on shadow eval |
| 4c | Sketch D — causal evidence graph | Graph traversal latency > regime budget |
| 4d | Sketch E — online-learning ranker | Calibration accuracy decline on shadow eval |
| 4e | Sketch F — project-specific candidate-proposer | Quality parity vs Sketch B not reached, or latency advantage not reached |

Each sub-phase ships with its rollback signal pre-defined. Observation period at least 2 weeks before declaring it stable.

---

## 15. Out of scope for this document

- The cloud-pipelining path (`pre-post-pipelined-cloud-checks-and-failure-recovery.md`) is independent. Memory architecture is local-first; cloud augmentation is additive when the receipt path is available.
- The PII / content-scanner pipeline that currently consumes `UserPromptSubmit` is orthogonal — both can extend the same handler.
- Specific implementation language for the reranker (transformer-based vs gradient-boosted vs rule-based) is deferred until the trigger and contract land.
- The agent-quality checks pipeline (`harness-firefox-bug-class-checks-plan.md`, the recurrence-tool-failure work) is a different system that shares JSONL substrate but not the trigger.
- Cross-developer aggregation of golden cases (privacy + opt-in mechanics) is deferred to the workspace-privacy design space.
- Runtime compaction policy (Claude Code's context manager) is not enforceable from the harness; the requirement is recorded in §8 but its implementation belongs to the runtime layer.

---

## 16. Reference: how this would have caught the Supermodel failure

A concrete trace through the original failure under this design:

**Phase 1 trigger.** User sends "Talk to me about supermodel tools' .graph. files and how they would be for this type of system."

**Concept extraction.** `["Supermodel", ".graph"]`.

**Multi-modal retrieval (wide regime).**
- Trigram index: 9 codebase hits including `src/harness/supermodel-graph.ts`, `src/harness/evaluator/pre-tool.ts`
- Memory: 3 entries matching "Supermodel"
- Docs: `docs/integrations/supermodel.md`, `docs/plans/07-supermodel-graph-integration.md`
- Authority assignment: 6 code hits at tier A1 (working tree, active callers); 1 at A2 (test fixture, not actively run); 2 test hits at tier B; 3 memory hits at tier C; 2 docs at tier B
- One memory entry has `resolution_status: superseded_by_implementation` linking to `src/harness/supermodel-graph.ts`

**Stage 1 forecast channel.** Surfaced to agent (cached for the turn):
```
[interlinked:concept-index] Your prompt mentions:
  Supermodel    → 9 code (A1: 6, A2: 1, B: 2) · 3 memory (C: 3) · 2 docs (B: 2)
                  1 of 3 memory entries has resolution_status: superseded_by_implementation
  .graph        → 4 code (A1: 4) · 1 doc (B: 1)
```

**Agent's claim_dependencies forecast** (the wrong-model attempt):
```yaml
claim_dependencies:
  - id: c1
    claim: "We don't yet have an on-disk graph integration."
    claim_type: non_existence
    subject:
      kind: feature
      name: "on-disk graph integration"
    self_confidence: high
    depends_on:
      enforceable: {}
    searched:
      - patterns: ["graph-history", "structure-cache"]
        scope: src/
        result_count: 2
        result_kind: code
```

**Reconciliation.** Non-existence claim reconciliation (system-side):
- `system_extracted_concepts = ["Supermodel", ".graph"]`
- `searched.patterns = ["graph-history", "structure-cache"]`
- Intersection is empty
- Un-searched concept "Supermodel" resolves to 6 tier-A1 hits

**Decision.** `block`. Reason:
```
[interlinked:reconciliation] Claim c1 cited searched.patterns ["graph-history", "structure-cache"]
but the prompt's concept extraction surfaced ["Supermodel", ".graph"]. Re-running the system's
search for "Supermodel" returned 6 tier-A1 code hits — including src/harness/supermodel-graph.ts
and src/harness/evaluator/pre-tool.ts:155-194 — which contradict the non-existence claim.
Re-grep for the un-searched concepts and re-emit.
```

**Forced re-turn (system action).** Stop hook returns block; agent's compliance behavior (typically: re-grep then re-emit) is observed, not enforced. The contract is the block; the agent's response to it is incidental.

**Agent's typical recovery.** Runs `grep -rln supermodel src/`. Finds the dedicated module. Re-emits with corrected claim_dependencies — now an existence claim with the 6 tier-A1 hits as enforceable evidence. Reconciliation passes.

**Stage 2 working-context channel reveal (pointers only).** After the corrected claim_dependencies block is logged:
```
[interlinked:bundle] Top evidence:
  src/harness/supermodel-graph.ts                 (A1 · code, 342 LOC)
  src/harness/evaluator/pre-tool.ts:155-194       (A1 · code · consumer)
  src/harness/__tests__/supermodel-graph.test.ts  (B · test, passing)
  docs/integrations/supermodel.md                 (B · doc)
  reference_supermodel_thesis.md                  (C · memory · superseded_by → supermodel-graph.ts)
```

If the agent needs to inspect any file, it issues `[interlinked:bundle] expand <id>` as a follow-up — explicit context cost, not passive injection.

**Outcome.** The failure that took 3 turns + user pushback is caught and corrected within 1 forced re-turn. The agent's wrong model is observable (declared search scope vs system search scope), checkable (deterministic set-difference), and correctable (re-grep + re-emit). The user never sees the wrong claim ship. Total token overhead: ~1,200 tokens for the forecast + bundle + block + reason — well under the standard regime's per-session cap.
