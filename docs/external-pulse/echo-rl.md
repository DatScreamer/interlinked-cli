# ECHO — Terminal Agents Learn World Models for Free

- **Source:** https://github.com/microsoft/echo-rl • paper `echo.pdf` (in-repo) • built on SkyRL (https://github.com/NovaSky-AI/SkyRL) • AI Frontiers / Microsoft Research blog post
- **Encountered:** 2026-05-18, blog post + repo pasted by user; cloned to `reference-repos/echo-rl`
- **Verdict:** RFC + memory note — lane 4 (pattern). The *method* is lane 6 (skip) for interlinked.

## 1. Core idea (one sentence, your words)

During RL of a CLI agent, ECHO stops masking out the terminal's response tokens and adds a cross-entropy loss on them, so the model is trained to predict how the environment reacts to its commands — alongside the usual GRPO loss on the agent's own action tokens.

## 2. Anatomy (concrete walkthrough)

**Blog/paper — load-bearing claims (my words):**
1. Standard agent RL (GRPO) pushes gradients only through *action* tokens and masks out the terminal-*response* tokens — even though those tokens are already in context and already forward-passed. Discarded supervision.
2. ECHO un-masks them: a masked, length-normalized cross-entropy on environment-observation tokens, scaled by λ, summed with the GRPO action loss — `L = L_GRPO(actions) + λ·L_env(obs)`. Same rollout, same forward pass, different mask; near-zero added cost.
3. Empirically improves every benchmark tested (Qwen3-8B/14B + an SFT'd 8B), ~2.3× faster to equal performance, ~doubles TerminalBench-2.0 pass@1 — no extra data, teacher, or rollouts.
4. Evidence it learns terminal dynamics: on held-out trajectories from a stronger model, ECHO sharply lowers environment-token cross-entropy; plain GRPO barely moves it.
5. Two surprises: ECHO from a base model recovers most of expert-SFT's benefit (much of SFT's value is an *interaction* prior, not a *strategy* prior); and with the GRPO term removed entirely (env-loss only, no verifier reward), the agent still self-improves on held-out tasks when rollouts are clean.

**Repo (`reference-repos/echo-rl`):** A SkyRL *extension*, not a fork. ECHO logic is `echo_rl/world_modeling/` (4 files, 477 LoC) + `echo_rl/terminal_agent/` (SkyRL generator + Harbor task backend + transcript mask construction). Load-bearing read: `world_modeling/loss.py::compute_world_model_loss` (~80 LoC) — `world_ce = -action_log_probs`, then `(world_ce * world_loss_mask)` normalized and scaled by `config.world_model_coeff` (= λ); `world_model_coeff: 0.0` recovers vanilla GRPO. The SkyRL change (`patches/skyrl_minimal_hooks.patch`) is genuinely minimal *and generic* — the only core-loss edit is `loss = loss + aux_policy_loss`; the rest is plumbing (an `extras` dict, `zero_pad_keys`). Notable: `terminal_agent/interaction.py` span-tags each transcript into four mask streams — action, observation, **warning**, **env-output** — so "train on the real terminal output, not harness warnings" is a first-class data-model decision, not an afterthought.

## 3. Deterministic or agentic?

**The method: a model-training technique — off-axis for the determinism filter.** Its *mechanism* is deterministic arithmetic (masked cross-entropy over already-computed logits; the masks are deterministic transcript span-tagging — verified, no `call_llm` at any leaf, unlike CodeWiki). But the filter asks whether *value depends on inference*, and ECHO's entire product is a better-*inferring* model. More decisively: **no interlinked surface trains models** — not the CLI, not Guardrails, not Agent CI (those consume off-the-shelf models via inference). The method has no home regardless of the filter.

**The transferable pattern is deterministic.** "The environment's response is free, ground-truth supervision; reconcile predicted-vs-actual" — its mechanism (set/string diff over a prediction and an observed result) needs no inference. That is what clears the CLI, and interlinked already ships it (§6).

License: **MIT** (Microsoft) — permissive, no blocker. Moot anyway: nothing here is borrowable as code (a torch/Ray/vLLM/Harbor GPU RL stack vs a TS CLI).

## 4. Substrate vs. surface

- **Surface:** a better-trained terminal-agent model.
- **Substrate:** the auxiliary-objective *principle* — predicted-vs-actual divergence on environment responses is dense, free supervision, and failed trajectories still carry it.

The substrate transfers only as a **pattern**, never as code. interlinked can't *train* on the divergence (no training loop) — but it can *surface* it, *log* it, and *tune the harness* off it. interlinked already does a constrained version of exactly this.

## 5. Lane (1–6)

**Lane 4 (pattern) — primary.** The adoptable thing is the predict/reveal/reconcile principle and ECHO's specific lessons about it. → memory + RFC.

**Lane 6 (skip) — the method itself.** Not lane 5: lane 5 routes inference/centralized work to the cloud roadmap, but no interlinked product *trains* models, so ECHO-the-trainer lands nowhere. The binding constraint isn't the determinism filter — it's "interlinked trains nothing."

## 6. Dependency & displacement

- **Deps:** none. No code is borrowed (ECHO is a GPU RL stack — torch, Ray, vLLM, Harbor). The §7 spike adds zero deps (set/string diff over JSONL).
- **Displacement — heavy overlap, no replacement.** interlinked *already* ships predict/reveal/reconcile, generalized across two surfaces: `graph_prediction` (file-edit prediction vs Supermodel `.graph.*` shard) and `claim_dependencies` (assistant-claim prediction vs inverted index) — two instances of one pattern (`docs/design/graph-prediction-protocol.md` §2). `recurrence.ts` (`harness_caught`/`harness_missed`) and `error-history.ts` are adjacent "learn from what happened" logs. ECHO doesn't displace any of it — it *validates the bet* and supplies three extension lessons:
  1. **Generalize the prediction target to action *consequences*, not just static oracles.** Both interlinked instances predict against a harness-*computed* artifact (a shard, an index) — static structure that exists independent of the action. ECHO predicts the *consequence of the action itself*. The missing — and highest-value — target is the **PostToolUse check outcome**: "will this edit fail tsc / introduce a finding?"
  2. **Teach on the real environment response, not harness narration.** ECHO's data model separates `warning` from `env-output` masks for exactly this reason ("warnings are easy to memorize"). interlinked's graph-prediction reveal (per `graph-prediction-verification-status.md`) is harness-computed *scores* (`deps.imports: 1.00`); ECHO argues the agent learns more from the raw *missed identifiers* than from the score.
  3. **The λ / gaming caution.** ECHO warns that over-weighting prediction makes the policy prefer *predictable* outputs over *correct* ones. interlinked's planned `enforced` mode (block on prediction miss) carries the same risk — agents could learn conservative, easy-to-predict edits. Keep prediction a telemetry/reveal signal, not a hard gate; the protocol's v1.2 "no aggregate-score gating" rule already half-encodes this.

## 7. Smallest spike

≤1 day: a deterministic accuracy-trend aggregator over `.interlinked/graph-reconciliations.jsonl` (273+ rows already captured — per-section scores + `weighted_avg`), modelled on the `interlinked recurrence` aggregator. Report prediction quality *per session* (does it climb within a session?) and *over time*. This operationalizes ECHO's central empirical test ("better predictors solve more tasks") on data interlinked already has but ships no command to read as a learning curve. Flat trend ⇒ the reveal isn't teaching (a finding — and a reason *not* to invest in lesson 1); rising trend ⇒ the loop works, generalize it.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | Accuracy-trend report over the reconciliation log; audit the reveal text (raw missed identifiers vs scores) | §7 | next |
| Guardrails (P2–3) | Predict-the-check-outcome as a fast deterministic signal in the blocking gate | New prediction target wired pre-gate | parked |
| Agent CI (P4–5) | Score an agent's world-model quality across a whole task / async scan | Reconciliation aggregate per deep-review run | parked |

Beyond the §8 rollout: interlinked's captured `activity.jsonl` *is* an ECHO-shaped action→observation corpus. If interlinked ever trained or fine-tuned a model — no surface does today — that corpus is the training data. Prose note only; no surface row.

## 9. Artifact

**RFC + memory note.** RFC: fold the three §6 lessons into the graph-prediction-protocol roadmap — chiefly "generalize the prediction target to PostToolUse check outcomes." Memory note: the ECHO-delta framing (predict action *consequences*, not just harness-computed oracles; teach on real output; the λ caution). No PR — the §7 spike is a viability experiment, not a shippable check; promote it to a PR only if the trend data says the loop teaches.

## Notes

- ECHO is refreshingly honest — *no* marketing-vs-reality trap (cf. CodeWiki). The "free / no extra forward pass" claim checks out three ways: `world_ce` reuses already-computed log-probs, the SkyRL core edit is one addition, no extra forward pass exists. Mild caveat: "a few LoC on top of any GRPO trainer" describes the *loss* (~80 LoC); the *integration* (transcript mask construction, SkyRL generator, Harbor backend) is the ~600-LoC bulk — but the README discloses this.
- `world_modeling/config.py` exposes trajectory-quality filters (`wm_filter_min_valid_tool_call_pct`, etc.) and a `world_model_only` mode — the code-level realization of the blog's "filter to clean rollouts" and "verifier-free self-improvement" findings. Both deterministic (counting parse errors / turns).
- The maze footnote — a 10M-param transformer reproduced the ECHO effect on a laptop maze before the cluster run — is a methodology point: "every clean idea has a microcosm." interlinked's checked-in probes (`.interlinked/e2e-protocol-*.mjs`) are exactly that — laptop-scale microcosms of the predict/reveal/reconcile protocol.
- Related: `docs/design/graph-prediction-protocol.md`, `graph-prediction-verification-status.md`; `reference_supermodel_thesis.md` (deterministic graph > probabilistic narrator).

## Methodology notes (optional)

ECHO inverts the determinism filter usefully: the *method* fails it (inference- and training-bound) but a *pattern underneath* the method passes (deterministic reconciliation). "Skip the method, extract the deterministic pattern it rests on" is a recurring move — worth an INTAKE.md note if it shows up again. Also: this is the rare intake whose verdict is "we already built this." The rubric handled it cleanly via §6 displacement, but a find that *validates an existing bet* (rather than proposing a new capability) leans almost entirely on §6 — fine, but worth noticing the shape.
