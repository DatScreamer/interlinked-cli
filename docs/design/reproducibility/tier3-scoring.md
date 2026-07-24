# Tier 3 — Scoring & comparison ledger

**Status:** Design. **Effort:** 2–3 days.
**Scope:** aggregate per-step scores into trajectory + suite metrics; a comparison ledger; `interlinked replay report`.
**Depends on:** [Tier 1](./tier1-teacher-forced-eval.md) (per-step scores). **Optional input:** [Tier 2](./tier2-onpolicy-env.md) (divergent rollouts).

## Goal

Turn per-step scores into an answer to "how close is candidate X to the
reference?" — per step, per trajectory, and per model — as a durable, diffable
ledger. **Deterministic aggregation only** (counting/stats over the scores; no
LLM-as-judge in the aggregator — repo policy `feedback_harness_deterministic_only`).
The metrics themselves (NLL, AST-diff) are already deterministic.

## Design

### Ledger schema

```jsonc
// .interlinked/replay/eval/<run_id>/ledger.jsonl  — schema "replay-eval.v1"
// one line per scored step
{
  "schema": "replay-eval.v1",
  "run_id": "...",                 // one eval run = (reference session set × one candidate)
  "reference": { "session_id": "...", "seq": 42, "tool_use_id": "toolu_...", "model": "claude-opus-4-8" },
  "candidate": { "model": "vllm://qwen3.5-distill", "decode": "greedy", "container_digest": "sha256:..." },
  "scores": {
    "action_match": 1,
    "ast_edit_distance": 0,        // null when action isn't an edit
    "argv_distance": null,
    "message_cosine": null,
    "teacher_forced_nll": 0.31,    // per-token mean; the north-star number
    "excess_nll": 0.12,            // NLL(ref action) − NLL(own greedy); template-mismatch canceller (T1)
    "self_check_ref_reproduced": true
  },
  "mode": "off_policy"             // "off_policy" (T1) | "on_policy" (T2)
}
```

```jsonc
// .interlinked/replay/eval/<run_id>/summary.json  — trajectory + suite aggregates
{
  "run_id": "...", "candidate_model": "...", "steps": 1284,
  "action_match_rate": 0.71,
  "mean_nll": 0.44, "median_nll": 0.29, "mean_excess_nll": 0.18,
  "ast_edit_distance_p50": 0, "ast_edit_distance_p90": 6,
  "sequence_alignment": 0.83,     // T2 only: edit-distance-normalized trajectory overlap
  "outcome_equivalence_rate": 0.62, // T2 only: same end-state (tests/gate/changed-files)
  "by_tool": { "Edit": { "match": 0.68, "mean_nll": 0.5 }, "Bash": { ... } }
}
```

### Aggregation

`src/harness/replay/eval-aggregator.ts` — pure functions over `ledger.jsonl`:
per-tool breakdowns, percentiles, rates. **Mean NLL is the headline distillation
metric** (mean excess NLL is its calibration companion — see Tier 1's NLL
subtlety); action-match-rate and AST-distance percentiles are the interpretable
companions. Sequence-alignment + outcome-equivalence apply only to Tier-2
on-policy runs (they need executed trajectories).

### Report

```
interlinked replay report --run <run_id>              # one candidate
interlinked replay report --compare <run_a> <run_b>   # leaderboard across candidates
```

Renders a table via the existing `src/lib/formatter.ts` (no new deps, per repo
convention) with `--json`/`--short`/`--full` output modes (`getOutputMode`).
Comparison mode ranks candidates by mean NLL + action-match on the *same*
reference session set (apples-to-apples — same observations).

## Files to change / add

| File | Status | Purpose |
|---|---|---|
| `src/harness/replay/eval-aggregator.ts` | new | Pure aggregation over `ledger.jsonl`. |
| `src/harness/replay/eval-ledger.ts` | new | Ledger writer/reader, `run_id` allocation. |
| `src/commands/replay.ts` | edit | `interlinked replay report` (+ `--compare`, output modes). |
| `src/harness/replay/__tests__/eval-aggregator.test.ts` | new | See test plan. |

## Test plan

- Aggregation: a fixture ledger → correct match-rate, mean/median NLL, per-tool breakdown, percentiles.
- Determinism: same ledger aggregated twice → byte-identical summary (no map-order/float-format drift — reuse the G4 canonicalization discipline).
- Compare: two runs over the same reference set rank by the documented key; a run over a *different* set is rejected (not comparable).
- Output modes: `--json` is machine-stable; `--short` is one line per candidate.

## Validation

- [ ] `interlinked replay eval` (T1) → `interlinked replay report` produces a mean-NLL + action-match summary for a candidate over a real session.
- [ ] `--compare` across two candidates on the same session set yields a stable leaderboard.
- [ ] Aggregation is bit-reproducible and contains no LLM call.

## Open questions

1. Weighting: is mean NLL the right headline, or a per-tool-weighted score (edits matter more than reads)? Ship unweighted; add a weight table if needed.
2. Confidence: with small session sets the rates are noisy — report n and a simple CI, don't over-claim a leaderboard on 50 steps.
3. Cross-run comparability requires an identical reference session set + identical scorer versions — stamp the scorer version in `summary.json` and refuse cross-version compares.
