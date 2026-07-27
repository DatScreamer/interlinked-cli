# From Agent Traces to Agent Simulations (Rustem Feyzkhanov, Snorkel AI)

- **Source:** https://www.youtube.com/watch?v=Ib5t2RLtxvM (AI Engineer conf, 20:23; uploaded 2026-07-25)
- **Encountered:** 2026-07-25, user-supplied; transcribed with whisper large-v3, corrected against YouTube auto-captions — sibling `snorkel-agent-simulations-transcript.md`
- **Verdict:** RFC-shaping input for the replay program (`docs/design/reproducibility/`) + this intake

## 1. Core idea (one sentence, your words)
Production traces alone can find failures but can't compare configurations;
converting traces into *repeatable offline simulation tasks* (environment +
instruction + oracle solution + verifiers) turns evaluation into a benchmark
that doubles as a release gate and a training-data generator, continuously
repopulated from production.

## 2. Anatomy (concrete walkthrough)
Load-bearing claims (Snorkel runs "millions of agent simulations per month"
selling benchmarks-as-a-service, so this is practiced, not speculative):

1. **Traces vs simulations**: a trace (prompt → actions → output) supports
   post-hoc failure analysis only; A/B in production is never apples-to-apples
   (database state, tool versions drift). Simulation = trace-derived task
   re-runnable offline with different agent configs against the *same*
   environment and verifiers.
2. **Task anatomy (Harbor format)**: what the agent sees (`instruction.md` +
   environment: Dockerfile/Compose), what it doesn't (oracle solution +
   verifiers), and metadata. **Oracle solution proves the task is solvable
   before it's admitted** — an unsolvable task measures nothing.
3. **Environment = mini-production**: DB snapshot not live DB; sidecar
   containers for APIs/MCP tools; mocked services; *simulated users* (an LLM
   with its own prompt mimicking human behavior); multi-step checkpoints with
   per-step prompts + verifiers so long-horizon tasks can fail fast.
4. **Verifier taxonomy**: deterministic checks (final output, tool calls) →
   LLM-as-judge / harness-as-judge (trace quality, planning) → subject-matter
   expert review, reserved for *disagreement between agent and verifiers*.
5. **Benchmark is software**: it needs its own CI — pinned dependencies, no
   missing fixtures, oracle-passes check, verifier-fails-without-oracle check,
   N agent runs to grade difficulty (simple/medium/hard) and stability, then
   explicit approval into the suite. Failure modes named: reward-hacking the
   sim, too-broad verifiers (always pass), broken verifiers (always fail),
   high run-to-run variance.
6. **Full-stack evaluation**: compare not just models but thinking level,
   prompts, harness, skills, tools — while environment + verifiers stay fixed;
   metrics beyond pass rate: cost, latency, retries. Fixes then land in the
   *correct layer* (harness for context overload, skill for missing procedure,
   structured output for schema) instead of the everything-in-the-prompt
   anti-pattern.
7. **Two connected loops**: observability → record failures → expand benchmark;
   simulation runner → experiment records → release gate → production.
   Train/validation split (~80/20) with a held-out set the agent never saw
   during iteration; coverage = bread-and-butter cases + edge cases (tool
   failures, DB problems), like integration tests' happy path + edge paths.

## 3. Deterministic or agentic?
Hybrid, cleanly split: environment + oracle + deterministic verifiers +
benchmark CI are deterministic; simulated users, LLM/harness-as-judge
verifiers, and trace-to-task construction are agentic. N/A license (talk).

## 3b. Role in its native architecture — and does it transfer?
Native role: the *product* (benchmarks as a service). For us it is the
**consumption architecture** our replay capture feeds: our G1–G5 capture +
T2 restore already produce exactly the raw material ("trace + environment
snapshot") their pipeline starts from (G5 toolchain pinning included, via
`toolchain-manifest.ts`). What transfers is the task lifecycle
around it — oracle-gated admission, benchmark CI, failure-driven expansion.

## 4. Substrate vs. surface
N/A (talk), but the referenced Harbor task format is a concrete substrate:
instruction/environment/oracle/verifier file layout — a natural target shape
for `interlinked replay export --as-task`.

## 5. Lane (1–6)
Lane 4 (pattern/architecture) shaping the replay program; a lane-2 sliver
(benchmark-CI checks are deterministic and harness-shaped).

## 6. Dependency & displacement
- **Deps:** none — patterns only.
- **Displacement:** our replay program IS the trace half of their pipeline;
  their per-tool-call comparison ("was the tool call correct") is our T1
  action-match scorer. Their environment snapshotting maps to G2 tree
  snapshots + state archive; their multi-step checkpoints map to our per-seq
  fork points (`replay restore --seq`).
- **Equivalence:** trace capture (**shipped**, stronger — seq-ordered,
  guard-verdict-annotated); env snapshot (**shipped** for repo tree + harness
  state; **absent** for external services/DB — we have no sidecar story);
  oracle solutions (**absent** — but a recorded reference-model session IS an
  oracle: it proves solvability by construction, our key advantage); verifier
  taxonomy (deterministic tier **shipped** as the check registry; judge tier =
  designed Tier 2/3 cloud lanes); benchmark CI (**absent**); simulated users
  (**absent**, cloud-only if ever); train/val split + difficulty tagging
  (**absent**, trivial once tasks exist).

## 7. Smallest spike
`interlinked replay export-task --session <id> --seq <n> --horizon <m>`: emit a
Harbor-shaped task directory from a captured session — `instruction.md` from
the user message(s) in the window, environment = G2 tree + state restore
script, oracle = the recorded reference actions (seq n..n+m), verifier =
deterministic action-match + post-tree-hash comparison against the recording.
≤1 day on top of the existing `replay restore` + trace assembler.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | task export (§7); benchmark-CI-style deterministic checks on exported tasks (pinned deps, fixture presence, oracle-replay passes) | §7 | now |
| Agent CI (P4–5) | simulation runner at scale: N candidate runs per task in Cloudflare Sandboxes, difficulty tagging, judge-tier verifiers, failure-driven task admission from prod traces | run one exported task in a Sandbox | next |

## 9. Artifact
This intake + fold the task lifecycle (oracle-gated admission, benchmark CI,
failure→task expansion loop) into `docs/design/reproducibility/` as the
consumption layer for T2. Compound: adopt oracle-as-recorded-session and task
export now; park simulated users and judge-tier verifiers to the cloud lanes
(determinism filter).

## Notes
- "You don't care about the model, you care about the full system" — argues for
  our capture to keep pinning harness config alongside model id (we already
  record toolchain manifest + rules hash; add skills/agent-config surface).
- "Benchmark development is an art… benchmark is software; treat it as such"
  — the benchmark-CI checklist is regex/AST-shaped and could become harness
  checks if we start committing task dirs.
- Reward-hacking the sim ≈ our baseline-integrity gate class: the agent editing
  the water-lines is the same failure as the agent gaming a too-broad verifier.
- Their trace→task loop assumes traces lack environment state (so tasks must be
  *reconstructed*); our G2 capture removes that reconstruction step entirely —
  we snapshot at capture time. That is the program's sharpest differentiator.
