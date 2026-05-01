# Cursor harness — Continually improving our agent harness

- **Source:** Cursor company blog post by Stefan Heule & Jediah Katz, dated 2026-04-30, ~11 min read. URL not captured; full text pasted into chat 2026-04-30 by user.
- **Encountered:** 2026-04-30, blog dropped same day; user pasted full text + INTAKE pointer.
- **Verdict:** lane 4 (pattern, primary) + lane 5 (LLM-judge satisfaction signal + log-walking automation belong on guardrails-cloud / agency-cloud) + thin lane 3 (deterministic tool-error taxonomy + Keep Rate as local activity-feed substrate). Prose source — no license gate, no code to borrow.

## 1. Core idea (one sentence, your words)

Cursor's harness team treats *the harness itself* — the deterministic wrapper around a model — as the product: as model capability rises they ratchet down static guardrails (lint feedback after every edit, read rewrites, tool-call caps), customize tool format and prompts per model, instrument *online* with deterministic metrics (Keep Rate, per-tool/per-model error baselines, latency/tokens) plus an LLM-judged user-satisfaction signal, and run a weekly Cloud-Agent Automation that walks logs to keep harness regressions out of production.

## 2. Anatomy (load-bearing claims, your words)

Prose source, so anatomy = the load-bearing claims worth carrying forward.

1. **Static guardrails decay as models improve.** Cursor's late-2024 harness shipped substantial scaffolding: lint/type errors injected into context after every agent edit, agent reads rewritten when too few lines were requested, hard caps on tool calls per turn, large static-context dumps (folder layouts, semantically-matched snippets, compressed attached files). *"That is mostly long gone."* Static context now is minimal (OS, git status, current and recently viewed files); guardrails replaced with dynamic context the agent fetches when it needs it. **This is a deliberate disagreement with `feedback_taste_enforcement.md`.** See §5 lane 4.
2. **Two-layer harness measurement: offline benchmarks + online A/B.** Offline: public benchmarks plus Cursor's internal `CursorBench` eval suite (referenced as their own; not published). Online: A/B harness variants on real production traffic, measured via:
   - Deterministic: latency, token efficiency, tool call count, cache hit rate, error rates per tool.
   - **Keep Rate** — *"For a given set of code changes that the agent proposed, we track what fraction of those remain in the user's codebase after fixed intervals of time."* Pure byte-survival check on git history; deterministic.
   - **LLM-judged satisfaction** — *"a language model to read the user's responses to the agent's initial output in order to capture semantically whether the user was satisfied or not. A user moving on to the next feature is a strong signal the agent did its job, while a user pasting a stack trace is a reliable signal that it didn't."* LLM-as-judge.
   Concrete win cited: a more expensive context-summarization model showed negligible online-quality improvement and was shelved — the online experiment vetoed an offline-plausible change.
3. **Tool-call errors as the leading harness-regression signal.** Errors stay in context, waste tokens, cause *"context rot."* Five expected-error classes — `InvalidArguments` (model mistake), `UnexpectedEnvironment` (context contradictions), `ProviderError` (vendor outage; they cite GenerateImage and WebSearch), `UserAborted`, `Timeout` — plus an `unknown` residual class which is *always* treated as a bug. Two alert types: (a) fixed-threshold alert when the unknown rate for any tool exceeds a bound; (b) anomaly-detection alert per-tool/per-model when expected errors significantly exceed baseline (different models mess up tool calls at different rates, so baselines are computed per-model). One focused sprint *"drove unexpected tool call errors down by an order of magnitude"* and *"all tool calls to at least 2 or often 3 9s of reliability."*
4. **Per-model harness customization is deep and concrete.** OpenAI models trained on patch-format edits → provision patch tool. Anthropic models trained on string-replace edits → provision string-replace tool. *"Either model could use either tool, but giving it the unfamiliar one costs extra reasoning tokens and produces more mistakes."* Custom prompting per provider and per model version: *"OpenAI's models tend to be more literal and precise in their instruction following, whereas Claude is a bit more intuitive and more tolerant to imprecise instructions."* New-model workflow: start from nearest existing harness, run offline evals + team usage, iterate. They name a real model quirk they fixed via prompt: **"context anxiety"** — model refusing work as context fills up.
5. **Mid-chat model switching is hostile by default — three mitigations.** Switching means the new model sees a history out of distribution from its own training, plus a guaranteed cache miss (caches are provider/model-specific). Their fixes: (a) custom *"you're taking over from another model"* instructions, (b) steer the new model away from tools that appear in conversation history but aren't in its current toolset, (c) summarize the conversation at switch time to mitigate cache penalty (which is itself an LLM call, and can lose details on complex tasks). Their explicit recommendation is to not switch unless there's a reason; the alternative is to start a subagent with a fresh context and let the user pick the subagent model directly.
6. **Weekly Cloud-Agent Automation walks logs and creates Linear tickets.** *"a weekly Automation equipped with a skill that teaches the model how to search through our logs, surface issues that are new or recently spiked, and create or update tickets in a backlog with an investigation. We lean heavily on Cloud Agents to kick off fixes for many issues at once, and can even trigger them directly from Linear."* The harness has a maintenance harness, and that meta-layer is agentic ("software factory").
7. **Multi-agent is the future, and orchestration lives in the harness, not in any single agent.** Planner / fast-edit / debug subagents, each scoped to its strength. The orchestration logic — which agent to dispatch, how to frame the task, how to stitch results — is harness-side. Already aligned with `project_vision_multiagent.md` and `project_supervisor_pattern.md`; logged not actioned.

## 3. Deterministic or agentic?

Mixed by design. Decomposing the post's harness:

- **Deterministic:** static-context provisioning, dynamic-context tool surfaces, per-model tool-format selection, per-model prompt selection, mid-chat custom instructions, the Keep Rate metric, anomaly-detection baselines for tool errors, the five-class error classification.
- **Agentic / LLM-as-judge:** user-satisfaction signal (LLM reads conversation), conversation-summary at model-switch (LLM call), the weekly Automation that reads logs and opens tickets.

License: not applicable (prose). The Cursor harness substrate is not open-source.

## 4. Substrate vs. surface

Skipped — prose source, no shipped substrate. Reusable bits are *patterns* and one or two metrics with clear deterministic implementations (Keep Rate, error taxonomy).

## 5. Lane

**Lane 4 (pattern) primary; lane 5 (the agentic pieces); thin lane 3 (deterministic substrate adds).**

- **Lane 4 — patterns:**
  1. **Online A/B is the only honest way to settle "is this harness change actually better."** Offline benchmarks miss the long tail. **But:** the CLI is single-tenant and local — there is no online A/B surface. This is precedent for guardrails-cloud / agency-cloud rule-tier ratchets (where rule changes can be A/B'd across customers), not for interlinked-cli today. Practical implication: rule changes here ship without Cursor's safety net, which argues for *more* conservative defaults, not less. Worth a one-line citation in the next harness-rule-design doc.
  2. **Disagreement on static guardrails worth recording.** Cursor's claim 1 ("knock down static guardrails as models improve") is the *opposite* of `feedback_taste_enforcement.md` ("harness checks are taste levers, opinionated quality patterns"). This is not a contradiction with something to resolve — it's a different design objective. Cursor optimizes for *let the model decide more*; interlinked optimizes for *enforce taste/safety the model won't supply*. Recording the disagreement explicitly is the point: it prevents drift toward Cursor's default during future agent-driven design work, which would otherwise pull this project in the wrong direction by gravity. Do not "modernize" the harness toward Cursor's default without an explicit reconsideration of `feedback_taste_enforcement.md`.
  3. **Tool-error taxonomy as harness-regression detector.** Cursor's five-class taxonomy is portable and substrate-shaped (see lane 3). Classifying *deterministically* at hook-write time gives `interlinked activity` and `interlinked status` a per-session breakdown without LLM inference.
  4. **Per-agent baselines for "expected" error rates.** Different models mess up tool calls at different rates — applies analogously to per-*agent-source* (claude / copilot / codex / gemini) baselines for the activity feed. Reinforces the multi-tenant-aware direction in `project_vision_multiagent.md`.
  5. **"Context anxiety" as a recordable model behavior.** Corroborates the harness↔model boundary is bidirectional — prompt content shapes model behavior at the margin. Not actionable on its own; useful framing for future hook-injected-instruction work.
  6. **"Harness" as terminology converges.** Cursor uses "harness" in our exact sense (the deterministic wrapper around a model). Naming is now public-facing and shared — small, but stops being our internal jargon.

- **Lane 5 — agentic pieces (cloud-roadmap fodder):**
  1. **LLM-judged user-satisfaction signal** — pure LLM-as-judge, auto-routes out of the CLI per `feedback_harness_deterministic_only.md`. Possible feature for guardrails-cloud (cross-org satisfaction telemetry on agent edits) or agency-cloud (per-agent quality scoring). The CLI/server split already gives the server the surface it would need: every activity event already syncs to the server in non-`local` sync modes.
  2. **Weekly log-walking Automation that opens tickets** — same shape as `project_supervisor_pattern.md`'s Workspace DO scale (detection → decision → action), applied to harness-quality maintenance rather than agent-runtime gating. Same primitive, different application.
  3. **Mid-chat conversation summary at switch** — uses an LLM call. Not directly relevant to interlinked-cli (the CLI doesn't manage conversation state); relevant to agency-cloud if it ever orchestrates multi-model sessions.

- **Lane 3 — substrate adds:**
  - **Tool-call error classifier.** New `src/lib/error-classifier.ts` mapping each `ActivityEvent` with a tool result to one of `InvalidArguments` / `UnexpectedEnvironment` / `ProviderError` / `UserAborted` / `Timeout` / `Unknown`. Pattern matching on existing JSONL payload (error message, exit code, signal). Plumbed through `interlinked activity` / `interlinked status` as a per-session breakdown. Half a day.
  - **Local Keep Rate command.** New `interlinked keep-rate [--session <id>] [--since <duration>]` walking the activity log for Edit/Write events and checking git for byte-survival of the edited regions. Per-session and per-agent-source ratios. ~1 day. Genuinely useful: deterministic "is this agent producing edits that stick" metric without server scale.

## 6. Smallest spike

**Tool-error classifier — half a day.**

1. Add `src/lib/error-classifier.ts`:
   - `classifyToolError(event: ActivityEvent): ErrorClass` returning the five-class union plus `Unknown`.
   - Pattern matching on:
     - `Timeout` — explicit timeout fields, hook-script timeout signals.
     - `UserAborted` — `SIGINT`, cancellation signals, abort markers.
     - `ProviderError` — provider-specific 5xx / rate-limit / outage strings (per tool / per agent source).
     - `UnexpectedEnvironment` — file-not-found, permission-denied, wrong-cwd, missing-binary patterns.
     - `InvalidArguments` — schema-validation failures, malformed-JSON args.
     - `Unknown` — fallthrough; treated as bug per Cursor's framing.
2. Tests in `src/lib/__tests__/error-classifier.test.ts` against representative real fixtures from existing `activity.jsonl` files (mocked).
3. Surface as a one-line per-session breakdown in `interlinked activity` / `interlinked status` (e.g., `errors: 3 (1 InvalidArguments, 2 ProviderError)`).
4. No server change. License-clean. No new dependency.

If this lands cleanly, the Keep Rate command is the obvious follow-up (~1 day): walk activity log → identify Edit/Write events → for each, check git for survival of the edited byte ranges → emit per-session/per-agent ratio.

## 7. Artifact

Memory note (this file) + half-day Spike (error classifier) when prioritized + Keep Rate follow-up after that. The lane-5 pieces (LLM-judge satisfaction telemetry, log-walking automation) are cloud-roadmap entries — file in the sibling server repo's `docs/design/` per `reference_sibling_server_repo.md` if/when guardrails-cloud picks up satisfaction-telemetry features. The static-guardrail disagreement (claim 1 vs `feedback_taste_enforcement.md`) is worth surfacing in the next major harness-scope design doc; not its own RFC.

## 8. Surface

- **interlinked-cli** — error-classifier spike, Keep Rate follow-up.
- **guardrails-cloud** — LLM-judged satisfaction signal applied to opt-in customer activity telemetry; weekly log-walking Automation as a managed feature.
- **agency-cloud** — Keep Rate + satisfaction-signal composite metric for per-agent quality scoring.

## Notes

- **Quote worth pinning** (drift-resistance for "harness checks are taste levers"): *"the harness gets more complex with more potential states, just like any piece of software. With this comes more surface area for bugs to crop up, many of which we can only detect at scale."* — interlinked has no scale to detect at; this is the explicit cost of local-first design and an argument for higher-confidence rules in the default set rather than aggressive ratchets that need A/B observation to be safe.
- **Quote worth pinning** (Keep Rate framing): *"For a given set of code changes that the agent proposed, we track what fraction of those remain in the user's codebase after fixed intervals of time."* — operational definition; implementable from git + activity log alone.
- **Quote worth pinning** (LLM-judge framing): *"A user moving on to the next feature is a strong signal the agent did its job, while a user pasting a stack trace is a reliable signal that it didn't."* — concrete shaping signals for any future satisfaction classifier in guardrails-cloud.
- **Static guardrail removal — disagreement worth recording.** Cursor's claim 1 is the opposite of `feedback_taste_enforcement.md`. Different optimization targets, not contradictions. The risk is gravitational: future agent-driven design work that reads Cursor's post and silently pulls interlinked toward their default. The disagreement note in §5 lane 4.2 exists to prevent that.
- **Pattern-cluster bookkeeping.** Cursor adds two same-shape-different-domain affirmations of detect-decide-with-LLM-judge: (a) satisfaction signal applied to *quality measurement* (vs Sondera/Goose's *gating decisions*), (b) weekly Automation applied to *harness self-monitoring* (vs runtime agent supervision). The cluster is now broader (more application domains) and unchanged in primary direction. The goose.md "third-affirmation → RFC" trigger remains the load-bearing event; this entry doesn't add a new threshold-crossing.
- **`CursorBench` is mentioned but not published.** Reference for the day interlinked or its sibling server want a comparable internal eval suite — but not borrowable.
- **Naming convergence:** Cursor uses "harness" in our exact sense. Public-facing now, no longer internal jargon.
- **Multi-agent claim aligns with `project_vision_multiagent.md`** — orchestration in the harness, not in any single agent. Logged not actioned; doesn't shift the existing memory.

## Methodology notes

- **Prose-source rubric still working** — sections 3 and 4 collapse to "skipped / N/A — patterns only," consistent with railway-agent-incident.md. The rubric is amortizing: ~30 minutes from "open template" to "lane assigned" once the post had been read once carefully.
- **Disagreement-as-output is a valid rubric result.** Most external-pulse entries record convergence (pattern affirmation across N projects); this one records a *deliberate* disagreement (Cursor's "knock down static guardrails" thesis is opposite to ours). Possible INTAKE.md edit: *"If the source's central thesis disagrees with a load-bearing memory, record the disagreement explicitly in §5/§Notes — it prevents drift toward the source's default during future agent-driven design work."*
- **"Read the source, not the README" doesn't apply** (no source). Equivalent here: *read the post's specific claims, not its title or section headers.* The headline ("continually improving the harness") underplays the load-bearing parts (the explicit list of what Cursor *removed* + the LLM-judge satisfaction signal, neither of which surface from the title or section headers). Discipline carries: extract specific claims from prose, don't paraphrase the framing.
- **URL not captured.** User pasted the full text without a URL. The post is identifiable from author bylines + date + opening sentences if it ever needs to be re-fetched. If this becomes load-bearing for an RFC, refetch with the original URL and re-quote against the canonical text.
