# Active Graph

- **Source:** https://github.com/yoheinakajima/activegraph (cloned to `reference-repos/activegraph`, Apache-2.0, v1.0.5.post2, last commit 2026-05-19, ~20K LoC Python in `activegraph/`, 70 test files)
- **Encountered:** 2026-05-20, user-provided pointer for adoption evaluation, with a note that it may matter "including but not limited to what we've done with Supermodel Tools so far"
- **Verdict:** RFC (Tier 3 / Agent CI substrate candidate) + memory note (convergent evidence on the reservation `Patch`/`expected_version` model and on the graph-as-runtime pattern). Not a PR today; not a skip.

## 1. Core idea (one sentence, your words)

A Python event-sourced reactive-graph **runtime** for agentic systems: the graph IS the agent's world state, behaviors (function / class / LLM-backed / attached to typed edges) react to events on it, every mutation is an append-only event, and any run can be **forked at any historical event** and structurally **diffed** against its parent — with a content-hashed LLM replay cache so a fork only pays for the diverged tail of model calls.

The framework's tagline — "the graph is the world; behaviors are physics; the trace is the proof" — captures the shape. It is a *substrate for building* agentic systems, not a tool that analyzes a codebase. That distinction is the single most important framing for placement (see §4 and the Supermodel connection in Notes).

## 2. Anatomy (concrete walkthrough)

Annotated directory map (`reference-repos/activegraph/`):

```
activegraph/                    ~20K LoC Python, 3.11+
  core/                         graph + event log + patch + view + clock + ids
    graph.py            (893)   Object/Relation handles + Graph (event-sourced projection)
    event.py / patch.py / view.py / ids.py / clock.py
  behaviors/
    base.py             (164)   Behavior / RelationBehavior / LLMBehavior dataclasses
    decorators.py       (369)   @behavior, @relation_behavior, @llm_behavior + registry
  runtime/                      the loop, the queue, fork, diff, scheduler, patterns
    runtime.py         (2592)   Runtime: subscribe → enqueue → match → invoke → emit
    diff.py             (145)   compute_diff(parent, fork) → Diff(shared/parent-only/fork-only)
    scheduler.py        (206)   activate_after=N event-count scheduler (NO wall-clock)
    patterns.py         (946)   Cypher subset matcher for pattern= subscriptions
    queue.py / behavior_graph.py / registry.py / budget.py / _live.py
  llm/
    cache.py            (180)   LLMCache keyed by prompt_hash (content), not event id
    provider.py / anthropic.py / openai.py / recorded.py / prompt.py / parsing.py
  tools/                        @tool decorator + ToolContext + cache + recorded
  store/                        memory.py / sqlite.py / postgres.py / serde.py / conformance
  observability/                logging, metrics, prometheus, migration
  packs/                        pack format + Diligence reference pack (8 obj types, 7 behaviors)
  trace/                        printer + causal walker
  cli/                          quickstart, inspect, status (Click)
  policy.py / frame.py / errors.py / __init__.py (public API surface)
docs/                            mkdocs site (docs.activegraph.ai), per-error reference pages
examples/                        babyagi.py, diligence_real_run.py, resume_and_fork.py, …
tests/                           70 test files, all-deterministic discipline (no live network)
CONTRACT.md                      305 KB locked design decisions, version by version
v1.1-plan.md                     33 KB roadmap
```

Five load-bearing pieces, in my words (citations verified by reading source):

1. **`core/graph.py` — event-sourced projector (CONTRACT v0.5 #15).** The graph holds `_objects`, `_relations`, `_patches`, `_events`. The *only* mutator is the module-level `apply_event(graph, event)` function, called from exactly two paths: `Graph.emit` (live) and `Graph._replay_event` (silent — no persist, no listener notify). Two callers, one code path. `add_object` / `add_relation` / `patch_object` / `propose_patch` are all sugar that builds an `Event` and emits it. Provenance is written by the projector, never by the behavior (`_strip_provenance` deletes any `provenance` key a behavior tries to set). Every object has a monotonic `version`; patches carry `expected_version` (optimistic concurrency).

2. **`runtime/runtime.py:Runtime` — the single-threaded FIFO loop (CONTRACT #10, 2592 lines, top-of-file docstring is the spec).** Responsibilities: subscribe to graph events, enqueue them, pop and find matching behaviors, invoke each in registration order, wrap with `behavior.started`/`completed`, catch exceptions and emit `behavior.failed` (CONTRACT #13). v0.5 added `persist_to=`, `Runtime.load(path)`, `runtime.fork(at_event)`, `runtime.diff(other)`, `replay_strict=True`. v0.6 added LLM behaviors with the runtime-owned lifecycle (assemble → cache lookup → cost pre-check → `llm.requested` → call → `llm.responded` → parse → handler). v0.7 added pattern subscriptions (Cypher subset), `activate_after=N`, and a tool-turn loop.

3. **`runtime/diff.py` (145 lines) — structural diff between two runs.** Walks both event logs to find the **shared prefix** (events that match by `id` + `type` + `payload`); the tail of each is the parent-only / fork-only set. Then walks both graphs' final state for divergent objects and relations. Lifecycle events (`behavior.*`, `relation_behavior.*`, `runtime.*`) are explicitly ignored in the partition — scaffolding, not history. Semantic comparison is out of scope; "do these claims express the same idea?" is a behavior's job, not the runtime's. The whole file is 145 lines and is the architectural payoff: forking is cheap, and you can show the user a precise structural delta.

4. **`llm/cache.py:LLMCache` (180 lines) — content-keyed replay cache (CONTRACT v0.6 #8).** Keyed by **prompt hash**, not event id. That's the whole trick: a fork's regenerated prompts hit the parent's recorded responses because the hash collides — no new API calls on the shared prefix. `LLMCache.from_events(events)` walks the recorded log and harvests every `llm.responded` whose preceding `llm.requested` carries a `prompt_hash`. `replay_strict=True` adds a divergence check — if the live re-assembled prompt has a different hash than the recorded one, raise `ReplayDivergenceError(event_id=…, expected=…, actual=…)`. Pin-the-offending-event-id is the same shape as their event-stream divergence error.

5. **`behaviors/decorators.py` (369 lines) — the developer surface.** `@behavior(name, on=[...], where={...}, pattern="...", activate_after=N)` constructs a `Behavior` and appends to the global `_REGISTRY`. `@llm_behavior(... output_schema=PydanticModel, tools=[...])` adds the structured-output and tool-turn machinery; the wrapped handler signature is `(event, graph, ctx, llm_output) -> None` — the runtime parses the LLM's response into `llm_output` before invoking the user's handler. `@relation_behavior(relation_type=..., on=...)` fires once per matching *edge* — coordination logic on the edge rather than on either endpoint, which is the framework's most differentiated primitive (the README's `unblock` example: when one side of a `depends_on` emits `task.completed`, transition the other side from `blocked` to `open`).

End-to-end session (`examples/babyagi.py`, which rebuilds Yohei Nakajima's BabyAGI as **three reactive behaviors** over a shared graph):

```
goal.created
  → @behavior initializer fires
      → graph.add_object("task", {title: "Plan the first step toward: <goal>", status: "pending"})
        → object.created (type=task)
  → @llm_behavior executor fires on object.created where object.type=task
      → runtime assembles prompt, calls provider, parses TaskResult
      → handler: patches status=completed, adds result object + "produced" relation
      → graph.emit("task.executed", {task_id, result})
  → @llm_behavior task_creator fires on task.executed
      → returns NewTasks(tasks=[...])
      → handler: for each title, add_object("task", {status: "pending"})
        → object.created (type=task) ← back to executor
…
```

The loop is **event propagation** — the original BabyAGI's `while True` is gone; the framework's queue drains until idle or budget exhausted. The graph IS the queue; the event log IS the ordering. Termination is "the LLM proposes an empty `NewTasks.tasks` list," not a Python `break`.

User invocation: `pip install activegraph && activegraph quickstart` (recorded fixtures, no API key needed). For custom builds: `Runtime(Graph(), frame=Frame(goal=...), llm_provider=Anthropic|OpenAI|Recorded|Scripted, budget={max_events, max_seconds}, persist_to="run.sqlite").run_goal(...)`.

## 3. Deterministic or agentic?

**Hybrid by design.** The *runtime substrate* (graph, projector, event log, queue, scheduler, fork, structural diff, LLM cache by prompt hash, `replay_strict` divergence pinning) is **fully deterministic** — `FrozenClock` exists, `activate_after` is *event-count only* and intentionally refuses wall-clock units (CONTRACT v0.7 #13: "wall-clock would break determinism under replay"), and the test discipline is locked: "Test discipline: tests must remain deterministic. No live network calls in CI. LLM and tool tests use recorded fixtures (`RecordedLLMProvider`, `RecordedToolProvider`). If a contribution adds a test that would only pass with a live API key or live HTTP, it cannot land." (README §Contributing.)

Behaviors can be either: `@behavior` is pure-Python deterministic; `@llm_behavior` calls a provider but inside a typed contract — `output_schema: BaseModel`, `prompt_hash` for caching, `replay_strict` for divergence detection, structured failure reasons (`llm.parse_error`, `llm.schema_violation`, `llm.network_error`, `llm.rate_limited`, `budget.cost_exhausted`). The framework treats LLM calls the way the harness treats compiler invocations: an opaque step with a typed contract on both ends.

**License: Apache-2.0** (switched from MIT in v1.0.5.post1 — `LICENSE` + `NOTICE` for attribution). Permissive — code-borrow (lane 3) and reuse (lane 5) are both unblocked. The CONTRACT.md is itself permissive content.

**Marketing-vs-reality check (per the CodeWiki lesson).** README says "v1.0 (stable)"; `pyproject.toml` classifies it `Development Status :: 3 - Alpha`. CONTRACT.md is 305 KB of locked decisions across v0 → v1.0 → v1.1 plans — serious discipline — but the project is single-maintainer (`authors = [{name = "Active Graph contributors"}]`, `[CONTRIBUTING.md] code PRs are maintainer-only`) and in early public phase. Read this as: the *abstractions* are deliberate and well-pinned; the *production-readiness* claim is generous. The discipline is real (mypy `--strict` allowlist with a CI gate, wheel-completeness gate, deploy-verification gate, fixture-based tests-must-stay-deterministic rule), but adoption today still carries founder-bus-factor risk. RFC, not adoption.

## 4. Substrate vs. surface

- **Surface:** a Python framework for building agentic systems. The Diligence pack (claim / evidence / risk / memo objects; question_generator / researcher / contradiction_detector behaviors) is the **reference example** showing how to write a domain-specific pack — not a product. The pack format itself (8 obj types, 7 behaviors, 3 tools, recorded fixtures, settings via typed Pydantic injection, prompts under `prompts/*.md`) is shippable as a *pattern* but not directly reusable for code review.

- **Substrate, cleanly separable:**
  - (a) **The graph-as-event-sourced-projection idea** — `apply_event` as the only mutator, behaviors propose mutations, runtime applies (CONTRACT #2/#5/#15). This is a *pattern*; not borrowable as code (Python ≠ TS) but cleanly portable.
  - (b) **The fork-at-event-then-structural-diff capability** — 145 lines in `runtime/diff.py` after you've paid for the rest of the framework. This is the framework's killer feature for hypothesis testing on agent runs.
  - (c) **The prompt-hash-keyed LLM cache** — 180 lines, also cheap to port. Most agent frameworks key LLM caches by event id or call site; keying by *content* is what makes fork reuse the parent's API calls automatically.
  - (d) **The `replay_strict=True` with `ReplayDivergenceError` pinned to an event id** — same pattern as our reservation-event replay (`replayTransitions`); a candidate for our recurrence/reservation logs (Notes).
  - (e) **Relation behaviors** — coordination logic on edges. Conceptually unusual; concretely useful for the kinds of multi-agent coordination Tier 3 will need.
  - (f) **The whole framework**, as an embedded library for a Python cloud surface (Agent CI). Apache 2.0, `pip install activegraph[anthropic,postgres,prometheus]`.

## 5. Lane (1–6)

**Primary: Lane 4 (pattern / architecture). Secondary: Lane 5 (cloud-only fodder).**

Justification (per the per-capability-decomposition pattern from `narsil-mcp.md`):

- **Lane 1** (imperative content) — no.
- **Lane 2** (detection technique) — no.
- **Lane 3** (substrate borrow into the CLI) — **ruled out by language**. The CLI is TypeScript; ActiveGraph is Python with `pydantic` for typed schemas. A TS port of the core (graph projection + event log + fork+diff) is conceivable but is a >1-day spike and overlaps with capabilities we don't have a current need for. Don't.
- **Lane 4 (pattern)** — **primary.** Two distinct patterns to absorb into memory and into design conversations going forward:
  - **Patch-with-`expected_version` + rejection-as-event** — convergent evidence on the reservation system shape (Notes).
  - **Fork-at-historical-event + structural diff + content-keyed LLM cache** — the canonical shape for "what would have happened if the agent had taken path B?" Tier 3 will need this; absent ActiveGraph we'd reinvent it.
- **Lane 5 (cloud)** — **secondary, but real.** ActiveGraph is a serious candidate to **be the substrate of Tier 3 (Agent CI, P4–5)**. The Tier 3 design (`docs/design/tier-3-async-deep-review.md`) is async, multi-agent, multi-turn, needs auditability, needs the ability to test policy changes against past reviews — i.e., it needs forking and replay. ActiveGraph already has them.
- **Lane 6** — Python-only adoption in the harness (rejected); the Diligence pack as a product (it's an example domain, not a reusable product); the postgres/prometheus extras (unneeded at this tier); the `activate_after` event-count scheduler (no current need); the LLM provider abstraction beyond what we already have via Tier 2.

## 6. Dependency & displacement

- **Deps (CLI side):** N/A — ActiveGraph is a Python framework and the CLI is TypeScript. No dependency question to answer for Phase 1.
- **Deps (cloud side, if adopted for Tier 3):** `pip install activegraph[anthropic]` brings `click`, `pydantic>=2`, `anthropic>=0.40`. Phase 4/5 backend is a separate codebase and a separate dependency stance; the CLI's "one runtime dep" rule does not apply there. Apache-2.0 permits unconditional reuse. The `pyproject` extras model is clean (per-provider `[anthropic]` / `[openai]`, optional `[postgres]` / `[prometheus]`), so a Tier 3 service can install the minimum surface it needs.
- **Displacement (internal):**
  - **No displacement of any current CLI code** — ActiveGraph does not overlap with `project-graph.ts`, `trigram-index.ts`, `evaluator.ts`, the reservation cache, or the recurrence log at the code level. (See "convergent evidence" in Notes for what *resembles* what — that is not the same as displacement.)
  - **Potential displacement of as-yet-unwritten Tier 3 plumbing.** The Tier 3 design memo doesn't currently specify the substrate — orchestrator, message bus, audit trail, state store are all undescribed. ActiveGraph would slot into all four. This is "would-have-been-written" displacement, not "is-being-rewritten," but it's the load-bearing displacement question.

## 7. Smallest spike

**≤1 day, Lane 4 + 5.** A "would ActiveGraph carry Tier 3?" calibration spike:

1. `pip install activegraph` and run `activegraph quickstart` to ground-truth the developer surface (~30 min).
2. Read `tests/test_fork.py` (4 cases — basic fork, parent untouched, fork persistence, fork-of-fork) and `tests/test_llm_replay.py` (cache from events, fork-with-replay_llm_cache hits the cache, divergent prompts fall through to provider) to pin exactly what the diff captures and what the cache promises (~1h).
3. Write a **200-line "Tier-3-shaped" demo**: two `@llm_behavior`s (Coordinator + Specialist) on a shared graph, one shared scope (the staged commit), one structured output schema per role, a `Frame` carrying the prose-policy text from the active skill's `*.prose.md` artifact. Persist to SQLite. (~3h.)
4. **Measurement that matters:** run once with policy P1; `fork(at_event=<post-coordinator>, replay_llm_cache=True)`; mutate the Specialist's prompt; re-run. Verify (a) the Coordinator's LLM call hits cache (zero new API calls), (b) the Specialist's call goes to the provider, (c) `parent.diff(fork)` produces a precise structural delta on the Specialist's emitted objects. If true, the spike is a green light to write a Tier 3 RFC with ActiveGraph as a named candidate substrate. If false, document the failure mode and revert to "roll our own." (~2h.)

The spike's question is binary: does fork-with-replay-cache give us a cheap way to A/B Tier-3 policy changes? If yes, this is a serious candidate. If no, the framework still informs the design but isn't a substrate.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | **Pattern absorption only.** The reservation system's `applyTransition(state, txn)` / `replayTransitions(events)` shape is convergent with ActiveGraph's `apply_event` projector + `replay_strict` model; treat as external validation of the existing direction (`feedback_safety_continuity.md`, the `ReservationTxn` discriminated union). No code change here today; if the recurrence log (`.interlinked/recurrences.jsonl`) ever grows a "branch at history-point and re-aggregate" need, ActiveGraph is the design template. | — (memory note) | parked |
| Guardrails (P2–3) | **Weak fit.** Guardrails is sub-second sync policy enforcement (typed-signal classifier + Cedar). ActiveGraph is multi-turn, event-loop-driven, wrong tempo. One narrow tangent: ActiveGraph's `Policy(can_create=, can_call_tool=, requires_approval=)` shape is what `policy.py` advertises but doesn't yet enforce; if Guardrails ever needs an *agent-internal* policy layer (not just the per-tool-call gate), the field names are a useful starting point. | — | parked |
| Agent CI (P4–5) | **Strong fit, primary surface.** Tier 3 async deep review (`docs/design/tier-3-async-deep-review.md`) is multi-agent, multi-turn, auditable, replay-needing, on the pre-push trigger. ActiveGraph supplies: event-sourced trace (audit trail), structural diff (delta surface for the human reviewer), fork-at-event + replay-LLM-cache (test policy/prompt changes against past reviews cheaply), patch lifecycle with approval as a first-class event (mirrors Tier 3's warn-only "suggested fixes" surface), failure-as-event (no exceptions in the audit trail), `Frame` carrying goal + constraints + permissions (a clean home for the active skill's `*.prose.md` + active Cedar policies). Spike per §7. | One-day calibration spike (§7); if green, a Tier 3 RFC follows | next |

Phases 6–7 (escalation wiring, enterprise tier) inherit from the Agent CI choice — no separate row.

## 9. Artifact

- **RFC (server repo's `docs/design/`):** "Tier 3 substrate — adopt ActiveGraph or roll our own?" Compares to (a) hand-rolled orchestration over a JSONL audit log, (b) LangGraph, (c) ActiveGraph. The discriminating capabilities to evaluate against are (i) fork-at-event, (ii) content-keyed LLM cache, (iii) replay-strict divergence pinning, (iv) failure-as-event audit trail, (v) trace inspectability. Add the §7 spike as the gating measurement. Don't merge the RFC without running the spike — the framework is v1.0.5.post2 with a maintainer-only contribution policy, and adoption risk needs to be measured against value before committing.
- **Memory note** (linking back to this intake file): the convergent-evidence reservation observation belongs in memory with cross-links to `feedback_safety_continuity.md` and the supervisor-pattern memory.
- **No PR, no harness check, no roadmap-item-today.** A skip on the Free CLI is the correct verdict.

## Notes

- **The Supermodel connection, honestly.** The user flagged this as potentially mattering "including but not limited to what we've done with Supermodel Tools so far." The honest read: Supermodel and ActiveGraph **share a philosophical move** ("deterministic structural primitives + delegated agentic judgment, both first-class") but **solve different problems**. Supermodel models *the source code* as a graph (parse / dep / call / domain layers, shared IDs, SIR artifact); the agent queries it. ActiveGraph uses a graph *as the agent's runtime substrate*; the agent lives inside it. Where they meet is suggestive, not direct: a Tier 3 review built on ActiveGraph could include a `@behavior` that fetches Supermodel-style code-graph facts about the staged diff and emits them as graph objects the LLM specialists then reason over. The two complement; they don't compete. What this intake **does not** validate is the existing "Supermodel-direction" backlog inside the harness (shard emitter, ranker, dead-code MCP tool from `reference_supermodel_dead_code_playbook.md`) — that work is still on its own merits.
- **Convergent evidence on the reservation transaction model.** `src/harness/reservations.ts` defines `ReservationTxn` as a discriminated union, applied through `applyTransition(state, txn)` with `replayTransitions(events: readonly ReservationTxn[])` running the same dispatch — exactly the Bitar / Active-Graph shape ("edge-defined-once," "two callers, one code path"). ActiveGraph's `apply_event` projector is the same architecture at the framework level. The optimistic-concurrency story matches too — ActiveGraph's `Patch(expected_version)` with `patch.rejected` as a first-class event is the same shape as our `reservation-events.jsonl` conflict path (which was specifically fixed 2026 to surface server-rejected grants as events rather than silent `.catch(() => {})`). Two independent designs converging on the same shape under different pressures is a strong signal the abstraction is right; nothing to do here today other than note it.
- **Differentiated capabilities, ranked by their value to Tier 3:**
  1. Fork-at-event + structural diff. Most agent frameworks can't do this; Tier 3 wants it.
  2. Content-keyed LLM replay cache. The thing that makes fork-A/B cheap.
  3. Failure-as-event. No try/except in the audit trail.
  4. Relation behaviors (coordination on edges). Tier 3's specialists-coordinate-over-shared-state pattern.
  5. Frame as a first-class context. Maps cleanly onto the active skill's `*.prose.md` + active Cedar.
  6. Patches with `expected_version` + approval as events. Mirrors Tier 3's warn-only "suggested fixes" surface.
- **What `replay_strict=True` adds that we don't have.** When you re-execute a saved run, the runtime re-fires every behavior and verifies the live output matches the recorded output; on the first divergence, it raises `ReplayDivergenceError(event_id=…)`. For LLM behaviors, the same check fires when the *re-assembled prompt's hash* differs from the recorded one — pinning divergence to either "the behavior produced different facts" or "the prompt has drifted." We have a partial analog (the parity test between `dist/hook-entry.js` and the generated `.mjs`); the *replay-the-trace-and-pin-divergence* primitive is missing from the harness, and that's a primitive we'd want for the Tier 3 review reproducibility story.
- **Maturity tension, restated.** README says "v1.0 (stable)." `pyproject.toml` classifies `Development Status :: 3 - Alpha`. CONTRACT.md is 305 KB of locked decisions, mypy `--strict` is gated, wheel-completeness gate exists, doc-deploy gate exists, every test must be deterministic. The discipline is real; the *adoption surface* is small. Production-readiness is to be measured by the §7 spike, not assumed from the README.
- **What's deliberately ruled out (Lane 6, explicit):** the Diligence pack as a product (example domain only), the Pack format as our packaging story (overkill for current needs), the Postgres backend (we're SQLite-or-server at this tier), the Prometheus integration (the harness has its own metrics path), the `activate_after` event-count scheduler (no current need; Tier 3 has its own tempo from the pre-push trigger), the LLM provider abstraction (Tier 2 already has one), and **any adoption into the CLI itself** (wrong language; would import a 20K-LoC Python framework into a TS codebase, which is impossible).
- **Related external-pulse entries:** `codewiki.md` (the canonical "read the source, not the README" precedent), `narsil-mcp.md` (the canonical large-multi-capability-repo intake with per-capability lane decomposition), `failproofai.md` (the deterministic-policy competitor — Tier 1/2 surface, not the Tier 3 surface ActiveGraph addresses).

## Methodology notes

- **Second large multi-capability framework intake** (after `narsil-mcp.md`). Same observation: the rubric implicitly assumes a small, single-purpose find. A 20K-LoC framework is a quarry. The per-capability lane decomposition (Lane 4 primary, Lane 5 secondary, Lane 6 explicit rejection list) is the working pattern for these. If a third one of these lands, fold the per-capability decomposition into INTAKE.md proper as a "for large multi-capability finds, ..." note.
- **Determinism filter applies cleanly but the verdict is unusual.** ActiveGraph is *partly* deterministic (substrate) and *partly* agentic (LLM behaviors). The rubric's framing — "agentic → lane 5, deterministic → CLI" — doesn't quite cover "the substrate is deterministic but you embed agentic behaviors inside it." The resolution: the *substrate* clears the determinism filter; the framework as a whole still routes to cloud because (a) wrong language for the CLI, (b) the binding constraint is the multi-turn / multi-agent / minutes-long *tempo* of the work, not just determinism (the same compute-budget point `narsil-mcp.md` §"The second filter" surfaced). The CLI's 300ms/800ms/2s budget is incompatible with a multi-turn LLM run regardless of how deterministic the surrounding substrate is.
- **Read the framework's CONTRACT before the README's "stable" claim.** README's "v1.0 (stable)" reads optimistic in isolation; CONTRACT.md, mypy-strict allowlist with a CI gate, wheel-completeness gate, deploy-verification gate, and the "no live network in CI" testing rule together say the discipline is real. The pyproject classifier "Development Status :: 3 - Alpha" is the more honest line. Two-source verification (README + classifier + CONTRACT skim) gave the calibrated reading.
- **One-sentence rule for evaluating frameworks vs. tools.** When the find is a *framework* (something you build *inside*), the §6 "invoke-as-subprocess vs. import-as-dependency" question is moot — neither applies. The substituted question is "is the *cloud surface*'s language compatible, and is the *adoption risk* (single maintainer / alpha / new) acceptable?" Suggested INTAKE.md edit if this recurs: §6 "Deps" could grow a third sub-question — "For frameworks the choice is *embed* vs. *roll our own*; what does the embed-risk look like (license, maturity, maintainer count, contribution policy)?"
