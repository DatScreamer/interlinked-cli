# SWE-check — 10x Faster Bug Detection

- **Source:** https://cognition.ai/blog/swe-check-10x-faster (Applied Compute × Cognition AI, 2026-04-14)
- **Encountered:** 2026-05-29, full blog text pasted by user + `INTAKE.md` pointer
- **Verdict:** memory note + half-day lane-2/3 spike + parked cloud-roadmap note — lane 5 (the product) / lane 4 (patterns) / lane 2–3 (the spike). The RL *method* is lane 6 (skip): interlinked trains nothing.

## 1. Core idea (one sentence, your words)

A small open-source model, RL-trained specifically on "find the bugs this diff just introduced" until it matches a frontier generalist *on that one task*, then served on fast inference so it can run on-demand in the IDE — where the quality-bar frontier models were too slow and too expensive to use that way.

## 2. Anatomy (prose source — load-bearing claims, my words)

1. **Specialization closes the in-distribution gap and narrows OOD, but stays behind frontier OOD.** Delta-F1 to Opus 4.6 goes 0.09 → 0 in-distribution and 0.49 → 0.29 out-of-distribution. They're explicit: the model is "on the Pareto frontier" but "not categorically the most capable." **The win is latency/cost, not raw capability** — the "10x faster" headline is a wall-clock/price claim, not a capability claim.
2. **Latency is a hard product requirement, not a nice-to-have.** They name the failure mode — the "Semi-Async Valley of Death" — and target near-real-time via dense fast inference (Cerebras). The entire reason to specialize was that frontier models meeting the quality bar were too slow/expensive for in-IDE, on-demand use.
3. **β=0.5 — precision over recall.** Early iterations used f_β with β=1 and "produced many false positives, flagging many benign diffs as bugs during dogfooding." They re-weighted to β=0.5 to emphasize precision. This is the single most transferable line in the post.
4. **The tracing-tools fix.** Dogfooders found the model "would constantly report bugs where if it simply looked up the definition of one of the variables in the code block, it would know the code block was correct." Fix: build find-definition / find-references tools into the harness (training **and** prod) and retrain. **FP reduction came from resolution capability, not just reward shaping.**
5. **Native harness integration + tight dogfooding loop.** They replicated the Windsurf production toolset inside the training sandbox so gains transfer 1:1, and treated "human taste and how the agent feels to use" as the ultimate arbiter over the reward number. Each training decision traces back to a production-environment fact or a real-user complaint.
6. **The RL recipe (the skip part).** *Reward linearization*: a first-order linear approximation of the population f_β in terms of P_pop/R_pop, so a per-sample reward (`½·P(τ) + R(τ)`) averages back to the global metric. *Two-phase post-training*: phase 1 maximizes capability against the base reward; phase 2 adds a latency penalty whose shape is the **CDF of how long users wait before switching the feature off**. Combining both objectives from the start collapsed to a local optimum ("fast but shallow"); separating them didn't.

## 3. Deterministic or agentic?

**The product is agentic** — an LLM is the bug detector. That routes the product to lane 5, never the local CLI (`feedback_harness_deterministic_only.md`), exactly as `openai-auto-review.md` routed its LLM action-reviewer.

**The method is off-axis for the filter, and homeless regardless.** Reward linearization and the two-phase loss are deterministic arithmetic, but the filter asks whether *value depends on inference* — and SWE-check's whole product is a better-*inferring* model. More decisively, and identically to `echo-rl.md`: **no interlinked surface trains models** (not the CLI, not Guardrails, not Agent CI — all consume off-the-shelf inference). The recipe has nowhere to land.

**The one deterministic, adoptable thing** is claim #4 inverted: *resolve a symbol's definition before flagging a bug about it.* SWE-check needed a model to call a find-definition tool because the model **is** the detector. interlinked's detectors are already deterministic, so they can consult the symbol graph **directly** — strictly cheaper and more precise than a model-mediated lookup. That clears the CLI.

**License/availability:** prose source; no license gate on the patterns. The model is described as open-source but ships as a *Windsurf Next preview* — no public weights/API at intake time, so even invoke-as-subprocess isn't on the table. Reinforces lane 5 (cloud product), not lane 3 (borrowable substrate).

## 4. Substrate vs. surface

- **Surface:** an on-demand, in-IDE diff-bug-detection model.
- **Substrate (two):**
  - *The specialist-beats-generalist-on-its-spike thesis* — not borrowable (no training surface), but it **validates the bet** that interlinked's review tier could one day run a fast bug-specialist instead of a slow frontier generalist.
  - *Resolution-before-flagging* — borrowable as a deterministic FP-suppression principle for existing heuristic checks, using substrate interlinked already ships (`project-graph.ts`, `impact-analysis.ts`, the same-file symbol scan).

## 5. Lane (1–6)

- **Lane 5 (product) — primary.** An LLM that reviews a diff and emits bug + fix is precisely interlinked's Tier-3 / `/ultrareview` shape (`docs/design/tier-3-async-deep-review.md`, `multi-agent-pre-push-review.md`), and precisely what a future fast specialist model could power on the Guardrails/Agent-CI tiers. → cloud-roadmap note.
- **Lane 4 (patterns).** β<1 precision-weighting; the latency-budget-from-user-abandonment-CDF method; capability-then-latency two-phase sequencing as a general "develop the skill, then compress it" recipe. → memory.
- **Lane 2–3 (the spike).** Resolution-before-flagging FP suppression for `ubs_division_by_variable` and its kin (lane 2 = refine the detector; lane 3 = lean on the symbol-resolution substrate). → half-day PR.
- **Lane 6 (skip).** Reward linearization + the RL recipe: no training surface, same as ECHO-the-trainer.

## 6. Dependency & displacement

- **Deps:** none. The §7 spike reuses the existing same-file symbol scan (the detector already walks the whole file — see `collectPathishNames`); zero new deps. The product is cloud-side, a separate codebase.
- **Displacement — heavy overlap, zero replacement.** Three existing things this *validates* rather than displaces:
  1. **The review tier.** SWE-check is the *fast-single-specialist* point on the same diff-review axis where interlinked's `/ultrareview` / Tier 3 currently sits at *slow-multi-frontier-agent*. It argues a faster, cheaper specialist tier is worth wanting; it doesn't change the Tier-3 design.
  2. **The precision-over-recall stance.** β=0.5 **is already** interlinked's `DEFAULT_ADVISORY_SKIPS` / default-gate split and the FP-rate obsession (`feedback_generalize_across_codebases.md`; the CLAUDE.md "refine the detector, don't demote it" rule). An independent team optimizing a near-identical objective re-derived "weight precision over recall." f_β with β<1 is a clean *formal name* for the existing taste — confirmation, not a behavior change.
  3. **The accumulated same-line guards in `division-by-variable.ts`.** `lineHasZeroGuard` (ternary / `if (x)` / `&&` shapes) and `collectPathishNames` (Python `Path` typing) are **line-local regex approximations of symbol resolution**, bolted on across two repo audits. SWE-check's lesson is that the real resolution makes the whole class evaporate — and interlinked's graph can do it deterministically (`supermodel.md`: "don't verify a precise tool with a less-precise one" — resolve via the graph, not a wider regex or a model guess).

## 7. Smallest spike (≤1 day)

Add a **definition-resolution suppression pass** to `ubs_division_by_variable` (advisory today; documented over-firer in `project_ubs_division_overfires_guarded`). When the divisor identifier resolves — **within the same file**, via a lightweight binding scan generalizing the existing `collectPathishNames` walk — to a provably-nonzero value (numeric literal, `.length`/`.size`/`.count`, a value guarded earlier in scope, or a Path-typed name), suppress the finding. Measure the FP-rate delta against the existing 139-repo audit corpus the detector already cites.

Scoped same-file deliberately, to stay inside the per-edit budget (`feedback_hook_latency_budget.md`); cross-file resolution is the cloud-tier version, not this spike. If the FP rate drops enough, this is the template for promoting the detector from advisory back to the default gate — the CLAUDE.md "refine, don't demote" directive, executed. The principle generalizes to any heuristic that flags a property of a *named binding* it could instead resolve (`magic_literal_in_conditional`, parts of the UBS family).

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | Resolution-before-flagging FP suppression for binding-property heuristics (divisor → provably-nonzero binding) | §7 | next |
| Guardrails (P2–3) | A fast specialized diff-bug model as a sub-second-ish review tier; β<1 as the explicit calibration target; the abandonment-CDF as how to *set* the deliberate latency budget (`feedback_deliberate_prepost_latency.md`) empirically | "adopt a bug-specialist model" RFC | parked |
| Agent CI (P4–5) | A SWE-check-style specialist as one fan-out reviewer inside `/ultrareview` / Tier 3, alongside the frontier generalists | wire a specialist into the Tier-3 fan-out | parked |

## 9. Artifact

Memory note (this file) + half-day lane-2/3 spike PR when prioritized + a parked cloud-roadmap note folded into `tier-3-async-deep-review.md` / the Guardrails design (the "review tier could run a fast bug-specialist" idea + the β<1 / abandonment-CDF calibration framing). The RL method gets no artifact (skip). No commit pending until requested.

## Notes

- **Honest post, no marketing-vs-reality trap** (like ECHO, unlike CodeWiki): they state outright they're behind frontier OOD and "not categorically the most capable." The only thing to guard against is the title — "10x faster" is latency/cost, and a careless read could hear "10x better." It isn't; capability is at-parity in-distribution and *behind* OOD.
- **The β switch is the headline takeaway for interlinked.** Independent empirical confirmation, from a team optimizing the same objective (flag real bugs, don't annoy with FPs), that a bug-flagging gate should weight precision above recall. That is interlinked's `DEFAULT_ADVISORY_SKIPS` philosophy stated as a loss function.
- **The abandonment-CDF latency-budget method is reusable.** Measuring "how long until users disable the feature" and using its CDF as the latency penalty is a concrete way to *set* the deliberate pre/post cloud window in `feedback_deliberate_prepost_latency.md` from data rather than feel — a note for whoever designs the Guardrails/Agent-CI latency contract.
- **Cross-refs:** `echo-rl.md` (same "RL method we can't adopt → skip the recipe, mine the pattern + the bet it validates" shape); `openai-auto-review.md` (same "LLM diff/action reviewer → lane 5, keep the CLI deterministic in front of it"); `supermodel.md` (deterministic-graph resolution beats both a wider regex and a model guess — the substrate argument for the §7 spike).

## Methodology notes (optional)

Second instance now (after ECHO) of the same intake *shape* — a procedural parallel, not a substantive one (ECHO is world-modeling, SWE-check is bug detection; the underlying ideas don't touch): **an RL-training post whose recipe is lane-6 skip, but which (a) validates an existing interlinked bet and (b) surfaces one deterministic spike** — and in both cases the CLI-actionable insight was a *data/tooling observation made in passing* ("we gave it find-definition and the FPs dropped"), not the headline training method. The "10x faster" framing very nearly buried that one line under RL-recipe detail irrelevant to a tool that trains nothing. ECHO's methodology note already proposed folding "skip the method, extract the deterministic pattern it rests on" into the rubric; SWE-check is the confirming second data point. If a third RL-method intake lands, promote it: **for RL-paper intakes, read for the harness/data observation and the bet validated before reading the loss function.**
