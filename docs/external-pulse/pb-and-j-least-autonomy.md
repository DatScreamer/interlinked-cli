# PB&J / Lethal-Trifecta / Least-Autonomy

- **Source:** Cyera blog post (user-shared, full text in chat 2026-05-27); cites Simon Willison's "lethal trifecta" framing and Xiang et al., "Architecting Secure AI Agents: Perspectives on System-Level Defenses Against Indirect Prompt Injection Attacks"
- **Encountered:** 2026-05-27, pasted by user as motivation for a security/exfiltration/injection feature pass
- **Verdict:** RFCs for the three architectural gaps (temporal-precondition rules, plan-submission gate, provenance-taint axis) + lane-2 detector drops for the rest

## 1. Core idea (one sentence)

An agent following literal instructions cheerfully turns "delete the test data" into a production drop — so the same control that defends against prompt injection (deterministic policy outside the model, fail-closed, structured human confirmation on high-blast actions) also defends against ordinary instruction ambiguity: **attack surface = accident surface**.

## 2. Anatomy (load-bearing claims)

Prose source — five claims, in the author's order:

1. **Attack surface = accident surface.** The failure mode of an authorized agent with ambiguous intent is the same whether the ambiguity came from a malicious payload or an under-specified user prompt. Solving one solves the other.
2. **External action is the load-bearing leg of the lethal trifecta.** Untrusted input alone is text — containable. The damage happens at egress; therefore the strictest gate belongs on external-action tools, not on input ingestion.
3. **Sequence failures are under-weighted.** Post-medication before confirming patient; move file before checking deps; transfer funds before verifying recipient. Permissions weren't the problem — order was. Stateless authorization can't express "X requires Y first"; Cedar entity-stores can approximate this; native LTL is the research frontier.
4. **System-level defense (Xiang et al.).** Agent submits a plan; an external engine evaluates the whole sequence before any tool fires. The plan becomes the artifact you reason about, not each call in isolation.
5. **Least autonomy, fail-closed to a human.** Not "least privilege" (capability-shaped) but "least autonomy" — the kitchen refuses regardless of how confident the cook is. When refusing, surface a structured confirmation with the resolved target ("about to delete the *test_users* table, proceed?"), don't fail silently.

## 3. Deterministic or agentic?

The mechanism is explicitly deterministic ("outside the model, outside the context window, deterministic, fail-closed"). Fully consistent with `feedback_harness_deterministic_only.md` — the blog is *arguing for* the architectural position Interlinked already takes at Tier 1. License: blog post, fair-use cite only.

## 4. Substrate vs. surface

N/A (prose source).

## 5. Lane (1–6)

**Lane 4 (architectural pattern) primary**, with three lane-2 detector drops.

- Lane-4 patterns: plan-submission gate (Xiang et al.); provenance-taint axis distinct from sensitivity-taint; tool externality taxonomy. → RFCs.
- Lane-2 detectors: temporal-precondition rule schema (`requires_prior: {…}` / `forbids_after: {…}` over `session.tool_sequence`); confirmation-receipt formatter (echo resolved target in `decision: "ask"` reason); plan-vs-execution drift detector at Stop event. → harness changes.

## 6. Dependency & displacement

- **Deps:** None new. All changes inside the existing harness + `interlinked-cedar-extensions.cedarschema`. Plan-submission gate consumes `TaskCreate` / `ExitPlanMode` plan events the runners already emit.
- **Displacement:** Builds on existing trajectory state (`session-state.ts`), the `decision: "ask"` plumbing already wired through the Cursor adapter / cloud-escalation / config-loosening-gate, and the Cedar extension schema's trajectory state axis. The hand-coded temporal checks (`pending_completions`, `tdd_cycles`, verification-before-stop) are precedents for the generic primitive, not things to replace.

## 7. Smallest spike (≤1 day)

Add one temporal-precondition rule end-to-end: `git push --force` requires a prior `git log` / `git diff` / `git status` within the last N events of `session.tool_sequence`. Add the rule-schema field (`requires_prior` predicate), wire `rules-loader.ts`, write the matcher against the trajectory, write tests for the happy path (preceded by inspection) and the block path (unverified force-push). Validates the primitive without touching MCP or Cedar.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | Temporal-precondition rule schema; provenance-taint axis on `TaintSource`; tool externality taxonomy in rule schema; confirmation-receipt formatter; plan-vs-execution drift detector (Stop event, reflection only) | §7 | now |
| Guardrails (P2–3) | Plan-submission gate: `TaskCreate` / `ExitPlanMode` event triggers cloud policy evaluation against the entire step sequence (Cedar + LLM gate at Tier 2) | one rule + Cedar emission for sequence eval | next |
| Agent CI (P4–5) | Async deep review of plan sequences containing external-action steps (Tier 3 prose review against least-autonomy principles) | none yet | parked |

## 9. Artifact

- RFCs: `docs/design/temporal-precondition-rules.md`, `docs/design/plan-submission-gate.md`, `docs/design/provenance-taint.md`
- PR for §7 spike (one temporal rule + schema extension)
- `MEMORY.md` update after RFCs land (new project entries linking to the RFCs)

## Notes

- The Xiang et al. paper warrants its own intake — fetch arxiv source before committing the plan-submission-gate design. Reading the citation is exactly the failure mode `codewiki.md` warns against ("read the source, not the README").
- **MCP Tasks (protocol 2025-11-25, experimental)** interact directly with the plan-submission-gate concept: any task-augmented `tools/call` returns `CreateTaskResult` immediately and the side effect happens later out-of-band. PreToolUse only gates *acceptance* of the task; *execution* is uninspectable in the current hook model. See parallel intake at `mcp-tasks-spec.md`.
- Simon Willison's "lethal trifecta" maps onto our existing infrastructure: leg 1 (untrusted input) → no provenance axis today; leg 2 (private data access) → `taint_sources` Public→HighlyConfidential; leg 3 (external action) → `signatures.ts` exfiltration category + MCP destructive-verb rules. The gap on leg 1 is precisely what provenance-taint fills.
- Watch for over-application of "fail-closed but ask a human" — the per-runner `decision: "ask"` capability matrix is uneven (Cursor honors `permission: "ask"` only on shell + MCP gates; Copilot/Codex collapse to deny). The confirmation-receipt formatter must degrade gracefully on runners that can't surface the structured prompt.
