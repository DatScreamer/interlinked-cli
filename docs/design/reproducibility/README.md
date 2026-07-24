# Reproducibility & Replay Program

**Goal:** collect enough per-tool-call data to reconstruct any past agent
session with high enough fidelity to (a) replay a recorded *reference* model's
trajectory and (b) run a *candidate* (smaller / distilled) model under
byte-identical conditions, then measure how closely the candidate reproduces the
reference. The eval substrate for model comparison and offline RL.

**Status:** Design — claim-audited against source on 2026-07-24 (58 repo
claims verified by 5 agents + a falsifier pass: 57 accurate, 1 corrected;
git-plumbing assumptions probe-measured on-machine). Nothing here is built as a
unit yet, but ~40% of the substrate already exists (see *Prior art* below). This directory is the handoff
spec — one file per deliverable, each self-contained.

**Audience:** a coding agent or developer who will implement one gap/tier at a
time. Read this README, then the one spec you're assigned.

---

## The reframe (read this before anything else)

"100% reproducibility" is two different problems; only one is hard.

1. **Trace fidelity** — losslessly record every `(observation → action → result → state)` quadruple. Pure observability. We're most of the way there.
2. **Deterministic replay** — re-run so the environment responds *byte-identically* to identical actions, leaving the **model** as the only free variable. The real RL-environment problem.

And the load-bearing correction, because it changes the cost by an order of
magnitude:

> **You cannot get bit-reproducible outputs from the reference models, and you don't need them.** Fable 5 / Opus 4.8 are cloud — no logits, no seed, no determinism guarantee (they batch server-side; float reductions are non-associative). Token-by-token logit comparison *against the reference* is impossible, full stop.

What you actually want — "how close is the distilled model to the reference in
identical conditions" — is measurable **without the reference's logits at all**:

> Record the reference's **trajectory** (its actions + the exact context it saw). Run the **candidate locally** and compute the per-token log-prob it assigns to the reference's actions. The score is the negative log-likelihood (NLL) of the teacher trajectory under the candidate — literally the distillation / imitation-learning loss. Perfectly reproducible (candidate is local + greedy), and it requires **no environment execution**.

This is **teacher forcing**. It means the eval needs great *capture* + a *local
candidate*, not a bit-perfect replayable cloud environment. The expensive
determinism work (Tier 2) is only for the harder mode: letting the candidate
**diverge** and take its own actions (on-policy rollout).

**Honest ceiling:**

| Target | Achievable? |
|---|---|
| Environment reproducibility (env is a deterministic function of the action sequence) | **Yes**, with the G-series work. |
| Candidate-model reproducibility (local open weights) | **Effectively yes** — batch-1, greedy, pinned container/kernel. |
| Reference-model reproducibility (Fable 5 / Opus 4.8) | **No.** You compare against a *recording*, never a live re-run. |

Adopt this operational definition of "100%": *the environment is a
deterministic, replayable function of the action sequence, and the model is
either a recorded teacher trace or a locally-controlled deterministic decoder.*
Under that definition, 100% is real and is what the eval needs.

---

## Prior art you build ON (do not re-implement)

Verified by reading source. Each deliverable *extends* one of these, not
greenfield.

| Asset | Where | What it already gives you |
|---|---|---|
| Cross-model replay scripts | `scripts/replay-reconstruct.mjs`, `scripts/replay-run.mjs` | Rebuilds the Messages context up to a `tool_use_id` from the runner transcript, calls a chosen model, diffs proposed vs ground-truth action. **This is the Tier-1 prototype.** Known gap: system prompt + tool schemas are reconstructed, not captured (`replay-reconstruct.mjs:15-16`, `replay-run.mjs:12-20`). |
| Decision-point corpus | `.interlinked/replay/gate-hit-*.json` + `*.context.json`, `decomposition-pairs.jsonl` | Worked examples of the reconstructed-context bundle shape. |
| Determinism-conformance driver | `src/harness/determinism-replay-driver.ts` + `determinism-conformance.ts`; fresh-process/perturbed-TZ proof in `__tests__/determinism-conformance.integration.test.ts:205-234` | Runs the check pipeline in a **fresh process under perturbed TZ/locale** (`TZ=Asia/Kolkata`, `LC_ALL=de_DE.UTF-8`) and byte-diffs against an in-process run. Its own comment: *"this same driver is the cloud-Sandbox rung's entry point."* **This is the Tier-2 cross-machine determinism check.** |
| Content-addressed store | `src/harness/scratchpad-archive.ts` (`archiveScratchpadDir`, `scratchpad-archive.v1`) | sha256 blob + manifest store with injectable clock (`:205`,`:247`). The **G2** CAS pattern, currently scoped to the tmp scratchpad. |
| Per-event live snapshot | `src/harness/live-snapshot.ts` (`writeLiveSnapshot`, atomic temp+rename) written every event at `src/harness/server-event-loop.ts:232` | The harness trajectory is **already snapshotted per tool call** to `<id>.live.json` — but overwritten in place and **deleted at SessionEnd** (`server/lifecycle-persist.ts:104`), so it is the **G2 wiring point**, not a history. G2 adds the per-step state archive Tier 2 restores from. |
| Session-start world anchor | Plan `docs/plans/11-phase1-prechecks-and-replay-foundation.md` Workstream B — **already shipped** in the generated hook (`src/lib/hook-template-chunks/session-state.ts:1180-1198`, session_start-gated `git stash create`) + `session-git-baseline.ts:22` (path sets) | Anchors working-tree state at **session** boundary. **G2 extends this to per-call**, standardizing on the temp-index `write-tree` primitive (measured ~50 ms warm / ~330 ms cold on this repo). |
| Evaluator-decision replay | Plan `docs/plans/free-cli-adoption/17-replay-testing-and-decision-receipts.md` | Designs `replay.ts` / `decision-receipt.ts` / `interlinked replay`, seeded RNG (`mulberry32`), `sha256(session_id‖event_index)` seed, "sort every key list", "pass currentTime as a param". **G4 adopts §17.4 wholesale** and extends it to the stateful surfaces. |
| Three correlated event logs | `activity.jsonl` / `collection.jsonl` / `timeline.jsonl` (`src/lib/local-activity-types.ts:22`, `src/lib/collection/types.ts:287`, `src/harness/transcript-record.ts:40`) | Actions, observations, thinking, transcript turns — correlatable by `tool_use_id`. tool_input lossless; tool_response full on daemon path. |
| Tamper-evident audit chain | `src/lib/audit-chain.ts`, `interlinked audit verify` | Hash-chained guard decisions. Integrity anchor for the trace. |

---

## The gap → deliverable map

| # | Gap (from the source audit) | Deliverable spec | Depends on |
|---|---|---|---|
| **G1** | **Exact model input never captured** — every recorder is a hook, downstream of context assembly. No system prompt / tool schemas / injected context / assembled messages. | [`g1-inference-capture.md`](./g1-inference-capture.md) | — |
| **G2** | **No per-tool-call filesystem snapshot** — only sha256 fingerprints + `applied`/`result_message`. Working tree captured only at session boundary (plan 11). | [`g2-tree-snapshots.md`](./g2-tree-snapshots.md) | G3 |
| **G3** | **No global event ordinal** — `ts` is ms-precision and collides for parallel calls; `event_id` isn't persisted. | [`g3-event-ordinal.md`](./g3-event-ordinal.md) | — |
| **G4** | **Harness-as-environment non-determinism** — ~13 decision-affecting time branches; a few unsorted `readdir` walkers. (RNG is trivial; network is ~off-path.) | [`g4-harness-determinism.md`](./g4-harness-determinism.md) | G3 |
| **T1** | **Teacher-forced replay eval** — the cheap, high-value win. Off-policy; no environment execution; perfectly reproducible by construction. | [`tier1-teacher-forced-eval.md`](./tier1-teacher-forced-eval.md) | G1, G3 |
| **T2** | **Deterministic environment for on-policy divergent rollout** — the true RL env. | [`tier2-onpolicy-env.md`](./tier2-onpolicy-env.md) | G1, G2, G4 |
| **T3** | **Scoring / comparison harness** — metrics + comparison ledger. | [`tier3-scoring.md`](./tier3-scoring.md) | T1 |

---

## Canonical shared definitions (specs reference this section)

### The trace spine

Every capture surface stamps the same join key. This is the one contract all
specs agree on:

```
StepKey = { session_id: string, seq: number, tool_use_id: string | null, ts: string }
```

- `session_id` — runner session id (already on every log).
- `seq` — **monotonic per-session counter** minted by the daemon for every observed event; a step's key uses its PreToolUse event's seq (the Post event carries its own seq and joins via `tool_use_id`). Defined in G3. This is the ordering primitive; `ts` is only a tiebreak label.
- `tool_use_id` — the assistant's tool-call id. Correlates the model output (G1), the hook events (activity/collection/timeline), and the tree snapshot (G2). Null for non-tool events (e.g. a plain assistant message).

The unified per-step **trace record** (written by T1's assembler, one line per
step) joins everything:

```jsonc
// .interlinked/replay/trace/<session_id>.jsonl   — schema "replay-trace.v1"
{
  "schema": "replay-trace.v1",
  "key": { "session_id": "...", "seq": 42, "tool_use_id": "toolu_...", "ts": "..." },
  "observation_ref": "inference/<session>.jsonl#<seq>",   // G1: exact model input+output envelope
  "action":      { "tool": "Edit", "input": { /* lossless tool_input */ } },
  "result":      { "outcome": "ok", "observation_ref": "collection.jsonl#<tool_use_id>" },
  "pre_tree":    "<git-tree-sha>",     // G2: working tree BEFORE the action
  "post_tree":   "<git-tree-sha>",     // G2: working tree AFTER the action
  "harness_state_ref": "state/<session>/<seq>.json.gz",  // G2 per-step state archive (live.json is overwritten + deleted at SessionEnd — no history exists without this)
  "guard":       { "decision": "allow", "rule_id": null, "receipt_id": null }  // plan-17 receipt if present
}
```

### Storage layout (consolidated under `.interlinked/replay/`)

```
.interlinked/replay/
  inference/<session_id>.jsonl     # G1  exact {request,response} envelopes, seq-keyed
  snapshots/index.jsonl            # G2  seq → {pre_tree, post_tree} + untracked manifest ref
  snapshots/blobs/<sha256>         # G2  untracked / non-git bytes (scratchpad-archive CAS); tracked bytes live in git's own object DB
  state/<session>/<seq>.json.gz    # G2  per-step harness-state archive (live-snapshot + the six baseline water-line files)
  trace/<session_id>.jsonl         # T1  the replay-trace.v1 spine above
  decisions/<session_id>.jsonl     # plan-17 evaluator-decision replay log (was .interlinked/_replay/)
  eval/<run_id>/                   # T3  comparison ledger (per candidate model)
  gate-hit-*.json                  # existing corpus (leave in place)
```

> **Naming reconciliation task (do this in G3):** plan 17 writes
> `.interlinked/_replay/` (underscore); the existing scripts write
> `.interlinked/replay/` (no underscore). Consolidate on `.interlinked/replay/`
> with the subdirs above; move plan-17's log to `replay/decisions/`. Flagged so
> the next implementer doesn't create a third directory.

### Config keys

All under the harness config (`.interlinked/guard-rules.json`, merged in
`src/harness/rules-loader.ts`; local override in `guard-rules.local.json`).
Matches the existing `harness.replay.recording_enabled` key from plan 17.

| Key | Default | Spec |
|---|---|---|
| `replay.event_ordinal` | **on** (cheap; just a counter) | G3 |
| `replay.inference_capture` | off | G1 |
| `replay.tree_snapshots` | off | G2 |
| `replay.deterministic_clock` | off (replay-only) | G4 |

Each has an `INTERLINKED_*` env bypass following the repo convention
(e.g. `INTERLINKED_DISABLE_TREE_SNAPSHOTS=1`). All capture is **fail-open and
never blocks a tool call** — this is observability, not a gate.

### The comparison metrics (defined once; T3 implements)

| Metric | Needs | Reproducible? | Notes |
|---|---|---|---|
| **Teacher-forced NLL** *(north star)* | candidate local (logits), reference *actions* only | Yes | Per-token log-prob the candidate assigns to the reference's action. = distillation loss. Reported with **excess NLL** (minus the candidate's own-greedy NLL) to cancel template mismatch. |
| **Action match** | tool name + normalized args | Yes | Exact / structural. Cheapest signal. |
| **AST edit-diff** | TS compiler API (already in-tree, the cyclomatic gate) | Yes | Structural distance for `Edit`/`Write`; beats string cosine on code. |
| **Argv / command diff** | — | Yes | For `Bash`. |
| **Embedding cosine** | local embedder | Yes | For natural-language messages only. |
| **Action-sequence alignment** | trace spine | Yes | Edit distance over the tool-call sequence (on-policy divergence). |
| **Outcome equivalence** | end-state (tests pass / gate verdict / changed-file set) | Yes | Coarsest, most robust. |
| ~~Cross-model logit / KL~~ | — | **No** vs cloud reference | Candidate-only; do not design toward it for the reference. |

---

## Sequencing

```
G3 (ordinal) ─┬─► G1 (inference capture) ─┐
              ├─► G2 (tree snapshots) ─────┼─► T1 (teacher-forced eval) ─► T3 (scoring)
              └─► G4 (determinism) ────────┘                    │
                                                                └─► T2 (on-policy env)  [needs G1+G2+G4]
```

Recommended order: **G3 → G1 → G2 → T1 → T3**, then **G4 → T2** (the expensive
tier) only if you need on-policy divergent rollout. G4 is independently valuable
(it hardens the harness against silent decision drift — plan 17's original
motivation) and can be done any time after G3.

**Relationship to plan 17:** plan 17 deliberately scoped out filesystem/network/
time replay and cross-machine replay, because its goal was support + regression
of the *evaluator decision path*. This program's RL-eval goal *requires* those
dimensions, so G2/G4/T2 pick them up. Land plan 17's decision-log + receipt work
as-is (it's the `replay/decisions/` subconcern); this program consumes its
receipt as the per-step `guard.receipt_id` and reuses its §17.4 determinism
techniques.

---

## First spike (2 days, entirely local, no new infra, no cloud)

Cut this before committing to the full program — it tells you whether capture
fidelity is good enough to be worth the rest.

1. **G1-lite** — an inference-boundary logger: point the runner's base URL (`ANTHROPIC_BASE_URL` for Claude Code) at a ~100-line local pass-through that appends each exact `{request, response}` to `.interlinked/replay/inference/<session>.jsonl`. Join key: the `tool_use_id` in the response's `tool_use` blocks. See `g1-inference-capture.md` §"Minimal proxy".
2. **G2-lite** — record `git stash create` (or `git write-tree`) once per PreToolUse into `snapshots/index.jsonl`, keyed by `seq`. One SHA per step; git dedups the bytes. See `g2-tree-snapshots.md` §"Minimal snapshot".
3. **T1-lite** — extend `scripts/replay-run.mjs` to (a) load the *real* system+tools from the G1 envelope instead of the reconstructed `DEFAULT_SYSTEM`/`TOOLS`, and (b) emit the teacher-forced NLL + AST edit-diff for one step against a local candidate. See `tier1-teacher-forced-eval.md` §"Minimal scorer".

Deliverable: a single-step "distilled-vs-Opus-4.8 in the exact same situation"
comparison with zero cloud dependency.

---

## Glossary

- **Reference / teacher** — the advanced model whose behavior is the target (Fable 5, Opus 4.8). Cloud; recorded, never re-run.
- **Candidate / student** — the smaller / distilled model under evaluation. Local; re-run under controlled decode.
- **Observation** — the exact input the model saw at a step (system + tools + messages). Captured by G1.
- **Action** — the model's emitted tool call (+ text/thinking).
- **Off-policy / teacher-forced** — feed recorded observations, score the candidate's action *without executing it*. No environment needed → reproducible by construction. Tier 1.
- **On-policy rollout** — let the candidate execute its own actions and diverge; the environment must respond deterministically. Needs G2+G4+sandbox. Tier 2.
