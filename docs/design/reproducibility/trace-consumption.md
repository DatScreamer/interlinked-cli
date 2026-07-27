# Trace consumption: simulations, benchmarks, and agent-readable experience

**Status:** design note, 2026-07-25. **Inputs:** Snorkel "From Agent Traces to
Agent Simulations" talk (intake: `docs/external-pulse/snorkel-agent-simulations.md`,
corrected transcript sibling) and Letta `trajectory` (intake:
`docs/external-pulse/letta-trajectory.md`). **Relation:** sits downstream of
G1–G5 capture and T1/T2/T3; names the remaining capture gaps and the consumer
surfaces a full capture unlocks.

## The two-consumer split (from Letta)

Every trace has two consumers with opposite needs, and one format cannot serve
both:

| Consumer | Needs | Our artifact |
|---|---|---|
| Replay / eval machinery | full fidelity: envelopes, seq, tree+state refs, untruncated outputs | `replay-trace.v1` (shipped) |
| Agents reading past experience | token-efficiency: ~5× smaller, flat records, truncated tool results | **shipped 2026-07-27** — `interlinked experience export` (trajectory-v1 interop + annotated trajectory-ix.v1; `experience analyze` for deterministic session metrics) |

Rule: never degrade replay-trace.v1 toward agent-readability; project outward
instead.

## Capture gaps that remain (ranked by leverage)

1. **Out-of-repo agent config.** G2 snapshots the repo tree; G1 envelopes carry
   the assembled system prompt + tools. What neither captures: `~/.claude/`
   surfaces (global CLAUDE.md, skills, settings.json, memory dir) and
   `.interlinked/config.local.json` — the "full system" the Snorkel talk insists
   you evaluate (harness + skills + policies, not just model). Fix: extend the
   G2 state archive's file list with a hashed, scrubbed copy of the resolved
   agent-config set per session start (not per step — it changes rarely; record
   a new blob only on hash change). Secrets-scrub before archiving
   (`config.local.json` holds tokens — reuse the redaction used for
   prompt/thinking capture).
2. **External tool/service responses as first-class replayable state.** The
   repo tree replays; MCP servers, network APIs, and databases do not. We
   already capture every tool *result* through hooks (collection.jsonl), which
   is enough for teacher-forced T1. For on-policy T2, recorded results become
   the mock layer: a rollout driver answers a candidate's tool call with the
   recorded response when the call matches (action-match scorer as the matcher)
   and quarantines the step as divergent when it doesn't. That is the Snorkel
   "sidecar/mock" pattern built from capture instead of hand-written mocks.
   Capture addition: record *request → response* pairing metadata for MCP/Bash
   tools (we have it via tool_use_id) plus an is-deterministic hint per tool
   (Read/Grep = deterministic given tree; WebFetch/date-dependent = not).
3. **Multi-step checkpoint markers.** Long-horizon tasks need intermediate
   fail-fast points. We have per-seq snapshots (stronger than their per-step
   Docker checkpoints); what's missing is a semantic marker for "task unit
   boundary" to cut episodes at. Cheapest source: the Stop event + user-message
   boundaries already in timeline.jsonl — no new capture, an assembler
   convention (episode = user message → Stop).

## What full capture unlocks (the consumer list)

- **T1/T3 (shipped):** teacher-forced eval + scoring ledger.
- **Task export (next spike):** `replay export-task` — Harbor-shaped task dir
  per episode: instruction = user message(s); environment = `replay restore`
  at the episode's opening seq; **oracle = the recorded reference session**
  (solvability proven by construction — the sharpest advantage over
  reconstruct-from-trace pipelines); verifiers = deterministic action-match +
  post-tree hash + the harness check registry re-run (dense per-step reward).
- **Benchmark CI (deterministic, CLI-lane):** oracle-replay-passes,
  fixtures-present, pinned-toolchain-matches-manifest, variance check across N
  runs — the Snorkel admission checklist, all deterministic, all buildable on
  existing probes.
- **Release gate:** run the exported task set against a candidate config before
  shipping harness/prompt/skill changes; compare cost/latency/retries from
  costs.jsonl + ledger, not just pass rate.
- **Training set:** episodes with verifier outcomes = RL/SFT corpus (the
  qwen-lora consumer already exists; the talk's small-model-matches-large
  fine-tune is exactly that loop).
- **Failure→benchmark expansion loop:** `interlinked recurrence` rows and guard
  blocks mark real production failures; each is a candidate task
  (`recurrence propose` gains an "export as task" action).
- **Agent memory (Letta lane):** trajectory-v1 export feeds cross-harness
  memory/dreaming consumers without exposing full-fidelity data.

## Failure modes to design against (Snorkel's list, mapped)

- Reward-hacking the sim = our baseline-integrity gate class; verifier
  water-lines must be as tamper-protected as coverage baselines.
- Too-broad verifiers (always pass) / broken verifiers (always fail) = the
  oracle-replay CI check catches both: oracle must pass, a null-action run must
  fail.
- Run variance: N-run difficulty/stability tagging before a task is admitted;
  flaky-tool quarantine (T2 spec) is the per-step version.
