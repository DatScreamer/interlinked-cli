# Tier 1 — Teacher-forced replay eval (the cheap win)

**Status:** Design. **Effort:** 2–3 days *given G1*. Delivers the model comparison you actually asked for.
**Scope:** productionize `scripts/replay-{reconstruct,run}.mjs` into `src/harness/replay/`; a trace assembler; a candidate runner (cloud + local backends); the NLL + AST-diff scorers; `interlinked replay eval`.
**Depends on:** [G1](./g1-inference-capture.md) (exact observation), [G3](./g3-event-ordinal.md) (`seq`). **Feeds:** [Tier 3](./tier3-scoring.md).

## Why this is the high-value tier

**Off-policy / teacher-forced:** feed each recorded observation to the candidate,
capture its proposed action, score it against the reference's action — **without
executing anything**. No environment, no divergence, so it's *perfectly
reproducible by construction* and needs none of G2/G4/Tier-2. This is
"compare distilled-vs-Opus-4.8 in the exact same situation," and it's mostly
wiring on top of the existing `replay-*.mjs` scripts once G1 supplies the real
observation.

## Design

### Trace assembler (shared with G1)

`src/harness/replay/trace-assembler.ts` joins, per `tool_use_id`:
the G1 envelope (observation) + the hook logs (recorded action + result) + the G2
snapshots (`pre_tree`/`post_tree`) → one `replay-trace.v1` line per step (README
§Trace spine). This replaces `replay-reconstruct.mjs`'s transcript reconstruction
— the observation is now the **exact** captured request, not a rebuild, closing
the `replay-run.mjs:12-20` fidelity caveat.

### Candidate runner — two backends

```
interlinked replay eval --session <id> --candidate <model> [--step <seq> | --all]
```

| Backend | For | Gives |
|---|---|---|
| **Cloud API** (`--candidate claude-...` / any provider) | action-level comparison | proposed action → action_match, AST-diff, argv-diff, embedding cosine |
| **Local open-weight** (`--candidate vllm://... \| mlx://...`) | the distilled model | all of the above **+ teacher-forced NLL** (needs logits) |

For each step: take the envelope's exact `{system, tools, messages, params}`, send
to the candidate, collect its `content` blocks. Off-policy — the *next* step still
uses the reference's recorded observation, never the candidate's action. Two
transforms happen in the runner: (a) **prior-turn thinking blocks are stripped
by default** — this mirrors the API's own cross-model semantics (foreign
thinking blocks are silently dropped server-side) and `replay-reconstruct.mjs`'s
precedent; `--keep-thinking` restores exact-envelope mode for same-model
candidates; (b) for local backends, the Anthropic-format `tools` array is
converted to the candidate's own tool-declaration format by the backend adapter.

### Scorers

`src/harness/replay/scorers/`:

- `action-match.ts` — tool name equal + normalized-arg equal.
- `ast-edit-diff.ts` — for `Edit`/`Write`, parse old/new with the TS compiler API
  (already in-process: the cyclomatic gate runtime-loads `typescript` via
  `createRequire` — `src/harness/checks/cyclomatic-ast.ts:40`, availability
  probe `astComplexityAvailable()` `:48`) and compute a structural distance
  (node-level edit script), not string cosine. For `Bash`, argv/command-token diff.
- `nll.ts` — **teacher-forced NLL**: serialize the reference's action into the
  candidate's *own* tool-call format via its chat template, then score
  `−Σ log p(reference_action_token | observation, prefix)` under the candidate.
  Backend-specific logit access: vLLM `prompt_logprobs`, llama.cpp `--logits-all`,
  mlx-lm logprobs. **This is the north-star metric** (README §metrics). Report
  **excess NLL** alongside: `NLL(reference action) − NLL(candidate's own greedy
  action)` — high absolute NLL with near-zero excess indicates a
  serialization/template problem, not behavioral distance.
- `message-cosine.ts` — local embedder, natural-language turns only.

### The fidelity self-check (do this before trusting any number)

Replay the **reference** model on its own captured envelope. If the API
reproduces the recorded action, the capture + serialization are trustworthy
(`replay-run.mjs:17-21` already recommends this). Bake it into
`interlinked replay eval --self-check`: it reports the reference's
self-reproduction rate; a low rate means the envelope or template is wrong, not
the candidate.

### Minimal scorer (first-spike version)

Extend `scripts/replay-run.mjs`: (1) load `system`/`tools`/`messages` from the G1
envelope instead of `DEFAULT_SYSTEM`/`TOOLS`; (2) after getting the candidate's
action, call `ast-edit-diff` + (for a local candidate) `nll` and print both
alongside the existing `same_tool`/`same_file` diff. One step, one command, no
cloud infra.

## The NLL subtlety (call it out in review)

The teacher-forced NLL is only meaningful if the reference action is serialized
**exactly as the candidate would emit it** — same tool-call grammar, same special
tokens, same whitespace. A template mismatch inflates NLL for reasons unrelated to
behavior. Pin the candidate's chat template + tool-call format in the backend
adapter, and validate with the self-check (score the candidate on its *own*
sampled action → NLL should be near-minimal). Excess NLL (above) bakes this
diagnostic into every report: subtracting the own-greedy-action NLL cancels
template-induced inflation.

## Files to change / add

| File | Status | Purpose |
|---|---|---|
| `src/harness/replay/trace-assembler.ts` | new | Build `replay-trace.v1` from envelopes + logs + snapshots. |
| `src/harness/replay/candidate-runner.ts` | new | Cloud + local backends behind one interface; thinking-strip + tool-schema conversion live here. |
| `src/harness/replay/scorers/{action-match,ast-edit-diff,nll,message-cosine}.ts` | new | The metric implementations. |
| `src/commands/replay.ts` | edit | `interlinked replay eval` / `--self-check`. |
| `scripts/replay-run.mjs`, `scripts/replay-reconstruct.mjs` | edit → thin | Keep as CLI wrappers over the new modules, or deprecate. |
| `src/harness/replay/__tests__/scorers.test.ts` | new | See test plan. |

## Test plan

- action-match: identical tool+args → 1.0; different tool → 0.
- ast-edit-diff: same edit → distance 0; a rename vs a body change → distinct, monotone distances; string-identical-but-AST-different formatting → distance 0 (proves it's structural).
- nll self-consistency: candidate scored on its own greedy action → NLL at the floor; on a random other action → higher.
- excess-NLL diagnostic: a deliberately corrupted serialization template inflates absolute NLL on both reference and own-greedy actions while excess stays near zero (separates template error from behavioral distance).
- self-check: reference on its own envelope reproduces the recorded tool for a fixture set at a high rate.
- Off-policy invariance: step N+1's observation is independent of the candidate's step-N action (no leakage).

## Validation

- [ ] `interlinked replay eval --session <id> --candidate <local-model> --all` emits per-step action-match + AST-diff + NLL, fully offline, and is bit-identical across two runs (candidate greedy).
- [ ] `--self-check` reports the reference self-reproduction rate; capture is only trusted above a documented threshold.
- [ ] Swapping the candidate model changes the scores but not the observations (same trace, different policy).

## Open questions

1. Which local inference backend first? vLLM has the cleanest `prompt_logprobs`; mlx fits the 16GB-Mac path (per the existing overnight-LoRA work). Recommend the backend that hosts the distilled model you're actually evaluating.
2. *(settled during review)* Thinking handling: prior-turn thinking is stripped from observations by default (see the candidate-runner transforms) and the NLL scores the action only (text + tool_use) — thinking is model-private and cross-model-incomparable.
