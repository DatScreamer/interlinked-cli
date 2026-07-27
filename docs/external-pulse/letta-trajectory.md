# Letta `trajectory` — standard format for agent experience data

- **Source:** https://www.letta.com/blog/trajectory/ + https://github.com/letta-ai/trajectory
- **Encountered:** 2026-07-25, user-supplied alongside the Snorkel agent-simulations talk
- **Verdict:** PR (exporter surface) + memory note (consumption patterns).
  **Shipped 2026-07-27** as `interlinked experience export|analyze|list`
  (`src/commands/experience/`): trajectory-v1 interop emit + our
  trajectory-ix.v1 annotated format (seq, tool classes, outcomes, guard
  verdicts, episodes, verification flags) + deterministic session analytics.

## 1. Core idea (one sentence, your words)
An open-source npm package that discovers local coding-agent sessions (Claude Code,
Codex, Letta Code) and normalizes each into one flat, token-efficient record list
(meta/user/reasoning/assistant/tool) so that *agents* — not replay tooling — can
read past experience cheaply for memory formation and cross-harness learning.

## 2. Anatomy (concrete walkthrough)
Load-bearing claims from the post:

1. **Schema**: a trajectory = `[{role: meta|user|reasoning|assistant|tool, ...}]`;
   first record is harness metadata (`source`, `cwd`, `git_branch`, `model`); tool
   results link to calls by `tool_call_id`. Spec: `trajectory-v1.schema.json`.
2. **Deliberate lossiness**: drops harness bookkeeping (per-line envelopes,
   duplicated payloads, UI event streams, encrypted reasoning blobs), optionally
   truncates long tool results. Measured ~5.6× token reduction vs native Claude
   Code format, ~5.4× vs Codex (Anthropic count-tokens API on real sessions).
3. **Explicit contrast with Harbor ATIF**: ATIF is for *full-fidelity replay and
   benchmarking* (per-step token metrics, structured payloads, untruncated
   outputs); trajectory is for *agent consumption*. Two formats, two consumers.
4. **API**: `listTrajectories({source, limit, cursor})` discovers sessions on
   disk; `normalizeTranscript({source, transcript})` → `{records, diagnostics}`.
5. **Consumption patterns**: Letta Code bootstraps memory from OTHER harnesses'
   sessions; agents search past trajectories cross-harness; a background
   "dreaming" process periodically consolidates recent sessions into persistent
   memory.

## 3. Deterministic or agentic?
The package itself is fully deterministic (parse + reshape + truncate). The
*consumers* (memory formation, dreaming) are agentic — that split is the point.
License: Apache-2.0 (GitHub) — no borrow constraints.

## 3b. Role in its native architecture — and does it transfer?
Native role: the **read path** of a continual-learning loop — the normalization
layer between heterogeneous session stores and an agent's memory process. It
transfers cleanly: we already own a richer capture layer; what we lack is exactly
this consumption-side view. In our stack it is a *projection* over data we
already store, not a new store.

## 4. Substrate vs. surface
Substrate: per-harness transcript parsers + the normalized schema. Surface:
`listTrajectories`/`normalizeTranscript` + Letta Code's `/init`. The substrate is
borrowable as a *format target* without importing anything.

## 5. Lane (1–6)
Lane 3 (substrate: an export format + projection over our logs) with a lane-4
tail (the dreaming/memory-bootstrap consumption pattern).

## 6. Dependency & displacement
- **Deps:** none needed — we would *emit* trajectory-v1 JSON from our own data
  (`interlinked query` already reads it all); no import of `@letta-ai/trajectory`.
- **Displacement:** overlaps our T1 trace assembler (`src/harness/replay/trace-assembler.ts`)
  only in shape, not purpose: replay-trace.v1 is our ATIF-analog (full fidelity,
  envelopes + tree/state refs); trajectory-v1 is the token-cheap agent-facing view
  we do NOT yet have. `interlinked logs`/`query` render for humans, not agents.
- **Equivalence:** capture (shipped, richer than any harness-native format — we
  have cross-runner collection.jsonl + guard verdicts + seq); full-fidelity
  normalize (shipped: replay-trace.v1); token-efficient agent view (**absent**);
  cross-harness discovery (shipped: we already ingest 5 runners' hooks — stronger
  than file-format parsing); dreaming/consolidation (**absent**; maps to a future
  Stop/SessionEnd or cron surface, cloud lane if LLM-driven).

## 7. Smallest spike
`interlinked trajectory export --session <id> [--format trajectory-v1]`: a
~150-line projection from collection.jsonl/timeline.jsonl records into
trajectory-v1 JSON (meta row from session state; tool_use/tool_result pairs by
tool_use_id; thinking → reasoning records where captured). Validate against
their published JSON schema in a test. ≤1 day.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | trajectory-v1 exporter over local logs (§7); makes our capture interoperable with the emerging ecosystem consumer-side | §7 | now |
| Agent CI (P4–5) | dreaming-style consolidation: async review of recent trajectories → distilled rules / skill suggestions (LLM work → cloud) | prompt an agent over exported trajectory-v1 files from 3 sessions; see if output maps onto `/enforce` artifacts | parked |

## 9. Artifact
PR (the exporter spike) + memory note for the consumption patterns. Compound
carve-out: adopt the *format as an export target*; reject importing the package
(dep stance) and reject replacing replay-trace.v1 with it (different consumer —
the ATIF-vs-trajectory distinction is the article's own argument for keeping both).

## Notes
- Their token-count table is the quantified version of our own experience: native
  Claude Code transcripts are ~5× bookkeeping. Our collection.jsonl is already
  leaner, but still not agent-optimal.
- The meta-record fields (source/cwd/git_branch/model) are all things we already
  stamp per session — export is a projection, zero new capture needed.
- Related: `docs/external-pulse/deintroverter.md` (external intake pattern),
  replay program `docs/design/reproducibility/README.md` (our ATIF-analog side).
