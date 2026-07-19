# Verification Harness Plan — Handoff (v3.2)

**Project:** interlinked-cli harness, full verification stack (test adequacy + code correctness + security/supply-chain + runtime resilience)

**Thesis (one paragraph):** Slow the agent down at runtime, deliberately, within a bounded discipline window — 30 seconds of hard-blocking checks per PreToolUse hook, optionally extended to ~60 seconds via the PreToolUse→PostToolUse bridging pattern — and use that window to subject every proposed change to the maximum disciplined gauntlet that fits. Coverage, mutation, red/green TDD, complexity, graph analysis, secrets, SCA, custom domain rules, acceptance routing, property tests — all running in parallel across Cloudflare's fleet, all returning verdicts before the agent's next move. The 30-second stall is the point: it's 30 seconds of forced quality scrutiny the agent would otherwise skip. Bridging is the transitional pattern for checks that don't yet fit blocking-mode; the harness gets stronger over time as the **Compression Program** (§19) systematically promotes bridging-mode checks into blocking-mode by making them faster, smaller-scoped, or more parallel. LLM review (Tier 3, eventual gpt-oss-safeguard-style models) is the asynchronous companion for judgment-class checks the deterministic gauntlet can't make. The whole architecture is also the prerequisite for safe multi-agent extension — when more than one agent operates in a workspace, the gauntlet *is* the trust boundary, and trust requires rigor in the single-agent foundation first.

**Status at handoff:** Design converged on a **lane × cadence matrix** with explicit categorization axes, a **phased build order** with measurement-gated transitions between phases, three operational disciplines (shadow mode, rollback paths, **compression toward blocking**) that apply across every phase, the **Cloudflare Agents Week 2026 stack** as the explicit Tier 2 substrate, and **LLM review as a first-class Tier 3 capability** with extensible substrate for future model integration. Several measure-don't-design questions remain that must be answered with instrumentation during the build itself; the build order has explicit measurement spikes (Phase 3.5) before committing to assumed numbers.

**Major changes from v3.1 (this is v3.2):**
- **§1 thesis rewrite:** the gauntlet philosophy and the 30s/60s budget reality are now explicit. The 30-second window is *budget for discipline*, not constraint to minimize.
- **Italic goal/summary lines** under every major header and meaningful subheader, so the doc is skim-navigable and an implementing agent can identify the right section without reading the body.
- **§6 cadence model split:** Tier 2 now distinguishes **Tier 2-blocking** (hard ≤30s ceiling, PreToolUse fail-closed) from **Tier 2-bridging** (≤60s total via PreToolUse-start + PostToolUse-consume pattern, can only advise not block). Tier 3 explicitly includes LLM review as a sub-category.
- **§13 new bridging-pattern section** explaining the PreToolUse→PostToolUse handoff via `additionalContext`, what work suits each mode, and the strict 30s ceiling on blocking-mode admission.
- **§13.9 admission formula** updated with `mode: "blocking" | "bridging"` as part of every admission decision; blocking-mode requires `predicted_p95_ms < 30000` as hard precondition.
- **§13.10 schema** adds `mode` field.
- **§19 new Compression Program** — the parallel arc systematically attacking bridging-mode latency to promote checks into blocking. Smaller-edit pressure, structural-seam splitting, sub-check parallelization. Treated as cross-cutting discipline alongside shadow mode and rollback paths.
- **New Phase 7.5** in §18 — Tier 3 LLM Review Substrate (review request schema, LLM-finding type, prompt-template framework, async delivery). Model-agnostic; specific integration (gpt-oss-safeguard, others) is downstream.
- **Multi-agent throughline** explicit in §1 and §16: the gauntlet *is* the trust boundary for eventual multi-agent extension.
- **§7 matrices updated** for blocking/bridging split and LLM review entries.

**Major changes from v3.0 → v3.1 (preserved for continuity):** §13.3 substrate correction (Dynamic Worker Loader + Facet for V8-class work; Sandboxes for Linux-class); §13.5 budget revised; receipt schema added `artifacts_commit_hash`, `supervisor_do_id`, `facet_ids[]`, `substrate`; Phase 0 added supervisor DO scaffold; Phase 3.5 doubled to measure both substrates; Phase 3.7 threat model distinguishes V8 vs. Linux boundaries; Phase 4 explicit Supervisor + Facet pattern.

**Major changes v2 → v3.0 (preserved for continuity):** Phased build order with dependency gates; Phase 3.5/3.7 as Phase 4 prerequisites; shadow mode and rollback as cross-cutting; Phase 0 as extraction; Tier 5 continuous; property-test/mutation separation.

---

## 1. Problem Framing

*Goal: Establish the thesis — the harness is a deliberately-slow gauntlet that subjects every agent edit to maximum quality scrutiny within a 30s blocking + 30s bridging budget, with bridging continually compressed into blocking, and LLM review as the async companion for judgment-class checks. The gauntlet is also the trust boundary for eventual multi-agent extension.*

The harness exists to **slow the agent down on purpose**. Not by 5 minutes, not by 30 seconds of dead time — by 30 seconds of *forced quality scrutiny* per edit. In that window, every discipline that fits gets to inspect the proposed change: red/green TDD, mutation testing, coverage analysis, complexity gates, graph analysis, secret detection, SCA, custom domain rules, acceptance routing, property tests, lint, type-check. The agent's next move cannot happen until the gauntlet returns its verdict. This is the runtime quality enforcement loop — the opposite of catching mistakes at PR review when the work is already done and the human has to interrupt their own flow to fix it.

### 1.1 The 30s/60s hard budget

*Goal: Make the literal Cloudflare hook budget explicit, so every other section is read against it.*

Cloudflare's PreToolUse and PostToolUse hooks each have a **hard 30-second budget**. Blocking checks run during PreToolUse — they must complete in under 30 seconds or the hook times out. The only way to extend the discipline window beyond 30 seconds is the **bridging pattern**: kick off a longer-running process at the start of PreToolUse, let it run while the tool call writes to disk, surface the result in PostToolUse via `additionalContext`. Bridging gives you up to ~60s total, but it can only *advise* — by the time PostToolUse fires, the edit has already landed.

This produces three execution modes for Tier 2 work:
- **Blocking mode:** check completes in PreToolUse within 30s; can fail-closed and prevent the edit.
- **Bridging mode:** check spans PreToolUse-start + tool-call duration + PostToolUse-consume, total ≤60s; can advise but not block.
- **Async mode:** check takes longer than 60s total; routed to Tier 3.

**The goal is to fit as many checks as possible into blocking mode**, because blocking is the only mode that *enforces* rather than *suggests*. The Compression Program (§19) is the parallel engineering arc that takes bridging-mode checks and systematically promotes them into blocking — by making them faster, by reducing their scope, by parallelizing more aggressively. The harness gets stronger over time as more checks earn promotion.

### 1.2 Layer 1 and Layer 2 today

*Goal: Snapshot what's live in the harness now, and name the hole the gauntlet fills.*

The harness today enforces verification in two conceptual layers, only one of which is live, and across an implicit single lane (test adequacy).

**Layer 1 — Shape & behavior enforcement (live, zero-dependency, firing on every edit).** Existence gates (`tdd_new_file_gate`, `test_file_exists`, `prod_delta_no_test_delta`, `prod_test_loc_ratio`, `done_without_verify`), red/green cycle tracking (`server-tdd-cycle.ts`, `behavioral-checks.ts`), anti-gaming shape checks (placeholders, `.only`, assertion density, assertion-free tests, assertion roulette, over-mocking, snapshot overuse, duplicate names, SUT-import absence, SUT self-mocking, nondeterminism, real I/O in unit tests), and diff-aware commit gates.

**Layer 2 — Ground-truth-ish verification (dormant).** Coverage analysis and mutation testing exist in the codebase as primitives (`mutation-gate.ts`, `coverage-ratchet.ts`, CRAP machinery via `crap.ts`) but are not wired into the live loop.

**The structural problem with Layer 1 alone:** every shape check is reverse-engineerable. The agent can satisfy assertion density with weak assertions, satisfy SUT-import with import-but-don't-use, satisfy red/green by writing a test that fails trivially and then makes it pass trivially. The harness comment in `behavioral-checks.ts:679` already acknowledges this: *"Plan 10 (mutation testing) catches it asynchronously."* Plan 10 isn't wired. The hole is open.

**The architectural irony:** forcing a test to exist is exactly the pressure that produces a worthless test. Layer 1 is the immune response to gate-gaming, but it chases symptoms.

Mutation testing is the **strongest currently practical behavioral-discrimination signal** available — it empirically verifies that *a test can fail when the code is wrong*. It is **not absolute ground truth** (it measures discrimination against Stryker's mutator set, not against all possible bugs), and it is one of several ground-truth-ish signals alongside red-then-green, acceptance tests, property tests, and production-bug regressions. Central in the test-adequacy lane, not singular — the gauntlet's strength comes from composing many disciplines, not from any one of them.

### 1.3 The four-lane reframe

*Goal: Establish that the gauntlet has to defend code quality along four orthogonal axes, because the agent will optimize for whichever is measured and you need to measure all four.*

Test adequacy is only one verification family. Three others are categorically distinct:

- **Code correctness independent of tests** (types, lint, complexity, dead code, architecture rules) — code can be correct-by-construction without any test running.
- **Security and supply chain** (SAST, SCA, secrets, IaC, container, license) — bug classes mutation cannot generate mutants for.
- **Runtime and behavioral resilience** (property tests, API fuzzing, performance, flakiness, e2e, coverage-guided fuzzing) — properties tests can't express as examples and static analysis cannot prove.

The gauntlet has to hit all four lanes (§5), because partial coverage produces well-tested wrong code, or type-safe untested code, or locked-down broken code. Each lane has its own cost profile, its own gating semantics, its own gaming surface — and its own contribution to the per-edit discipline window.

### 1.4 LLM review as judgment-class signal (Tier 3)

*Goal: Name the class of checks no deterministic discipline can perform, and place them at Tier 3 cadence.*

Some classes of code quality cannot be verified by any deterministic check: *did the agent understand what it was supposed to do? are these names good? is the abstraction at the right level? does this fit existing patterns in the codebase? would a senior engineer write this differently?* These are judgment-class questions, and only another language model can answer them.

LLM review (Tier 3, async) is the companion to the deterministic Tier 1/Tier 2 gauntlet. It runs asynchronously per edit — costs tokens, takes tens of seconds to minutes — and surfaces findings to the agent on the next turn or at Stop. It does not replace mutation or coverage; it complements them. The substrate is built generically in Phase 7.5 (review request schema, LLM-finding type, prompt-template framework, async delivery) so that specific model integration (gpt-oss-safeguard-style safety/quality models, or task-specific reviewer models) can be added without architectural change.

### 1.5 The multi-agent throughline

*Goal: Explain why the single-agent gauntlet has to be load-bearing, not advisory — because it's the prerequisite for any future multi-agent system.*

The doc explicitly defers multi-agent build work (single-agent first). But the gauntlet's design must not foreclose the eventual extension, because the gauntlet *is* the trust boundary between agents. When Agent B inherits a workspace where Agent A has been editing, Agent B needs to trust that Agent A's edits passed real disciplines — not advisory ones, not heuristics. That trust is only possible if the single-agent gauntlet is deterministic, receipt-bound, and consistent.

This is why the disciplines in this plan are designed to be rigorous now, even though only one agent will use them at first. Forward-compatibility seams (§15.3) preserve the multi-agent option without building it. Multi-agent extension may eventually appear as *another type of Tier 3 check* — peer-agent review of another agent's edit — surfaced as a finding through the same substrate as LLM review.

---

## 2. The Two Test-Quality Techniques (Lane A Primer)

*Goal: Define coverage and mutation precisely — what each empirically verifies, where each fails, why mutation is central but not singular to Lane A's gauntlet contribution.*

### 2.1 Coverage Analysis

*Goal: Distinguish execution-tracking from verification — coverage measures what tests touched, not what they checked.*

Runs tests with bytecode/AST instrumentation; records which lines, branches, and statements executed. Returns a percentage.

**Fundamental limit:** coverage measures *execution*, not *verification*. A test that calls `add(2,3)` and asserts nothing achieves 100% line coverage. Coverage is necessary but profoundly insufficient.

**Two coverage products at two cadences:**
- **Diff-aware "are your new lines hit?"** — post-processing of a piggybacked test run, microseconds, surfaces fast in Tier 1.
- **Per-file ratchet (%)** — needs whole-suite coverage for correctness; Tier 3 (Stop/Stage 6) cadence.

### 2.2 Mutation Testing

*Goal: Frame mutation as Lane A's strongest practical signal, with explicit limits — it discriminates against Stryker's mutator set, not all possible bugs.*

Tool (Stryker) systematically perturbs the source: flips `+`→`-`, `>`→`>=`, replaces return values with defaults, deletes statements, negates conditionals. For each mutant, re-runs the covering tests. Surviving mutants = tests cannot distinguish correct code from this wrong version. Mutation score = killed / total.

**Why it's central, not singular:** it's the only check that empirically demonstrates tests can fail on wrong code, rather than approximating that property with proxies. But it discriminates only against the mutator set Stryker generates.

**Cost model:**
```
mutation_wall_time ≈ dry_run(covering_tests)
                   + (mutants_on_changed_lines × covering_test_runtime ÷ concurrency)
```

Three terms:
- `mutants_on_changed_lines` — eliminable via `--mutate file:lines` diff-scoping. Cuts ~100–150 mutants/file to ~5–20/diff.
- `dry_run` — eliminable if you piggyback on the agent's own test run (harness already intercepts via `server-tdd-cycle.ts:detectTestRunFile`).
- `covering_test_runtime` — **set by blast radius, not by you.** This decides whether the budget closes in blocking mode (§13).

### 2.3 CRAP

*Goal: Compose complexity and coverage into a single high-risk indicator that rides existing measurement.*

`comp² × (1 − cov)³ + comp`, per function — the canonical Crap4J metric (Savoia & Evans, 2007), matching `src/harness/checks/crap.ts::crapScore`. Free once coverage exists. Plain-language: *high complexity + low coverage = high risk; well-tested or simple code scores low* — the `(1 − cov)³` factor zeroes the squared term at full coverage, so a fully-covered function scores just `comp`. Crap4J's native threshold is CRAP > 30. Rides whatever coverage cadence you choose.

### 2.4 Property Tests in Lane A's Cost Model — Bob Martin's Concern

*Goal: Explain why property tests in mutation's covering set produce a cost catastrophe and probabilistic mutation scores — and why the architectural correction is separation, not parallelization alone.*

A property test is `N runs × random_input × test_body`. Default fast-check N is 100. When property tests sit in mutation's covering set, cost compounds:

```
mutation_with_properties = mutants × covering_property_tests × N × per_run_cost
```

For 80 mutants × 1 property × N=100 at 50ms per run, that's 8,000 property-test executions per file — minutes serial. **Bob Martin's concern about this is correct.**

Three issues persist even with parallelism:
- **Nondeterministic scores.** Random seeds make mutation results probabilistic.
- **Timeout false-kills amplified.** Per-mutant `timeoutMS` bites worse when N runs widen latency distribution.
- **Shrinking variance.** When a property fails, fast-check shrinks sequentially.

**Architectural correction:** by default, exclude property tests from mutation's covering set. Property tests verify discrimination against random inputs (Lane D signal). Mutation verifies discrimination against code perturbations (Lane A signal). Mixing inflates cost without proportional epistemic gain.

**Opt-in only at Tier 4 scheduled cadence** for explicitly-marked function-level properties, with reduced N (e.g., N=20 with fixed seed-set).

---

## 3. Measured Anchors

*Goal: Anchor every cost estimate in measured numbers from this codebase. What's unmeasured is flagged for Phase 3.5.*

(Quentin's machine, single-file vitest, threads enabled. Lane A only.)

| Measurement | Value |
|---|---|
| Vitest startup tax (per invocation) | ~0.6s |
| Single-file unit test, pure (19 tests) | 0.8s |
| Single-file subprocess-heavy (35 tests, real git spawns) | 3.6s |
| V8 coverage instrumentation overhead | +10–30% |
| Diff-scoped Stryker mutant count | 5–20 |
| Full-file Stryker mutant count | 80–150 |
| Cloud core vs. laptop core (raw thread speed) | ~2–3× |

**Blast radius distribution in this codebase (verified):**

| File class | Direct importers | Covering-test set |
|---|---|---|
| `checks/crap.ts` (leaf) | 1 | ~1–3 |
| `checks/shared.ts` (hub) | 47 | ~47+ |
| `harness/types.ts` (mega-hub) | 316 | ~whole harness suite |

Distribution is bimodal. Most files are leaf or mid-fan-in; a small number of hubs dominate the cost tail.

**Phase 3.5 measurement spike will produce anchors for** Cloudflare Dynamic Worker Loader + Facet startup, sandbox restore, Workflows orchestration, result-return latency, bridging round-trip overhead. Both substrates measured side-by-side.

---

## 4. Per-Tool-Call Cost Table (Lane A, Local, Single Machine)

*Goal: Quantify Lane A's local cost distribution to expose the bimodal cheap/expensive split that the cadence cascade exploits.*

| Check | Diff-scoped | Full-file | Cost driver |
|---|---|---|---|
| Supermodel graph read | <50ms | <50ms | Local `.graph` file I/O |
| Dependency-structure traversal | <50ms | <50ms | One-hop BFS on cached graph |
| Module size (LOC) | <1ms | <1ms | Trivial |
| Cyclomatic complexity | 50–200ms* | 50–200ms | TS parse dominates |
| RGR state gate | ~0 | ~0 | State in cycle store |
| RGR refactor-detection (public-API-stable AST diff) | 50–200ms | 50–200ms | AST diff, not test run |
| CRAP | <10ms | <10ms | Pure function, rides coverage |
| Coverage — piggybacked on agent test | +0.1–1s marginal | n/a | +10–30% on a run that's happening |
| Coverage — independent (whole covering set) | 1–3s leaf → 15–60s hub | same | Covering runtime × blast radius |
| Mutation (`--mutate file:lines`) | 2–15s leaf → 60s+ hub | n/a | 5–20 mutants × covering runtime |
| Mutation (whole file) | n/a | 10–55s leaf → minutes+ hub | 80–150 mutants × covering runtime |
| Mutation with property tests in covering set | 30–90s leaf+ → minutes hub | n/a | mutants × properties × N |
| Acceptance tests (1–3 scenarios) | 5–180s | similar | Inherent (HTTP/CLI/db setup) |

*Assumes no AST cache. Cached: <1ms.

**Parallelism reality:** the first seven rows are independent and parallelize freely. Expensive rows share test runner and CPU. **Lane A cost distribution is bimodal: cheap ~200–500ms, expensive 3s–minutes.** That gap is what the cadence cascade exploits.

---

## 5. The Four Verification Lanes

*Goal: Decompose code quality into four orthogonal verification families, each with distinct tools, epistemic semantics, and gaming surfaces. The gauntlet must hit all four to be robust against agent calibration.*

### 5.1 Lane A — Test Adequacy

*Goal: Verify that tests actually exercise and discriminate the SUT's behavior — not just that they exist.*

**Tools:** red/green cycle tracking, coverage, mutation, CRAP, acceptance tests, property tests (Lane D crossover), Layer 1 shape checks, test-runtime ratchet, flakiness detection (Lane D crossover).

**Verifies:** Mostly the *test code* and the *relationship* between test and SUT.

**Gaming surface:** High. Most Layer 1 checks pattern-matchable; mutation gameable against Stryker's mutator set (§14).

**Adversarial defenses:** Mutator rotation, recurrence-feedback loop, pairing with external-reality lanes.

### 5.2 Lane B — Code Correctness and Maintainability

*Goal: Verify the production code is well-formed, type-safe, non-pathological in structure — independent of any test running.*

**Tools:** TypeScript strict, ESLint/Biome/oxlint, cyclomatic complexity, dead-code detection (Supermodel Deadcode Hunter), import-cycle detection, architecture rules (Dependency Cruiser), doc-vs-signature drift.

**Verifies:** The *production code* directly, without running tests.

**Gaming surface:** Low. Most checks deterministic and rule-based.

**Cost profile:** Mostly cheap. Most fit Tier 1 trivially.

### 5.3 Lane C — Security and Supply Chain

*Goal: Verify the code has no security vulnerabilities, leaked secrets, vulnerable dependencies, unsafe configuration, or supply-chain compromises — bug classes mutation cannot reach.*

**Tools by bug class (rather than tool name — see §7.3):**
- **Secret detection:** Gitleaks, TruffleHog, inline regex
- **Dependency CVEs:** OSV-Scanner, npm/pnpm audit, Dependabot
- **Pattern-based SAST:** Semgrep core rules
- **Taint analysis:** Semgrep Pro/interfile, CodeQL
- **Misconfiguration:** Trivy, Checkov, tfsec
- **Supply-chain posture:** OpenSSF Scorecard, SLSA/provenance
- **Reachability filtering:** graph-derived filter on dependency CVEs

**Gaming surface:** Variable. Pattern-based moderately gameable; taint analysis harder; CVE matching essentially ungameable; secret detection hard to fake-around.

**Cost profile:** Highly bimodal. Diff-scoped Gitleaks, lockfile-delta SCA, curated Semgrep <2s. Full CodeQL DB build minutes-to-hours.

### 5.4 Lane D — Runtime and Behavioral Resilience

*Goal: Verify the SUT behaves correctly on inputs the agent didn't think of, under concurrency, at scale, under fault injection — catching what example-based testing misses.*

**Tools by flavor:**
- **Property-based (generative):** fast-check
- **Coverage-guided (structural):** jsfuzz, jazzer for untrusted-input parsers
- **API/contract/protocol:** Schemathesis, custom contract diffing
- **Behavioral:** Playwright e2e, acceptance (Lane A crossover)
- **Operational:** flakiness detection, performance benchmarks, chaos

**Gaming surface:** Low. Random seeds explore blindspots by construction.

**Cost profile:** Variable. Bounded property tests fit Tier 2-blocking; aggressive fuzzing and full e2e are Tier 3, 4, or 5.

### 5.5 LLM Review as Cross-Lane Judgment Layer

*Goal: Acknowledge that judgment-class quality (intent, naming, abstraction, pattern-fit) crosses all four lanes and requires a model-based reviewer rather than a deterministic check.*

LLM review is not a fifth lane — it's a judgment layer at Tier 3 async cadence (§6). Per-lane example questions:
- **Lane A:** "Is this test actually testing the behavior or just exercising the code?"
- **Lane B:** "Are these names good? Is the abstraction at the right level?"
- **Lane C:** "Does this auth check look complete given the surrounding patterns?"
- **Lane D:** "Does this acceptance test match the human-authored scenario's intent?"

Substrate is built in Phase 7.5 generically; specific model integration is downstream.

---

## 6. Cadence Tiers — Shared Across Lanes

*Goal: Define the time-budget cascade — five execution cadences applied within each lane — including the new blocking/bridging split at Tier 2 and the LLM-review sub-category at Tier 3.*

Each lane uses the same cadence model. Cadence is *latency budget and trigger context*; lane determines *what runs*.

```
┌─────────────────────────────────────────────────────────────────┐
│ TIER 1 — Local-sync                       budget: 0–500ms       │
│ Per-edit, blocking, on developer/agent machine                  │
├─────────────────────────────────────────────────────────────────┤
│ TIER 2-BLOCKING — Remote-sync hard ≤30s                         │
│ PreToolUse blocking; fail-closed permitted; admitted only       │
│ when predicted p95 < 30000ms. Cloudflare fan-out via            │
│ Dynamic Worker Loader + Facets.                                 │
├─────────────────────────────────────────────────────────────────┤
│ TIER 2-BRIDGING — Pre+Post handoff ≤60s total                   │
│ Starts in PreToolUse, runs while tool call writes to disk,      │
│ result consumed via PostToolUse additionalContext. Advise only  │
│ — cannot block since edit has already landed by Post.           │
│ Transitional staging area for checks targeted for Compression   │
│ Program (§19) promotion into blocking.                          │
├─────────────────────────────────────────────────────────────────┤
│ TIER 3 — Async / Stop / pre-push / CI     budget: 60s–minutes   │
│ Event-triggered, non-blocking-but-surfaced                      │
│ Splits into Stage 5 (post-edit Stop), Stage 6 (pre-push/CI),    │
│ and LLM review (model-based judgment, cost in tokens + latency) │
├─────────────────────────────────────────────────────────────────┤
│ TIER 4 — Scheduled / nightly discrete     budget: minutes–hours │
│ Time-triggered, non-blocking, discrete jobs                     │
│ Full Scorecard, mutation sweeps, full image scans               │
├─────────────────────────────────────────────────────────────────┤
│ TIER 5 — Continuous / persistent state    budget: continuous    │
│ Background-running with persistent state across runs            │
│ Coverage-guided fuzzing (corpus), continuous SCA (external feed │
│ invalidation), continuous Semgrep policy                        │
└─────────────────────────────────────────────────────────────────┘
```

### 6.1 The Tier 2 split — blocking vs. bridging

*Goal: Make the 30s/60s hook-budget reality structural — blocking can enforce, bridging can only advise, both are valuable but only one stops bad edits.*

The split exists because Cloudflare hook budgets are hard: each of PreToolUse and PostToolUse caps at 30s. **The Compression Program (§19) is the explicit engineering arc that promotes bridging-mode checks into blocking-mode** — by making them faster, smaller-scoped, more parallel — so the gauntlet's enforcement power grows over time.

| Mode | Budget | Surface | Authority | Promotion path |
|---|---|---|---|---|
| **Tier 2-blocking** | ≤30s PreToolUse | Fail-closed possible | Can prevent the edit | Endpoint state |
| **Tier 2-bridging** | ≤60s spanning Pre+Post | Advisory only (edit landed) | Can warn but not block | Compression Program → blocking |
| **Tier 3** | >60s | Async surfacing | Next-turn or Stop feedback | N/A — different epistemic class |

**Admission to blocking mode requires `predicted_p95_ms < 30000`.** No exceptions. A check that occasionally exceeds 30s in blocking mode causes hook timeouts, which is worse than the check not running at all.

### 6.2 Tier 3 LLM review as sub-category

*Goal: Place LLM review at Tier 3 explicitly because cost (tokens + latency) is async-shaped, not because it's lower priority.*

Tier 3 traditionally covers async/Stop/CI/pre-push deterministic checks. v3.2 adds LLM review as a sub-category. Same async surface (next-turn or Stop), different cost driver (LLM tokens rather than test execution), different epistemic class (judgment rather than discrimination). Substrate built in Phase 7.5. Examples: code-review-style model on each edit, intent-verification against task description, fit-with-existing-patterns judgment.

### 6.3 Trigger axis (orthogonal to cadence)

*Goal: Note that tools fire on different events even within the same cadence — per-edit, event-triggered, periodic, continuous. Event-triggered is underexploited.*

- **Per-edit:** Every Edit/Write/MultiEdit. Lane A shape checks, Lane B lint/types, Lane C diff-secret-scan.
- **Event-triggered:** Specific file types or change patterns. Lockfile → SCA. Dockerfile → Trivy. Schema → migration check.
- **Periodic / scheduled:** Time-based discrete jobs (Tier 4).
- **Continuous:** Always running with persistent state (Tier 5).

Event-triggered is underexploited. Conditional triggering ("only run CodeQL taint analysis when an edit touches an HTTP handler or DB call") is cheaper than periodic and more targeted than per-edit. Lane C benefits especially.

---

## 7. Lane × Cadence Matrix — Tool Placement

*Goal: Master placement table for every tool. v3.2 splits Tier 2 column into blocking and bridging; adds LLM-review entries at Tier 3.*

Each tool's default cadence per lane shown. "Bridging" cells mark checks that *cannot yet fit blocking* but are candidates for Compression Program promotion (§19).

### 7.1 Lane A — Test Adequacy

| Tool / check | T1 local | T2-blocking | T2-bridging | T3 Stop/CI/LLM | T4 scheduled | T5 continuous |
|---|---|---|---|---|---|---|
| Layer 1 shape checks | ✓ default | — | — | — | — | — |
| Red/green cycle tracking | ✓ default | — | — | — | — | — |
| Test-runtime ratchet | ✓ default | — | — | — | — | — |
| Piggyback diff coverage | ✓ default | — | — | — | — | — |
| CRAP (from manifest) | ✓ default | — | — | — | — | — |
| Coverage ratchet (whole-suite %) | — | possible (sharded) | ✓ default-bridging | ✓ Stop | — | — |
| Mutation (diff-scoped, leaf/mid) | — | ✓ admitted | — | — | — | — |
| Mutation (diff-scoped, hub) | — | experimental | ✓ default-bridging | ✓ pre-push | — | — |
| Mutation (full file/repo) | — | — | — | ✓ pre-push | ✓ nightly | — |
| Mutation w/ property tests (marked function-level only) | — | — | — | — | ✓ default | — |
| Acceptance tests (short scenarios) | — | opt-in | ✓ default-bridging | ✓ Stop | — | — |
| Acceptance tests (full suite) | — | — | — | — | ✓ default | — |
| **LLM test-quality review** ("is this test testing behavior?") | — | — | — | ✓ default | — | — |

### 7.2 Lane B — Code Correctness and Maintainability

| Tool / check | T1 local | T2-blocking | T2-bridging | T3 Stop/CI/LLM | T4 scheduled | T5 continuous |
|---|---|---|---|---|---|---|
| TypeScript strict (`tsc --noEmit` incremental) | ✓ default | — | — | — | — | — |
| ESLint / Biome / oxlint (changed files) | ✓ default | — | — | — | — | — |
| Cyclomatic complexity | ✓ default | — | — | — | — | — |
| Dead-code detection (Supermodel Deadcode Hunter) | — | possible | ✓ default-bridging | ✓ Stop | — | — |
| Import-cycle detection | ✓ default | — | — | — | — | — |
| Architecture rules (Dependency Cruiser, custom) | possible (cached graph) | — | — | ✓ default | — | — |
| Doc-vs-signature drift | possible | — | — | ✓ default | — | — |
| Whole-project type-check | — | possible (cached) | ✓ default-bridging | ✓ Stop | — | — |
| **LLM naming/abstraction review** | — | — | — | ✓ default | — | — |

### 7.3 Lane C — Security and Supply Chain (organized by bug class)

| Bug class / check | T1 local | T2-blocking | T2-bridging | T3 Stop/CI/LLM | T4 scheduled | T5 continuous |
|---|---|---|---|---|---|---|
| **Secrets — inline detection (high-confidence patterns)** | ✓ default fail-closed | — | — | — | — | — |
| Secrets — Gitleaks (changed diff verification) | possible | ✓ admitted | — | ✓ default | — | — |
| Secrets — Gitleaks (full history) | — | — | — | ✓ pre-push | ✓ default | — |
| **Dependency CVEs — OSV-Scanner (lockfile delta)** | ✓ event-triggered | — | — | — | — | — |
| Dependency CVEs — OSV-Scanner (full closure) | — | — | ✓ event-bridging | ✓ default | ✓ default | ✓ external-feed-poll |
| License + maintainership + postinstall check on new deps | — | ✓ event-triggered | — | ✓ default | — | — |
| **Pattern SAST — Semgrep curated rules (changed files)** | ✓ default | — | — | — | — | — |
| Pattern SAST — Semgrep org policy | — | ✓ admitted | ✓ default-bridging | ✓ default | — | ✓ scheduled-poll |
| **Taint analysis — Semgrep interfile/pro** | — | ✓ admitted | ✓ default-bridging | ✓ default | — | — |
| Taint analysis — CodeQL (incremental, prebuilt DB) | — | experimental | ✓ default-bridging | ✓ default | — | — |
| Taint analysis — CodeQL (full DB + full query pack) | — | — | — | — | ✓ default | — |
| **Misconfiguration — Trivy (changed Dockerfile/IaC)** | — | ✓ event-triggered | — | — | — | — |
| Misconfiguration — Trivy (full image scan) | — | — | — | ✓ pre-push | ✓ nightly | — |
| Misconfiguration — Checkov / tfsec (changed IaC) | possible | ✓ event-triggered | — | ✓ default | — | — |
| **Reachability filter on dependency CVEs** | — | ✓ default (graph-derived) | — | ✓ default | — | — |
| **Supply-chain posture — OpenSSF Scorecard** | — | — | — | — | ✓ default | — |
| Supply-chain posture — SLSA / provenance / branch protection | — | — | — | — | ✓ release-time | — |
| **Domain-specific custom rules (workspace/tenant/auth invariants)** | ✓ default (Semgrep) | possible (CodeQL) | ✓ default-bridging | ✓ default | — | — |
| **LLM security-pattern review** (auth-fit, tenant-isolation) | — | — | — | ✓ default | — | — |

### 7.4 Lane D — Runtime and Behavioral Resilience

| Tool / check | T1 local | T2-blocking | T2-bridging | T3 Stop/CI/LLM | T4 scheduled | T5 continuous |
|---|---|---|---|---|---|---|
| fast-check property tests (bounded N runs) | — | ✓ admitted | ✓ default-bridging | ✓ default | — | — |
| fast-check (deep shrink, large N) | — | — | — | — | ✓ default | — |
| **Coverage-guided fuzzing (untrusted-input parsers)** | — | — | — | — | — | ✓ default |
| Continuous property-test corpus | — | — | — | — | — | possible |
| Schemathesis (changed OpenAPI/GraphQL diff) | — | ✓ event-triggered | — | ✓ default | — | — |
| Schemathesis (full schema fuzz) | — | — | — | — | ✓ default | — |
| API contract diff (schema breaking-change detector) | ✓ event-triggered | — | — | — | — | — |
| Playwright e2e (smoke, headless) | — | — | ✓ default-bridging | ✓ default | — | — |
| Playwright e2e (full suite) | — | — | — | — | ✓ default | — |
| Performance microbench (per-function hot-path budget) | — | possible | ✓ default-bridging | ✓ default | — | — |
| Performance regression (whole-suite) | — | — | — | — | ✓ default | — |
| Flakiness sampling (N=5 reruns on subset) | — | — | — | — | ✓ default | — |
| Migration smoke (apply + verify schema diff) | — | ✓ event-triggered | — | ✓ default | — | — |
| **LLM intent/pattern-fit review** | — | — | — | ✓ default | — | — |

---

## 8. Categorization Axes for Reasoning About the Stack

*Goal: Five axes for reasoning about why a tool belongs where it belongs — used when adding a new tool or auditing for coverage gaps.*

### 8.1 Five axes that matter most

*Goal: Apply when adding any new tool to determine where it belongs.*

**Axis 1 — Lane (§5):** A / B / C / D. Answers *what bug class are we addressing?*

**Axis 2 — Cadence (§6):** Tier 1 / 2-blocking / 2-bridging / 3 / 4 / 5. Answers *what latency budget and trigger context?*

**Axis 3 — What's being verified:** SUT vs. test vs. relationship.

| Verifies production code | Verifies test code | Verifies relationship |
|---|---|---|
| Static analysis (CodeQL, Semgrep, ESLint) | Assertion density, placeholders, `.only` ban | Coverage |
| TypeScript strict mode | Test-isolation gates, fixture-leak detection | Mutation |
| Cyclomatic complexity | Test-runtime ratchet | Red-then-green |
| Performance regression | Assertion-roulette, over-mocking | CRAP |
| Migration safety | Test-block-count regression | SUT-import check |
| Dependency vulns | Mocking-the-SUT-self | Acceptance criteria binding |
| Cross-file invariants | Duplicate test names | Property-test counterexamples |
| Doc drift | Real-I/O-in-units | Test-to-code feature map |

**Axis 4 — Adversarial robustness:** how gameable?

- **Hard to game (external reality):** Acceptance tests against real endpoints, property tests with random seeds, performance benchmarks, real-bug regressions, SCA against external vulnerability DBs, secret scanning of high-entropy strings, LLM-review-of-pattern-fit.
- **Moderately gameable (finite explicit rule set):** CodeQL queries, Semgrep rules, mutation testing.
- **Easily gameable (pattern-matchable surface):** Shape checks, coverage percentage, test counts.

**Design implication:** stack must contain at least one hard-to-game signal per lane. Otherwise the agent calibrates to gameable signals over time.

**Axis 5 — Deterministic vs. probabilistic vs. heuristic vs. judgment:** dictates gating policy.

- **Deterministic** (same input → same output): can hard-block.
- **Probabilistic / sampled** (real findings, not exhaustive): advise with confidence intervals.
- **Heuristic** (needs judgment): never hard-block; only inform.
- **Quasi-deterministic with recall risk** (deterministic for rule set, but rule set is finite): can hard-block within rule scope.
- **Judgment (LLM review):** never hard-block; surfaces findings as model-based opinions; trust calibrated through track-record over time.

### 8.2 Three more axes for tool decisions

*Goal: Secondary axes useful for caching, infrastructure, and trigger decisions.*

**Axis 6 — Static vs. dynamic:** predicts cost and Cloudflare-primitive applicability.

**Axis 7 — Scope of context required:** single-file / graph-derived / project-derived / environment-derived. Dictates cache strategy.

**Axis 8 — Trigger:** per-edit / event-triggered / periodic / continuous. Same tool can have variants on different triggers.

### 8.3 Using them together

*Goal: Concrete procedure for adding a new tool — fill in the row, identify where in the matrix, decide gating policy.*

When adding a new tool, fill in the row (Lane, Cadence, What it verifies, Adversarial robustness, Determinism, Static/dynamic, Context scope, Trigger). When deciding whether the stack has a gap, build the matrix of (Lane × Bug class) and verify every important cell has coverage. Cells with no coverage are blindspots (§15).

---

## 9. Lane A Ship-Now Items

*Goal: Enumerate the cheap, deterministic, synchronous-local Lane A work that ships in Phases 1–2 — these are the foundation everything dynamic later depends on.*

### 9.1 Close the new-file-gate loop

*Goal: Plug the assertion-free blind spot in `behavioral-checks.ts:679` by evaluating companion test bodies at write time.*

Current gate accepts a test file existing without inspecting content. Add companion PreToolUse check that evaluates test body at write time: `checkPlaceholderTests`, `checkAssertionFree`, cross-check that it references the public surface the gate extracted from the impl. *"You must write a test"* → *"...and it must assert against the symbols I named."* Microseconds. (Phase 1.)

### 9.2 Enforce red-then-green

*Goal: Require companion tests to be observed-red before impl lands — cheapest ground-truth-ish signal in the stack.*

Cycle tracker already records `red_at`. Require companion test to be *run and seen red* before impl lands. Harness cost ~0; cost displaced onto agent (one Bash call, 0.8–3.6s). Effect: test seen red-then-green has proven it can fail — effectively a 1-mutant mutation test ruling out tautologies. **Does not catch subtle-bug blindness; only mutation does.** (Phase 1.)

### 9.3 Recurrence feedback

*Goal: Background process that learns from `harness_missed` events — the only path by which Layer 1 keeps pace with new gaming patterns.*

When a bad test slips through (`harness_missed` event), flag it, scaffold a new shape check. Offline JSONL aggregation, 0 hot-path cost. Not a gate; meta-process that raises Layer 1's coverage of gaming patterns over time. (Phase 2.)

### 9.4 Test-runtime ratchet (keystone)

*Goal: Measure per-file test runtime so Tier 2-blocking admission is data-driven, not guessed.*

Harness intercepts test-run commands; vitest emits per-file `Duration`. Record to `.interlinked/test-timings.json` with absolute ceiling and regression ratchet. Deterministic, free. **Precondition for any Tier 2 admission.** Without it, admission is a guess. (Phase 2.)

Don't *ban* slow tests, *price* them. `behavioral-diff-checks.integration.test.ts` at 2.88s spawning real git is the correct test for code that shells to git. Block avoidable slowness; route legitimate integration tests to different cadence.

### 9.5 Promote advisory checks to gates

*Goal: Convert four built-but-advisory unit-test gates to PreToolUse blocks — applied only to unit-classified tests via Phase 0 classifier.*

`checkTestSubprocessDefaultTimeout`, `checkRealIoInTests`, `checkHardcodedTimeoutInTests`, `checkTestNondeterminism` — built, currently advisory. Promote to PreToolUse blocks **for tests classified as unit** (Phase 0 classifier). Inverts for acceptance (§12). (Phase 1.)

### 9.6 Piggyback coverage on agent test runs

*Goal: Inject `--coverage` into agent test invocations — get diff-aware coverage and per-file ratchet input for free.*

Inject `--coverage` into agent's vitest invocations harness already intercepts. V8 overhead (10–30%) on a run that's happening anyway. Yields diff-aware "new lines hit?" (free, Tier 1) and per-file ratchet (whole-suite, Tier 3). (Phase 2.)

---

## 10. Lane B, C, D Ship-Now Items

*Goal: Enumerate the equivalent ship-now items for Lanes B, C, D — most are wiring existing tools rather than building from scratch.*

Detailed in Phase 1 and Phase 3 of §18. Summary:

### 10.1 Lane B — Code Correctness (Phase 3, Tier 1)

*Goal: Wire existing static-analysis tools as harness finding sources with consistent confidence semantics.*

- TS strict + `tsc --noEmit` incremental as harness finding source.
- ESLint / Biome / oxlint integrated as PreToolUse-blocking on changed files.
- Import-cycle detection.
- Dead-code detection via Supermodel (users only; internal fallback skips).
- Doc-vs-signature drift advisory.

### 10.2 Lane C — Security and Supply Chain

*Goal: Ship the highest-risk-per-effort security items immediately; defer infrastructure-heavy items (CodeQL, full image scans) to Tier 3/4.*

- **Inline secret detection (Phase 1, Tier 1, fail-closed).** Pattern-based PreToolUse block on confirmed secret patterns. No Gitleaks dependency.
- **Gitleaks as project/strict verification (Phase 3, Tier 3).**
- **OSV-Scanner event-triggered on lockfile change (Phase 3, Tier 1).**
- **License/maintainership/postinstall check on new-dep events (Phase 3, Tier 2-blocking event-triggered).** Block on unauthorized postinstall scripts.
- **Curated Semgrep ruleset for changed files (Phase 3, Tier 1).** Start small — 10–20 rules.
- **GitHub secret scanning enabled at repo level (Phase 3, free, runs in background).**
- **Domain-specific custom rules — inventory begins (Phase 3, thinking work), authoring (Phase 7).**
- Defer to Tier 3/4: CodeQL full, Semgrep full policy, full image scans, Scorecard, SLSA.

### 10.3 Lane D — Runtime Resilience (Phase 2 + Phase 9)

*Goal: Establish flakiness baseline first (validates ratchet signal); defer fuzzing and full e2e to later phases.*

- **Flakiness baseline (Phase 2, Tier 4 scheduled).** Sample N=5 reruns nightly.
- **fast-check integration for pure-function modules (Phase 9, Tier 2-blocking or bridging).**
- **API contract diff on schema-file change (Phase 9, Tier 1, event-triggered).**
- **Migration smoke test on migration-file change (Phase 9, Tier 2-blocking event-triggered).**
- **Performance microbench for known hot paths (Phase 9, Tier 3).**
- **Coverage-guided fuzzing (Phase 9, Tier 5).** Targeted at untrusted-input parsers.
- Defer to Tier 4: Schemathesis full fuzz, Playwright full e2e, deep property-test shrink, accessibility audits.

---

## 11. Supermodel Integration — Per-Dimension Mapping

*Goal: Map Supermodel's four graph layers to harness needs lane-by-lane. Note where the graph cheaply unlocks new capability vs. where its recall limits bite.*

| Dimension | Supermodel contribution | Lane | Status |
|---|---|---|---|
| **Test coverage (static)** | Test Coverage Map. Recall-limited: dynamic dispatch, higher-order, re-exports invisible. Union with file-level imports as safety floor. | A | Test selection: usable now. Coverage % gates: still need V8. |
| **Dependency structure** | Flagship. File-level imports give file-level blast radius. Function-level `[calls]` collapses many hub edits. | A, B | File-level: wired. Symbol-level: parsed, surfaced as advisory, **not yet wired into covering-set computation.** Phase 5. |
| **Reachability filter on dependency CVEs** | Call graph filters OSV findings to actually-reachable vulnerabilities. | C | Phase 5. |
| **Dead-code detection** | Supermodel Deadcode Hunter. | B | Phase 3 surfaces as Tier 3 finding. |
| **Cyclomatic complexity** | Composed: weighted blast radius. Feeds CRAP. | A, B | Phase 3. |
| **Module sizes** | Useful indirectly: graph identifies *structural seams* for Compression Program (§19) file-splitting recommendations. | B | Phase 3 advisory; §19 consumer. |
| **Mutation testing** | Graph supplies covering set, priority order. | A | Phase 5. |
| **Cross-file invariants** | Custom graph queries. Compose with `/enforce`. | B, C | Phase 7. |
| **Architecture rules** | Domain graph supports module-boundary rules. | B | Phase 3 baseline; Phase 7 custom. |
| **Acceptance tests** | **Graph cannot see them.** Need explicit feature-binding (capability tags + symbol map). | A | Phase 6. |
| **RGR / refactor detection** | Indirect — signature-change vs. internal-only delta. | A | Phase 1. |
| **CRAP** | Free composition. | A | Phase 2 after coverage piggyback. |
| **Security dataflow** | Custom Semgrep + graph call paths produce stronger taint detection. | C | Phase 7. |
| **LLM review context** | Graph supplies "what calls this, what does this call" to prompts — improves judgment quality. | all | Phase 7.5. |

**Pattern:** Supermodel makes *scoping* cheaper and more accurate. Can't fix epistemic limits of the checks themselves.

**Caveats:** Freshness race (`dependency-view.ts` trusts shard only when `shard_mtime ≥ source_mtime`); Supermodel shards exist only for paying users.

---

## 12. Acceptance Tests as a First-Class Category

*Goal: Establish acceptance tests as a first-class category with inverted gates, outer-loop cycle tracking, and capability-tag feature-binding per Martin discipline.*

Classification ships in Phase 0; inverted gates in Phase 1; full capability-map work in Phase 6.

### 12.1 Where Layer 1 inverts

*Goal: Show concretely which unit-test gates flip semantics when applied to acceptance tests.*

| Check | Unit-test semantics | Acceptance-test semantics |
|---|---|---|
| `real_io_in_tests` | Bad | **Required** |
| `over_mocking` | Bad | **Mocks invalidate the test** |
| `test_missing_sut_import` | Bad | **Correct — invokes through HTTP/CLI** |
| `mocking_the_sut_self` | Bad | N/A |
| `assertion_density` | High = good | Low normal |
| `prod_delta_no_test_delta` | 1:1 expected | **1:N — one feature test covers dozens of impl files** |
| `prod_test_loc_ratio` | Symmetric | Breaks symmetrically the opposite direction |

### 12.2 Where structural gates break

*Goal: Show why the new-file-gate and per-file cycle tracker fail under ATDD without explicit handling.*

**`tdd_new_file_gate`** demands companion test per file. ATDD: scenario written first, each impl file would be blocked demanding its own companion.

**TDD cycle tracker** is per-file; acceptance tests run on outer loop — red for hours through many inner unit cycles. Phase 6 two-tier tracker.

### 12.3 Where Layer 2 breaks worse

*Goal: Show why coverage and mutation behave pathologically on acceptance tests without explicit handling.*

- **Coverage inflation:** one acceptance test hits 60% of codebase via indirection.
- **Mutation cost catastrophe:** slow, broad tests run once per mutant.
- **Mutation score weirdness:** surviving mutant could mean "tests are weak" or "this internal mutation isn't externally observable."
- **Call graph blindness:** §11.

### 12.4 Architectural correction (Phase 6)

*Goal: First-class category, inverted gates, outer-loop tracker, ratio-gate exclusion, feature-binding.*

Acceptance tests need first-class category, identified by path/annotation, with:
- Inverted gate set (Phase 1, after Phase 0 classifier).
- Outer-loop cycle tracker.
- Exclusion from per-file ratio gates.
- Explicit feature-binding mechanism (test → covered symbols).
- Tier 3 cadence by default; Tier 2-blocking only for short parallelizable scenarios; Tier 2-bridging for medium-length scenarios.

### 12.5 Capability Tags as Feature-Binding (Martin Discipline)

*Goal: Make acceptance tests legible to graph routing via capability tags + capability-to-symbol map, without coupling spec to implementation.*

Bob Martin's framing: acceptance tests are *executable specifications*, owned by humans/business stakeholders, signed off as the contract.

**v3 integration:** acceptance scenarios carry capability tags (`@payment-authorization`), not function-name manifests. A separate **capability-to-symbol map** (project-scoped artifact, version-controlled) maps tags to implementation symbols. The scenario stays decoupled from implementation; the map evolves with code.

**Drift detector** (Tier 4 scheduled) runs each scenario with coverage on, compares actual-covered-symbols to capability-map-declared symbols, emits drift findings.

**Why this matters:** the scenario doesn't know about functions; the routing layer translates tags to symbol-sets via the map; the harness gains graph visibility into acceptance tests without coupling the spec to the implementation.

---

## 13. Tier 2 — Stage 2R Remote-Sync Gate Design

*Goal: Specify the Tier 2 remote-sync mechanism — supervisor DO + Facet pattern for V8-class work, Sandboxes for Linux-class work, with blocking/bridging mode split and admission-controlled by §13.9 formula.*

### 13.1 Staging within the verification lifecycle

*Goal: Show that Stage 2R is one stage among many — does not replace Stop, CI, scheduled, or continuous; each addresses a different epistemic moment.*

```
Stage 2R-blocking — PreToolUse remote-sync, ≤30s hard ceiling (Phase 4)
  Surface:        PreToolUse hook, deterministic-patch tools only
  Mode:           Pre-execution simulation against proposed patch
  Authority:      Advisory first (shadow mode), gate later — can fail-closed
  Failure:        Fail-open on infra failure or timeout
  Receipt:        Speculative, bound to base + patch hash

Stage 2R-bridging — PreToolUse-start + PostToolUse-consume, ≤60s total (Phase 4+)
  Surface:        PreToolUse starts process; PostToolUse consumes via additionalContext
  Mode:           Result returns after edit has landed
  Authority:      Advisory only — cannot block (edit already on disk)
  Failure:        Fail-open; finding may still surface to agent on next turn
  Receipt:        Authoritative for landed state; promotion target for Compression Program (§19)

Stage 5 — Stop / PostToolUse on landed diff
Stage 6 — pre-push / CI authoritative
Stage 6.5 / Tier 4 — scheduled discrete
Tier 3 LLM review (Phase 7.5) — async model-based judgment per edit
Tier 5 — continuous with persistent state
```

### 13.2 Architectural premise

*Goal: Justify the cloud substrate — local cost is bounded by cores; remote cost is bounded by snapshot restore + fan-out width.*

Local cost model and cloud cost model categorically different. Locally, mutation bounded by cores. Remotely: snapshot restore + fan-out moves some checks from "async only" into "remote-sync possible."

**Phase 3.5 measurement spike (§18) validates this premise before any Phase 4 build.**

### 13.3 Primitive-to-check mapping (Agents Week 2026 substrate)

*Goal: Match each harness execution context to the correct Cloudflare primitive. V8 isolates for pure JS/TS work; Sandboxes for Linux-class work; Containers for full systems.*

**Three-way decomposition:**

| Execution context | Substrate | Startup | Used for |
|---|---|---|---|
| **Pure JS/TS, no fs, no subprocess, millisecond-class** | Dynamic Worker Loader + Facet | single-digit ms | Stryker mutation per-mutant, fast-check property runs, lint/type-check, AST analysis, graph queries, CRAP, pattern-based Semgrep |
| **JS/TS + filesystem + subprocess, second-class** | Sandbox restored from snapshot | 1–3s cold, <1s warm-restore | Acceptance tests, integration tests, coverage-guided fuzzing, Semgrep interfile/pro, anything requiring `npm install` |
| **Full Linux env with persistent services** | Container | 1–3s+ | Postgres-backed acceptance tests, Playwright e2e |

**Detailed mapping by harness component:**

| Harness component | Cloudflare primitive | Why |
|---|---|---|
| **Per-mutation execution (Phase 4 MVP)** | Dynamic Worker Loader instantiating Stryker as a Facet | V8 isolate, 100× faster than container |
| **Supervisor DO holding admission, receipt, audit state** | Durable Object class (parent of Facets) | Co-located SQLite for admission-log, finding-history, baselines |
| **Per-edit ephemeral execution state** | Durable Object Facet (child of supervisor) | Each edit's results in own SQLite; parent's DB off-limits |
| **Property tests (fast-check, bounded N)** | Dynamic Worker Loader + Facet | Pure JS |
| **Acceptance tests, integration tests, fuzz corpus runs** | Sandbox with backup/restore snapshot | Needs real filesystem |
| **Coverage-guided fuzzing (Tier 5)** | Sandbox + DO Facet for corpus state | Sandbox executes; Facet stores corpus metadata |
| **CodeQL incremental** | Sandbox with DB volume + DO Facet for DB cache | DB build needs real fs |
| **Semgrep curated (changed files only)** | Dynamic Worker (pure rule eval) or Sandbox (interfile/pro) | Depends on mode |
| **e2e tests (Playwright)** | Container | Sandbox insufficient |
| **Repo state delivery** | Artifacts + ArtifactFS | Blobless clone; receipt binds to Artifacts commit hash |
| **Per-tenant verification rule policy** | Dynamic Workflows | Forward-compat for multi-agent |
| **Orchestration of fan-out runs** | Workflows V2 | 50,000 concurrent instances |
| **Egress security from Sandboxes** | Outbound Workers | Zero-trust credential injection; TLS interception |
| **LLM review prompt execution** | Dynamic Worker invoking external LLM API via Outbound Worker | Credentials never enter sandbox |

**The supervisor-facet pattern for the Phase 4 MVP:**

```
                  ┌─────────────────────────────────────────┐
                  │ Supervisor DO (MutationSupervisor)       │
                  │  - Own SQLite: admission-log,            │
                  │    finding-history, baselines, cache     │
                  │  - Loads Stryker code via env.LOADER     │
                  │  - Signs and stores receipts             │
                  │  - Enforces cost ceilings per session    │
                  │  - Routes egress through Outbound Worker │
                  └────────────────┬────────────────────────┘
                                   │
                                   │ this.ctx.facets.get("mutant-N", ...)
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
        ▼                          ▼                          ▼
  ┌──────────┐              ┌──────────┐              ┌──────────┐
  │ Facet 1  │              │ Facet 2  │              │ Facet N  │
  │ Mutant A │              │ Mutant B │              │ Mutant N │
  │ own SQL  │              │ own SQL  │              │ own SQL  │
  └──────────┘              └──────────┘              └──────────┘
```

### 13.4 Stage 2R lane spec

*Goal: Define the Stage 2R interface — what tools surface to it, how admission decides, what receipts bind.*

```
Surface:        PreToolUse (blocking-mode) and PreToolUse-start + PostToolUse-consume (bridging-mode).
                Deterministic-patch tools (Edit, MultiEdit, Write).

Admission:      Local cheap layer computes blast radius, affected tests, mutant estimate,
                cache-hit probability, expected p95.
                Admit to blocking iff predicted_p95_ms < 30000 AND remote_sync_score > threshold.
                Admit to bridging iff predicted_p95_ms < 60000 AND remote_sync_score > threshold.

Budget:         blocking_target_ms:   10000–25000 (well under hard 30000 ceiling)
                blocking_hard_ms:     30000 (Cloudflare hook hard limit)
                bridging_target_ms:   30000–50000 (well under hard 60000 ceiling)
                bridging_hard_ms:     60000

Failure policy: infra failure         → fail-open + receipt + enqueue async rerun
                stale base hash       → do not run / fail-open + enqueue async
                deterministic failure → may block (blocking mode); advisory (bridging mode)
                timeout in blocking   → fail-open; check failed to fit budget
                timeout in bridging   → fail-open; result may still surface as Tier 3 if finishes
                cost ceiling          → fail-open + degrade tier
                circuit breaker open  → fail-open

Receipt binding:
                base_repo_hash
                tool_call_id
                proposed_patch_hash
                artifacts_commit_hash  (when ArtifactFS hydration used)
                supervisor_do_id
                facet_ids[]
                sandbox_snapshot_id    (when Sandbox path used)
                check_plan_hash
                covering_set_hash      (Phase 5 populated)
                result_hash
                p50/p95 observed for this (file, check) pair
                substrate              ("dynamic_worker_facet" | "sandbox" | "container")
                mode                   ("blocking" | "bridging")
```

### 13.5 The bridging pattern — PreToolUse-start + PostToolUse-consume

*Goal: Specify how Tier 2-bridging actually works mechanically — the only way to extend the discipline window beyond 30s without going fully async.*

Cloudflare hook budgets are strict per-hook: 30s for PreToolUse, 30s for PostToolUse. The bridging pattern threads work between them via the tool-call's own duration plus `additionalContext`:

```
Time →
─────────────────────────────────────────────────────────────────
  PreToolUse hook (≤30s)
    │
    ├─ Phase 1: blocking checks (must complete in this hook)
    │
    └─ Phase 2: bridging-mode work starts
         │
         │  Kicks off remote work in supervisor DO
         │  Records bridging_token in workspace state
         │  Returns to caller (allowing hook to complete in time)
         │
         ▼
  Tool call writes to disk
    │
    │  (bridging work continues running in cloud during this window)
    │
    ▼
  PostToolUse hook (≤30s)
    │
    └─ Phase 3: check workspace state for bridging_token
         │
         │  Poll supervisor DO for completion
         │  If ready: collect result, return via additionalContext
         │  If not ready by Post deadline: fail-open, fall to Tier 3
         │
         ▼
  additionalContext surfaced to agent (advisory; edit already landed)
```

**What suits bridging mode:**
- **Mutation against larger blast-radius files** (mid/hub) that don't fit blocking
- **Whole-suite coverage** that needs all shards to merge
- **Semgrep interfile/pro** on broader scope
- **Acceptance tests with longer scenarios** (still parallelizable but ≥30s)
- **CodeQL incremental queries** that exceed 30s
- **Performance benchmarks** that need warmup runs

**What does NOT suit bridging mode:**
- **Anything that needs to block the edit.** Secrets, fail-closed compliance gates. These must fit blocking or be rejected entirely.
- **Checks whose value depends on pre-edit state.** If the check can only meaningfully report against the state-before-edit, bridging is wrong.
- **Anything sub-second.** Bridging has overhead; if a check fits blocking, run it blocking.

**Bridging mode admission rules:**
- Same admission formula (§13.9) as blocking, with relaxed `predicted_p95_ms < 60000` ceiling.
- Bridging-mode receipts marked `mode: "bridging"` and `authority: "advisory"`.
- Bridging-mode findings always surface as advisory regardless of severity.

**Bridging as Compression Program (§19) staging area:** every bridging-mode check is implicitly a candidate for promotion to blocking. The Compression Program tracks bridging-mode latency over time and identifies which checks are close to fitting blocking — then attacks the specific latency contributors (file size, edit scope, fan-out width, sub-check parallelization) that would close the gap. Bridging is not the destination; it's the antechamber.

### 13.6 End-to-end remote-sync budget (revised, measurement-pending, substrate-corrected)

*Goal: Quantify expected wall-clock costs per substrate and per mode, marking everything as Phase 3.5-measurement-pending.*

**All numbers in this table are estimates pending Phase 3.5 measurement.**

| Stage | Estimate | Notes |
|---|---|---|
| Hook fires, hash diff + repo state | ~5ms | Local |
| Supervisor DO lookup → wake (warm path) | <50ms | DO already running |
| Supervisor DO cold start | ~200–500ms | Rare; supervisor stays warm |
| Worker Loader code resolution → Facet instantiation | single-digit ms per facet | V8 isolate |
| Code delivery via ArtifactFS | ~10–15s cold; near-zero incremental | Blobless clone |
| Workflows orchestration spinup (when needed) | 1–2s | Phase 3.5 measures |
| **Compute — leaf, mutation diff-scoped, 100-way fan-out via Facets** | **0.5–2s** | Per-mutant runtime parallel |
| **Compute — mid, mutation diff-scoped, 100-way fan-out** | **2–6s** | |
| **Compute — hub, mutation diff-scoped, mutant×test fan-out** | **3–12s** | Experimental |
| **Compute — whole-suite coverage, 50-shard fan-out via Sandboxes** | **8–15s** | Sandbox needed |
| **Compute — acceptance, 5 short scenarios in Sandboxes** | **8–15s** | |
| **Compute — Semgrep core via Dynamic Worker** | **<500ms** | |
| **Compute — Semgrep interfile/pro via Sandbox** | **3–10s** | |
| **Compute — CodeQL incremental on cached DB** | **5–15s** | DB caching required |
| **Compute — mutation with property tests in covering set** | **5–30s+** | Tier 4 default |
| Egress via Outbound Worker (when needed) | +5–20ms per request | |
| Result aggregation in supervisor + receipt write | 100–300ms | |
| Return to caller | 50–200ms | RTT |

**Honest totals (pending Phase 3.5, mode-classified):**

| Workload | End-to-end estimate | Mode (today) | Compression target |
|---|---|---|---|
| Leaf mutation | 2–6s | **Blocking** ✓ | Already blocking |
| Mid mutation | 5–12s | **Blocking** ✓ (post-Phase 5) | Already blocking |
| Hub mutation | 8–20s | **Blocking** if orchestrator built; else **Bridging** | Blocking — Compression |
| Whole-suite coverage | 12–25s | **Bridging** | Blocking via smaller shards |
| Acceptance (short scenarios) | 15–25s | **Bridging** | Blocking via parallelization |
| CodeQL incremental | 10–30s | **Bridging** | Blocking via DB-caching maturity |
| Semgrep interfile | 5–15s | **Blocking** ✓ | Already blocking |

### 13.7 PreToolUse is predictive, not authoritative

*Goal: Bound the epistemic claim of Stage 2R — it's a hypothesis about counterfactual state.*

Stage 2R is *simulating proposed patch against current base state*. Actual local edit has not happened yet.

Tool type modulates predictive validity:
- **Edit/Write/MultiEdit:** proposed patch deterministic, base queryable → high validity.
- **Bash:** can produce different fs state than simulation → low validity. Opt-in per command pattern only.

**PostToolUse (and Tier 3 Stop) remain the authoritative observation of landed state.**

### 13.8 Cache invalidation

*Goal: Specify how Stage 2R receipts cache and when caches invalidate.*

A cached `(file_state_hash, diff_hash) → "all green"` is safely reusable.

A cached `(file_state_hash, diff_hash) → "2 mutants survived in foo"` finding **is not** — if a different file's test was strengthened to cover `foo` indirectly, finding is stale.

**Cache keys must include covering-set hash** (Phase 5 populated). Bites mutation harder than coverage.

**Lane C scanners have their own invalidation rules:** SCA findings invalidate on lockfile hash *and* external-vuln-DB timestamp (Tier 5 continuous-SCA polls). CodeQL findings invalidate on DB rebuild or query-pack version change.

### 13.9 Agent-stall economics — admission formula

*Goal: Decide which checks earn the per-edit budget. We want the agent to stall in the 30s/60s window because that's the point — but within that window we want maximum valuable discipline.*

**Admission formula:**

```
remote_sync_score =
    predicted_finding_probability
  × expected_finding_severity
  × confidence_in_result
  ÷ predicted_stall_seconds

Admit to blocking iff:
    predicted_p95_ms      < 30000  (HARD - Cloudflare hook limit)
  AND remote_sync_score   > project_threshold
  AND admission_features.cache_status != "fresh_hit"
  AND admission_features.queue_depth  < queue_ceiling
  AND admission_features.session_cost_remaining > predicted_cost

Admit to bridging iff:
    predicted_p95_ms      < 60000  (HARD - bridging hard limit)
  AND remote_sync_score   > project_threshold_bridging  (typically lower)
  AND blocking admission preconditions for cache/queue/cost
```

**Component definitions and bootstrap policy:**

| Term | Source | Bootstrap |
|---|---|---|
| `predicted_finding_probability` | Per-(file × check-type) historical rate | Blast-radius prior: leaf=0.05, mid=0.15, hub=0.35; replace after N≥20 |
| `expected_finding_severity` | Per-check-type constant | Constants in config |
| `confidence_in_result` | 1.0 for deterministic + full covering set; degrade for recall risk | Default 1.0; drop to 0.6 if covering set from internal fallback |
| `predicted_stall_seconds` | Measured p95 × overhead constant | Cold-start estimate from blast-radius + mutant count |
| `project_threshold` | Configurable; calibrate against Phase 4 MVP shadow mode | Default permissive during shadow mode |

### 13.10 Typed admission decision schema

*Goal: Make admission decisions first-class typed objects, not buried conditionals. Every decision auditable.*

```typescript
type RemoteSyncAdmissionDecision = {
  decision: "admit_blocking" | "admit_bridging" | "route_async"
          | "skip_cached" | "defer_no_history" | "skip_low_value"
          | "skip_cost_ceiling";
  reason:
    | "cache_hit" | "predicted_p95_under_blocking_budget"
    | "predicted_p95_under_bridging_budget" | "predicted_p95_over_budget"
    | "hub_file" | "no_snapshot" | "no_history" | "queue_depth_high"
    | "low_expected_value" | "stale_base_hash" | "infra_circuit_breaker_open"
    | "session_cost_exhausted";

  mode: "blocking" | "bridging" | "async";
  lane: "A" | "B" | "C" | "D";
  check_type: string;

  predicted_p50_ms?: number;
  predicted_p95_ms?: number;
  predicted_stall_seconds?: number;

  predicted_finding_probability?: number;
  expected_finding_severity?: number;
  confidence_in_result?: number;
  remote_sync_score?: number;

  blast_radius_class: "leaf" | "mid" | "hub" | "mega_hub";
  blast_radius_source: "supermodel_calls" | "supermodel_imports" | "internal_fallback";
  covering_set_hash?: string;
  cache_status: "fresh_hit" | "stale" | "miss"
              | "covering_set_invalidated" | "external_db_updated";

  substrate: "dynamic_worker_facet" | "sandbox" | "container";
  artifacts_commit_hash?: string;

  base_repo_hash: string;
  proposed_patch_hash?: string;
  receipt_id?: string;
  supervisor_do_id?: string;
  bridging_token?: string;

  bootstrap_priors_used: boolean;
  history_observation_count: number;
  shadow_mode: boolean;
  decided_at_ms: number;
  compression_candidate?: boolean;  // bridging-mode entries flagged for §19
};
```

Every decision appended to `.interlinked/admission-log.jsonl`.

---

## 14. Cross-Cutting Concern — Mutation as Gameable Proxy

*Goal: Acknowledge mutation's gaming surface and design defenses around it — rotation, multi-signal composition, recurrence-feedback. The defense is the stack, not any single check.*

Mutation is the strongest practical behavioral-discrimination signal *for the mutator set Stryker generates*. Once a live gate at any tier, agent's optimization target shifts from "write valid tests" to "write tests that kill Stryker's mutators."

This is not solved by moving mutation to the cloud. **Cloud makes mutation cheap to run; doesn't make mutation a better optimization target.** Tighter inner loop makes calibration pressure stronger.

**Mitigations:**
- **Mutator rotation:** rotating subset at sync; full set at Stage 6 (Phase 10).
- **Multiple ground-truth signals:** red-then-green, acceptance, property tests, Lane C scanners, LLM review. **Cross-lane composition is the real defense.**
- **Periodic harness self-review:** recurrence-feedback loop applied to Layer 2 (Phase 2 + ongoing).
- **LLM-review-of-test-quality** as Tier 3 companion — asks "is this test actually testing behavior?" in natural language.

**Property tests + mutation interaction (Bob Martin's concern):** §2.4. Architectural correction: separate the cadences. Property tests are Lane D, mutation is Lane A; default exclusion of property tests from mutation covering sets.

**Related concerns:**
- Per-mutant `timeoutMS` produces false-killed mutants.
- Diff-scoping recall risk: incomplete covering set → false kills → silent downgrade from `[proven]` to `[heuristic]`.
- Test-runtime ratchet (§9.4) is one-way door without release valve.

---

## 15. Blindspots and Deferred Concerns

*Goal: Track what this plan does not yet cover, distinguishing retired items (now handled in build order) from genuine gaps still requiring follow-on work.*

### 15.1 Retired (now handled in build order)

*Goal: Show what was v2 blindspot but v3 absorbs into phases.*

- ~~Generated/vendored-code classification~~ → **Phase 0**.
- ~~Cost ceiling per session~~ → **Phase 3.7**.
- ~~Harness threat model~~ → **Phase 3.7** (lightweight); **Phase 10** (full).
- ~~Lane prioritization under contention~~ → **Phase 3.7**.
- ~~Rollback paths~~ → **cross-cutting discipline** (§16).
- ~~Shadow mode~~ → **cross-cutting discipline** (§16).
- ~~Compression toward blocking~~ → **cross-cutting discipline + dedicated §19**.
- ~~LLM review as first-class capability~~ → **Phase 7.5** in §18.

### 15.2 Remaining blindspots

*Goal: Real gaps. Each tagged with lane and intended cadence so the table doubles as a follow-on work catalog.*

| # | Blindspot | Lane | Eventual cadence | Notes |
|---|---|---|---|---|
| 1 | Dependency-change gates as discrete risk events | C | Tier 1 event-triggered | Phase 3 partial. |
| 2 | License and compliance risk depth | C | Tier 2 event-triggered | Phase 3 baseline; abandoned-package deeper. |
| 3 | Postinstall/build-script execution risk | C | Tier 2 event-triggered | Phase 3 blocks unknown; allowlist needs Phase 7. |
| 4 | Migration / schema / data-loss checks | D | Tier 2-blocking event-triggered | Phase 9 ships smoke. |
| 5 | Config / IaC drift | C | Tier 2 event-triggered + Tier 4 | Phase 3 partial; wrangler-specific deeper. |
| 6 | API contract compatibility depth | D | Tier 1 event-triggered | Phase 9 diff detector; semantic compat deeper. |
| 7 | Observability and rollback readiness | meta | Stage 6 / review | Not gated. |
| 8 | Test-pyramid composition as emergent property | A | Tier 4 reporting | Report shape over time. |
| 9 | The harness verifying itself (meta-mutation) | meta | Phase 10 | |
| 10 | Cross-language toolchain | meta | (out of scope) | TS-only fleet. |
| 11 | Multi-agent extension | meta | (separate doc) | Forward-compat in Phase 0; eventual peer-agent review as Tier 3 LLM extension. |
| 12 | Continuous fuzzing corpus management at scale | D | Phase 8/9 | |
| 13 | Provenance and SLSA as release-time stage | C | Stage 7 | Phase 10. |
| 14 | Generic CodeQL vs. custom domain rules tension | C | Phase 7 + Phase 9 | |
| 15 | LLM-review prompt-engineering discipline | meta | Phase 7.5 + ongoing | Templates need versioning, A/B testing. |

**Lane C remains the largest source of remaining blindspots.**

### 15.3 Forward-compatibility seams (deferred multi-agent extension)

*Goal: Preserve multi-agent option without building it — name the seams that must not be foreclosed.*

- **Receipts as transferable certificates.** §13.4 schema is content-hash-keyed and cryptographically verifiable from day one.
- **Capability maps as project-scoped artifact** (not agent-scoped).
- **Workspace-vs-session state cleanly separated** (Phase 0).
- **Lane independence.** §5 lanes are independently runnable.
- **Recurrence-feedback portable schema.** §9.3 JSONL structured for eventual federation.
- **Supervisor DO per-workspace pattern.** Multi-agent may key facets by `(agent_id, edit_id)` rather than just `edit_id`.
- **Dynamic Workflows for per-tenant verification policy.** MIT-licensed library released May 2026 is the substrate.
- **Artifacts namespaces per-agent.** Phase 4 uses one per workspace; multi-agent may use one per agent.
- **Peer-agent review as Tier 3 LLM-review extension.** Same substrate as LLM review (Phase 7.5).

None require build work in v3. All require *not foreclosing* the option.

---

## 16. What's Important to Quentin and Cross-Cutting Disciplines

*Goal: Anchor constraints that should be re-checked at every fork. Three operational disciplines (shadow mode, rollback paths, compression toward blocking) apply across every phase.*

### 16.1 Preferences anchored throughout

*Goal: List the design preferences that shaped this doc.*

- **Gauntlet philosophy.** The 30-second window is *budget for discipline*, not constraint to minimize. The whole point of the harness is to force quality scrutiny that the agent would otherwise skip.
- **Multi-agent as load-bearing reason for single-agent rigor.** The gauntlet must be deterministic, receipt-bound, and consistent because it *is* the trust boundary for any future multi-agent extension.
- **Direct, unhedged analysis.** No reflexive softening of structural problems.
- **Push back when imprecise.** v3 downgrades v2's casual claims; v3.1 corrected substrate placement; v3.2 corrects the framing error that treated 30s as a soft target rather than a hard ceiling.
- **Measure rather than infer.** Phase 3.5 is mandatory before Phase 4 commits to numbers — measures **both substrates**.
- **Cloudflare Agents Week 2026 stack as default infrastructure.** Dynamic Worker Loader + Facets (V8-class work); Sandboxes (Linux-class); Outbound Workers (egress security); Artifacts + ArtifactFS (state delivery); Workflows V2 (orchestration); Dynamic Workflows (forward-compat per-tenant policy).
- **Open-weight LLMs only for any harness review work.** The harness is infrastructure, not an agent — it should use predictable, controllable, self-hostable models (gpt-oss-safeguard, Llama, Gemma, Granite, Mistral families). Frontier closed models (Sonnet/Opus, GPT-5.x) are the agent's tier; the harness does not invoke them. This is both a cost discipline and a sovereignty/auditability discipline. Connects to the broader "deterministic API calls > vector RAG" pattern in Quentin's MCP work — prefer controllable predictable primitives over opaque flexible ones.
- **The Lagging Strand discipline.** Every "X takes Y seconds" claim is measured, cited, or modeled with explicit assumptions. No invented numbers.
- **`/enforce` as composition substrate.** Cross-file invariants compose with existing `/enforce` skill system.
- **Single-agent pipeline first.** Multi-agent extension deferred to separate Protocol doc.
- **Deployment-target awareness — Claude Managed Agents on Cloudflare.** CMA integration (May 2026) is the eventual production home.

### 16.2 Shadow mode discipline (cross-cutting)

*Goal: Every new check ships advisory-first, accumulates calibration data, promotes to blocking only after measurement.*

**Every new check ships advisory-only first.** Logs what it *would* have flagged for a calibration window (typically one week or N=50 edits), then graduates to blocking only after finding rate is sane, false-positive rate is acceptable, and threshold/budget assumptions hold.

Shadow-mode findings still feed the finding-history substrate Phase 0 sets up; they just don't block.

### 16.3 Rollback path discipline (cross-cutting)

*Goal: Every feature ships with a no-code-change off-switch — config flags minimum, DO Facet kill-switches ideally.*

**Every feature ships with a no-code-change off-switch.** Config-driven feature flags minimum; kill-switches in DO Facet state ideally. Phase 0 establishes the substrate so subsequent phases inherit it.

Without explicit rollback paths, "we'll just turn it off" becomes "we'll need a refactor and a deploy and downtime."

### 16.4 Compression toward blocking (cross-cutting, see §19)

*Goal: Every bridging-mode check is a candidate for promotion to blocking. The Compression Program (§19) is the parallel engineering arc that systematically attacks bridging-mode latency.*

Bridging mode is the transitional staging area. The discipline is to continually compress bridging-mode checks into blocking-mode by reducing per-edit scope, reducing per-file complexity, sub-check parallelization, smarter scoping, and substrate optimization.

§19 details the program. Cross-cutting discipline means: when ship-now decisions get made, every bridging-mode placement is provisional and triggers a compression-candidate entry in the work catalog.

---

## 17. Open Questions Requiring Measurement (Reference)

*Goal: Catalog measurement-pending questions across all phases.*

### 17.1 Pointer to build order

Sequencing of *when* to build *what* lives in §18.

### 17.2 Open measurement questions

| Question | Where measured | Lane |
|---|---|---|
| Actual p95 sandbox restore time on this codebase | Phase 3.5 | infra |
| Actual p95 Dynamic Worker Loader + Facet startup | Phase 3.5 | infra |
| Workflows orchestration overhead at 100-way fan-out | Phase 3.5 | infra |
| Sandbox warm-restore-after-diff timing | Phase 3.5 | infra |
| Substrate-comparison: same workload across both paths | Phase 3.5 | infra |
| Cold-start fraction (% of edits with no admission history) | Phase 4 | infra |
| Agent finding-density per check type | Phase 2 onward | all |
| Initial `project_threshold` for `remote_sync_score` (both modes) | Phase 4 shadow-mode | infra |
| Bootstrap blast-radius priors vs. measured probabilities | Phase 4–5 | infra |
| Lane B Tier 1 cost on this codebase | Phase 3 | B |
| Lane C Gitleaks/OSV-Scanner/Semgrep p95 | Phase 3 | C |
| Lane D fast-check p95 with bounded N=100 | Phase 9 | D |
| Lane D flakiness rate on existing suite | Phase 2 | D |
| Reachability-filter false-positive reduction rate | Phase 5 | C |
| Continuous-fuzzing crash discovery rate | Phase 9 | D |
| Domain-rule precision/recall | Phase 7 | C |
| LLM-review token cost per edit, latency p95, finding-density | Phase 7.5 | all |
| **Bridging-mode latency distribution per check-type (Compression Program input)** | Phase 4+ ongoing | infra |
| **Bridging→blocking promotion candidates (which checks within 20% of 30s)** | Phase 4+ ongoing | infra |

### 17.3 Explicitly held until measured

*Goal: Don't graduate any of these to Tier 2-blocking default without measurement evidence.*

- **Hub mutation as Tier 2-blocking default.** Stays Tier 2-bridging until mutant×test orchestrator built and measured under 30s.
- **Whole-suite coverage ratchet as Tier 2-blocking default.** Stays Tier 2-bridging unless sharded-coverage merge p95 below 30s.
- **Acceptance test execution as Tier 2-blocking default.** Tier 3 always; per-scenario Tier 2-blocking opt-in only for measured-under-30s scenarios.
- **CodeQL as Tier 2-blocking.** Stays Stage 6 or Tier 2-bridging until incremental CLI + DB-caching infra built.
- **Mutator rotation.** Add after Phase 4 exposes measurable gaming pattern.
- **Bash command opt-in for Stage 2R.** Defer until Edit/MultiEdit/Write stable.
- **Full Schemathesis fuzz at Tier 2.** Stays Tier 4.
- **Performance benchmarks at Tier 2.** Stays Tier 3.
- **Property tests in mutation covering set.** Default excluded; opt-in only at Tier 4.
- **LLM review as gating signal.** Always advisory; never hard-blocks.

---

## 18. Phased Build Order

*Goal: Operational core. Build phases in dependency order with measurement gates, pre-/post-conditions, and disciplines (shadow mode, rollback, compression toward blocking) applied throughout.*

Every phase ships under the three cross-cutting disciplines (§16). **Total estimate: ~9–12 months part-time.**

### Phase 0 — Thin substrate unification

*Goal: Unify existing scattered substrate into named contracts. Extraction work, not greenfield.*

**Duration:** 1–2 weeks. **Dependencies:** None.

**Work items:**
- **0.1 File-kind classifier.** Unify functions from `src/harness/checks/shared.ts:143` into typed `classifyFile(path) → {kind, confidence}`. Add `acceptance` vs. `unit`.
- **0.2 State layout — cloud-first.** **Workspace state lives in cloud Supervisor DO SQLite by default.** Local filesystem footprint is intentionally minimal: test files (agent-authored, customer-owned work product), optional capability map (customer choice whether to version-control). All other operational state — test-timings, coverage/mutation baselines, admission-log, harness-missed, finding-history, bridging-token registry, prompt-template versions, compression-candidates catalog — lives in cloud DO SQLite scoped per workspace. Customer access via dashboard, CLI, REST API. Optional opt-in local mirror (`harness sync --mirror-to=.interlinked/`) for power users; default off. This architecture removes the "harness clutters my repo" objection and enables capabilities (cross-workspace pattern detection, centralized audit, real-time dashboards, faster iteration) that local-file architectures can't provide. Session state stays in cloud DO Facets per existing v3.2 design.
- **0.3 Receipt schema as transferable artifact.** §13.4 binding fields locked in including `covering_set_hash` (Phase 5), `artifacts_commit_hash`, `mode`. Receipts queryable via REST API for customer audit access.
- **0.4 Finding-history schema.** Cloud-resident in DO SQLite (not JSONL on local disk). Schema supports cross-workspace anonymized analytics for vendor-side Compression Program improvements.
- **0.5 Result delivery contract.** Pick canonical remote-result delivery path.
- **0.6 Config-flag substrate.** Cloud-managed by default; per-workspace overrides via dashboard or CLI.
- **0.7 Supervisor DO scaffold.** Stub class with own SQLite, `new_sqlite_classes` migration. Phase 4 fills dynamic-loading parts. SQLite schema includes all the workspace-state tables moved out of local filesystem in 0.2.
- **0.8 Bridging-token registry schema.** Workspace state table in Supervisor DO tracking active bridging-mode runs.
- **0.9 Customer-facing surfaces (MVP).** Minimal dashboard (web UI for findings, baselines, admission decisions), CLI (`harness baseline coverage`, `harness findings recent`, `harness audit log`), REST API (read-only initially). These are the customer's window into the cloud-resident state. MVP versions only — full surfaces evolve over Phases 1–10.

**Exit gates:** all nine pieces shipped; classifier passes own tests; schemas documented; config-flag substrate has working example; supervisor DO deploys with full workspace-state schema; bridging-token registry round-trips a fake run; dashboard renders a workspace's findings and baselines; CLI returns workspace state; REST API returns receipts for a known edit.

### Phase 1 — Stop the bleeding

*Goal: Plug actively-gamed Lane A holes and actively-dangerous Lane C risk. Shadow mode first.*

**Duration:** 1–2 weeks. **Dependencies:** Phase 0.

**Work items:**
- **1.1 Inline secret detection (Lane C, Tier 1, fail-closed).** Integration point: `src/harness/check-engine/tool-runners/generic.ts:193`.
- **1.2 New-file-gate loop close (Lane A, Tier 1).**
- **1.3 Red-then-green enforcement (Lane A, Tier 1).**
- **1.4 Advisory-to-gate promotion for unit-classified tests (Lane A, Tier 1).**

**Exit gates:** adversarial tests for secrets, placeholder tests, no-red-cycle, unit-vs-acceptance gating all pass; all four shipped in shadow mode first, promoted after 1-week / N=50-edit calibration.

### Phase 2 — Test telemetry substrate

*Goal: Measure the test suite. Keystone for everything dynamic downstream.*

**Duration:** 2 weeks. **Dependencies:** Phase 0.

**Work items:**
- **2.1 Test-runtime ratchet (Lane A, Tier 1).** **Precondition for Phase 4 admission.**
- **2.2 Piggyback coverage on agent test runs (Lane A, Tier 1).**
- **2.3 CRAP from coverage manifest (Lane A, Tier 1).**
- **2.4 Flakiness baseline (Lane D, Tier 4 scheduled).** Two-week calibration.
- **2.5 Recurrence-feedback aggregation (meta, background).**

**Exit gates:** test-runtime ratchet has real numbers for ≥80% of test files; flakiness rate measured; CRAP scores exist per function; recurrence-feedback log has data.

### Phase 3 — Lane B/C broad wiring

*Goal: Wire existing static-analysis tools. Mostly already exists in ecosystem.*

**Duration:** 2–3 weeks. **Dependencies:** Phase 0, Phase 2.

**Work items:**
- **3.1 TS strict + lint as harness findings (Lane B, Tier 1).**
- **3.2 Cyclomatic complexity + import-cycle findings (Lane B, Tier 1).**
- **3.3 OSV-Scanner event-triggered on lockfile change (Lane C, Tier 1).**
- **3.4 License + maintainership + postinstall check on new-dep events (Lane C, Tier 2-blocking event-triggered).**
- **3.5 Gitleaks as project verification (Lane C, Tier 3).**
- **3.6 Curated Semgrep ruleset for changed files (Lane C, Tier 1).**
- **3.7 Domain-invariant inventory (Lane C, thinking work).**
- **3.8 Architecture rules baseline (Lane B, Tier 3).**

**Exit gates:** adversarial tests for vulnerable dependency, TS strict violation, postinstall-script dependency, anti-pattern; all in shadow mode first; domain-invariant inventory document exists.

### Phase 3.5 — Remote infrastructure measurement spike

*Goal: Measure Cloudflare's actual numbers across both substrates. Produces go/no-go decision artifact for Phase 4.*

**Duration:** 1–2 weeks. **Dependencies:** Phase 0.

**Work items (Dynamic Worker Loader + Facet path):** Worker Loader cold/warm; Facet instantiation; 100-way Facet fan-out; per-facet test execution; supervisor aggregate latency.

**Work items (Sandbox path):** snapshot creation/restoration; cold vs. warm start; Sandbox + ArtifactFS hydration; Outbound Worker egress overhead.

**Cross-substrate:** same mutation workload, both substrates; 100-way fan-out, both substrates.

**Workflows orchestration:** V2 spinup with Facet-creation steps.

**Bridging-mode round-trip:** PreToolUse→PostToolUse handoff overhead. Measure: start a bridging run in fake PreToolUse, simulate tool-call write delay, collect result in fake PostToolUse via additionalContext. End-to-end overhead beyond the compute itself.

**No admission logic. No product surface. Just measurement.**

**Exit gates:** numbers exist with p50/p95/p99; substrate-selection recommendation document; go/no-go for Phase 4; bridging-mode round-trip overhead known.

### Phase 3.7 — Lightweight threat model and cost ceilings

*Goal: Operational prerequisites for Phase 4. Sandbox-class and Facet-class threats differentiated.*

**Duration:** 1 week. Parallel-able with Phase 3.5.

**Work items:**
- **3.7.1 Harness threat model document.** V8 isolate boundary vs. Linux process boundary distinguished.
- **3.7.2 Cost cap per session.** Active CPU seconds, Worker Loader invocations, DO ops, Artifacts ops, Outbound Worker invocations.
- **3.7.3 Lane prioritization policy.** Lane C blocking > Lane A blocking > Lane B blocking > Lane D advisory.
- **3.7.4 Rollback feature flags for Phase 4 components.** Per-substrate kill-switches.
- **3.7.5 Circuit breaker pattern.** Separate breakers per substrate.
- **3.7.6 Outbound Worker baseline policy.** Default-deny from Sandbox/Facet running Phase 4; allowlist for ArtifactFS endpoints only.

**Exit gates:** threat model document distinguishes substrates; cost cap exercised in test; rollback flags verified per-substrate; circuit breaker triggered in test; Outbound Worker baseline verified.

### Phase 4 — Tier 2 leaf mutation MVP (Supervisor DO + Facet, blocking mode first)

*Goal: Build Tier 2 remote-sync for leaf-file diff-scoped mutation. Blocking mode first; shadow mode first within blocking. Bridging mode capability built but not used for mutation in Phase 4.*

**Duration:** 3–4 weeks. **Dependencies:** Phase 0 (substrate, supervisor DO scaffold, bridging-token registry), Phase 2 (test-runtime ratchet — keystone), Phase 3.5 (measured infra), Phase 3.7 (threat model + cost caps + rollback + Outbound Worker baseline).

**Architectural shape:** see §13.3 supervisor-facet diagram.

**Work items:**
- **4.1 MutationSupervisor DO class.** Inherits scaffold from Phase 0.7.
- **4.2 MutantExecutor class as dynamically loaded code.**
- **4.3 ArtifactFS-based code delivery.**
- **4.4 Receipt schema implementation.** Including `mode: "blocking"` for Phase 4.
- **4.5 Diff-scoped mutant generation.** Stryker `--mutate file:lines`.
- **4.6 Fan-out coordination.** Direct supervisor → facets (preferred) or Workflows-coordinated (>100-way).
- **4.7 Admission model with bootstrap priors.** Hard `predicted_p95_ms < 30000` for blocking.
- **4.8 Admission decision schema + log.**
- **4.9 Async fallback queue as fail-open destination.**
- **4.10 Outbound Worker baseline enforcement.**
- **4.11 Bridging-mode wiring.** Build the bridging-token round-trip end-to-end *as a capability*, even though leaf mutation in Phase 4 fits blocking. Validate the mechanism so it's ready when Phase 5 expands the admitted set into mid/hub files that may need bridging.
- **4.12 Shadow-mode operation for first 100 admissions.**
- **4.13 Promotion to advisory PreToolUse** after admission log shows reasonable agreement.

**Exit gates:** leaf-file diff mutation works as PreToolUse advisory in measured-and-validated p95 (Phase 3.5 sets threshold); fail-open verified; cost cap gracefully degrades; admission log shows reasonable agreement; rollback flag works; Outbound Worker baseline verified adversarially; receipts verifiable offline; bridging-mode mechanism round-trips end-to-end on synthetic check.

### Phase 5 — Supermodel covering sets + reachability-filtered SCA

*Goal: Wire Supermodel `[calls]` into covering-set computation. Expands Phase 4 admission to mid-fan-in; cuts SCA false-positive rate.*

**Duration:** 2 weeks. **Dependencies:** Phase 4, Phase 3.

**Work items:**
- **5.1 Wire `SupermodelGraph.calls` into `getDependents()` and `getBlastRadius()`.**
- **5.2 Internal-fallback `confidence_in_result` degradation.**
- **5.3 Covering-set hash as cache key dimension.**
- **5.4 Reachability filter for Lane C SCA.**
- **5.5 Phase 4 admission expands to mid-fan-in.** Most as Tier 2-blocking; some as Tier 2-bridging (Compression Program tracks promotion candidates).

**Exit gates:** mid-fan-in Tier 2-admissible; SCA finding count drops by reachability-filter ratio; mutation cache invalidation correctly handles test-side strengthening; shadow mode first.

### Phase 6 — Acceptance routing and capability maps

*Goal: Apply Martin discipline to acceptance tests. Capability tags as feature-binding; capability-to-symbol map as living contract; drift detector at Tier 4.*

**Duration:** 3–4 weeks. **Dependencies:** Phase 0, Phase 1, Phase 5.

**Work items:**
- **6.1 Two-tier RGR cycle tracker.**
- **6.2 Capability tagging convention for Gherkin scenarios.**
- **6.3 Capability-to-symbol map as project-scoped artifact.**
- **6.4 Drift detector — Tier 4 scheduled.**
- **6.5 Acceptance-routing on edit.** Most fit Tier 2-bridging at this stage; Compression Program targets blocking promotion.
- **6.6 Bootstrap from coverage.**

**Exit gates:** acceptance tests no longer false-positive on inverted Layer 1 checks; drift detector has run a full pass; capability map is non-empty and verified; outer-loop cycle tracker correctly tracks acceptance scenarios.

### Phase 7 — Domain-specific Lane C rules

*Goal: Highest-value custom Lane C work. Rule-authoring discipline.*

**Duration:** 2–3 weeks. **Dependencies:** Phase 3.7 inventory, Phase 3 Lane C infrastructure, Phase 5.

**Work items:**
- **7.1 Author custom Semgrep rules for the Phase 3.7 inventory.** Start with five.
- **7.2 Cross-file invariants via `/enforce`.**
- **7.3 Custom CodeQL queries for taint-style invariants** (deferred until Phase 9 CodeQL infra).
- **7.4 Allowlist mechanism for known-safe patterns.**

**Exit gates:** rules catch known historical incidents; precision high enough that findings are mostly real; all in shadow mode first.

### Phase 7.5 — Tier 3 LLM Review Substrate (NEW)

*Goal: Build the model-agnostic LLM-review capability scoped to open-weight models only. The harness uses open-weight LLMs because the harness is infrastructure — predictable, controllable, self-hostable — not a duplicate of the frontier-tier agent that runs on top of it.*

**Duration:** 2–3 weeks. **Dependencies:** Phase 4 (Tier 2/3 substrate), Phase 5 (call graph for prompt context), Phase 7 (domain rules inform LLM questions).

**Model tier constraint:** the harness uses **open-weight LLMs only** (gpt-oss-safeguard-20b, Llama 3.1 8B, Gemma 4 26B A4B, Granite 4.0 Micro, Mistral Small, and equivalents). Frontier closed models (Sonnet/Opus/GPT-5.x) are the agent's tier and are not invoked from the harness. This isn't just a cost decision — it's an architectural decision (see cost-latency analysis §8.7). The escalation path is "more deterministic checks plus human review queue" rather than "bigger LLM."

**Work items:**
- **7.5.1 Review request schema.** Typed object capturing edit content, file context, blast-radius context, lane-relative question, prompt template ID, model preference, timeout, callback. Stored in DO Facet.
- **7.5.2 LLM-finding type as first-class finding.** Same shape as deterministic findings, with `model_id`, `model_provider` (e.g. "workers-ai", "groq"), `prompt_template_id`, `model_response_raw`, `confidence_self_reported`, `track_record_calibration`. `model_id` must reference an open-weight model.
- **7.5.3 Prompt-template framework.** Versioned per (lane, question-type). A/B testing infrastructure built in. Template versions tracked for regression analysis. Templates designed around policy-classification framing (compatible with gpt-oss-safeguard's bring-your-own-policy interface).
- **7.5.4 Model invocation via Dynamic Worker + Outbound Worker.** Worker constructs prompt, invokes open-weight model via Cloudflare Workers AI (preferred for ecosystem alignment) or external provider (Groq for gpt-oss-safeguard, etc.) through Outbound Worker for credential injection. Model never sees workspace API tokens.
- **7.5.5 Async delivery via Tier 3 surface.** Result surfaces on next-turn or Stop via existing async-finding-queue path. Never blocks. **Note:** open-weight model latency (5–10s typical) is fast enough that Phase 7.5 could plausibly fit Tier 2-bridging mode rather than Tier 3 async — this capability shift is worth evaluating post-Phase 3.5 measurement, not foreclosing in the substrate design.
- **7.5.6 Model-agnostic within the open-weight tier.** Swap between gpt-oss-safeguard-20b, Llama 3.1 8B, Gemma 4 26B A4B, Granite 4.0 Micro, etc. via config — no architectural change. Specific integration order (which model is the production default, which is escalation) is a downstream decision based on Phase 3.5 measurement of quality vs. latency vs. cost on Quentin's actual workload.
- **7.5.7 Per-lane LLM-review check types.** Five built initially, shadow mode. **All using gpt-oss-safeguard-20b or equivalent open-weight model:**
  - Lane A: "Does this test discriminate behavior or just exercise code?"
  - Lane B: "Is the naming and abstraction appropriate?"
  - Lane C: "Does the security-pattern-fit look correct?" (gpt-oss-safeguard is a strong fit — policy-based classification matches code-review-against-rules)
  - Lane D: "Does the implementation match the task description?"
  - Cross-lane: "Are there code-smell concerns a senior engineer would raise?"
- **7.5.8 Track-record calibration.** Per-template historical agreement rate against deterministic ground-truth checks. Surface confidence-weighted findings.
- **7.5.9 Escalation path is non-LLM, not bigger-LLM.** When the lightweight LLM is uncertain or produces a finding the agent disputes, the system queues additional deterministic checks (broader Semgrep policy, mutation against a larger covering set, etc.) or flags for human review. The harness does not escalate to frontier models.

**Exit gates:** review-request and LLM-finding schemas documented; prompt-template framework round-trips a review using an open-weight model; five per-lane templates in shadow mode using gpt-oss-safeguard-20b or equivalent; track-record calibration accumulates data for ≥50 edits; Outbound Worker credential injection verified; model substitutability verified (swap default model via config change, system continues working).

### Phase 8 — Tier 5 continuous infrastructure

*Goal: Build persistent-state continuous-job substrate. Generic infrastructure that Phase 9 fuzzing uses.*

**Duration:** 3 weeks. **Dependencies:** Phase 4 substrate, Phase 3 Lane C tools.

**Work items:** Continuous-job substrate; Continuous SCA (poll vuln-DB versions); Continuous Semgrep; Crash deduplication; External-feed invalidation pattern.

**Exit gates:** Tier 5 jobs run reliably across multi-day windows; state survives across runs; external-feed invalidation works.

### Phase 9 — Fuzzing and deeper static analysis

*Goal: Lane D completion + heavyweight Lane C SAST. CodeQL infrastructure unlocks Phase 7's taint-style domain rules.*

**Duration:** 3–4 weeks. **Dependencies:** Phase 8, Phase 4.

**Work items:**
- **9.1 fast-check property testing for pure-function modules (Lane D, Tier 2-blocking or bridging).** Default-excluded from mutation covering set.
- **9.2 Schemathesis on changed-schema events (Lane D, Tier 2-blocking event-triggered).**
- **9.3 API contract diff (Lane D, Tier 1 event-triggered).**
- **9.4 Migration smoke test (Lane D, Tier 2-blocking event-triggered).**
- **9.5 Performance microbench for marked hot-path functions (Lane D, Tier 3).**
- **9.6 Coverage-guided fuzzing for untrusted-input parsers (Lane D, Tier 5).**
- **9.7 CodeQL infrastructure.**
- **9.8 CodeQL custom queries for taint analysis** (extends Phase 7).

**Exit gates:** all four lanes have at least one Tier 4+ tool running; CodeQL produces findings; property tests find at least one bug example-based tests didn't; fuzzing corpus produced at least one crash or coverage milestone.

### Phase 10 — Hardening and harness self-verification

*Goal: Verify the verifier. Adversarial testing of the harness itself; meta-mutation; mutator rotation operationalized.*

**Duration:** 2–3 weeks. **Dependencies:** Phase 9.

**Work items:** Full harness threat model; Meta-mutation on harness check code; Mutator rotation operational; Provenance and SLSA (Stage 7 release-time); Test-pyramid composition reporting (Tier 4); Documentation pass.

**Exit gates:** threat model tested adversarially; meta-mutation produces non-zero findings; mutator rotation operational; test-pyramid report has at least one month of data.

### 18.1 Critical reads on this order

*Goal: Five decisions worth re-emphasizing because they're easy to violate without realizing it.*

The single most important decision is to **resist building Phase 4 early.** Tier 2 remote-sync is architecturally novel and fun; expensive to build twice. Phase 0 + Phase 2 + Phase 3.5 + Phase 3.7 must ship first.

The second is to **ship Phase 1 fast.** Secrets-on-diff and gaming-hole closure are highest-risk-per-effort.

The third is to **let Phase 8 (Tier 5 continuous) appear earlier** if continuous fuzzing or continuous SCA proves high-value.

The fourth is to **honor Phase 3.5's go/no-go decision.** If sandbox restore or Facet startup turn out worse than assumed, Phase 4's design changes before any production code touches it.

The fifth (new in v3.2) is to **treat every bridging-mode placement as a Compression Program (§19) candidate.** Don't accept bridging as the destination. Every bridging-mode finding is a tracked debt that should drive smaller-edit pressure, file-split advisories, sub-check parallelization, or substrate optimization.

---

## 19. Compression Program — Bridging→Blocking Promotion

*Goal: Define the parallel engineering arc that systematically attacks bridging-mode latency to promote checks into blocking-mode. The harness gets stronger over time as more checks fit the 30s blocking budget.*

The Compression Program is not a phase; it's a continuous engineering arc that runs alongside Phases 4 onward. Its premise: bridging mode is the transitional staging area, not the destination. Every bridging-mode check is a candidate for promotion to blocking, because only blocking can *enforce* — bridging can only *advise*.

### 19.1 The compression problem

*Goal: Frame why some checks land in bridging in the first place.*

A check lands in bridging mode because, at admission time, its predicted p95 latency exceeds 30 seconds. The latency contributors are usually one or a combination of:

- **Edit scope too large.** A 500-line refactor takes longer to verify than a 5-line change.
- **File too complex.** A hub file with 316 importers has a covering set of ~the whole suite.
- **Insufficient parallelization.** A check that could fan out at finer grain running at coarser grain.
- **Substrate too heavy.** Work that could run in Dynamic Worker Loader running in Sandbox.
- **Cold start dominating.** ArtifactFS cold-hydrate, sandbox cold-start, DB cache miss.
- **External dependency latency.** Vuln-DB lookup, model API round-trip, third-party tool.

The Compression Program identifies which of these contributes to each bridging-mode check, then systematically attacks the contributors.

### 19.2 Five compression levers

*Goal: Name the concrete techniques for moving checks from bridging into blocking. These are work items, not principles.*

**Lever 1 — Smaller edits.** The harness can advise the agent to make smaller edits. Mechanism: blast-radius-weighted edit-size budget per file class. Leaf files: up to 100 lines per edit. Mid files: 50 lines. Hub files: 20 lines or split across multiple turns. The advisory becomes a hard gate once the agent's edit-sizing behavior has been measured. **Direct effect:** smaller edits → smaller covering sets → faster mutation, coverage, type-check.

**Lever 2 — Smaller files.** Lane B's structural-seam advisories (§11) identify files with clusters of functions that could split cleanly. Compression Program consumes those advisories to drive file-splitting recommendations to the agent. Once a hub file is split into two mid files, each mid file's edits become Tier 2-blocking admissible. **Direct effect:** hub files become mid files; blast-radius distribution shifts down.

**Lever 3 — Sub-check parallelization.** A check running serially within itself can sometimes be re-architected to fan out at finer grain. Examples: mutation that currently fans out per-mutant could fan out per-(mutant, test) pair when blast radius is large; coverage that currently runs per-shard could run per-(shard, file) when shard count is high; Semgrep interfile that processes rules sequentially could parallelize per-rule. **Direct effect:** wall-clock collapses as fan-out width grows.

**Lever 4 — Substrate migration.** Work currently running in Sandbox (Linux container, 1–3s startup) that could be re-implemented to run in Dynamic Worker Loader + Facet (V8 isolate, single-digit ms). Not always possible — some work genuinely needs Linux — but when possible, the substrate change collapses startup cost dramatically. **Direct effect:** startup-dominated checks become compute-dominated; compute can then be parallelized further.

**Lever 5 — Caching and incrementality.** ArtifactFS warm-hydrate vs. cold; DB cache hits vs. misses; mutant result caching across edits to the same file. The cache infrastructure exists in Phase 0/4; the discipline is to track cache hit rates and tune cache invalidation aggressively. **Direct effect:** repeated work amortizes; second edits to the same file pay near-zero hydrate cost.

### 19.3 Compression Program operational mechanism

*Goal: Specify how the Compression Program actually runs as engineering work — not a one-shot project but an ongoing accumulation of small wins.*

The Compression Program operates as a tracked work catalog with weekly or biweekly review cadence:

**Inputs:**
- Bridging-mode admission log (every bridging admission marks the check as compression-candidate).
- Per-check latency distribution over the prior calibration window.
- Latency-contributor breakdown (which of the five levers dominates each check's cost).
- Promotion proximity score (how close is this check to fitting 30s blocking — within 20%? 50%? 200%?).

**Outputs (work catalog entries):**
- Specific compression work items, each tagged with which lever applies and which check it would promote.
- Expected promotion outcome (e.g., "splitting `harness/types.ts` into 4 files would promote 12 bridging-mode mutation checks to blocking").
- Effort estimate.

**Cadence:**
- Weekly review of bridging-mode admission stats during Phases 4–7.
- Promotion decisions made as part of normal sprint planning.
- Each promotion is itself a small ship-and-measure cycle: do the compression work, observe whether bridging-mode latency dropped below 30s for the targeted checks, promote to blocking under shadow mode first.

### 19.4 Where the Compression Program intersects the build phases

*Goal: Show that the Compression Program doesn't replace phase work — it runs alongside, consuming outputs from Phase 5 (graph), Phase 11 (structural seams), and Phase 4+ (admission log).*

| Phase | Compression Program input | Compression Program contribution |
|---|---|---|
| Phase 4 | Bridging-mode admission log starts accumulating | First bridging candidates identified; initial latency-contributor analysis |
| Phase 5 | Symbol-level covering set lets compression target smaller-scope checks | Mid-file mutation may promote from bridging to blocking after covering-set tightening |
| Phase 6 | Capability-routed acceptance tests scope shrinks | Some acceptance scenarios become blocking-eligible |
| Phase 7 | Domain Semgrep rules generally pattern-fast | Most fit blocking from the start; few candidates here |
| Phase 7.5 | LLM review is fundamentally Tier 3 | Not a compression candidate — judgment-class checks stay async |
| Phase 8/9 | Tier 5 continuous and fuzzing | Generally not compression candidates — different cadence class |
| Phase 10 | Meta-mutation, mutator rotation | Some operational checks may compress; mostly off the critical path |

### 19.5 Compression as cross-cutting discipline (per §16.4)

*Goal: Reinforce that compression isn't optional — it's how the harness's enforcement power grows over time.*

Every bridging-mode placement should be treated as provisional. The acceptable steady state is: most checks run blocking; only checks that fundamentally cannot fit (whole-suite work, full-repo scans, long-running fuzzing, async LLM review) stay non-blocking. A check sitting in bridging mode for months without an active Compression Program work item is a signal that either (a) the check shouldn't be Tier 2 at all and should move to Tier 3 permanently, or (b) someone needs to do compression work on it.

The discipline produces three behavioral outcomes:
1. **Smaller, more focused edits from the agent** (via Lever 1's edit-size guidance).
2. **Better-factored codebases over time** (via Lever 2's structural-seam splitting).
3. **More work enforceable in the 30s window** (via Levers 3–5's technical compression).

All three reinforce the gauntlet thesis: maximum disciplined scrutiny per edit, growing over time.

---

## 20. Decision Log — Why This Shape, Not Others

*Goal: Explain the design decisions and their alternatives so future-Quentin (or implementing agents) can re-evaluate when context shifts.*

**Why not "cheap-local-sync vs. expensive-async" binary?** Cost distribution is bimodal at the *file* level and Cloudflare's primitives close the gap for the leaf-mid band. Forcing all expensive work async leaves highest-value signal (mutation) too far from edit loop.

**Why not "always remote-sync"?** Agent-stall economics (§13.9) and predictive-not-authoritative epistemics. Most edits don't need it; admission keeps stall bounded. The gauntlet wants stall *within* the 30s/60s window, not unbounded stall.

**Why is 30s a hard ceiling, not a soft target?** Cloudflare PreToolUse hooks have a 30s hard limit. Treating it as soft causes hook timeouts, worse than the check not running.

**Why have a bridging mode at all if it can only advise?** Because some checks are genuinely valuable as advisory feedback ("you committed code with surviving mutants — here's where") and don't fit blocking yet. Bridging is the staging area; Compression Program (§19) is the path out.

**Why not LOC caps to reduce verification cost?** LOC doesn't predict cost — blast radius does. Compression Program Lever 2 uses *structural seams* from the graph, not LOC.

**Why not sample mutants for speed?** Random mutant sampling silently converts mutation from `[proven]` to `[heuristic]`. Changed-line scoping is complete-for-the-diff; sampling is not.

**Why not skip mutation and lean on Layer 1?** Every shape check is reverse-engineerable. Without ground-truth-ish signal somewhere, gaming-pattern arms race has no terminating condition.

**Why four lanes, not three or five?** Three collapses code-correctness into "static analysis" and loses the distinction between type/lint and SAST. Five would add "process hygiene" or "documentation" — both real but lower priority.

**Why is Lane C ship-now smaller than Lane A?** Lane C tools mostly already exist as standalone CLIs; many checks event-triggered; highest-value items are cheapest.

**Why is CodeQL not Tier 2-blocking default?** Database build is minutes-to-hours. Stage 6 with cached incremental DB is honest placement.

**Why lane × cadence instead of tier-only?** Tier-only conflates *what to verify* with *when to verify*.

**Why Phase 0 as extraction, not greenfield?** Classifier functions exist; dependency view exists; async finding queue exists; cycle tracker exists. Framing Phase 0 as build overstates work.

**Why Phase 3.5 measurement spike, not just trust §13.6 estimates?** Every "X takes Y seconds" claim is modeled or estimated — none measured on this codebase. A 1-week spike is cheap insurance.

**Why Phase 3.7 threat model and cost ceilings before Phase 4?** Sandbox escape, cache poisoning, runaway costs are operational prerequisites for running untrusted-ish code in fan-out cloud workers.

**Why shadow mode discipline?** Check that ships fail-closed from day one produces false positives that erode harness credibility.

**Why rollback path discipline?** Infrastructure projects accumulate entangled features that become irreversible without explicit rollback paths.

**Why compression-toward-blocking discipline?** The gauntlet's enforcement power grows only as more checks fit blocking. Bridging is consolation; blocking is enforcement.

**Why single-agent first, multi-agent deferred?** Multi-agent infrastructure on immature single-agent foundation produces coordination layer that papers over verification gaps.

**Why is property-test/mutation interaction handled by separation rather than infrastructure?** Bob Martin's concern is correct. Cloudflare fan-out reduces wall-clock but doesn't resolve nondeterministic scores, timeout false-kills, shrinking variance.

**Why LLM review folded into Tier 3 rather than its own tier?** Cost (tokens + latency) is async-shaped. Same async surface as other Tier 3 work; the distinction is in the substrate (Phase 7.5 prompt-template framework) and gating policy (always advisory, track-record-calibrated).

**Why build LLM review substrate generically before specific model integration?** Model landscape shifts fast. gpt-oss-safeguard-style models are an example, not a commitment. Substrate (prompt templates, finding schema, async delivery) is stable; specific model behind it should be swappable via config. **The model tier is constrained to open weights** (gpt-oss-safeguard, Llama, Gemma, Granite, Mistral, etc.) — the harness does not invoke frontier closed models, because doing so duplicates the agent's capability and inverts the right cost asymmetry (gatekeeper should cost less than gated work).

**Why is multi-agent peer review noted as Tier 3 LLM-review extension rather than new tier?** Peer-agent review is structurally LLM review with a different model invocation. Same surface, same finding type, same gating policy.

---

*End of handoff v3.2. Re-read §16 before any fork-in-the-road decision. Re-read §15 before claiming design is comprehensive — by construction it isn't, and named blindspots are where next round of work lives. Re-read §18 to remember that **build order matters** — most plans like this fail by shipping architecturally interesting parts before substrate they depend on. Re-read §19 to remember that **bridging is the staging area, not the destination** — the harness gets stronger over time as compression promotes checks into blocking.*

## 21. Scope Strategy — Per-Diff, Per-File, Per-Codebase

*Goal: Make explicit how verification scope decisions are made and configured. The v3.2 design implicitly assumed per-diff verification (only what the agent is editing right now). For brownfield codebases with significant pre-existing technical debt, the architecture needs explicit support for per-file and per-codebase scopes, with policy controls for how pre-existing findings are surfaced to the agent and what behavior is enforced.*

### 21.1 The three scope levels

| Scope | What's verified | When it runs | Default cadence |
|---|---|---|---|
| **Per-diff** | Only changed lines + direct dependencies | Every edit | Tier 2-blocking |
| **Per-file** | Entire file being touched | Every edit to that file | Tier 2-bridging (if fits) or Tier 3 async |
| **Per-codebase** | Whole codebase | On-demand or scheduled | Tier 4 scheduled or Tier 5 continuous |

Each scope produces a different category of finding:
- **Per-diff findings**: directly caused by the current edit. Highest priority. Always blocking by default.
- **Per-file pre-existing findings**: in the file the agent is touching, but not in the changed lines. Default policy: surface as required-to-fix.
- **Per-codebase pre-existing findings**: anywhere else in the codebase. Default policy: accumulate to backlog, surface only highest-priority.

### 21.2 The pre-existing finding problem with current SOTA agents

SOTA coding agents (Claude Code, Cursor, equivalent) are trained to be task-focused and conservative about scope expansion. When the harness surfaces a finding outside the agent's current edit scope, the typical behavior is: acknowledge the finding, note it as pre-existing, do NOT fix it, complete the original task and move on.

This is partially desirable (prevents agent scope-creep, prevents unwanted changes) but mostly counterproductive for brownfield codebases where the harness's value depends on actually reducing tech debt over time. Without active intervention, the harness becomes a high-quality finding-detection tool whose findings are routinely ignored — which is what existing tools like SonarQube do, and what this harness needs to do better to justify premium pricing.

**The default should be aggressive helpfulness: fix everything you can while in this file. Toggle for customers who want stricter scope discipline.**

### 21.3 Pre-existing finding policy engine

For each finding produced by per-file or per-codebase scope, the harness classifies and routes:

**Classification dimensions:**

| Dimension | Values |
|---|---|
| `category` | security, quality, test, accessibility, performance |
| `severity` | critical, high, medium, low |
| `provenance` | introduced-by-current-edit, pre-existing-in-file, pre-existing-codebase |
| `fix_complexity` | trivial (≤5 lines), small (≤25 lines), medium (≤100 lines), large (>100 lines) |

**Policy actions:**

| Action | Mechanism | Agent behavior |
|---|---|---|
| `block-edit` | PreToolUse `decision: "block"` | Cannot complete edit until finding addressed |
| `require-fix` | PostToolUse gating + strong language; Stop hook escalation | Should fix before completing response |
| `recommend-fix` | PostToolUse adds finding with directive language | Likely to fix if simple |
| `surface-informational` | PostToolUse adds finding as context only | May or may not fix |
| `backlog-only` | Stored, not surfaced to agent | Visible in dashboard only |
| `ignore` | Not stored | No action |

**Default policy matrix (default-to-fix-everything):**

| Provenance ↓ Severity → | Critical | High | Medium | Low |
|---|---|---|---|---|
| introduced-by-current-edit | block-edit | block-edit | require-fix | recommend-fix |
| **pre-existing-in-file** | **require-fix** | **require-fix** | **recommend-fix** | **backlog-only** |
| pre-existing-codebase | recommend-fix | backlog-only | backlog-only | ignore |

The aggressive defaults on the in-file row reflect the user-stated preference. Per-codebase findings are more conservative because surfacing 5,000 findings on every edit destroys the agent's context budget.

### 21.4 Making agents actually fix pre-existing findings

Five techniques in combination overcome SOTA agents' tendency to skip pre-existing findings:

**1. Stronger directive language.**
- Weak: "There's also an issue at line 234"
- Strong: "**REQUIRED FIX**: Address the pre-existing issue at line 234 before continuing. This file's policy requires it to be left in a clean state when modified."

**2. PostToolUse hook gating.** When pre-existing findings exist in a file the agent just edited:
```json
{
  "decision": "block",
  "reason": "Pre-existing issues in foo.ts must be addressed before completing this response. Issues: [structured list with locations and suggested fixes]."
}
```

**3. Actionable context with suggested fix.** Include the proposed fix code, not just the description:
- Weak: "SQL injection risk at line 234"
- Strong: "SQL injection risk at line 234. Current: `query(\"SELECT * FROM users WHERE id=\" + userId)`. Fix: `query(\"SELECT * FROM users WHERE id=?\", [userId])`. ~3 lines."

**4. Stop hook escalation.** At session Stop, if pre-existing findings remain in any touched file, block stop:
```json
{
  "decision": "block",
  "reason": "Session cannot complete. Files modified this session still contain unaddressed pre-existing issues: [files and issues]."
}
```

**5. Escalation tracking with stricter language.** If agent has skipped 3+ pre-existing findings in a session, escalate language and gating strictness. Reset per session. The harness gets progressively more insistent with non-compliant agent behavior.

Together these convert the harness from "finding-detector" into "fix-enforcer."

### 21.5 LoC enforcement as a parallelization enabler

The user's intuition is correct: constraining edit size makes parallelization easier and more likely to fit the 30-second blocking window. Compression Program Lever 1 already mentions this as discipline; this section makes it enforceable as policy.

**LoC limit defaults:**

| Edit type | Default limit | Rationale |
|---|---|---|
| New file creation | 200 lines | Reasonable initial implementation |
| Modification of existing file | 80 lines | Fits comfortably in 30s blocking window |
| Test file modification | 150 lines | Tests often longer due to setup/teardown |
| Pure formatting/rename | unlimited | No semantic content; auto-detected via diff structure |
| Refactoring/file splitting | unlimited | Requires `[refactor]` tag in edit context |
| Generated code | unlimited | Auto-detected via patterns (`@generated`, etc.) |

**Enforcement:**

PreToolUse hook examines diff size. If LoC > limit:
```json
{
  "decision": "block",
  "reason": "This edit modifies 187 lines (limit: 80). Suggested split points from AST: line 45 (function `processOrder`), line 89 (class `OrderHandler`), line 134 (refund section). Each split should be ≤80 lines."
}
```

**Smart split-point suggestion:** AST analysis suggests natural boundaries (function/method/class boundaries, logical section breaks, import boundaries, comment boundaries). Makes the split actionable rather than arbitrary.

**Override mechanism:** Agent includes tags in edit context — `[refactor]`, `[format]`, `[generated]` — that bypass LoC limits. Logged for audit. Per-workspace configuration of which tags are permitted.

**Benefits for parallelization:**
- Smaller edit → smaller covering set → fewer mutants
- Easier to fan out across Facets within 30s window
- More edits per session but each completes quickly → better feedback loop
- Per-edit cost decreases
- Compression Program Lever 1 becomes enforced rather than advisory

**Tradeoffs:**
- Some legitimate large edits get blocked initially → mitigated by override tags + smart suggestions
- Agent may need multiple PreToolUse rejections to learn limits → mitigated by clear error messages with split suggestions
- Refactoring sessions slow if every step is small → `[refactor]` mode batches related edits

### 21.6 Per-codebase audit capability

**On-demand audit:**
```bash
harness audit-codebase                  # Full audit, all lanes
harness audit-codebase --lane=security  # Security-only
harness audit-codebase --severity=critical
harness audit-codebase --since=2026-01-01  # Diff against historical baseline
```

**Scheduled audit (Tier 5):** Default weekly full audit per workspace. Configurable cadence. Diff against previous audit shows new vs. resolved issues over time.

**Audit output:**
- Findings by category, severity, provenance
- Tech-debt heat map by file/module/directory
- Recommended fix priority
- Estimated effort per fix
- Trend over time (per-category improving/worsening)
- Module-level health scores

**Audit storage and lifecycle:** Each finding has lifecycle `detected → triaged → fixed → verified → archived` (or `won't-fix`). State transitions logged with timestamps for compliance.

### 21.7 Brownfield onboarding flow

When customer installs on existing codebase:

**Step 1: Codebase audit** (`harness init --brownfield`, 5-60 minutes depending on size)

**Step 2: Findings summary**
```
Audit complete.

Critical: 12 findings (8 security, 3 quality, 1 test)
High: 247 findings
Medium: 1,832 findings  
Low: 4,521 findings

Tech-debt heat map: src/legacy/* contains 67% of high+ findings.
Module health: src/core 8.2/10, src/api 7.5/10, src/legacy 3.1/10
```

**Step 3: Policy configuration wizard** — interactive prompts to set defaults. Defaults are aggressive (default-to-fix-everything) but every choice is explicit, with rationale for each option.

**Step 4: Baseline establishment** — current state becomes the floor (existing tests must continue passing, coverage/mutation scores are ratchets, no new issues allowed, pre-existing handled per chosen policy).

**Step 5: LoC limits configuration** based on codebase characteristics.

**Step 6: Begin operation** — first 5-10 sessions may have many blocked edits as the agent learns the policies; expected and normal.

### 21.8 Forward-only vs. tech-debt-reduction posture

Two distinct customer postures, both supported:

**Forward-only (ratchet):** Pre-existing issues catalogued but not actively required to fix. New issues blocked. Less friction. Recommended for: codebases planned for replacement, teams under heavy delivery pressure, pre-existing-issue counts in tens of thousands.

**Tech-debt-reduction (aggressive, DEFAULT):** Pre-existing critical/high issues in touched files require fix. New issues blocked. More friction, faster cleanup. Recommended for: codebases the team owns long-term, teams with bandwidth to absorb fix work, regulated industries where tech debt has compliance implications.

**Per-file-pattern policy overrides:**
```yaml
policies:
  - pattern: "src/legacy/**"
    posture: forward-only
    reason: "Legacy code planned for decommission Q3 2026"
  - pattern: "src/security/**"
    posture: tech-debt-reduction
    severity_floor: medium  # Even medium pre-existing requires fix here
  - pattern: "tests/**"
    posture: tech-debt-reduction
```

### 21.9 Cost implications

| Scope addition | Additional CPU/session | Additional cost/session |
|---|---|---|
| Per-file scan on every edited file | ~5-15 CPU-seconds | ~$0.02-0.05 |
| Per-codebase audit (weekly, amortized) | ~30-90 CPU-minutes/week | ~$0.05-0.15 |
| Pre-existing finding tracking storage | minimal | <$1/month per workspace |

Total: 5-15% cost increase over per-diff-only operation for a substantial capability expansion. Disproportionately valuable for brownfield customers — the segment most willing to pay premium pricing.

### 21.10 Implementation across phases

**Phase 0 additions:**
- **0.10 Edit-size enforcement substrate.** PreToolUse hook examines diff LoC, rejects exceeding configured limits with AST-based smart split-point suggestions. Per-file-type configuration. Override tag system (`[refactor]`, `[format]`, `[generated]`).

**Phase 4 additions:**
- **4.5 In-file pre-existing issue detection.** When per-diff verification runs, also run per-file scan (within bridging budget where fits, async to Tier 3 otherwise). Findings tagged with `provenance: pre-existing-in-file`. Policy engine routes to action.
- **4.6 Pre-existing finding policy engine.** Configurable policy matrix per workspace. PostToolUse and Stop hook integration to enforce policies. Agent escalation tracking — language and gating get progressively stricter when agent skips pre-existing findings within a session.

**New Phase 11 — Brownfield onboarding and codebase-wide capability**

*Goal: Make the harness work effectively on existing codebases with significant pre-existing technical debt.*

**Duration:** 3-4 weeks. **Dependencies:** Phase 4 (per-file scanning), Phase 7 (Lane C rules), Phase 8 (Tier 5 substrate).

**Work items:**
- **11.1 Codebase audit capability.** `harness audit-codebase` command with filter flags. Runs all applicable Lane A/B/C/D checks across entire codebase.
- **11.2 Audit storage and lifecycle.** Cloud-resident finding storage with status lifecycle. Audit log of state transitions for compliance.
- **11.3 Scheduled audit (Tier 5).** Default weekly full audit per workspace. Diff against previous audit shows new vs. resolved over time.
- **11.4 Tech-debt heat map and module scoring.** Visualization of finding density by file/module. Composite health scores. Dashboard widget and CLI report.
- **11.5 Onboarding wizard.** `harness init --brownfield` triggers structured flow.
- **11.6 Per-file-pattern policy overrides.** YAML configuration for different policies per file pattern.
- **11.7 Forward-only vs. tech-debt-reduction toggle.** Workspace-level with per-pattern overrides.
- **11.8 Pre-existing finding triage workflow.** UI for team to bulk-triage findings.
- **11.9 Brownfield-specific telemetry.** Track time-to-fix, tech-debt reduction rate, false-positive rate. Feeds Compression Program.

**Exit gates:** brownfield codebase (≥10K LoC) onboarded in <60 minutes; first audit produces categorized findings; policy configuration persists; per-file-pattern overrides work; tech-debt heat map renders in dashboard; pre-existing finding policies measurably drive agent fix behavior (compared to control group with policies disabled).

### 21.11 The customer value story this enables

For brownfield customers (most real-world codebases), this transforms the value proposition:

**Before harness:** Agent makes changes. Pre-existing tech debt persists. Agent often introduces new issues. Code quality degrades or stays static.

**After harness with default brownfield policies:** Agent makes changes. Pre-existing critical/high issues in touched files get fixed alongside the request. New issues blocked at edit time. Code quality monotonically improves. Tech-debt heat map shows measurable progress. Audit reports prove improvement for compliance/management.

This converts the harness from "prevents future problems" to "actively reduces existing problems." Sales pitch becomes:

> "Install on your brownfield codebase. Within 30 days, your critical security findings drop by 60-80%. Code quality metrics improve continuously. Agents stop introducing new debt AND actively reduce existing debt. All measurable. All audit-grade documented."

For enterprise customers — the segment most willing to pay premium pricing — this is substantially stronger than "harness for AI-generated code quality." It addresses the real pain point (existing tech debt + AI agents making it worse) rather than just preventing a future problem.

### 21.12 Decision log addendum

**Why per-file pre-existing finding policy defaults to require-fix (aggressive) rather than informational-only (scope discipline)?** Two reasons. First, user-stated preference: the harness should be most valuable for codebases that need quality improvement, meaning default to fixing everything that can be fixed. Second, customers can always toggle to less aggressive policies; defaulting to less aggressive means the value isn't immediately apparent and many customers never discover the more aggressive option. Aggressive default + easy toggle better serves the value proposition.

**Why LoC enforcement at all, when smaller edits are already in Compression Program?** Compression Program treats smaller edits as a discipline measured over time. LoC enforcement makes it a hard rule at edit time. The difference matters because (a) parallelization within the 30s blocking window depends on edit size being predictable, (b) discipline gradients work better with concrete limits than aspirational guidelines, (c) the override tag system handles legitimate exceptions without abandoning the principle.

**Why a separate brownfield onboarding flow rather than treating brownfield as just "harness with more findings"?** Onboarding experience matters disproportionately for product adoption. A brownfield customer who installs and immediately sees 5,000 blocked edits churns out instantly. A brownfield customer walked through audit → policy configuration → calibrated expectations completes onboarding successfully. The flow is a product feature, not just operational scaffolding.

## 22. The Configurability Framework — Vendor Opinions and Customer Preferences

*Goal: Articulate the principle that resolves tensions between vendor opinions about what's valuable and customer preferences about how they want their codebase organized. The harness has strong opinions about WHAT matters and provides configurability about HOW and WHERE the customer accepts the help. This framework applies to test file location, but also to many other surfaces where vendor defaults and customer preferences could conflict.*

### 22.1 The principle: opinions about WHAT, configurable HOW/WHERE

The harness divides every design decision into three layers:

**Layer 1 — Non-negotiable opinions (vendor-enforced).** These are the "we believe" claims that constitute the product's value proposition. If a customer rejects these, the harness can't deliver value, so they're not configurable:

- AI-generated code requires verification before completion
- Security-critical findings must be addressed (cannot disable secret detection, credential exposure checks)
- Receipts must be cryptographically signed when audit-grade tier is active
- Verification must be deterministic where possible (no fuzzy substitutes for exact checks)
- The agent cannot bypass the harness once the harness is engaged

**Layer 2 — Strong default opinions (vendor-recommended, customer-overridable).** These are the choices vendor believes are best for most customers but acknowledges customer expertise about their context:

- Default scope is per-file (catches more) rather than per-diff (less intrusive)
- Default policy is fix-everything-pre-existing rather than scope-disciplined
- Default LoC limits are 80 lines for existing-file modifications
- Default location for test files is `tests/` alongside source
- Default escalation is to non-LLM verification, not bigger LLMs
- Default LLM tier is open-weight, not frontier

**Layer 3 — Customer configuration (full control).** These are the cosmetic and structural choices where customer preference dominates:

- Where each artifact type lives (in repo at custom path, in sidecar repo, cloud-only, etc.)
- Which Lane C rules are active
- Specific severity assignments per rule
- Per-file-pattern policy overrides
- Telemetry granularity
- LoC limit values

This three-layer split lets the harness say: "We have strong opinions about what verification means. We have recommendations for how to do it well. We support your preferences about how you want it integrated."

### 22.2 The artifact location framework

Every artifact the harness produces or consumes has a natural location category. Default location varies by category, but all locations are customer-configurable within constraints:

| Category | Examples | Default location | Configurable options | Constraints |
|---|---|---|---|---|
| **Customer code** | Application code | Customer repo (customer owns) | Customer owns entirely | None |
| **Test code** | Unit, integration, acceptance tests | Customer repo at `tests/` | Custom path, sidecar repo, cloud-only | Must be executable somehow |
| **Configuration artifacts** | Capability maps, Semgrep rules, `/enforce` rules | Customer repo at conventional paths | Custom path, cloud-managed | Must be version-trackable |
| **Operational state** | Baselines, telemetry, finding history | Cloud (paid tier), local (free CLI) | Cloud-only, local-only, mirrored | Cloud required for team features |
| **Generated artifacts** | Graph shards, AST caches | Local cache (gitignored) | Cloud-cached, no-cache | Must be regeneratable |
| **Audit artifacts** | Receipts, audit logs | Cloud-only | Cloud-only (export available) | Cannot be local-only for paid tier |

The three categories that benefit most from customer-configurable location:

1. **Test code** — because tests are simultaneously customer IP, agent context, and runtime artifacts. Different customers have different opinions about which aspect dominates.

2. **Configuration artifacts** — because they encode customer policies and customers care about version control.

3. **Operational state** — because the data has compliance, privacy, and analytics implications customers want to control.

### 22.3 Test file location — the specific case the customer asked about

The user's example: "Keep test files only on our remote side rather than the developer's local machine." This is technically feasible but has serious tradeoffs that need explicit acknowledgment. The harness supports multiple configurations, ranked from most-standard to most-separated:

#### Configuration A: Tests in customer repo at default path (RECOMMENDED DEFAULT)

```
customer-repo/
├── src/
│   └── orders.ts
└── tests/
    └── orders.test.ts
```

**Tradeoffs:**
- ✅ Familiar pattern; works with all standard tooling
- ✅ Customer's IDE shows tests next to code
- ✅ CI runs tests as usual
- ✅ Tests are version-controlled in customer's git
- ✅ Test refactoring uses normal editor flow
- ⚠️ Adds files to customer repo (the original objection)

**Best for:** standard development teams, open-source projects, anyone who treats tests as first-class artifacts.

#### Configuration B: Tests in customer repo at custom path

```
customer-repo/
├── src/
│   └── orders.ts
└── .interlinked-tests/
    └── orders.test.ts
```

Customer configures: `test_location: .interlinked-tests/`

**Tradeoffs:**
- ✅ Customer chooses path that fits their conventions
- ✅ Can be gitignored if customer wants (with caveats)
- ✅ Easy to identify harness-generated tests
- ⚠️ Non-standard path may confuse other tooling
- ⚠️ If gitignored, loses version control benefit

**Best for:** teams that want clear separation between hand-written and harness-generated tests, teams with strong opinions about repo structure.

#### Configuration C: Tests in sidecar repo

```
customer-app/                 # Customer's main repo
└── src/orders.ts

customer-app-tests/           # Harness-managed sidecar repo
└── orders.test.ts
```

Customer configures: `test_location: sidecar_repo`. Harness creates and manages the sidecar repo (in customer's git org).

**Tradeoffs:**
- ✅ Main repo stays clean
- ✅ Tests still version-controlled (in sidecar)
- ✅ CI can clone both repos
- ✅ Clear ownership: sidecar is harness-managed
- ⚠️ More complex git workflow
- ⚠️ Sidecar repo to manage, permission, back up
- ⚠️ Cross-repo coordination during refactoring

**Best for:** teams that want main repo cleanliness without giving up version control of tests, organizations with mature multi-repo workflows.

#### Configuration D: Tests cloud-only (ADVANCED)

```
customer-repo/                # No test files at all
└── src/orders.ts

(Vendor cloud)
└── Workspace tests for orders.ts (stored in DO SQLite)
```

Customer configures: `test_location: cloud_only`.

**Architecture:**
- Tests live in workspace DO SQLite
- Cloud Sandbox spawned per test run: clones customer repo, injects tests from DO, executes, returns results
- Agent sees tests via context window injection from cloud
- Developer accesses tests via dashboard UI (read, edit, export)
- CI integrates via vendor API: `interlinked test-run` instead of `npm test`
- Test version history maintained in cloud, exportable on demand

**Tradeoffs:**
- ✅ Main repo absolutely clean of test files
- ✅ Tests still version-tracked (in vendor cloud)
- ✅ Agent has full test visibility
- ⚠️ Customer CI must integrate with vendor API
- ⚠️ Customer IDE doesn't show tests locally
- ⚠️ Test debugging requires dashboard or CLI to view test code
- ⚠️ Test IP/version control at vendor (some customers won't accept this)
- ⚠️ Cannot run tests offline without first downloading
- ⚠️ Some compliance frameworks require test code in customer-controlled storage

**Best for:** the rare customer who has strong "lean main repo" requirements and accepts the operational tradeoffs. Often pitched as "managed test infrastructure" — vendor handles test storage, customer focuses on application code.

#### Configuration E: No tests at all (NOT SUPPORTED)

Customer wants the harness without any test enforcement.

**This is not supported.** Tests are core to the harness's value proposition. A customer who doesn't want tests is not the right customer for this product. We don't deliver crippled value to win business that wouldn't otherwise convert.

### 22.4 The general decision framework for these tensions

For any customer preference that pushes against vendor opinion, apply this decision tree:

```
Is the customer's preference cosmetic (path, format, naming)?
├── YES → Support as configuration. Document the option. Default to vendor recommendation.
└── NO ↓

Does the customer's preference reduce harness value but preserve core function?
├── YES → Support as advanced configuration. Document tradeoffs explicitly. 
│         Default to vendor recommendation with warning when customer chooses alternative.
└── NO ↓

Does the customer's preference eliminate harness value?
├── YES → Do not support. Refuse the configuration. Document why.
└── NO ↓

Is the customer's preference better than vendor's default for this customer's context?
├── YES → Update vendor default OR support as documented alternative
└── NO → Default holds
```

Examples:

- "Tests at `__tests__/` instead of `tests/`" → cosmetic, support directly
- "Tests in cloud only" → reduces value (no local IDE visibility) but preserves core function (tests still exist and run) → advanced configuration with documented tradeoffs
- "No tests at all" → eliminates value → refuse
- "Tests must run in our existing CI, not vendor's" → reduces value (less integration) but preserves core function → supported with documented tradeoffs

### 22.5 Other configurable surfaces beyond test location

The same principle applies to many other product decisions:

#### Configuration locations

| Artifact | Default | Configurable options |
|---|---|---|
| Capability maps | `capability-map.yaml` in repo | Custom path, cloud-managed |
| Domain Semgrep rules | `.semgrep/` in repo | Custom path, cloud-managed |
| `/enforce` rule files | `.claude/skills/enforce/` | Custom path, cloud-managed |
| Workspace config | `.harness.yaml` in repo | Custom path, environment vars, cloud dashboard |
| LoC limits | Compiled defaults | Per-file-type overrides in workspace config |

#### Enforcement strictness levels

For each lane and tier, customer can choose strictness:

| Level | Behavior |
|---|---|
| `strict` (default for security) | Block on any finding |
| `enforce` (default for quality) | Block on critical/high, warn on medium |
| `advise` (option) | Warn on all findings, don't block |
| `monitor` (option) | Log findings, don't surface to agent |
| `off` (option for specific rules) | Disable specific checks |

#### Rule selection within lanes

Customer can:
- Disable specific Lane C rules (with audit log of disabled rules)
- Add custom Lane C rules (their own Semgrep patterns)
- Configure rule severity (within bounds — can't downgrade critical to low)
- Per-file-pattern rule overrides

#### Policy action overrides

The policy matrix from §21.3 is fully customer-configurable:
- For each (category × severity × provenance) tuple, customer chooses action
- Vendor provides recommended defaults
- Customer can override per workspace or per file pattern

#### Telemetry granularity

| Level | What's reported |
|---|---|
| `full` (default for paid tiers) | All measurement data |
| `aggregate` (default for free CLI) | Anonymized aggregate only |
| `minimal` (option) | Only crash reports and version |
| `off` (option) | Nothing |

### 22.6 What's non-configurable and why

The vendor's "we believe" opinions that don't yield, with reasoning:

**1. AI-generated code requires verification.**
- *Why non-configurable:* This is the product's reason for existing. A customer who rejects this isn't a customer.
- *Customer escape:* Don't use the harness.

**2. Critical security findings must be addressed.**
- *Why non-configurable:* These are by definition findings that endanger the customer or their users. Allowing override creates liability for vendor and potential harm for customer's users.
- *Customer escape:* False positive triage process; vendor adjusts the rule's specificity, not whether it blocks.

**3. Receipts must be cryptographically signed (paid tiers).**
- *Why non-configurable:* The receipt's value is its tamper-evidence. Unsigned receipts are useless for audit.
- *Customer escape:* Use free tier (no signed receipts).

**4. The harness cannot be bypassed once engaged.**
- *Why non-configurable:* A bypassable harness has no value as a gatekeeper. The whole architecture depends on inviolability.
- *Customer escape:* Uninstall the harness if they don't want it.

**5. Verification must use deterministic primitives where available.**
- *Why non-configurable:* The receipt-bound trust model depends on this. Fuzzy substitutes (embeddings, similarity matching) weaken the trust architecture (per §9 of cost-latency-analysis.md).
- *Customer escape:* Use a different tool if they want fuzzy verification.

**6. Verification must complete within budget (30s blocking, 60s bridging).**
- *Why non-configurable:* Longer wait times break the agent feedback loop. Customers who want longer verification windows are misunderstanding what the harness is for.
- *Customer escape:* Use slower batch tools for the cases that need them.

These aren't arbitrary lines. Each represents a load-bearing assumption that the rest of the architecture depends on. Yielding on them would unravel the product.

### 22.7 Configuration as a feature

Done well, this framework becomes a feature in marketing and sales:

> "interlinked has strong opinions about what makes AI-generated code trustworthy. It also has strong opinions about respecting your team's conventions. Configure where artifacts live, which rules apply, and how strict enforcement is — but don't ever question whether your code is verified."

**Positioning against comparables:**

- SonarQube has comprehensive configuration but no opinions about AI agents specifically
- Snyk has opinions about security but limited customization
- GitHub Copilot has minimal customization at all
- interlinked has opinions AND deep customization, scoped to AI-agent-generated code

**Customer onboarding implications:**

The configurability framework affects the brownfield onboarding wizard from §21.7:

```
Step 3.5: Configuration preferences

Where should test files live?
[1] In your repo at tests/ (recommended for most teams)
[2] In your repo at a custom path
[3] In a sidecar repo we'll create
[4] Cloud-only (advanced; documented tradeoffs)

How aggressive should enforcement be?
[1] Strict — block on most findings
[2] Standard — block on critical/high, warn on rest (recommended)
[3] Advisory — warn but don't block
[4] Monitor — log but don't surface

What's your telemetry preference?
[1] Full (helps us improve the product, helps you measure ROI)
[2] Aggregate only (anonymized)
[3] Minimal (crashes only)
[4] Off
```

Each choice is explicit, each comes with vendor recommendation, each documents implications.

**Customer success implications:**

Customer success teams need to:
- Identify when customer configuration is undermining harness value
- Recommend default-aligned configurations during onboarding
- Track which non-default configurations correlate with churn or low engagement
- Update defaults when customer base patterns show better choices

A customer who configures everything to "advise" mode and never sees blocking probably won't see the value and will churn. Customer success identifies this pattern and intervenes early.

### 22.8 Implementation across phases

The configurability framework is largely infrastructure-level work, distributed across phases:

**Phase 0 additions:**
- **0.11 Configuration substrate.** YAML-based workspace config with schema validation. Cloud-managed or repo-resident per customer choice. Override hierarchy: workspace defaults → file-pattern overrides → individual file overrides.

**Phase 0.9 (Customer-facing surfaces) additions:**
- Configuration management UI in dashboard
- CLI commands: `harness config get/set`, `harness config validate`
- Configuration migration tools for changing layouts

**Phase 4 additions:**
- **4.7 Policy configuration loader.** Reads workspace config, applies overrides, validates against vendor constraints.

**New Phase 11.10 (within brownfield onboarding):**
- Configuration wizard during onboarding
- Default recommendation engine based on detected codebase characteristics

**Phase 12 (new, post-launch):**
- **12.1 Test storage abstraction.** Support for the four test location configurations (repo-default, repo-custom, sidecar, cloud-only). Test execution adapter for each.
- **12.2 Sidecar repo management.** Auto-create, auto-sync, permission management for customers choosing sidecar.
- **12.3 Cloud-only test infrastructure.** DO storage of tests, Sandbox execution flow, dashboard UI for test management, CLI/API for CI integration.
- **12.4 Configuration analytics.** Track which configurations correlate with adoption success vs. churn; feed back into default recommendations.

### 22.9 The customer story this enables

For sales conversations where customer expresses concerns about vendor opinions vs. their preferences:

> "We have strong opinions about what verification means. We don't have strong opinions about how it fits into your existing setup. Tell us your conventions and we'll configure around them — within the constraints of what makes verification meaningful."

For technical evaluators who push hard on configurability:

> "We're not Snyk or SonarQube where every rule is independently configurable to the point that you can make it do nothing. We're not GitHub Copilot where you take what we give you. We sit in the middle: opinionated about what we believe, flexible about how you integrate it. Here's the configuration matrix."

For customers comparing against in-house tooling:

> "You could build something custom that matches your exact preferences perfectly. You'd then have to maintain it, evolve it, support it. We give you 80% of your preferences with 100% of the verification capability, for less than the cost of one engineer maintaining custom infrastructure."

This framing — opinions about what, flexible about how — is also the right framing for the broader product strategy. It justifies premium pricing (opinions = expertise = value) while addressing the legitimate customization needs that prevent customer churn (flexibility = respect = trust).

### 22.10 Decision log addendum

Adding to §20 Decision Log:

**Why is test file location customer-configurable but the existence of tests is not?** Because tests are core to the harness's value proposition (Lane A doesn't function without tests), but where they live is operational preference. The "opinions about what, configurable about where" principle. A customer who doesn't want tests at all is asking for a different product.

**Why support cloud-only tests if it has so many tradeoffs?** Because the rare customers who genuinely want this configuration are often the highest-value enterprise customers — they have specific architectural requirements (lean main repo, vendor-managed test infrastructure) that translate to willingness to pay. Supporting the configuration is cheap; refusing it loses those customers entirely.

**Why is the policy matrix configurable but rule existence is not?** Because rules represent vendor's domain expertise (what should be checked); policy represents customer's enforcement preferences (how strict to be about it). Both are valid concerns and should be separated. Customer can say "I want this checked less aggressively" without having to say "I don't want this checked."

**Why allow customers to override the policy matrix at all if defaults are aggressive?** Because not all customers are in the same context. A regulated bio/clinical customer needs maximum aggression; a hobbyist exploring AI tools wants minimum interference. The defaults serve the majority who haven't expressed a preference; configuration serves the minority who have. Both are first-class customers.

**Why distinguish "non-configurable" from just "we strongly recommend"?** Because vendor reputation depends on certain things. If a customer disables secret detection and then ships secrets to production, they will blame the vendor regardless of who configured what. Some things must be non-configurable to protect the vendor's integrity and the customer's outcomes simultaneously.
