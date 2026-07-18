# Plan: adopting the Dicklesworthstone test gauntlet into the local harness

**Status: plan, 2026-07-17.** Source taxonomy: `docs/design/test-category-adoption-from-the-wild.md`
(§3 June survey + §13 fresh sweep of 46 repos). Trajectory architecture:
`docs/design/trajectory-continuity-local-split.md`. Directives folded in:
per-edit tests are repo policy (quality > speed, budget 150s); placement
preference is **PreToolUse → PostToolUse → trajectory → SessionEnd**, and only
what cannot fit a local timeout window goes to the separate cloud plan (§8).
Single device, single agent. Deterministic pipeline only (no LLM judges here).

## 0. The timeout windows this plan fits into (verified against source 2026-07-17)

Client deadline = `hook-entry.ts::defaultTimeoutForPhase`. Hook grant =
`lib/hook-timeouts.ts` (only Pre/PostToolUse set; all others inherit Claude
Code's default). Values traced to source, not asserted:

| Surface | Daemon budget | Client deadline | Hook grant | Source |
|---|---|---|---|---|
| PreToolUse (code edit) | `budget_ms` 150s | 180s (`COVERAGE_EDIT_PRE_TOOL_TIMEOUT_MS`) | 240s | guard-rules.json:3; hook-entry.ts:282; hook-timeouts.ts:19 |
| PreToolUse (Bash/Read/Grep) | — | **5s** (`DEFAULT_LEGACY_PRE_TOOL_TIMEOUT_MS`) | 240s | legacy-client.ts:16 |
| PostToolUse | — | 60s (`DEFAULT_HOOK_TIMEOUT_MS`) | 120s | hook-entry.ts:61; hook-timeouts.ts:20 |
| Stop / SubagentStop | — | 60s | CC default (~60s, unverified) | hook-entry.ts:61 |
| SessionEnd hook | — | 60s | CC default (~60s, unverified) | hook-entry.ts:61 |
| **Commit gate (Bash `git commit`)** | full-suite scale | **5s ⚠ BUG** — Bash isn't in `EDIT_TOOL_NAMES`, so it gets the legacy 5s ceiling; the client cold-fallback-ALLOWS before any real suite finishes | 240s | hook-entry.ts:290,302 |

Invariant: daemon budget < client deadline < hook grant. **The commit-gate row
VIOLATES it** (5s client < full-suite daemon work): the outflow anchor this
whole plan leans on cannot deliver its verdict on any repo whose suite exceeds
5s. Pre-existing (the per-edit timeout work 2026-07-17 raised only the edit
lane); MUST be fixed before §5 commit-gate additions mean anything. Fix:
route a Bash `git commit`/`git push` to a commit-scaled client deadline
(mirror the edit lane — add a commit-detecting branch to
`defaultTimeoutForPhase`), and grant the commit path the 240s hook ceiling it
already nominally has. SessionEnd daemon-side async jobs remain unbounded
(hook returns immediately; the daemon keeps working — the scratchpad-archive
pattern), which is why §4's heavy batch lives there.

## 1. PreToolUse — the pre-disk gauntlet (target: everything that fits 150s)

**Already live** (the overlay runs the affected suite per edit): scoped
unit+integration with coverage · red/green debt lifecycle · CRAP · cyclomatic
cap+slew · line cap · TDD-new-file · secrets/SAST-lite · inline check families
(ubs-derived) · snapshot hygiene · baseline-integrity · supply-chain gates.

**Free by construction** (no build needed — they are just tests, and the
affected-set overlay already executes them when a repo has them; note in docs,
verify with fixtures): golden/snapshot tests · contract/schema-drift tests ·
metamorphic tests · round-trip tests · compile-fail suites (TS type-level
tests run under the suite) · TP/FP corpus tests · invariant suites.

**P0 builds (small, days):**
1. **Bounded-N property runs** — when the affected set contains property tests,
   inject the case-cap env into the overlay command (`PROPTEST_CASES`,
   `FAST_CHECK_NUM_RUNS`, hypothesis profile) so per-edit stays inside budget;
   record "capped-N" on the verdict; full-N escalates to the commit gate.
   (`coverage-runner-commands.ts` env injection + config knob.)
2. **Flake double-run of changed tests** — when the edit adds/changes test
   files, run the scoped suite twice (fits when scoped run ≤ ~60s; else
   defer the second run to PostToolUse async tail). Divergence ⇒
   `[interlinked:flake]` warning: "a retry-pass is still a flake signal."
3. **Test-integrity pre-blocks, completed** (June §9.1b; zero-FP, pure content):
   block introducing `.only`/`.skip`/`xit`/`#[ignore]`/`@pytest.mark.skip`;
   block deleting/emptying a test file while its prod pair changes in-window;
   shift the assertion-density drop from Post-ratchet to Pre-warn.
4. **Determinism ban-list extension** — port his clippy.toml bans to our static
   nondeterminism checks (`thread_rng`, `Uuid::new_v4`, bare `Date.now()`/
   `Math.random()` in test files), warn tier.
5. **UBS pattern refresh** — diff his current pattern set against our
   `checks/ubs-*` families; port the high-signal missing ones (≥3 pos/≥3 neg
   each; advisory first per repo convention).

**Deliberately NOT PreToolUse:** fuzz-smoke (60s eats the box next to the
suite — commit gate, §5) · micro-benches (variance under live load ⇒ FP
derailment — SessionEnd, §4) · anything needing an instrumented rebuild.

## 2. PostToolUse — the async tail + on-disk-only residue

1. **Formalize the async tail**: a Pre verdict that overflowed its window
   lands as `additionalContext` on the next event (async-findings channel
   exists; make overflow-verdict delivery a first-class path with the
   fingerprint of which edit it belongs to).
2. Flake double-run overflow (from §1.2) executes here when the scoped suite
   is 60–150s.
3. Existing Post passes stay (tsc+biome quality pass now has 120s to finish).
4. **Micro-perf advisory (later phase)**: touched-function criterion/tinybench
   micro-runs, warn-only, variance-aware (§6 e-process thresholds) — never a
   gate locally.

## 3. Trajectory — the cross-call unit (all local, μs; the continuity ladder)

Per `trajectory-continuity-local-split.md`: fingerprint store on every block →
seven workaround detectors born in shadow → one Stop line → the single outflow
block (workaround laundering at commit). Plus his cadence rules as windowed
checks: narrowest-proof-first (edits landing with no test run in K calls →
Stop nudge; verification-stop signals exist), fresh-eyes review cadence
(30–60 min → Stop suggestion), retry-shaping (minimally-mutated resubmission).
Derailment-budget telemetry gates every promotion. SessionStart preloads the
prior session's flags/debts/fingerprints (continuity across restarts).

## 4. SessionEnd — the idle-compute batch (daemon-side, unbounded)

Prerequisite: the **resource governor** (adoption doc §7 — job caps below
core count, background QoS via `taskpolicy -b`/nice, load pre-flight) so the
batch never fights the next session or the human.

Fire-and-forget daemon jobs at SessionEnd, results land as SessionStart
context + recurrence records + refreshed baselines:
1. Full suite + coverage refresh (feeds baselines, suite-runtime estimate,
   untested-file floor).
2. **Fuzz-smoke sweep**: run-if-exists fuzz targets, 60s each, deterministic
   seeds, frozen iteration budgets (his PR-smoke pattern); crashes recorded as
   recurrence + a SessionStart flag, never a mid-session surprise.
3. Bench snapshot with variance-aware thresholds (e-process, §6) — drift
   surfaces next session as information, not a block.
4. `recurrence scan --record` full-repo sweep.
5. **Evidence bundle** (proof-of-enforcement seed): the session's closeout in
   his Command/Artifact/Result(pass|blocked|degraded|not-run) shape — which
   gates ran, which deferred, which were skipped-honest.
6. Fingerprint/flag archive → SessionStart preload.
7. Flake-budget + calibrator updates (§6).

## 5. Commit gate — the outflow anchor (exists; additions)

Existing: full suite + coverage + CRAP + cyclomatic. Add:
1. **No-mock policy scan** — his `check_no_mock_policy` pattern as an inline
   check family (module-mocking bans with allowlist; we have `introverted_test`
   — this is its policy-tier sibling).
2. **Workaround-laundering block** (§3) — staged content matching a still-armed
   blocked fingerprint blocks with the provenance story.
3. Full-N property runs (uncapped) + fuzz-smoke on touched fuzz targets.
4. Flake budget enforcement (double-run divergences accumulated this session).
5. Claim/doc-drift, generalized: gen-facts markers (exist) toward a
   proof-lane-lite manifest — README claims tied to checkable facts.

## 6. Cross-cutting: statistical calibration (the anti-derailment layer)

Anytime-valid e-process / split-conformal thresholds over streaming local
evidence for every noisy signal (flake rates, perf drift, warn-rate anomaly,
fuzz-crash recurrence). Cheap math, no dependencies, replaces fixed cutoffs;
directly reduces the FP-derailment cost that makes agents restart. This is
the single most transferable piece of his statistical layer.

## 7. Sequencing

| Phase | Contents | Size |
|---|---|---|
| P0 | §1.1–1.5 (property-N cap, flake double-run, integrity pre-blocks, determinism bans, UBS refresh) | days |
| P1 | §3 trajectory: fingerprint store, detectors 1–4 shadow, Stop line, SessionStart preload, derailment telemetry | 1–2 wk |
| P2 | Resource governor + §4 SessionEnd batch (jobs 1, 4, 6 first) | 1–2 wk |
| P3 | §5 commit-gate additions incl. laundering block; §2 async tail | 1 wk |
| P4 | §6 calibrators; §4 jobs 2/3/5; §2 micro-perf advisory; doc-example runner | 2 wk |
| P5 | Cloud plan doc (§8) — authored, not built | days |

### 7.1 Shipped status (2026-07-17)

- **P0 — DONE + deployed (all five).** P0.2 flake double-run, P0.3
  test-integrity pre-blocks, P0.4 determinism bans (`rust_test_nondeterminism`),
  P0.5 UBS refresh. **P0.1 (bounded-N property runs) now BUILT** (was deferred
  as latency-only; built on request): `src/test-setup/property-budget.ts` is a
  vitest setupFile that caps `fast-check` numRuns from `INTERLINKED_PROPERTY_NUMRUNS`;
  `coverage-runner.ts::perEditBudgetEnv` injects the cap (25) for SCOPED
  (per-edit) runs only, so full / commit / CI runs keep their default numRuns —
  which also gives P3's "full-N property runs at commit" for free. (The
  coverage-runner was at the line cap, so its result helpers were extracted to
  `coverage-run-helpers.ts` to make room — a real modularity win.)
- **P1 — DONE + deployed + live-verified.** Fingerprint store + 4 workaround
  detectors (`block-fingerprint.ts`), session integration + choke-point glue
  (`block-fingerprint-session.ts`, wired in `server-event-loop.ts`), Stop line,
  and cross-restart archive/hydrate (`fingerprint-archive.ts`) with SessionEnd
  cleanup. Job 6 (fingerprint archive→preload) shipped HERE. **Divergence from
  "SessionStart preload":** hydration keys on session_id + first-event (not
  SessionStart-only), because the common restart is the build-refresh daemon
  handover (mid-session, fires no SessionStart) and the 15-min TTL makes
  cross-session fingerprint preload inert. Cadence extras (narrowest-proof,
  fresh-eyes, retry-shaping) + derailment telemetry: not yet.
- **UBS class-breadth — DONE.** `naive_datetime` (new class: temporal
  correctness) + `redos_catastrophic` (new class: algorithmic DoS) shipped, plus
  the P0.5 batch (`weak_random`, `archive_extract_traversal`,
  `python_assert_tautology`). `except:pass` already covered by
  `error-handling.ts`. `go_unchecked_error` + SSRF deferred to cloud (need
  type/taint) — see the cloud-remainder §2 table.
- **P2 — governor + jobs 4/6 DONE, job 1 deferred.** Resource governor
  (`resource-governor.ts`, pure + tested) is live: consulted + logged at every
  SessionEnd. Job 6 (fingerprint archive→preload) shipped in P1. **Job 4**
  (whole-repo recurrence scan) ships as a governed, detached, fire-and-forget
  background subprocess (`server/session-end-batch.ts`, `runSessionEndJobs`) —
  spawned only when the governor doesn't defer; `INTERLINKED_DISABLE_SESSION_END_JOBS=1`
  opts out; live-verified end-to-end. **Job 1 (coverage ratchet) now BUILT**
  alongside job 4 in the same governed job list — it was deferred over a
  baseline-lowering fear, but `compareCoverage` advances a baseline metric ONLY
  when flat-or-rising and holds the high-water mark otherwise, so it is
  raise-only by construction and safe to auto-run.
- **P3 — laundering block DONE (the centerpiece); other items deferred.**
  §5.2 **workaround-laundering block** ships (`evaluator/commit-laundering-gate.ts`,
  wired in `pre-tool-pipeline.ts` before the heavy commit gate) — it escalates the
  P1 shadow detectors to a BLOCK at the commit outflow, ZERO-FP by construction
  (reuses `runPreBlockRegistryGate` introduced-only, so a fixed commit never
  blocks; only a still-present violation of a rule that blocked THIS session,
  matched by armed fingerprint). Fail-open; `INTERLINKED_DISABLE_LAUNDERING_GATE=1`
  bypass. **The rest of §5/§2 are covered:** §5.1 no-mock — `checkMockingTheSUT`
  (+ `introverted_test`/`mock_only_test`); §5.3 full-N property runs at commit —
  falls out of P0.1 (the cap is scoped-only, so the unscoped commit run keeps full
  numRuns); §5.5 doc-drift — gen-facts markers + `docs:check`. **§2 async tail is
  ALREADY realized** by the coverage-obligation-ledger: `deferForBudget` catches a
  Pre check that overflows its budget, records a deferred obligation, surfaces it
  at Stop (`checkDeferredCoverage`), and ENFORCES it at the commit gate
  (`commit-gate-suite.ts`). That exceeds a Post async re-run (the obligation is
  enforced, not just surfaced), and Stop-surfacing (once/turn) is deliberately
  less derailing than nagging every PostToolUse. §5.4 flake budget is the P4
  calibrator (below).
- **P4 — calibrator DONE + wired live; remaining jobs repo-specific/deferred.**
  §6 **anytime-valid e-process** (`calibration/eprocess.ts`, pure + tested) — a
  fixed-alternative likelihood-ratio martingale; Ville's inequality gives valid
  alarms at ANY stopping time, so it replaces fixed cutoffs with no
  multiple-testing penalty. **Wired live** via its canonical consumer, the flake
  signal (`calibration/flake-calibrator.ts` → `server/post-tool-flake-phase.ts`):
  the single `[interlinked:flake]` warning fires on any divergence; the
  calibrated `[interlinked:flake-calibrator]` escalation fires ONLY when the
  flake RATE is statistically elevated (persistent per-repo e-process, re-arms
  after alarm, rolls at a window cap). That is the anti-derailment payoff — noise
  vs a real problem, decided validly. **Job 5 (evidence bundle) now BUILT**
  (`server/session-end-evidence.ts`, wired at SessionEnd) — an honest session
  closeout (files edited, tests run + pass/fail, warnings, verification observed)
  from OBSERVED signals only; `result` stays `unverified` unless a verification
  signal actually fired (never a false pass). **Jobs 2/3 (fuzz-smoke + bench) now
  BUILT** end-to-end: SessionEnd spawns governed, detached `npx vitest` runs
  (`server/session-end-heavy-jobs.ts` + `fuzz-targets.ts`) — fuzz targets detected
  by fast-check usage and run HARD (numRuns 500, recovering P0.1's traded depth);
  each writes its own json report; SessionStart reads them
  (`server/session-start-heavy-reports.ts`), surfacing fuzz failures (+ a
  `harness_missed` recurrence) and bench regressions vs a stored baseline
  (e-process-style threshold), then consumes the report. Run-if-exists +
  governed + `INTERLINKED_DISABLE_SESSION_END_JOBS=1` opt-out. **Doc-example
  runner now BUILT** (`harness/doctest.ts` + `commands/doctest.ts`, `interlinked
  doctest`) — extracts only `doctest`-tagged fences (safe opt-in) and runs them
  under bash, failing on non-zero exit. **Micro-perf advisory** was already
  covered by `checks/performance.ts` (10+ checks: `checkSpreadInReduce`,
  `checkStrlenInLoopCondition`, `checkJsonClonePattern`, …). **Every plan item is
  now built or confirmed-covered.**

House rules throughout: every check ≥3 pos/≥3 neg fixtures; advisory/shadow
first, promote on dogfood evidence; ratchet-shaped (block growth, allow
hold/shrink); fail-open on infra error; the harness runs suites, agents author
them (debt gate keeps forcing companions; nudge-if-missing for bespoke kinds
— "added a parser, no fuzz target").

## 8. The cloud remainder (seed for the separate remote plan)

Cannot fit local timeout windows or a single device, deferred wholesale:
fuzz campaigns (hours) · sanitizer matrices (ASan/TSan/Miri instrumented
rebuilds) · Loom/DPOR exhaustive interleaving · soak/stress/24h · live-oracle
differential at scale (pip-install-the-reference class) · cross-platform/arch
matrices · competitor benches on pinned hardware · formal-proof CI (Lean/TLA+)
· whole-suite mutation campaigns · LLM window-review judge (Tier 2/3) ·
RCH-style remote build offload · per-agent isolated forks (multi-agent).
Design anchors already exist: adoption doc §5.4/§6/§8 (Artifacts fork +
Sandbox fan-out, per-edit cost router, parity-or-bust single-sourcing).
