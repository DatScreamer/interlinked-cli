# The agentic eval layer — ZPD evals for harness-guarded codebases

Status: DESIGN (2026-07-06). Layer 3 of the eval story. Companion to the
shipped compat suite (`evals/`, layer 2) and the vitest base (layer 1).
Origin: operator direction — evals for qualities that *can never* be defined
deterministically, proving the harness widens the **zone of proximal
development** for cheap/fast agents (Haiku on Claude Code, mini models on
Codex): tasks a weak agent fails unaided but completes with the harness as
the "more knowledgeable other."

Boundary (standing policy, restated): agentic judging lives ONLY in this
offline eval layer — never in the hook path. The check pipeline stays
deterministic (`feedback_harness_deterministic_only`); this layer is
Tier-3-shaped (periodic, cloud-friendly, warn-only).

## 1. Why these qualities cannot be vitest

A deterministic test asserts a point. These qualities are judgments over
distributions and contexts:

| Class | Meaning | Example |
|---|---|---|
| Relational | quality relative to intent/audience | is this error message helpful *to a novice*? |
| Counterfactual | what would a cold reader/user do? | would someone misread this API? |
| Distributional | visible only across many trials | does guidance work for 8/10 phrasings? |
| Emergent | holistic, not decomposable | UX coherence; API ergonomics |
| Trajectory-shaped | about the *path*, not the endpoint | did the block teach, or did the agent thrash? |

## 2. Eval dimensions per artifact class (any guarded repo)

- **Web apps** (browser agent via playwright / chrome-devtools MCP):
  cold-user task completion from the rendered UI only (no source);
  error-state empathy (kill the API mid-flow; judge whether the UI's
  recovery guidance works when followed literally); a11y-in-practice
  (agent restricted to the accessibility tree must still complete tasks —
  axe is deterministic, task-completion-through-the-tree is not); visual
  coherence judged by a vision model (the agentic sibling of the
  deterministic `design_slop` check).
- **CLI tools**: cold-agent discoverability (`--help` output only, no
  README, real tasks); error-message actionability (misuse deliberately,
  then have a cheap agent follow the error's suggested fix *verbatim*);
  man-page test (write accurate docs from behavior alone; diff vs real docs
  = drift found by use, not by grep).
- **MCP servers**: tool-description sufficiency (cold agent with only the
  manifest composes multi-tool workflows — every failure is a description
  defect no schema validator sees); semantic schema honesty (does the
  return match the promise, judged); recovery affordance (self-correct
  from tool error text alone).
- **Libraries**: cold-reader comprehension (public surface only — types +
  JSDoc — predict behavior, write correct usage); misuse-resistance (ask
  an agent to misuse it plausibly; does the design make misuse hard?).

## 3. The ZPD mechanism

Matrix: {cheap agent} × {task} × {scaffold: none / warnings-only / full
harness}. Definitions:

- **Zone map** (the product chart): per model tier, the set of tasks where
  the unaided arm fails and the harness arm passes. Zone width = harness
  value for that tier.
- **Frontier auto-calibration**: tasks both arms pass (too easy) or both
  fail (too hard) carry no signal. The corpus must re-center on the
  difficulty edge as models improve — task difficulty becomes a managed
  property, not a fixed corpus.
- **Within-session learning curve**: over a session, does
  block→retry→success get *faster* and do warnings change subsequent
  choices? Guidance that teaches beats guidance that gates. Measured from
  `activity.jsonl` timing + ordering (deterministic extraction, agentic
  interpretation).
- **Cross-tier judging**: a strong model rubric-scores the weak model's
  artifact — always PAIRWISE between arms (never absolute scores), with
  multiple judge lenses (correctness, maintainability, cold-reader), each
  adversarially verified (the existing workflow verify pattern). Judges are
  grounded in artifacts: screenshots, a11y trees, terminal transcripts,
  trajectories.

## 4. Closing the loops with shipped machinery

- **Check-health**: judge-labeled dead-end blocks per rule_id across eval
  runs feed `interlinked harness health` as probation evidence — the eval
  layer becomes the calibration instrument for the demote loop.
- **Capability ratchet**: `evals-baseline.json` records the harness-arm
  pass-rate high-water per (tier, task-class). Direction: may only rise —
  the monotonic-ratchet philosophy applied to *behavioral capability*; the
  baseline-integrity gate covers the file like every other water-line.
- **Compat suite**: layer 2's FAIL/WARN verdicts are the precondition;
  layer 3 runs only on harness builds that pass layer 2.

## 5. Outside-the-box instruments (keep)

- **Persona fuzzing**: same task under rushed / meticulous / non-native
  phrasings — robustness of guidance across interaction styles.
- **Misunderstanding harvest**: N cheap agents on a deliberately ambiguous
  task; cluster the misreadings; each cluster is a docs/API defect that no
  test, linter, or single review could find.
- **Chaos arms**: daemon killed mid-session; verify fail-open/closed
  *behavior* end-to-end (the e2e-cold-fallback probe's behavioral sibling).
- **Zone-map regression**: a harness change that shrinks any tier's zone
  is a regression even if every deterministic test passes — the headline
  metric this layer exists to defend.

## 6. Build order (post-2026-07-06)

1. Layer-2 hardening: run the compat suite for real (Haiku), fix what it
   surfaces; add `--arms` scaffold-gradation (warnings-only arm).
2. Judge harness v0: pairwise rubric judging over compat-suite artifacts
   (transcripts + products), Opus/Fable judges, adversarial verify stage —
   reuse the Workflow verify pattern verbatim.
3. Zone map v0 for the CLI-tool class (this repo is the first subject:
   cold-agent discoverability of `interlinked` itself).
4. MCP-server class next (highest external value: the operator's other
   repos); browser-based web-app class last (needs the browser-tool
   plumbing budgeted, not bolted on).
5. `evals-baseline.json` ratchet + baseline-integrity coverage once zone
   measurements stabilize (two consecutive stable sweeps).
