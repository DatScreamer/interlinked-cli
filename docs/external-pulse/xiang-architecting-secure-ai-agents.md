# Architecting Secure AI Agents (Xiang et al., arxiv 2603.30016)

- **Source:** https://arxiv.org/abs/2603.30016 · HTML https://arxiv.org/html/2603.30016v1
- **Encountered:** 2026-05-27, cited by Cyera PB&J blog (`pb-and-j-least-autonomy.md`)
- **Verdict:** RFC — validates our direction; one architectural concept worth borrowing (synthesized step validators)

## 1. Core idea

A six-component agent architecture (Orchestrator → Plan/Policy Approver → Executor → Policy Enforcer → Environment → Feedback Loop) that decomposes "stop the agent doing the wrong thing" into separable concerns; the load-bearing claim is that **dynamic replanning is required** for real tasks, but only safe under tiered enforcement: rule-based deterministic first, LLM judges second on *typed diffs only*, humans third for ambiguity.

## 2. Anatomy (load-bearing claims)

- **Plan = ordered sequence (or DAG) of execution steps.** Policy = predicate over steps + execution histories. Formal vocabulary maps cleanly to our `session.tool_sequence` + GuardRule.
- **Three positions:**
  1. Dynamic replanning + policy updates are *necessary* — strict plan-execution isolation (CaMeL) breaks real cases (HTTP 410 → switch endpoint, debug session requires log access).
  2. LLMs are necessary for *some* security decisions — but only on typed/structured diffs, *never* raw environment text.
  3. Personalization + human interaction for ambiguity — three flavors: semantic ambiguity (`what is "urgent"`), objective conflict (`"reproduce the bug" vs "never run untrusted code"`), expression-level (`"all my files"`).
- **Decoupling instruction recognition from instruction-following.** Two-step procedure: (1) model explicitly verbalizes intended instructions; (2) system traces provenance and applies one of three modes:
  - **Mode 1:** Block instructions sourced from untrusted data (pure deterministic; provenance-only).
  - **Mode 2:** Require user confirmation.
  - **Mode 3:** Pre-declaration + structured instruction-state adjudication (typed diffs only).
- **Synthesized step validators (the most novel concept).** At plan time, an LLM generates per-step deterministic check programs — e.g., for "extract Q4 revenue": *"look in Revenue × Q4 cell, regex `[0-9,.]+`, cite DOM path, reject otherwise."* Runtime applies the validator to structured environment data (DOM-as-JSON), rejects violations without the executor judging anything. **The LLM's output is the policy; the decision remains deterministic.**
- **Critique by omission of existing defenses:**
  - CaMeL — strict plan-execution isolation breaks replanning.
  - Progent — unsecure policy updates (raw feedback to LLM).
  - PFI — over-redacts, hurts utility.
  - AgentArmor — LLM judges on raw text (adaptive-attack vulnerable).
  - DRIFT — LLM updates plans from environment data.
- **Cedar appears as the worked example of the rule-based layer.** Validates our Sondera-compatible Cedar emission.

## 3. Deterministic or agentic?

**Hybrid by design.** Paper explicitly: "*Whenever rule-based controls are sufficient, we should prefer them … This reduces reliance on fragile model-level robustness and makes behavior easier to audit.*" Maps directly to `feedback_harness_deterministic_only.md`. The synthesized-validator concept is the one place LLM inference enters the policy path — and even there, only at validator-generation time, not at validator-application time.

## 4. Substrate vs. surface

N/A — architectural prose, not code.

## 5. Lane (1–6)

**Lane 4 (architectural pattern) primary.** The synthesized step validator is the one lane-2 (detector) idea worth borrowing, but its shape is generative-then-deterministic, not pattern-match — design memo before any spike.

## 6. Dependency & displacement

- **Deps:** None for validation. Synthesized validators would need a Tier 2 LLM call at plan time (cloud, not local).
- **Displacement:** No replacement of existing code. The six-component architecture *describes* what we already have at a different abstraction level:
  - Orchestrator + Plan/Policy Approver → our Tier 1 deterministic + Tier 2 cloud (the plan-submission gate from `pb-and-j-least-autonomy.md`)
  - Policy Enforcer → our PreToolUse harness
  - Feedback Loop → `error-history.ts` + `recurrence.ts`
  - Their "decoupling" Mode 1 → our provenance-taint axis (PB&J item #3)
  - Their Mode 2 → our `decision: "ask"` + confirmation receipts (PB&J item #5)

## 7. Smallest spike (≤1 day)

Implement Mode 1 end-to-end: when an MCP tool result or fetched-content read carries `provenance: "fetched_external" | "mcp_remote"`, and a subsequent external-action tool call appears to act on instructions in that content, fire `decision: "ask"`. This is the PB&J §7 spike (provenance taint) plus a thin "did the content contain imperative-shaped text" detector. Validates the paper's most adoptable position on existing infrastructure.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|---|---|---|---|
| Free CLI (P1) | Mode 1 (provenance-based blocking) — already on roadmap as PB&J item #3; plan-update capture (replanning, not just initial plan) for PB&J item #2 | §7 | now |
| Guardrails (P2–3) | Plan/Policy Approver: cloud LLM evaluates captured plans with strict typed-diff input (Mode 3); replanning support | medium | next |
| Agent CI (P4–5) | Synthesized step validators: at plan time, generate per-step deterministic check programs; runtime applies them; misfires feed recurrence | long — RFC out first | parked |

## 9. Artifact

- RFC: `docs/design/synthesized-step-validators.md` — the most novel idea, deserving its own design memo.
- Memory: `project_xiang_paper_architecture.md` linking this intake + the PB&J one + supermodel-style cross-link.
- No PR immediately — the local items already mapped to PB&J intake still hold.

## Notes

- **Position 1 (dynamic replanning) implies plan capture must support plan *updates*, not just an initial plan.** PB&J item #2 must accept replanning events (`TaskCreate` called again, `ExitPlanMode` after a prior plan); JSONL append-only is the right shape.
- The paper's section II-B critique by omission is itself a useful evaluation rubric for our architecture. Post-mortem question worth periodically asking: what does Interlinked omit?
- **The synthesized-validator's subtlety is that the LLM's *output* is the policy, not the *decision*.** Decision remains program-executed at runtime. Bridges learned + deterministic without violating `feedback_harness_deterministic_only.md` — the model is a code generator here, not a judge.
- Cross-link: `pb-and-j-least-autonomy.md` cites this paper; both intakes coexist.
