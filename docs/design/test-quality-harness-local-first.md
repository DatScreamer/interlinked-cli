# Verification Harness Plan — Local-First Subset (Phases 0–3.7)

**Project:** interlinked-cli harness, local-first verification stack (test adequacy + code correctness + security/supply-chain + runtime resilience), Phase 0 through Phase 3.7 only.

**Companion document:**
- `docs/test-quality-harness-plan.md` — full v3.2 plan including cloud Tier 2 (Cloudflare DO+Facets+Sandboxes+Workflows+Outbound Workers), Phases 4–11, customer-facing surfaces, brownfield onboarding wizard, and configurability framework. Plans for later. This subset deals exclusively with local checks and tests that don't require or aren't best served by a remote/cloud offering.

**Thesis (one paragraph):** The harness slows the agent down on every edit, deliberately, using the full PreToolUse latency window (30-second hard timeout from Claude Code) for an adaptively-selected subset of the maximum-value verification that fits the current edit's context — and surfaces longer work on PostToolUse, Stop, pre-push, and CI. Lane A/B/C/D coverage with shadow-mode promotion. State is local-canonical (SQLite under `.interlinked/`); a sync substrate (federated peer, remote, or otherwise — undecided here) is additive only when later phases need it, never the default. The receipt schema is designed up front to be cryptographically signed and content-hash-keyed so it transfers cleanly to whatever sync layer eventually arrives, without rework. Customer-facing surfaces (dashboard, REST API, brownfield wizard) and sales positioning live in the companion v3.2 doc as future work; this subset is exclusively local.

**Why local-first first:**
- The 30s PreToolUse hook timeout is a Claude Code constraint that applies locally regardless of substrate. The existing daemon answers in ~1ms (protocol overhead); the remaining ~29s is the working budget for valuable verification, filled adaptively by smart selection (§13).
- A local SQLite ledger of receipts, findings, baselines, and selection decisions is sufficient to enable promotion gating, replayability, and Compression-Program-style measurement. Storage starts local-canonical; sync is additive only when needed.
- Customer-facing surfaces (dashboard, REST API, brownfield wizard) are premature until the local kernel has empirical user data.
- The receipt schema's "transferable certificate" property (cryptographically signed, content-hash-keyed) preserves forward-compatibility with future sync without forcing a substrate decision today.

**Scope notes:**
- Phases 4 through 11 (Cloudflare Tier 2 substrate, Supermodel covering-set wiring beyond Phase 5 prereqs, capability maps, domain rules, LLM review, Tier 5 infrastructure, fuzzing, hardening, brownfield onboarding, configurability implementation) — see the v3.2 plan.
- The remote-sync gauntlet (v3.2 §13) is entirely out of scope here; the local adaptive-selection substrate is described in §13 below.

---

## 1. Problem Framing

*Goal: Establish what the local-first harness is and what it isn't. It is a synchronous-blocking + async-surfacing gauntlet around every edit, locally. It is not a cloud-orchestrated fan-out substrate.*

### 1.1 The local discipline budget

*Goal: Make explicit what the actual hook budgets are and how the adaptive selection substrate uses them.*

Local cadence is structured around the Claude Code hook timeouts. The numbers:

- **PreToolUse — 30-second hard timeout.** Synchronous-blocking before the edit. Existing daemon decision is ~1ms (protocol overhead); the remaining ~29s is the *available working budget for verification*. The substrate (§13) decides adaptively per-edit how much of that budget to actually use — most edits use a small fraction, but the budget is there when valuable checks fit it. The 4.4s linger latency in `interlinked-activity.mjs` when the server is down ([[project_hook_script_linger_latency]]) is a tracked bug, not part of the working budget.
- **PostToolUse — 30-second hard timeout.** Synchronous-blocking after the edit lands. Existing harness typically uses 0.2–1.4s for quality checks; stays sync per [[feedback_posttooluse_stays_sync]]. Do not propose async/next-turn channels for sync per-edit warnings.
- **Stop** runs at the end of the agent's turn. Several seconds tolerable; reflection content only, no blocking. **Stop is the only end-of-work surface the local kernel uses.**
- **SessionEnd is wired narrowly and Claude-Code-only — two items.** (1) A reason-aware audit-chain row annotating *how* the session ended (`clear` / `resume` / `logout` / `prompt_input_exit` / `bypass_permissions_disabled` / `other`), useful for forensic post-mortems — only Claude Code emits a `reason`. (2) One-time `reconcileCommits` finalization (already gated on session_end at `src/lib/hooks-template.ts:1023-1025`). Everything else stays on Stop. Codex has no SessionEnd event so neither item runs there; Gemini's SessionEnd is fire-and-forget; hard-kill skips SessionEnd on every runner. The kernel's incremental durability discipline (PostToolUse receipts + Stop reflection) ensures the worst-case state-at-exit is recoverable on any runner. SessionEnd's broader future role is the cloud/remote tier (final session-bundle upload, batched receipt sync) — that's v3.2 substrate, deferred. See `docs/design/harness-system-diagrams.md` §7 for the per-runner contract.
- **Pre-push / CI** runs only when explicitly invoked. Minutes acceptable.
- **Scheduled / continuous** runs in the background with no per-edit budget.

The substrate's job is to **use the 30-second PreToolUse window intelligently** — under-filling it wastes the budget the agent has already accepted; over-running it times out the hook. Adaptive selection (§13) picks the subset of tests and checks that fits the window AND has the highest expected value for the current edit's context, and constantly improves which tests run, at which stage, in which environment based on accumulated receipts. Work that doesn't fit routes to PostToolUse, Stop, pre-push, or scheduled cadences. [[feedback_hook_latency_budget]]: hooks have no sub-10ms budget — the 10ms in `project-graph.ts` is per-file regex, not pipeline budget. Plenty of headroom up to 30s.

### 1.2 Layer 1 and Layer 2 today

*Goal: Snapshot what's live in the harness now, and name the hole the local gauntlet still has to fill.*

The existing harness enforces verification in two conceptual layers, only one of which is live, and across an implicit single lane (test adequacy).

**Layer 1 — Shape & behavior enforcement (live, zero-dependency, firing on every edit).** Existence gates (`tdd_new_file_gate`, `test_file_exists`, `prod_delta_no_test_delta`, `prod_test_loc_ratio`, `done_without_verify`), red/green cycle tracking (`server-tdd-cycle.ts`, `behavioral-checks.ts`), anti-gaming shape checks (placeholders, `.only`, assertion density, assertion-free tests, assertion roulette, over-mocking, snapshot overuse, duplicate names, SUT-import absence, SUT self-mocking, nondeterminism, real I/O in unit tests), diff-aware commit gates.

**Layer 2 — Ground-truth-ish verification (dormant).** Coverage analysis and mutation testing exist in the codebase as primitives (`mutation-gate.ts`, `coverage-ratchet.ts`, CRAP machinery via `crap.ts`) but are not wired into the live loop.

**The structural problem with Layer 1 alone:** every shape check is reverse-engineerable. The agent can satisfy assertion density with weak assertions, satisfy SUT-import with import-but-don't-use, satisfy red/green by writing a test that fails trivially and then makes it pass trivially. The harness comment in `behavioral-checks.ts:679` already acknowledges this: *"Plan 10 (mutation testing) catches it asynchronously."* Plan 10 isn't wired. The hole is open.

Mutation testing is the **strongest currently practical behavioral-discrimination signal** available — it empirically verifies that *a test can fail when the code is wrong*. It is **not absolute ground truth** (it measures discrimination against Stryker's mutator set, not all possible bugs), and it is one of several ground-truth-ish signals alongside red-then-green, acceptance tests, property tests, and production-bug regressions. Central in the test-adequacy lane, not singular — the local gauntlet's strength comes from composing many disciplines.

### 1.3 The four-lane reframe

*Goal: Establish that the gauntlet defends code quality along four orthogonal axes, because the agent optimizes for whichever is measured and you need to measure all four.*

Test adequacy is only one verification family. Three others are categorically distinct:

- **Code correctness independent of tests** (types, lint, complexity, dead code, architecture rules) — code can be correct-by-construction without any test running.
- **Security and supply chain** (SAST, SCA, secrets, IaC, container, license) — bug classes mutation cannot generate mutants for.
- **Runtime and behavioral resilience** (property tests, API fuzzing, performance, flakiness, e2e, coverage-guided fuzzing) — properties tests can't express as examples and static analysis cannot prove.

The gauntlet has to hit all four lanes (§5), because partial coverage produces well-tested wrong code, or type-safe untested code, or locked-down broken code.

### 1.4 LLM review (deferred)

*Goal: Note that judgment-class checks are valuable but out of scope here.*

Out of scope for this subset. v3.2 plan §1.4 / Phase 7.5 covers it. When/if added later, must use open-weight models only and never block — the harness is infrastructure, not an agent. Local-first kernel ships before any LLM-review work begins.

### 1.5 The multi-agent throughline (forward-compat)

*Goal: Explain why the local gauntlet has to be load-bearing now, even though only one agent uses it.*

The gauntlet *is* the trust boundary between agents. When Agent B inherits a workspace where Agent A has been editing, Agent B needs to trust that Agent A's edits passed real disciplines. That trust is only possible if the single-agent gauntlet is deterministic, receipt-bound, and consistent.

This is why the disciplines in this subset are designed to be rigorous now. Forward-compatibility seams (§15.3) preserve the multi-agent option without building it. Receipts are content-hash-keyed and cryptographically signable from day one (§18 Phase 0.3).

---

## 2. The Two Test-Quality Techniques (Lane A Primer)

*Goal: Define coverage and mutation precisely — what each empirically verifies, where each fails, why mutation is central but not singular to Lane A's gauntlet contribution.*

### 2.1 Coverage Analysis

Runs tests with bytecode/AST instrumentation; records which lines, branches, and statements executed. Returns a percentage.

**Fundamental limit:** coverage measures *execution*, not *verification*. A test that calls `add(2,3)` and asserts nothing achieves 100% line coverage. Coverage is necessary but profoundly insufficient.

**Two coverage products at two cadences:**
- **Diff-aware "are your new lines hit?"** — post-processing of a piggybacked test run, microseconds, surfaces fast in Tier 1.
- **Per-file ratchet (%)** — needs whole-suite coverage for correctness; Tier 3 (Stop) cadence locally.

### 2.2 Mutation Testing

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
- `covering_test_runtime` — **set by blast radius, not by you.** This decides which cadence the check fits.

### 2.3 CRAP

`comp² × (1 − cov)³ + comp`, per function — the canonical Crap4J metric (Savoia & Evans, 2007), matching `src/harness/checks/crap.ts::crapScore`. Free once coverage exists. Plain-language: *high complexity + low coverage = high risk; well-tested or simple code scores low* — the `(1 − cov)³` factor zeroes the squared term at full coverage, so a fully-covered function scores just `comp`. Crap4J's native threshold is CRAP > 30. Rides whatever coverage cadence you choose.

### 2.4 Property Tests in Lane A's Cost Model — Bob Martin's Concern

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

*Goal: Anchor every cost estimate in measured numbers from this codebase.*

(Quentin's machine, single-file vitest, threads enabled. Lane A only.)

| Measurement | Value |
|---|---|
| Vitest startup tax (per invocation) | ~0.6s |
| Single-file unit test, pure (19 tests) | 0.8s |
| Single-file subprocess-heavy (35 tests, real git spawns) | 3.6s |
| V8 coverage instrumentation overhead | +10–30% |
| Diff-scoped Stryker mutant count | 5–20 |
| Full-file Stryker mutant count | 80–150 |
| Daemon PreToolUse decision time (protocol overhead) | ~1ms |
| Inline cold-fallback PreToolUse (protocol overhead) | <50ms |
| `interlinked-activity.mjs` linger (server down) | ~4.4s — tracked bug |
| PreToolUse hook hard timeout (Claude Code) | 30s |
| PostToolUse hook hard timeout (Claude Code) | 30s |
| PostToolUse typical use (existing quality checks) | 0.2–1.4s observed |

**Blast radius distribution in this codebase (verified):**

| File class | Direct importers | Covering-test set |
|---|---|---|
| `checks/crap.ts` (leaf) | 1 | ~1–3 |
| `checks/shared.ts` (hub) | 47 | ~47+ |
| `harness/types.ts` (mega-hub) | 316 | ~whole harness suite |

Distribution is bimodal. Most files are leaf or mid-fan-in; a small number of hubs dominate the cost tail.

**Implication for local-first:** hub-file *whole-suite* mutation/coverage won't fit the 30s PreToolUse window on a single machine — the smart-selection substrate (§13) picks the highest-value subset that does fit and routes the rest to Stop / scheduled. Leaf-file diff-scoped mutation can fit Tier 1 today. The placement isn't fixed; the substrate decides per-edit and improves over time.

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

**Local cadence implication:** the first seven rows fit Tier 1 trivially. The expensive rows are Tier 3 (Stop) or Tier 4 (scheduled) only — locally there is no Tier 2.

---

## 5. The Four Verification Lanes

*Goal: Decompose code quality into four orthogonal verification families. The gauntlet must hit all four to be robust against agent calibration.*

### 5.1 Lane A — Test Adequacy

**Tools:** red/green cycle tracking, coverage, mutation, CRAP, acceptance tests, property tests (Lane D crossover), Layer 1 shape checks, test-runtime ratchet, flakiness detection (Lane D crossover).

**Verifies:** Mostly the *test code* and the *relationship* between test and SUT.

**Gaming surface:** High. Most Layer 1 checks pattern-matchable; mutation gameable against Stryker's mutator set (§14).

**Adversarial defenses:** Mutator rotation, recurrence-feedback loop, pairing with external-reality lanes.

### 5.2 Lane B — Code Correctness and Maintainability

**Tools:** TypeScript strict, ESLint/Biome/oxlint, cyclomatic complexity, dead-code detection (Supermodel Deadcode Hunter), import-cycle detection, architecture rules (Dependency Cruiser), doc-vs-signature drift.

**Verifies:** The *production code* directly, without running tests.

**Gaming surface:** Low. Most checks deterministic and rule-based.

**Cost profile:** Mostly cheap. Most fit Tier 1 trivially.

### 5.3 Lane C — Security and Supply Chain

**Tools by bug class:**
- **Secret detection:** Gitleaks, TruffleHog, inline regex
- **Dependency CVEs:** OSV-Scanner, npm/pnpm audit, Dependabot
- **Pattern-based SAST:** Semgrep core rules
- **Taint analysis:** Semgrep Pro/interfile, CodeQL (deferred until Phase 9 cloud or local CodeQL CLI)
- **Misconfiguration:** Trivy, Checkov, tfsec
- **Supply-chain posture:** OpenSSF Scorecard, SLSA/provenance
- **Reachability filtering:** graph-derived filter on dependency CVEs

**Gaming surface:** Variable. Pattern-based moderately gameable; taint analysis harder; CVE matching essentially ungameable; secret detection hard to fake-around.

**Cost profile:** Bimodal. Diff-scoped Gitleaks, lockfile-delta SCA, curated Semgrep <2s. Full CodeQL DB build minutes-to-hours (deferred).

### 5.4 Lane D — Runtime and Behavioral Resilience

**Tools by flavor:**
- **Property-based (generative):** fast-check
- **Coverage-guided (structural):** jsfuzz, jazzer for untrusted-input parsers (Tier 5)
- **API/contract/protocol:** Schemathesis, custom contract diffing
- **Behavioral:** Playwright e2e, acceptance (Lane A crossover)
- **Operational:** flakiness detection, performance benchmarks

**Gaming surface:** Low. Random seeds explore blindspots by construction.

**Cost profile:** Variable. Bounded property tests can fit Tier 1 for small N; aggressive fuzzing and full e2e are Tier 3, 4, or 5.

---

## 6. Cadence Tiers (Local Subset)

*Goal: Define the local-only cadence cascade. There is no Tier 2 locally — that's cloud substrate per v3.2 §13.*

```
┌─────────────────────────────────────────────────────────────────┐
│ TIER 1 — Local-sync (PreToolUse + PostToolUse)                  │
│ Hard ceiling: 30s per hook (Claude Code timeout)                │
│ Working budget: up to 25s PreToolUse / 0.2–1.4s typical Post    │
│ Adaptive per-edit selection (§13) fills the window with the     │
│ highest-value subset of tests/checks for this edit's context.   │
│ Most edits use a fraction; the budget is there when valuable.   │
├─────────────────────────────────────────────────────────────────┤
│ TIER 3 — Async / Stop / pre-push / CI     budget: 60s–minutes   │
│ Event-triggered, non-blocking-but-surfaced                      │
│ Splits into Stage 5 (post-edit Stop) and Stage 6 (pre-push/CI)  │
├─────────────────────────────────────────────────────────────────┤
│ TIER 4 — Scheduled / nightly discrete     budget: minutes–hours │
│ Time-triggered, non-blocking, discrete jobs                     │
│ Full Scorecard, mutation sweeps, full image scans               │
├─────────────────────────────────────────────────────────────────┤
│ TIER 5 — Continuous / persistent state    budget: continuous    │
│ Background-running with persistent state across runs            │
│ Coverage-guided fuzzing (corpus), continuous SCA polling        │
└─────────────────────────────────────────────────────────────────┘
```

**No Tier 2 locally.** v3.2's Tier 2-blocking and Tier 2-bridging are cloud-substrate organizational concepts (DO+Facets+Sandboxes fan-out). Locally, the 30s PreToolUse window IS the same window cloud Tier 2-blocking uses — but it's called Tier 1 here because there's only one local execution context, not two. The smart-selection substrate (§13) is the local analog of v3.2 §13.9 admission. Work that doesn't fit Tier 1 after selection routes to Tier 3.

### 6.1 Trigger axis (orthogonal to cadence)

- **Per-edit:** Every Edit/Write/MultiEdit. Lane A shape checks, Lane B lint/types, Lane C diff-secret-scan.
- **Event-triggered:** Specific file types or change patterns. Lockfile → SCA. Dockerfile → Trivy. Schema → migration check.
- **Periodic / scheduled:** Time-based discrete jobs (Tier 4).
- **Continuous:** Always running with persistent state (Tier 5).

Event-triggered is underexploited locally. Conditional triggering ("only run heavier Semgrep when an edit touches an HTTP handler or DB call") is cheaper than periodic and more targeted than per-edit. Lane C benefits especially.

---

## 7. Lane × Cadence Matrix — Local Subset

*Goal: Master placement table for local-first cadences. v3.2 §7 has the full matrix including Tier 2 columns; here we drop those.*

### 7.1 Lane A — Test Adequacy

| Tool / check | T1 local | T3 Stop/CI | T4 scheduled | T5 continuous |
|---|---|---|---|---|
| Layer 1 shape checks | ✓ default | — | — | — |
| Red/green cycle tracking | ✓ default | — | — | — |
| Test-runtime ratchet | ✓ default | — | — | — |
| Piggyback diff coverage | ✓ default | — | — | — |
| CRAP (from manifest) | ✓ default | — | — | — |
| Coverage ratchet (whole-suite %) | — | ✓ Stop | — | — |
| Mutation (diff-scoped, leaf/mid) | ✓ admitted | — | — | — |
| Mutation (diff-scoped, hub) | — | ✓ pre-push | — | — |
| Mutation (full file/repo) | — | ✓ pre-push | ✓ nightly | — |
| Mutation w/ property tests | — | — | ✓ default | — |
| Acceptance tests (short scenarios) | — | ✓ Stop | — | — |
| Acceptance tests (full suite) | — | — | ✓ default | — |

### 7.2 Lane B — Code Correctness

| Tool / check | T1 local | T3 Stop/CI | T4 scheduled | T5 continuous |
|---|---|---|---|---|
| TypeScript strict (`tsc --noEmit` incremental) | ✓ default | — | — | — |
| ESLint / Biome / oxlint (changed files) | ✓ default | — | — | — |
| Cyclomatic complexity | ✓ default | — | — | — |
| Dead-code detection (Supermodel) | — | ✓ Stop | — | — |
| Import-cycle detection | ✓ default | — | — | — |
| Architecture rules | possible | ✓ default | — | — |
| Doc-vs-signature drift | possible | ✓ default | — | — |
| Whole-project type-check | — | ✓ Stop | — | — |

### 7.3 Lane C — Security and Supply Chain

| Bug class / check | T1 local | T3 Stop/CI | T4 scheduled | T5 continuous |
|---|---|---|---|---|
| Secrets — inline detection (high-confidence) | ✓ default fail-closed | — | — | — |
| Secrets — Gitleaks (changed diff) | possible | ✓ default | — | — |
| Secrets — Gitleaks (full history) | — | ✓ pre-push | ✓ default | — |
| Dependency CVEs — OSV-Scanner (lockfile delta) | ✓ event-triggered | — | — | — |
| Dependency CVEs — OSV-Scanner (full closure) | — | ✓ default | ✓ default | ✓ external-feed-poll |
| License + maintainership + postinstall check | ✓ event-triggered | ✓ default | — | — |
| Pattern SAST — Semgrep curated (changed files) | ✓ default | — | — | — |
| Pattern SAST — Semgrep org policy | — | ✓ default | — | ✓ scheduled-poll |
| Misconfiguration — Trivy (changed Dockerfile/IaC) | ✓ event-triggered | — | — | — |
| Misconfiguration — Trivy (full image scan) | — | ✓ pre-push | ✓ nightly | — |
| Misconfiguration — Checkov / tfsec (changed IaC) | ✓ event-triggered | ✓ default | — | — |
| Reachability filter on dependency CVEs | ✓ default (graph-derived) | ✓ default | — | — |
| Supply-chain posture — OpenSSF Scorecard | — | — | ✓ default | — |
| Domain-specific custom rules (Semgrep) | ✓ default | ✓ default | — | — |

### 7.4 Lane D — Runtime and Behavioral Resilience

| Tool / check | T1 local | T3 Stop/CI | T4 scheduled | T5 continuous |
|---|---|---|---|---|
| fast-check property tests (bounded N) | ✓ admitted (small N) | ✓ default | — | — |
| fast-check (deep shrink, large N) | — | — | ✓ default | — |
| Coverage-guided fuzzing (untrusted-input parsers) | — | — | — | ✓ default |
| Schemathesis (changed OpenAPI/GraphQL diff) | ✓ event-triggered | ✓ default | — | — |
| Schemathesis (full schema fuzz) | — | — | ✓ default | — |
| API contract diff (schema breaking-change) | ✓ event-triggered | — | — | — |
| Playwright e2e (smoke, headless) | — | ✓ default | — | — |
| Playwright e2e (full suite) | — | — | ✓ default | — |
| Performance microbench (per-function hot-path) | — | ✓ default | — | — |
| Performance regression (whole-suite) | — | — | ✓ default | — |
| Flakiness sampling (N=5 reruns on subset) | — | — | ✓ default | — |
| Migration smoke (apply + verify schema diff) | ✓ event-triggered | ✓ default | — | — |

---

## 8. Categorization Axes for Reasoning About the Stack

*Goal: Five axes for reasoning about why a tool belongs where it belongs — used when adding a new tool or auditing for coverage gaps.*

### 8.1 Five axes that matter most

**Axis 1 — Lane (§5):** A / B / C / D. Answers *what bug class are we addressing?*

**Axis 2 — Cadence (§6):** Tier 1 / 3 / 4 / 5. Answers *what latency budget and trigger context?*

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

- **Hard to game (external reality):** Acceptance tests against real endpoints, property tests with random seeds, performance benchmarks, real-bug regressions, SCA against external vulnerability DBs, secret scanning of high-entropy strings.
- **Moderately gameable (finite explicit rule set):** CodeQL queries, Semgrep rules, mutation testing.
- **Easily gameable (pattern-matchable surface):** Shape checks, coverage percentage, test counts.

**Design implication:** stack must contain at least one hard-to-game signal per lane. Otherwise the agent calibrates to gameable signals over time.

**Axis 5 — Deterministic vs. probabilistic vs. heuristic:** dictates gating policy.

- **Deterministic** (same input → same output): can hard-block.
- **Probabilistic / sampled** (real findings, not exhaustive): advise with confidence intervals.
- **Heuristic** (needs judgment): never hard-block; only inform.
- **Quasi-deterministic with recall risk** (deterministic for rule set, but rule set is finite): can hard-block within rule scope.

### 8.2 Three more axes for tool decisions

**Axis 6 — Static vs. dynamic:** predicts cost.

**Axis 7 — Scope of context required:** single-file / graph-derived / project-derived / environment-derived. Dictates cache strategy.

**Axis 8 — Trigger:** per-edit / event-triggered / periodic / continuous. Same tool can have variants on different triggers.

### 8.3 Using them together

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

Note: existing `recurrences.jsonl` corpus is ~99% probe noise ([[project_echo_reconciliation_corpus_probe_dominated]]). Cleaning that corpus is a precondition for the feedback loop to produce useful signal.

### 9.4 Test-runtime ratchet (keystone)

*Goal: Measure per-file test runtime so admission to heavier checks (mutation, coverage) is data-driven, not guessed.*

Harness intercepts test-run commands; vitest emits per-file `Duration`. Record to local SQLite (Phase 0.2) with absolute ceiling and regression ratchet. Deterministic, free. **Precondition for any Tier 3 mutation/coverage placement decision.** Without it, placement is a guess. (Phase 2.)

Don't *ban* slow tests, *price* them. `behavioral-diff-checks.test.ts` at 2.88s spawning real git is the correct test for code that shells to git. Block avoidable slowness; route legitimate integration tests to different cadence.

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

- TS strict + `tsc --noEmit` incremental as harness finding source.
- ESLint / Biome / oxlint integrated as PreToolUse-blocking on changed files.
- Import-cycle detection.
- Dead-code detection via Supermodel (users only; internal fallback skips).
- Doc-vs-signature drift advisory.

### 10.2 Lane C — Security and Supply Chain

- **Inline secret detection (Phase 1, Tier 1, fail-closed).** Pattern-based PreToolUse block on confirmed secret patterns. No Gitleaks dependency.
- **Gitleaks as project/strict verification (Phase 3, Tier 3).**
- **OSV-Scanner event-triggered on lockfile change (Phase 3, Tier 1).**
- **License/maintainership/postinstall check on new-dep events (Phase 3, Tier 1 event-triggered).** Block on unauthorized postinstall scripts. Already partially shipped via `interlinked allowlist` (per CLAUDE.md §"Supply-chain allowlist").
- **Curated Semgrep ruleset for changed files (Phase 3, Tier 1).** Start small — 10–20 rules.
- **GitHub secret scanning enabled at repo level (Phase 3, free, runs in background).**
- **Domain-specific custom rules — inventory begins (Phase 3, thinking work), authoring (later phase).**
- Defer beyond this subset: CodeQL full, Semgrep full policy, full image scans, Scorecard, SLSA.

### 10.3 Lane D — Runtime Resilience (Phase 2 + later)

- **Flakiness baseline (Phase 2, Tier 4 scheduled).** Sample N=5 reruns nightly.
- **fast-check integration for pure-function modules (later, Tier 1 or Tier 3).**
- **API contract diff on schema-file change (later, Tier 1, event-triggered).**
- **Migration smoke test on migration-file change (later, Tier 1 event-triggered).**
- **Performance microbench for known hot paths (later, Tier 3).**
- **Coverage-guided fuzzing (later, Tier 5).** Targeted at untrusted-input parsers.
- Defer beyond this subset: Schemathesis full fuzz, Playwright full e2e, deep property-test shrink, accessibility audits.

---

## 11. Supermodel Integration — Per-Dimension Mapping

*Goal: Map Supermodel's four graph layers to harness needs lane-by-lane.*

| Dimension | Supermodel contribution | Lane | Status |
|---|---|---|---|
| **Test coverage (static)** | Test Coverage Map. Recall-limited: dynamic dispatch, higher-order, re-exports invisible. Union with file-level imports as safety floor. | A | Test selection: usable now. Coverage % gates: still need V8. |
| **Dependency structure** | Flagship. File-level imports give file-level blast radius. Function-level `[calls]` collapses many hub edits. | A, B | File-level: wired. Symbol-level: parsed, surfaced as advisory, **not yet wired into covering-set computation.** Phase 5 (future). |
| **Reachability filter on dependency CVEs** | Call graph filters OSV findings to actually-reachable vulnerabilities. | C | Phase 5 (future). |
| **Dead-code detection** | Supermodel Deadcode Hunter. | B | Phase 3 surfaces as Tier 3 finding. |
| **Cyclomatic complexity** | Composed: weighted blast radius. Feeds CRAP. | A, B | Phase 3. |
| **Module sizes** | Useful indirectly: graph identifies *structural seams* for file-splitting recommendations (§19). | B | Phase 3 advisory; §19 consumer. |
| **Mutation testing** | Graph supplies covering set, priority order. | A | Phase 5 (future). |
| **Cross-file invariants** | Custom graph queries. Compose with `/enforce`. | B, C | Later phase. |
| **Architecture rules** | Domain graph supports module-boundary rules. | B | Phase 3 baseline; later for custom. |
| **Acceptance tests** | **Graph cannot see them.** Need explicit feature-binding (capability tags + symbol map). | A | Later phase (Phase 6 in v3.2). |
| **RGR / refactor detection** | Indirect — signature-change vs. internal-only delta. | A | Phase 1. |
| **CRAP** | Free composition. | A | Phase 2 after coverage piggyback. |

**Pattern:** Supermodel makes *scoping* cheaper and more accurate. Can't fix epistemic limits of the checks themselves.

**Caveats:** Freshness race (`dependency-view.ts` trusts shard only when `shard_mtime ≥ source_mtime`); Supermodel shards exist only for paying users — internal fallback degrades `confidence_in_result`.

---

## 12. Acceptance Tests as a First-Class Category

*Goal: Establish acceptance tests as a first-class category with inverted gates and outer-loop cycle tracking. Capability-map work (Phase 6) is out of scope for this subset.*

Classification ships in Phase 0; inverted gates in Phase 1; capability-map work is deferred.

### 12.1 Where Layer 1 inverts

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

**`tdd_new_file_gate`** demands companion test per file. ATDD: scenario written first, each impl file would be blocked demanding its own companion.

**TDD cycle tracker** is per-file; acceptance tests run on outer loop — red for hours through many inner unit cycles. Future capability: two-tier tracker.

### 12.3 Where Layer 2 breaks worse

- **Coverage inflation:** one acceptance test hits 60% of codebase via indirection.
- **Mutation cost catastrophe:** slow, broad tests run once per mutant.
- **Mutation score weirdness:** surviving mutant could mean "tests are weak" or "this internal mutation isn't externally observable."
- **Call graph blindness:** §11.

### 12.4 Architectural correction (this subset)

Acceptance tests need first-class category, identified by path/annotation, with concrete work split across Phase 0–3.5:

- **Phase 0.1** — classifier detects an `acceptance` kind: path patterns (`tests/acceptance/`, `tests/integration/`, `*.feature`, `spec/integration/`, `e2e/`), `@acceptance` annotations, content heuristics (HTTP-client imports + absence of SUT imports). Every kind-aware check gets routing for free.
- **Phase 1** — kind-aware inverted gate set: `real_io_in_tests`, `over_mocking`, `test_missing_sut_import`, `prod_delta_no_test_delta` flip semantics for acceptance-classified files. Complementary gates fire instead (e.g. `acceptance_test_without_real_io`, mocking-invalidates-the-test).
- **Phase 2.6** — smart selection (§13) reads the capability-tag mapping (built in Phase 3.5) when deciding which acceptance scenarios fit the PreToolUse window for the current edit. Until Phase 3.5 ships, falls back to "short-runtime acceptance tests by recent failure rate."
- **Phase 3.5** — Acceptance test routing scaffolding (new — see §18). Capability-tag parser (`@<tag>` annotations on scenarios) + workspace-resident `capability-map.yaml` mapping tags to test files. Outer-loop cycle tracker for scenarios that span many inner cycles. Tier 4 scheduled full suite + capability-coverage drift detector.
- **Capability-to-symbol map** — deferred to v3.2 §12.5 / Phase 6. The kernel's Phase 3.5 ships tag → test-file routing only; tag → symbol routing requires the symbol map + drift detector v3.2 builds.
- **Tier 3 default cadence** — full acceptance suite runs at Stop / pre-push. Smart selection (§13) can opt short scenarios into PreToolUse once their runtime baseline is established (per-test bug-catch + p95 < 5s opt-in).
- **Exclusion from per-file ratio gates** — `prod_test_loc_ratio` and `prod_delta_no_test_delta` skip acceptance files entirely; one feature test legitimately covers dozens of impl files, so the per-file ratio is meaningless.

---

## 13. Smart Test-Selection Substrate

*Goal: Use the full PreToolUse latency window (30s hard timeout) for the maximum-value subset of tests and checks for the current edit's context, decided adaptively per-edit, and constantly improve which tests run at which stage in which environment based on accumulated receipts.*

### 13.1 The selection problem

Every edit produces a covering set — the tests that touch the changed code transitively, plus the checks that apply to the changed files. The covering set is often much larger than fits the PreToolUse window. The substrate's job: pick the subset that fits the working budget (up to 25s, headroom under the 30s hard timeout) and has the highest probability of catching a bug introduced by this edit; then route the rest to PostToolUse / Stop / pre-push / scheduled.

This is the local analog of v3.2 §13.9's admission decision, but applied to **tests** (not just checks), within the local PreToolUse window (not against a cloud fan-out substrate), and adaptive (track which tests catch real bugs and learn).

### 13.2 Three operating principles

- **Use the window.** The 30s budget exists; under-filling it wastes scrutiny the agent has already accepted.
- **Stay adaptive.** Don't run 30s of work when 100ms answers the question. Most edits don't need the whole window. The substrate decides per-edit how much to run based on edit context (file kind, blast radius, recent finding history).
- **Stay sync.** PreToolUse remains synchronous-blocking. No async/next-turn channel for sync per-edit warnings ([[feedback_posttooluse_stays_sync]]).

### 13.3 Selection inputs

The substrate decides per-edit. Inputs available locally:

| Input | Source | Purpose |
|---|---|---|
| Changed file(s) | Tool input | Direct |
| Diff hunks | Tool input | Scope |
| File-kind classification | Phase 0.1 classifier | Routing (unit vs acceptance vs config) |
| Blast radius | Supermodel graph (§11) | Covering-set size estimate |
| Symbol-level callers | Supermodel `[calls]` (§11) | Tighter covering set |
| Per-test runtime history | Phase 2.1 ratchet | Cost prediction |
| Per-test bug-catch history | Phase 0.4 + adaptive loop (§13.7) | Value prediction |
| Recent finding history | Phase 0.4 finding-history | Recency-weighted relevance |
| Per-check runtime / value history | Phase 0.3 receipts | Same shape as test selection |
| Current edit size | Diff size | Edit-level prior |
| Recent agent retry behavior | Session state | Retry-loop detection |

### 13.4 Selection algorithm (admission, applied to tests AND checks)

For each candidate test or check in the working set:

```
value = bug_catch_probability(item, changed_file) × severity_prior(item)
cost  = predicted_runtime_ms(item, current_machine)

select items greedily by (value / cost) until
  budget_remaining_ms < expected_next_item_cost_ms
```

Hard limits:
- Total selected runtime ≤ 25,000 ms (5s headroom under the 30s ceiling)
- No single item consumes > 5s of the budget unless flagged allow-long
- If the working set entirely fits, run all of it
- If no items touch the changed file, fall through to PostToolUse-only verification for this edit
- Cheap deterministic items (lint, types, secrets, shape checks) are admitted unconditionally up to their combined cost ceiling — they're not part of the ranked competition

### 13.5 Stage routing

Items not selected for PreToolUse route based on cost and value:

| Stage | Budget | Routing rule |
|---|---|---|
| **PreToolUse (Tier 1)** | up to 25s | Top-ranked items fit budget |
| **PostToolUse (Tier 1)** | 0.2–1.4s typical, up to 25s if needed | Items skipped for cost but high value; quick spot-checks |
| **Stop (Tier 3)** | 30–60s | Broader covering set; mutation against changed lines |
| **Pre-push (Tier 3)** | minutes | Full covering set; whole-file mutation |
| **Scheduled (Tier 4)** | hours | Whole suite; flakiness sampling; full mutation; rotating mutator sets |

### 13.6 Environment / runner configuration

Same test can run differently per stage. The substrate owns this configuration; the agent's invocation gets rewritten if the agent's chosen runner config is more expensive than necessary for the stage.

| Stage | Reporter | Coverage | Workers | Subprocess isolation |
|---|---|---|---|---|
| PreToolUse | minimal (no I/O) | piggyback if agent ran it | max parallelism | shared (faster) |
| PostToolUse | minimal | piggyback | max | shared |
| Stop | default | yes | max | per-file (catches leaks) |
| Pre-push | verbose | yes + ratchet | max | per-file |
| Scheduled | full | yes + ratchet + flakiness reruns | max | per-file or per-test |

### 13.7 The adaptive loop

The substrate must improve over time, not stay static. Track per-test and per-check, in the local receipts ledger (Phase 0.3) and finding history (Phase 0.4):

- How many times selected
- How many times surfaced a finding that was subsequently fixed (treat as bug-catch)
- How many times produced a false positive (user-marked, or item appeared repeatedly without action)
- Recent runtime drift (cost prediction stays calibrated)
- Whether the item ever caught the **same** bug class twice in this codebase (recurrence signal — §9.3)

Promotion criteria:
- Item selected often + catches bugs → boost `bug_catch_probability` prior
- Item never selected after N edits (low priority every time) → demote / route to Tier 3 only
- Item catches bugs but consistently exceeds budget → flag for refactor (Compression Program candidate, §19 Lever 3)
- Item never produces a finding after K runs → consider removing from active set entirely

This is the local analog of v3.2 §13.9's `predicted_finding_probability` learning, but it runs entirely from local receipts. No model, no LLM — deterministic counting + decay weighting ([[feedback_harness_deterministic_only]]).

### 13.8 What "smart selection" doesn't fix

- **Hub-file edits** still have whole-suite covering sets. No selection algorithm makes 3,940 tests fit 30s. Hub-file PreToolUse runs the highest-value 25s subset; the rest goes to Stop. The long-term lever is structural-seam splitting (§19 Lever 2).
- **Acceptance tests** are slow by nature; mostly Tier 3 even with selection. Short scenarios can opt in once §13.7 has data ranking them.
- **First-edit-to-a-file** has no per-test bug-catch history; the substrate falls back to blast-radius prior + uniform value prior.
- **Mutation per-mutant cost** is asymmetric — selecting tests doesn't change the per-mutant runtime; mutation at PreToolUse is bounded by `mutants × selected covering test runtime`. Diff-scoping (5–20 mutants/diff) is the leverage.

### 13.9 Implementation as Phase work

Specified in §18 Phase 2.6: a substrate that consumes Phase 0.1 classifier, Phase 0.4 finding history, Phase 2.1 test-runtime ratchet, and Supermodel graph; emits a per-edit selection decision; logs the decision into the receipt for the adaptive loop. Initial implementation uses simple heuristics (blast-radius prior, runtime cap, uniform value prior) and learns from receipts as they accumulate.

The substrate is the load-bearing component for everything beyond Phase 1. Without smart selection, "use the 30s window" devolves into either timing out the hook or under-using it.

---

## 14. Cross-Cutting Concern — Mutation as Gameable Proxy

*Goal: Acknowledge mutation's gaming surface and design defenses around it. The defense is the stack, not any single check.*

Mutation is the strongest practical behavioral-discrimination signal *for the mutator set Stryker generates*. Once a live gate at any tier, agent's optimization target shifts from "write valid tests" to "write tests that kill Stryker's mutators."

This is not solved by faster mutation runs. **Cloud makes mutation cheap to run; doesn't make mutation a better optimization target.** Tighter inner loop makes calibration pressure stronger.

**Mitigations:**
- **Mutator rotation:** rotating subset; full set at Tier 4 (later phase).
- **Multiple ground-truth signals:** red-then-green, acceptance, property tests, Lane C scanners. **Cross-lane composition is the real defense.**
- **Periodic harness self-review:** recurrence-feedback loop applied to Layer 2 (Phase 2 + ongoing; corpus cleanup precondition per §9.3).

**Property tests + mutation interaction (Bob Martin's concern):** §2.4. Architectural correction: separate the cadences. Property tests are Lane D, mutation is Lane A; default exclusion of property tests from mutation covering sets.

**Related concerns:**
- Per-mutant `timeoutMS` produces false-killed mutants.
- Diff-scoping recall risk: incomplete covering set → false kills → silent downgrade from `[proven]` to `[heuristic]`.
- Test-runtime ratchet (§9.4) is one-way door without release valve.

---

## 15. Blindspots and Deferred Concerns

*Goal: Track what this subset does not yet cover.*

### 15.1 Retired (now handled in build order)

- Generated/vendored-code classification → Phase 0.
- Lane prioritization under contention → Phase 3.7.
- Rollback paths → cross-cutting discipline (§16).
- Shadow mode → cross-cutting discipline (§16).
- Compression toward smaller edits → cross-cutting discipline + §19.

### 15.2 Deferred to later phases (v3.2 has full treatment)

| # | Topic | Where it lives |
|---|---|---|
| 1 | Cloud Tier 2 remote-sync substrate | v3.2 §13, Phase 4+ |
| 2 | Supermodel symbol-level covering set | v3.2 Phase 5 |
| 3 | Capability maps for acceptance routing | v3.2 §12.5, Phase 6 |
| 4 | Custom domain rules (CodeQL-class) | v3.2 Phase 7, Phase 9 |
| 5 | LLM review substrate | v3.2 Phase 7.5 |
| 6 | Tier 5 continuous-job infrastructure (full) | v3.2 Phase 8 |
| 7 | Fuzzing infrastructure | v3.2 Phase 9 |
| 8 | Mutator rotation operationalized | v3.2 Phase 10 |
| 9 | Brownfield onboarding wizard | v3.2 Phase 11 |
| 10 | Customer-facing dashboard / REST API | v3.2 Phase 0.9 (full); only minimal CLI here |
| 11 | Provenance / SLSA release-time stage | v3.2 Phase 10 |
| 12 | Multi-agent extension | separate doc; forward-compat seams §15.3 below |

### 15.3 Forward-compatibility seams (deferred multi-agent extension)

*Goal: Preserve multi-agent option without building it — name the seams that must not be foreclosed.*

- **Receipts as transferable certificates.** §18 Phase 0.3 schema is content-hash-keyed and cryptographically signable from day one — even though the local kernel doesn't require signing yet, the substrate is there.
- **Workspace-vs-session state cleanly separated** (Phase 0).
- **Lane independence.** §5 lanes are independently runnable.
- **Recurrence-feedback portable schema.** §9.3 JSONL/SQLite structured for eventual federation.
- **Local SQLite schema designed to survive eventual sync.** If/when a sync substrate is later added (federated peer, remote, or otherwise — undecided here), it inherits this schema; the local kernel stays the authoritative source. Storage is local-canonical, period; sync is purely additive.

None require build work in this subset. All require *not foreclosing* the option.

---

## 16. What's Important to Quentin and Cross-Cutting Disciplines

*Goal: Anchor constraints that should be re-checked at every fork. Three operational disciplines (shadow mode, rollback paths, compression toward smaller edits) apply across every phase.*

### 16.1 Preferences anchored throughout

- **Gauntlet philosophy.** The discipline window — sub-second locally, longer at Tier 3 — is *budget for discipline*, not constraint to minimize. The whole point of the harness is to force quality scrutiny that the agent would otherwise skip.
- **Local-first.** State lives in the workspace's `.interlinked/` directory. Cloud sync is additive, not foundational. The CLI is the surface; no dashboard / REST API in this subset.
- **PostToolUse stays sync.** Don't propose moving sync per-edit warnings to async/next-turn channels ([[feedback_posttooluse_stays_sync]]). The perf lever is incremental (content-hash cache, scope-limited tool wrappers), not async.
- **Hooks have no sub-10ms budget; PreToolUse has a 30-second hard timeout and the working budget is up to 25s** ([[feedback_hook_latency_budget]]). The 10ms-per-file regex line in `project-graph.ts` is per-file, not pipeline budget. Smart selection (§13) fills the window with the highest-value subset for each edit's context.
- **Harness checks are taste levers, not FP-optimized regressors** ([[feedback_taste_enforcement]]). Promotion to default is "do we want this pressure on every edit?" — not "is FP rate below 2%?"
- **Harness checks must be deterministic, not agentic** ([[feedback_harness_deterministic_only]]). LLM inference is not in the check pipeline. LLM review is a Tier 3 advisory escalation, never blocking, and out of scope for this subset.
- **Multi-agent as load-bearing reason for single-agent rigor.** The gauntlet must be deterministic, receipt-bound, and consistent because it *is* the trust boundary for any future multi-agent extension.
- **Direct, unhedged analysis.** No reflexive softening of structural problems.
- **Measure rather than infer.** Cost estimates in §4 are measured locally; cloud measurement (v3.2 Phase 3.5) is deferred.
- **Open-weight LLMs only** when LLM review eventually arrives. The harness is infrastructure, not an agent.
- **The Lagging Strand discipline.** Every "X takes Y seconds" claim is measured, cited, or modeled with explicit assumptions. No invented numbers.
- **`/enforce` as composition substrate.** Cross-file invariants compose with existing `/enforce` skill system.
- **Single-agent pipeline first.** Multi-agent extension deferred to separate Protocol doc.

### 16.2 Shadow mode discipline (cross-cutting)

**Every new check ships advisory-only first.** Logs what it *would* have flagged for a calibration window (typically one week or N=50 edits), then graduates to default (or block) only after the user has confirmed they want the pressure on every edit. Promotion criterion is *the user's verdict*, not FP rate — see [[feedback_taste_enforcement]].

Shadow-mode findings still feed the finding-history substrate Phase 0 sets up; they just don't surface to the agent yet.

### 16.3 Rollback path discipline (cross-cutting)

**Every feature ships with a no-code-change off-switch.** Config-driven feature flags minimum. Local: a key in `.interlinked/config.local.json` or an entry in `DEFAULT_ADVISORY_SKIPS`. Phase 0 establishes the substrate so subsequent phases inherit it.

Without explicit rollback paths, "we'll just turn it off" becomes "we'll need a refactor and a deploy."

### 16.4 Compression toward smaller edits (cross-cutting, see §19)

**Every check or test that doesn't fit the 25s PreToolUse working budget after smart selection (§13) is a candidate for compression** — by tightening scope (Lever 1), by splitting hot files (Lever 2), by parallelizing sub-checks (Lever 3 — vitest workers, parallel tool invocations), or by caching aggressively (Lever 5). v3.2 §19's Lever 4 (substrate migration to cloud V8 isolates / Facets) is cloud-only and out of scope here.

Local compression discipline produces three behavioral outcomes:
1. **Smaller, more focused edits from the agent** (via Lever 1's edit-size guidance, surfaced through advisory then blocking).
2. **Better-factored codebases over time** (via Lever 2's structural-seam splitting; `large-files-baseline.json` already pressures file size; blast-radius could ratchet similarly).
3. **More verification fits the 25s working budget per edit** (via Lever 3 parallelization + Lever 5 caching, both making each individual selected item cheaper so more of them fit).

---

## 17. Open Measurement Questions (Local Subset)

*Goal: Catalog measurement-pending questions for this subset.*

| Question | Where measured | Lane |
|---|---|---|
| Test-runtime distribution per-file on this codebase | Phase 2 (test-runtime ratchet) | A |
| Lane B Tier 1 cost on this codebase (tsc/lint/complexity per-edit) | Phase 3 | B |
| Lane C Gitleaks/OSV-Scanner/Semgrep p95 | Phase 3 | C |
| Lane D flakiness rate on existing suite | Phase 2 | D |
| Diff-scoped mutation p95 on leaf files (local) | Phase 2+ | A |
| Coverage piggyback overhead in practice | Phase 2 | A |
| Per-edit cost ceiling (sum of all Tier 1 checks) | Phase 3.7 | meta |
| Hook-script linger latency under various server states | Phase 0 (precondition) | meta |
| Recurrence corpus signal-to-noise after probe cleanup | Phase 2 | meta |

**Explicitly held until measured:**

- **Diff-scoped mutation as Tier 1 default.** Stays Tier 3 (Stop) until adaptive selection (§13) shows it fits the 25s working budget for at least 80% of leaf-file edits in this codebase.
- **Whole-suite coverage ratchet as Tier 1.** Permanently Tier 3 — full-suite coverage is minutes-class. Selected-subset coverage at Tier 1 is the §13 question.
- **Acceptance test execution at Tier 1.** Default Tier 3; short scenarios can opt into Tier 1 once §13.7's adaptive loop ranks them.
- **Property tests in mutation covering set.** Default excluded; opt-in only at Tier 4.
- **Per-test bug-catch tracking as a promotion gate.** Stays advisory until the adaptive loop (§13.7) has data for ≥50 edits per tracked test.

### 17.3 Three-layer threshold framework

*Goal: Close the ratchet-only gap. Pure "no regress" lets a workspace stay broken if it started broken; pure absolute thresholds force the vendor's opinion on every workspace. The hybrid: thin vendor floor + workspace ratchet (dominant pattern) + optional workspace target.*

**Layer 1 — Vendor floor (universal, deliberately low).** Fires regardless of baseline when a metric is in genuinely-broken territory. These are not aspirational; they catch "this code is in a bad state by any reasonable measure":

- Per-file coverage < 20% on a touched file → warning
- Mutation score < 30% on a leaf file with > 50 LOC → warning
- CRAP > 50 on a function the agent edited → warning
- Cyclomatic complexity > 15 on a function the agent edited → warning
- Per-test runtime p95 > 30s for a single test → warning (price the slowness; don't ban)

Layer 1 floors are warning-severity, never blocking. They catch genuine breakage on touched files without forcing a workspace below the floor to fix everything at once. The existing 80-line function-length and 1500-line file-cap advisories already act as Layer 1 floors for the structural axes; this subsection extends the same pattern to coverage / mutation / CRAP / complexity.

**Layer 2 — Workspace ratchet (per-workspace, dynamic).** The dominant gate. "Don't regress from where you are." Already specified throughout this doc — baselines pinned at install, every Tier 1 check ratchets on metric increase / decrease. Covers most of the surface area. Per [[feedback_taste_enforcement]], this stays the load-bearing pattern.

**Layer 3 — Workspace target (optional, customer-set).** A `.interlinked/policy.json` entry where the workspace declares its own aspirational bars:

```json
{
  "coverage_target": 0.80,
  "mutation_score_target": 0.65,
  "max_function_complexity": 10,
  "max_function_loc": 60
}
```

When set, the workspace gets a third tier of warnings: "you're below your declared target." Optional, off by default — this is where each team's ambition lives, not the vendor's.

**Why three layers and not just two:** pure ratchet (Layer 2 only) is too permissive at the bottom — a workspace that starts at 8% coverage stays at 8% forever, with no signal that the absolute state is broken. The vendor floor (Layer 1) catches this without forcing a global target. Layer 3 handles ambition for teams that want it.

**Why not lift Layer 1 to industry numbers** (80% coverage, 75% mutation score)? Per [[feedback_taste_enforcement]], checks are opinionated taste levers — vendor-shipping ambitious targets cooks agent behavior in directions that may be wrong for the customer's context. Layer 1 catches the floor; Layer 3 handles ambition. Two distinct mechanisms, distinct calibration.

**Implementation:**

- **Layer 1 floors** add a "below floor" condition to existing warning functions (`formatCoverageWarning`, `formatMutationWarning`, etc.) — roughly 20 lines per metric. Lands in Phase 2 alongside the ratchet plumbing.
- **Layer 3 targets** read from the Phase 0.6 config-flag substrate; check functions accept an optional target threshold and warn when the post-edit value is below it. Lands in Phase 2 or Phase 3.7.
- **Floor numbers above are starting points** — specific values are TBD via measurement on this codebase (see the §17.1 table for what to measure first). Treat the numbers as scaffolding the kernel ships with; real calibration happens after the first ~50 edits worth of receipt data accumulate.

---

## 18. Phased Build Order (Phase 0 – Phase 3.7)

*Goal: Operational core for the local-first kernel. Phase 4+ lives in v3.2. Disciplines (shadow mode, rollback, compression) applied throughout.*

Every phase ships under the three cross-cutting disciplines (§16). **Total estimate for this subset: ~2–3 months part-time.**

### Phase 0 — Thin substrate unification (local-first)

*Goal: Unify existing scattered substrate into named contracts. Extraction work, not greenfield. State layout is local-canonical.*

**Duration:** 1–2 weeks. **Dependencies:** None.

**Work items:**

- **0.1 File-kind classifier.** Unify functions from `src/harness/checks/shared.ts:143` into typed `classifyFile(path) → {kind, confidence}`. Add `acceptance` vs. `unit`. The existing predicates (`isCappableFile`, test-and-demo check family, structural-checks file-kind branches) are half-implicit; this lifts them into one normalized object every check receives.

- **0.2 State layout — local-canonical hybrid (SQLite for normalized state, JSONL for event streams).** Workspace state lives in `.interlinked/` as the canonical store. The storage decision splits by *structural purpose*, not by file:

  **Stays JSONL — append-only event streams (chain, queue, time-ordered ledger semantics):**
  - `activity.jsonl` — canonical event transcript, including the hash-chained audit (guard_* + session_end records per `audit-chain.ts`). Append-only matches the tamper-evident chain's design; the verifier already assumes JSONL.
  - `recurrences.jsonl` — finding-recurrence ledger (deterministic counting per [[feedback_harness_deterministic_only]]).
  - `reservation-events.jsonl` — temporal stream of file-reservation transitions.
  - `realtime-retry.jsonl` — naturally append-pop queue for failed sync POSTs.
  - Small audit / observability logs that stay JSONL: `content-scanner.audit.jsonl`, `metacoder.audit.jsonl`, `permission-rule-strips.jsonl`, `sync-errors.jsonl` (+ rotation `.1`), `dedup-shadow.jsonl`, `verify-runs.jsonl`, the `graph-*` research family.

  **Moves to SQLite (`.interlinked/harness.sqlite`) — relational, queryable, joinable state:**
  - `receipts` (new, Phase 0.3) — one row per tool call.
  - `findings` (new, Phase 0.4) — fingerprint-keyed, consolidates today's `suggestion-telemetry.jsonl`, `suggestion-outcomes.jsonl`, `error-history.jsonl`, `rules-stats.json`, and the inline `guard_check_results[]` array in activity.jsonl. Same `findings` table, multiple producers.
  - `baselines` — consolidates today's mutation scores, coverage %, ratchet counts, large-file LOC, etc. Today these are scattered across per-baseline files; SQLite makes "current baseline state across all metrics for file X" a single query.
  - `test_runs` + `test_timings` — consolidates today's `tests.jsonl` (1.4 MB, per-test command outcomes) and the per-test runtime ratchet from Phase 2.1. Joinable on `(test_file, session, agent)`; powers the smart-test-selection adaptive loop (§13.7).
  - `costs` — consolidates today's `costs.jsonl` (15 MB, byte-cursored token usage). The cursor file `costs-cursor.json` retires with the JSONL.
  - `selection_decisions` — per-edit Phase 2.6 smart-selection decisions joined to the receipt that consumed them.

  **Decommissioned (derivable from SQLite):**
  - `files-touched.jsonl` (3.4 MB today, labeled "derivative view" in the source). Once `receipts` is indexed by changed_file_path, "what's the recent history on file X?" becomes a SQL query, not a separate stream.

  **Stays JSON (small config / committed baseline files — git-diffable matters):**
  - `check-policy.json`, `config.json`, `distilled-rules.json` (+ overrides), `file-priority.json`, `guard-rules.local.json`, `installer-manifest.json`, `learned-rules.json`, `registry-parity.json`, `statusline.snapshot`. These are configuration, not state; `large-files-baseline.json` is committed and intentionally diff-reviewable.

  **Cursor files retire with their JSONLs:**
  - `costs-cursor.json`, `suggestion-outcomes-cursor.json`, `thinking-cursor.json` exist only to track byte offsets into JSONLs that are moving to SQLite. SQLite row IDs / `last_seen_at` timestamps replace them. `turn-cursor.json` is different — tracks turn-id minting state, not a byte offset — and stays.

  **Schema evolution pattern (must be specified before Phase 0.3 ships):**
  - **Versioned migrations.** A `schema_version` table tracks the current version. Numbered migrations live in `src/harness/storage/migrations/` (e.g., `001_initial.sql`, `002_add_findings_severity.sql`). The daemon auto-applies missing migrations at startup; each migration is idempotent. Downgrades aren't routinely supported but the option is there if a release regresses.
  - **JSON metadata column on every table.** SQLite's built-in `JSON1` extension lets new fields land without migrations: every table has a `metadata JSON` column for forward-compat / extension fields. Promote to first-class columns only when you need to index on them. Avoids "every minor harness change requires a schema migration."

  **Transition path for the JSONLs being absorbed into SQLite:**
  - Phase 0.4 ships **write-through compatibility** — `suggestion-telemetry.jsonl`, `suggestion-outcomes.jsonl`, `error-history.jsonl`, `tests.jsonl`, `costs.jsonl` keep being written so existing consumers (CLI tools, grep-based scripts) continue working.
  - **The SQLite tables are the authoritative join surface from day 1.** New consumers read from SQLite; the JSONL writes are transitional.
  - **Sunset path:** once a release confirms no external consumer reads a given JSONL, drop its write. Tracked in a `docs/design/jsonl-sunset.md` list (one bullet per file, with a status field). Goal is to retire all five "absorbed" JSONLs within 2–3 release cycles of Phase 0.4 shipping.

  **Cloud-DO transfer story:**
  - Cloudflare DO SQLite has near-identical semantics to local SQLite — same SQL, same indexes, same constraints. The schema you write locally transfers as-is to a DO Facet if/when the cloud tier ships. Migration is "open the local DB, dump rows, push to the DO," not "rewrite the schema." The local kernel stays authoritative; cloud is additive forever.

- **0.3 Receipt schema as transferable artifact.** One row per tool call, joinable to the diff and per-check results. Required fields:
  - `receipt_id` (stable; not the same as `hash`)
  - `tool_call_id` (new — gap in current `appendGuardDecision`; needed to join receipt to the originating tool event)
  - `workspace_id`, `agent_id`, `created_at`
  - `base_git_sha`, `diff_hash`, `changed_file_hashes` (cross-file join from `appendLocal`'s `content_sha256`)
  - `hook`, `tool`
  - `mode` (`local_blocking` | `local_advisory` | `async_local`)
  - `substrate` (`local_process` for now; extensible to `cloud`, `ci`, `peer`)
  - `check_plan_hash` (fingerprint of which checks ran in what config)
  - `check_runs[]` — per check: `check_id`, `check_version`, `authority` (`block`/`advise`/`observe`), `verdict`, `duration_ms`, `finding_ids[]`
  - `final_decision` (`allow` / `deny` / `allow_with_warnings` / `fail_open`)
  - `result_hash`, `receipt_hash`, `previous_hash` (chains to ASI11 audit chain)
  - Cryptographically signable from day one (forward-compat with multi-agent)

  The existing `appendGuardDecision` audit row is ~70% of this. The bridging work is documented in [the prior round's analysis] — five gaps: `tool_call_id`, per-check `duration_ms`, `authority`, `check_version`, `diff_hash` on the row, `fail_open` granularity. Phase 0.3 closes those five gaps.

- **0.4 Finding-history schema.** Local SQLite table with stable `fingerprint` (sha256 of `check_id + file + line + first-N-chars-of-message-normalized`), `first_seen_at`, `last_seen_at`, `status` (open / resolved / wontfix), `severity`, `confidence`. Subsumes the identity work currently scattered across `suggestion-telemetry.jsonl`, `suggestion-outcomes.jsonl`, `recurrences.jsonl`, `error-history.jsonl`, and inline `guard_check_results[]`. Existing files keep being written (back-compat); new normalized table is the authoritative join surface.

- **0.5 Result delivery contract.** Local PostToolUse `stdout` (warnings to agent) and `stderr` (warnings to human) plus structured write to `.interlinked/harness.sqlite`. No async/next-turn channel for sync per-edit warnings ([[feedback_posttooluse_stays_sync]]).

- **0.6 Config-flag substrate.** Local workspace config in `.interlinked/config.json` (committed) and `.interlinked/config.local.json` (gitignored). Per-check enable/disable, per-check authority override (advisory → default), workspace-level shadow-mode flag. Subsumes `DEFAULT_ADVISORY_SKIPS` + `disabled_rules` patterns.

- **0.7 Receipt CLI surface.** Minimal:
  - `interlinked harness receipts recent [--limit N]`
  - `interlinked harness receipt show <id>`
  - `interlinked harness findings recent [--check ID] [--file PATH]`
  - `interlinked harness finding show <fingerprint>`
  - `interlinked harness timings [--file PATH]`
  - `interlinked harness baseline [--check ID]`
  - `interlinked harness doctor` (existing surface; extend)
  
  No dashboard, no REST API. Those are v3.2 Phase 0.9 work.

- **0.8 Promotion-lifecycle plumbing.** Per-check `authority` (`observe` / `advise` / `block`) recorded in receipts. CLI: `interlinked harness check promote <id>` (advisory → default) and `interlinked harness check demote <id>` (default → advisory). Promotion criterion is the user's verdict, not FP rate.

- **0.9 Fix the hook-script linger ([[project_hook_script_linger_latency]]).** Precondition for any latency claim in subsequent phases. `interlinked-activity.mjs` adds ~4.4s/call when the server is down. Owned bug; needs fixing in `src/lib/hook-template-chunks/` before Phase 1's secret-detection check is timed.

**Exit gates:** all nine pieces shipped; classifier passes own tests; SQLite schema documented and migrating cleanly from existing JSONL; receipt CLI returns a recent receipt with all required fields populated; config-flag substrate has working example (one check toggled via config alone); promotion plumbing round-trips advisory ↔ default for one check; hook-script linger measurably below 100ms on cold path.

### Phase 1 — Stop the bleeding

*Goal: Plug actively-gamed Lane A holes and actively-dangerous Lane C risk. Shadow mode first.*

**Duration:** 1–2 weeks. **Dependencies:** Phase 0.

**Work items:**

- **1.1 Inline secret detection (Lane C, Tier 1, fail-closed).** Integration point: `src/harness/check-engine/tool-runners/generic.ts:193`. Pattern-based PreToolUse block on confirmed secret patterns; no Gitleaks dependency. High-confidence patterns only (AWS keys, GCP service-account JSON, GitHub PATs, Stripe keys, etc.). Lower-confidence patterns route to advisory.

- **1.2 New-file-gate loop close (Lane A, Tier 1).** §9.1.

- **1.3 Red-then-green enforcement (Lane A, Tier 1).** §9.2.

- **1.4 Advisory-to-gate promotion for unit-classified tests (Lane A, Tier 1).** §9.5. Promotes `checkTestSubprocessDefaultTimeout`, `checkRealIoInTests`, `checkHardcodedTimeoutInTests`, `checkTestNondeterminism` — but only for tests classified as unit by Phase 0.1.

**Exit gates:** adversarial tests for secrets, placeholder tests, no-red-cycle, unit-vs-acceptance gating all pass; all four shipped in shadow mode first (advisory authority), promoted to default after user verdict (not FP rate); receipts capture promotion-state changes; rollback flag verified.

### Phase 2 — Test telemetry substrate

*Goal: Measure the test suite. Keystone for everything dynamic downstream.*

**Duration:** 2 weeks. **Dependencies:** Phase 0.

**Work items:**

- **2.1 Test-runtime ratchet (Lane A, Tier 1).** §9.4. **Precondition for Phase 3+ admission decisions.**

- **2.2 Piggyback coverage on agent test runs (Lane A, Tier 1).** §9.6.

- **2.3 CRAP from coverage manifest (Lane A, Tier 1).** §2.3.

- **2.4 Flakiness baseline (Lane D, Tier 4 scheduled).** Two-week calibration. Sample N=5 reruns nightly on a rotating subset.

- **2.5 Recurrence-feedback aggregation (meta, background).** §9.3. **Precondition:** clean the existing `recurrences.jsonl` corpus from the 99% probe-noise problem before the aggregator's output is used as signal.

- **2.6 Smart test-selection substrate (§13).** The load-bearing component. Consumes Phase 0.1 classifier, Phase 0.4 finding history, Phase 2.1 test-runtime ratchet, and Supermodel graph. Emits a per-edit selection decision: which tests and checks run at PreToolUse, PostToolUse, Stop, or scheduled — within the 25s PreToolUse working budget. Decision logged into the receipt (Phase 0.3) so the adaptive loop (§13.7) can learn from outcomes. Initial implementation uses simple heuristics (blast-radius prior, runtime cap, uniform value prior); refinement is continuous as receipts accumulate. Includes the stage-routing logic from §13.5 and the environment configuration from §13.6 (rewrite agent's vitest invocation if the agent's config is more expensive than the stage warrants).

**Exit gates:** test-runtime ratchet has real numbers for ≥80% of test files; flakiness rate measured for two-week window; CRAP scores exist per function; recurrence-feedback log has post-cleanup signal (≤30% probe noise); smart test-selection emits a decision for every edit and 80% of PreToolUse hooks complete under 25s; adaptive loop is accumulating bug-catch / false-positive data per test.

### Phase 3 — Lane B/C broad wiring

*Goal: Wire existing static-analysis tools. Mostly already exists in ecosystem.*

**Duration:** 2–3 weeks. **Dependencies:** Phase 0, Phase 2.

**Work items:**

- **3.1 TS strict + lint as harness findings (Lane B, Tier 1).** Existing `quality-checks.ts` runners already do this; consolidate into normalized findings shape (Phase 0.4 schema). `tsc --noEmit` incremental for changed files.

- **3.2 Cyclomatic complexity + import-cycle findings (Lane B, Tier 1).** Existing checks; surface via Phase 0.4 normalized findings.

- **3.3 OSV-Scanner event-triggered on lockfile change (Lane C, Tier 1).** Existing `interlinked allowlist` system already gates new dependencies; OSV-Scanner adds CVE lookup on lockfile diffs. Event-triggered, not per-edit.

- **3.4 License + maintainership + postinstall check on new-dep events (Lane C, Tier 1 event-triggered).** Existing supply-chain allowlist + Levenshtein typosquat detector + the `interlinked allowlist add` flow. Extend with license + maintainership check on new approvals.

- **3.5 Gitleaks as project verification (Lane C, Tier 3).** Differs from 1.1 inline detection — Gitleaks covers history scans and broader patterns; runs on Stop / pre-push.

- **3.6 Curated Semgrep ruleset for changed files (Lane C, Tier 1).** Start small — 10–20 rules.

- **3.7 Domain-invariant inventory (Lane C, thinking work).** Walk the codebase. Identify candidate invariants: workspace isolation, tenant boundaries, auth checks, etc. Inventory document; rule authoring is later phase.

- **3.8 Architecture rules baseline (Lane B, Tier 3).** Dependency Cruiser or equivalent for module-boundary rules.

**Exit gates:** adversarial tests for vulnerable dependency, TS strict violation, postinstall-script dependency, anti-pattern all pass; all in shadow mode first; domain-invariant inventory document exists with ≥20 candidates.

### Phase 3.5 — Acceptance test routing scaffolding

*Goal: Route acceptance tests by capability tag without building the full v3.2 §12.5 capability-to-symbol map. Tag → test-file routing only; tag → symbol routing stays deferred to v3.2 Phase 6.*

**Duration:** 1–2 weeks. **Dependencies:** Phase 0.1 (classifier with `acceptance` kind), Phase 1.4 (kind-aware inverted gates), Phase 2.6 (smart selection substrate).

**Work items:**

- **3.5.1 Capability-tag parser.** Scan acceptance-classified files for `@<tag-name>` annotations (JSDoc-style tags on `.test.ts` / `.spec.ts` describe blocks; Gherkin `@tag` lines on `*.feature` files). Emit an in-memory `capability_to_test_files: Record<TagName, FilePath[]>` map.

- **3.5.2 Workspace `capability-map.yaml` (minimal).** Optional artifact at workspace root declaring authoritative `capability → test_file_paths` mappings. Default-empty; the parser populates the in-memory map even without this file. When the file exists, it is the human-readable source of truth and the parser checks parsed tags against it (drift detection — small, no symbol map yet).

- **3.5.3 Smart-selection integration.** When the agent edits a file, smart selection (§13) consults `capability_to_test_files` to find acceptance scenarios that might apply. Until the v3.2 symbol map ships, this is heuristic — "any acceptance test whose declared capability is mentioned in changed-file path tokens or recent commit messages." Imperfect but adds signal beyond the runtime-only fallback in Phase 2.6.

- **3.5.4 Outer-loop cycle tracker.** A two-tier cycle tracker — inner (per-file, existing) + outer (per-acceptance-scenario, new). Acceptance scenarios can span dozens of inner cycles in the red state before going green; tracking this prevents the cycle tracker from interpreting a long red phase as "agent forgot to fix." Subset of v3.2 §12.5 / Phase 6 — capability-map symbol drift stays deferred.

- **3.5.5 Tier 4 scheduled acceptance suite.** Local cron / launchd / GitHub Actions schedule running the full acceptance suite nightly. Coverage-on run logs each scenario's actual covered symbol set; diffs against `capability-map.yaml` when one exists. Emits findings into the Phase 0.4 finding-history with `category: "capability-drift"`.

**Exit gates:** capability-tag parser runs against the workspace's acceptance tests in <1s; smart selection demonstrably picks the right scenarios for at least three test edit cases; outer-loop cycle tracker survives a multi-cycle red phase without misfiring; Tier 4 schedule produces a drift-detector run.

### Phase 3.7 — Lightweight local threat model and cost ceilings

*Goal: Operational prerequisites before any heavier local work. Local-only — v3.2 Phase 3.5 cloud measurement spike is out of scope.*

**Duration:** 1 week. Parallel-able with Phase 3.

**Work items:**

- **3.7.1 Local threat model document.** Hook script runs in user's shell — the harness's threat surface is the user's machine, not a sandboxed cloud worker. What patterns of malicious input can reach the harness's deterministic checks? What's the worst-case behavior of a crafted file content under content-scanner? Document.

- **3.7.2 Per-edit cost ceiling.** Sum of Tier 1 check + test time per edit. Default working budget: 25s PreToolUse (under the 30s Claude Code hard timeout), 5s typical PostToolUse (also under 30s hard timeout). Exceeding: degrade-to-advisory (best-effort completion) rather than block. Smart selection (§13) is the primary mechanism for staying under budget; this ceiling is the backstop when selection mispredicts a cost.

- **3.7.3 Lane prioritization policy.** Lane C blocking > Lane A blocking > Lane B blocking > Lane D advisory. Documented.

- **3.7.4 Rollback feature flags.** Per-check kill-switches (Phase 0.6 substrate).

- **3.7.5 Circuit breaker pattern.** Per-tool: if external tool (Semgrep, Gitleaks, OSV) exceeds budget 3× in a session, mark as degraded for rest of session.

**Exit gates:** threat model document covers the realistic local attack surface; cost-cap mechanism exercised in test; rollback flags verified; circuit breaker triggered in test.

### What ships at the end of Phase 3.7

A local-first harness with:
- File classification governing every check (unit / acceptance / config / generated / vendored)
- Local SQLite ledger of receipts, findings, baselines, selection decisions
- Receipt CLI for inspection / replay / promotion / demotion
- Phase 1's gaming-hole closures and inline secret detection (default-on)
- Phase 2's test telemetry, coverage piggyback, and smart test-selection substrate (§13) with adaptive loop
- Phase 3's Lane B/C wiring as normalized findings
- Phase 3.5's acceptance test routing scaffolding (capability tags, outer-loop cycle tracker, Tier 4 scheduled drift detector)
- Phase 3.7's threat model + cost ceilings + rollback substrate
- §17.3's three-layer threshold framework (vendor floor + workspace ratchet + workspace target) with starting numbers tunable per-workspace

Phase 4 onward — Cloudflare DO+Facet+Sandbox+Workflows substrate, Supermodel symbol-level covering set wiring, capability maps for acceptance routing, custom domain Lane C rules, LLM review substrate, Tier 5 continuous, fuzzing, hardening, brownfield onboarding, full configurability framework — is the v3.2 plan, picked up after this subset has empirical user data.

### 18.1 Critical reads on this order

The single most important decision is to **resist building Phase 4 early.** Cloud Tier 2 remote-sync is architecturally novel and fun; expensive to build twice. Local-first kernel must ship and get real user data first.

The second is to **ship Phase 1 fast.** Secrets-on-diff and gaming-hole closure are highest-risk-per-effort.

The third is to **measure Phase 0.9's hook-script linger fix before any latency claim downstream.** The 4.4s/call ambient cost dominates everything until it's fixed.

The fourth is to **clean the recurrence corpus in Phase 2 before claiming the feedback loop works.** 99% probe noise = no signal.

---

## 19. Compression Program — Local Subset

*Goal: Define the local subset of v3.2's Compression Program. Locally, three of the five levers apply: smaller edits, smaller files, caching. Sub-check parallelization (Lever 3) and substrate migration (Lever 4) are cloud-substrate concerns.*

### 19.1 The compression problem (local framing)

An item (test or check) routes to Tier 3 (async) rather than Tier 1 (sync) because, at smart-selection time (§13), its predicted cost exceeds what's left of the 25s PreToolUse working budget given the higher-value items already admitted for this edit. Locally, latency contributors are usually:

- **Edit scope too large.** A 500-line refactor takes longer to verify than a 5-line change.
- **File too complex.** A hub file with 316 importers has a covering set of ~the whole suite — locally that's seconds at least.
- **Cold AST cache.** Repeated parses of unchanged files.
- **External tool startup cost.** Stryker startup, Semgrep startup, Trivy startup.
- **Serial sub-check execution.** Running tsc + biome + secret-scan + complexity sequentially when they could run concurrently.

### 19.2 Four local levers (Lever 4 is cloud-only)

**Lever 1 — Smaller edits.** Blast-radius-weighted edit-size budget per file class. Leaf files: up to 100 lines per edit. Mid files: 50 lines. Hub files: 20 lines or split across multiple turns. Surfaces first as advisory (shadow mode), then promoted to default after user verdict.

**Lever 2 — Smaller files.** Lane B's structural-seam advisories (§11) identify files with clusters of functions that could split cleanly. Compression consumes those advisories to drive file-splitting recommendations to the agent. Existing `large-files-baseline.json` already pressures file size (1500-line cap, grandfathered list); a blast-radius ratchet would extend the same pattern to importer count.

**Lever 3 — Sub-check parallelization (local).** Vitest worker count, parallel external-tool invocations (Semgrep + Gitleaks + tsc running concurrently rather than serially), per-test isolation tuning (in-process vs subprocess). The local equivalent of v3.2's cloud Facet-level parallelization is process-level / thread-level parallelism. Smart selection (§13) hands the runner a budget; the runner decides how to parallelize within it. Vitest already has a worker pool; the discipline is configuring it properly per stage (§13.6).

**Lever 5 — Caching and incrementality.** AST cache, content-hash cache for unchanged regions, per-file finding cache invalidated by `content_sha256`, per-test result cache for unchanged covering sets, incremental `tsc --noEmit`. Cache infrastructure exists; the discipline is tracking hit rates and tuning invalidation.

**Lever 4 (substrate migration to V8 isolates / cloud Facets) is cloud-only.** Out of scope here.

### 19.3 Compression Program operational mechanism (local)

Same shape as v3.2 §19.3 but the inputs are local:
- **Inputs:** per-item duration distribution from receipts (Phase 0.3); per-edit cost ceiling (Phase 3.7.2); blast-radius distribution (Phase 3 / §3); smart-selection rejection log (which items §13 wanted to admit but didn't fit).
- **Outputs:** work catalog of compression candidates (which items are within 20% of fitting Tier 1 after current Lever 3/5 work).
- **Cadence:** weekly review during active phase work; the smart-selection adaptive loop (§13.7) provides the per-item data continuously.

### 19.4 Compression as cross-cutting discipline (per §16.4)

An item sitting in Tier 3 (async) for months without a compression work item is a signal that either (a) it shouldn't be at Tier 1 at all and should stay Tier 3 permanently (whole-suite work, fuzzing, async LLM review), or (b) someone needs to compress it.

The discipline produces three behavioral outcomes locally:
1. Smaller, more focused edits from the agent (Lever 1).
2. Better-factored codebases over time (Lever 2).
3. More verification fitting the 25s PreToolUse working budget per edit (Levers 3 + 5 — parallelization + caching make each item cheaper, so more fit).

---

## 20. Decision Log — Why This Subset, Not Others

*Goal: Explain the design decisions and their alternatives.*

**Why local-first first, given the v3.2 plan went cloud-first?** The first-two-milestones reframe (the conversation that produced this subset) made the case: receipt + finding + baseline substrate are valuable on their own, even before any cloud. The existing CLI is local. Customer-facing surfaces, dashboard, REST API, brownfield onboarding wizard are premature. Cloud-first SaaS framing is a different product (probably belongs in the sibling server repo per [[reference_sibling_server_repo]]).

**Why no Tier 2 locally?** v3.2's Tier 2-blocking and Tier 2-bridging are cloud-substrate organizational concepts (DO+Facets+Sandboxes fan-out). Locally, the 30s PreToolUse window IS used — it's the same window cloud Tier 2-blocking uses — but it's called Tier 1 here because there's only one local execution context, not two. The smart-selection substrate (§13) is the local analog of v3.2 §13.9 admission. Long-running checks that don't fit Tier 1 after selection go to Tier 3.

**Why is the receipt schema in Phase 0.3 not the same as the audit-chain row?** The audit-chain row (commit 544c2d9) is correctly scoped for ASI11 tamper-evidence on guard decisions. The receipt is a higher-level artifact — one summary record per tool call, joinable to the diff, fingerprinted per check, queryable by `tool_call_id`. Five fields are missing from the current row (`tool_call_id`, per-check `duration_ms`, `authority`, `check_version`, `diff_hash`, `fail_open` granularity). Phase 0.3 closes them.

**Why SQLite over JSONL?** Querying "what just fired" requires either grep or scan-with-cursor on JSONL — 128 MB activity.jsonl + archives makes that expensive. SQLite indexes pay off as soon as the receipt CLI surfaces are useful. Existing JSONL files stay for back-compat; new normalized tables are the authoritative join surface.

**Why is hook-script linger a Phase 0 precondition, not a side fix?** [[project_hook_script_linger_latency]] — 4.4s/call when the server is down. Any "PreToolUse fits <500ms" claim downstream is false until that's fixed.

**Why is recurrence corpus cleanup a Phase 2 precondition?** [[project_echo_reconciliation_corpus_probe_dominated]] — 99% probe noise. The feedback loop has no signal until the corpus is cleaned.

**Why does Phase 0.3 design the receipt to be cryptographically signable, even though local doesn't need signing yet?** Forward-compat with multi-agent extension (§15.3 / [[feedback_safety_continuity]]). Receipt-as-transferable-certificate is the trust boundary. Building the schema for signing now is cheap; retrofitting later isn't.

**Why is the FP-rate promotion criterion from v3.2 §16.2 explicitly rejected here?** [[feedback_taste_enforcement]] — harness checks are opinionated taste levers. Some checks (ratchet metrics like non-null-assertion, `as any`) are loud-on-purpose to discourage the pattern. Promotion criterion is the user's verdict that the pressure is wanted, not "FP rate < 2%."

**Why do we not build the dashboard?** Premature. CLI surfaces (Phase 0.7) answer the same questions for now: what fired, in what mode, how long, what receipt proves it, has this fingerprint appeared before. Web UI is downstream when there's a non-Quentin user.

**Why is LLM review out of scope?** [[feedback_harness_deterministic_only]] — checks are deterministic; LLM is a narrow escalation layer only. Building the LLM-review substrate now is premature optimization in the wrong direction. v3.2 Phase 7.5 has the design when it's needed.

**Why is smart test-selection (§13) the load-bearing component?** Without it, "use the 30s PreToolUse window" devolves into either (a) timing out the hook by running too much, or (b) under-using the budget the agent has already accepted. The substrate is the difference between *having* a 25s budget and *using* it well. It's also the only mechanism by which "constantly improve which tests run, at which stage, in which environment" becomes a system rather than a slogan — the adaptive loop (§13.7) accumulates per-test bug-catch / false-positive data from receipts and promotes/demotes deterministically. No LLM in the selection path ([[feedback_harness_deterministic_only]]).

**Why is the storage decision local-first with sync deferred (not "cloud-first with optional local mirror")?** Receipts, findings, baselines, and selection-history are valuable on their own, even before any sync substrate. The existing CLI is local. A cloud-first storage decision foreclosures the option that the kernel ships and improves on local data alone for a long time before sync becomes load-bearing. Sync substrate (federated peer, remote, or otherwise) is additive when later phases need it; the local kernel is the authoritative source by default and forever.

---

## 21. Scope Strategy — Per-Diff, Per-File, Per-Codebase

*Goal: Make explicit how verification scope decisions are made and configured locally. The v3.2 §21 covers brownfield onboarding wizard and audit-grade documentation; here we keep just the scope-strategy core.*

### 21.1 The three scope levels

| Scope | What's verified | When it runs | Default cadence |
|---|---|---|---|
| **Per-diff** | Only changed lines + direct dependencies | Every edit | Tier 1 |
| **Per-file** | Entire file being touched | Every edit to that file | Tier 1 (if fits) or Tier 3 async |
| **Per-codebase** | Whole codebase | On-demand or scheduled | Tier 4 scheduled |

Each scope produces a different category of finding:
- **Per-diff findings**: directly caused by the current edit. Highest priority. Always blocking by default.
- **Per-file pre-existing findings**: in the file the agent is touching, but not in the changed lines. Default policy: surface as required-to-fix ([[feedback_fix_pre_existing_in_touched_files]]).
- **Per-codebase pre-existing findings**: anywhere else in the codebase. Default policy: accumulate to backlog, surface only highest-priority.

### 21.2 The pre-existing finding problem with current SOTA agents

SOTA coding agents are trained to be task-focused and conservative about scope expansion. When the harness surfaces a finding outside the agent's current edit scope, the typical behavior is: acknowledge the finding, note it as pre-existing, do NOT fix it, complete the original task and move on.

This is partially desirable (prevents agent scope-creep) but mostly counterproductive for the user's codebase where the harness's value depends on actively reducing tech debt over time.

**The default here matches [[feedback_fix_pre_existing_in_touched_files]]: fix everything you can while in this file.** Configurable to less aggressive for users who want stricter scope discipline.

### 21.3 Pre-existing finding policy engine

Classification dimensions:

| Dimension | Values |
|---|---|
| `category` | security, quality, test, accessibility, performance |
| `severity` | critical, high, medium, low |
| `provenance` | introduced-by-current-edit, pre-existing-in-file, pre-existing-codebase |
| `fix_complexity` | trivial (≤5 lines), small (≤25 lines), medium (≤100 lines), large (>100 lines) |

Policy actions:

| Action | Mechanism |
|---|---|
| `block-edit` | PreToolUse `decision: "block"` |
| `require-fix` | PostToolUse gating + strong language; Stop hook escalation |
| `recommend-fix` | PostToolUse adds finding with directive language |
| `surface-informational` | PostToolUse adds finding as context only |
| `backlog-only` | Stored, not surfaced to agent |
| `ignore` | Not stored |

Default policy matrix:

| Provenance ↓ Severity → | Critical | High | Medium | Low |
|---|---|---|---|---|
| introduced-by-current-edit | block-edit | block-edit | require-fix | recommend-fix |
| **pre-existing-in-file** | **require-fix** | **require-fix** | **recommend-fix** | **backlog-only** |
| pre-existing-codebase | recommend-fix | backlog-only | backlog-only | ignore |

The aggressive defaults on the in-file row reflect [[feedback_fix_pre_existing_in_touched_files]]. Per-codebase findings are more conservative because surfacing 5,000 findings on every edit destroys the agent's context budget.

### 21.4 Per-codebase audit capability (local subset)

```bash
interlinked harness audit-codebase                  # Full audit, all lanes
interlinked harness audit-codebase --lane=security  # Security-only
interlinked harness audit-codebase --severity=critical
interlinked harness audit-codebase --since=<sha>    # Diff against historical baseline
```

Audit output: findings by category, severity, provenance. No brownfield onboarding wizard in this subset — that's v3.2 Phase 11.

---

*End of local-first subset. Re-read §16 before any fork-in-the-road decision. Re-read §15 before claiming this subset is comprehensive — by construction it isn't. Re-read §18 to remember that **build order matters** — Phase 0 is the substrate everything else depends on. For everything beyond Phase 3.7, see `docs/test-quality-harness-plan.md`.*
