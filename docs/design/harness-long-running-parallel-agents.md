# Harness optimization for long-running + parallel agent processes

**Status: measured 2026-07-17; priorities re-set same day (see below); the
gate-composition track is SHIPPED, the latency tiers are deprioritized.**

## Priorities update (2026-07-17, user directive)

Quality, testability, and cleanliness of the produced code outrank agent-session
latency — slower gates are acceptable, even desirable, when they buy better
code. Consequently T1–T3 below (edit-gate latency, hook-client boot, parallel
throughput) are **deprioritized**, retained as reference. What shipped instead,
same day (the gate-composition fixes from the live workaround incident):

- **Ownership-scoped debt focus** — only debts the SAME session opened can
  block its wander; a foreign session's debt surfaces as a once-per-session
  heads-up note (`coverage-debt.ts::resolveWander`,
  `coverage-debt-foreign.ts`). Unattributable owners warn, never block.
- **One product-code domain definition** — root `scratch/` joined
  `.interlinked/` in the canonical `isCappableFile` predicate, and the debt
  gate now consults that same predicate (`coverage-debt-gate.ts`), ending the
  scratchpad-guard ↔ debt-focus disagreement that pushed a compliant agent
  into a side channel.
- **Narrowed in-band escape** — the wander block message names only the
  scoped `debt_wip_limit` lever; the whole-mode `debt_mode:false` flip is
  repo-owner documentation, no longer advertised to the gated party.
- **Inline-exec visibility** — `node -e` / `python -c` / piped-heredoc Bash
  after a debt block is counted per session and reflected once at Stop
  (`debt-evasion.ts`); warn-only by design (zero-FP pre_block contract).
- Line-cap decompositions forced en route: `code-line-count.ts` and
  `coverage-pairing.ts` extracted (re-exported; import paths unchanged).

Follow-ups surfaced, not yet done: `large-file-policy.ts:~392` contains a raw
NUL byte in the `OVER_CAP_SENTINEL` literal (breaks rg binary-detection and
exact-match editing — normalize to the `\0` escape); budget-defer obligation
rows are recorded for `scratch/` files (pre-predicate-fix noise, now stops
accruing); the deployed-but-unwired `.mjs` activity-sync path and dead
`ApiClient.postHookEvent` (see conversation 2026-07-17).

### Per-edit test runs pinned ON (2026-07-17, same-day follow-up)

The user's directive sharpened: tests must run **per edit**, guiding the agent
mid-session — deferring enforcement to `git commit` "defeats the entire
purpose", and added latency is acceptable. Shipped as a three-layer chain
whose ordering is the invariant (**budget < client failsafe < hook grant**):

| Layer | Value | Where |
|---|---|---|
| Daemon per-edit budget | `budget_ms: 150_000` | `.interlinked/guard-rules.json` (committed policy; default was 25s) |
| Dist-client edit deadline | 180s (was 30s) | `hook-entry.ts::COVERAGE_EDIT_PRE_TOOL_TIMEOUT_MS`; non-edit ceiling 5s → 60s |
| Claude Code hook grant | PreToolUse 240s / PostToolUse 120s | `lib/hook-timeouts.ts` (single source) → adapter fragment + legacy installer |

Verified live: a leaf-file edit ran a real 19.3s overlay suite and the verdict
arrived through the dist client (`scratch/verify-per-edit-run.mjs`). The
budget now *means* "the largest per-edit verdict the pipe can deliver": runs
whose rolling estimate exceeds it (pathological full-suite fallbacks, ~285s+)
still defer to the commit gate — everything deliverable enforces per edit.
Known follow-ups: no overlay concurrency cap yet (parallel editing sessions
each trigger runs — CPU + transient-RSS stack), and a session started before
this change keeps its old 60s hook snapshot until restarted.
All numbers measured live on this repo (M-series mac, warm daemon, ~2.1k source
files). Re-runnable probes: `scratch/measure-hook-path.mjs`,
`scratch/measure-daemon-rt.mjs`.

## Measured baseline

| Component | Measured |
|---|---|
| Native binary spawn floor (`/usr/bin/true`) | ~2ms p50 |
| Node interpreter boot (`node -e ''`) | ~79ms p50 |
| One hook event, cheap tool (Bash Pre or Post) | ~111ms p50 |
| Agent-visible overhead per cheap tool call (Pre+Post) | ~220ms |
| Daemon socket round-trip (Bash event) | 0.9–1.2ms p50; p99 2.6ms fresh → 6.5ms after 2 days |
| Edit PreToolUse, hub file, novel content | 27.0s (old build) / **30.1s new build — hit the client deadline, verdict lost** |
| Edit PostToolUse quality pass (tsc+biome) | 1.8–5.1s (5s cap) |
| Immediate identical re-edit | 0.7s (completed run's refreshed coverage state; no re-run) |
| Full-suite estimate (`.interlinked/coverage-runtime-estimate.json`) | 25.3s |
| Daemon RSS | 137MB baseline (index removed; 276MB with) → **967MB transient during overlay** → settles ~131MB |
| Plain `rg` full-repo scan | ~18ms (why grep acceleration is moot at this scale) |

## What the 27–30s is NOT

It is **not mutation testing**. The Edit-gate latency is the per-edit
**coverage** gate: a local vitest run under v8 coverage
(`defaultJsTestCommand`, `coverage-runner-commands.ts`). The per-edit
**mutation** gate (`src/harness/mutation/`) is separate scaffolding: config
`per_edit_mutation` defaults **off**, no `.interlinked/guard-rules*.json`
exists to enable it, no `runner_url` is configured (`mutation/gate.ts:36` —
"absent → no runner → honest not-measured"), and no `mutation-manifest.json` /
receipts exist. The Cloudflare-Worker runner is the *design* for that gate
(private `interlinked-cloud` repo) and is not wired here. Nothing on the edit
path runs in the cloud today.

## Findings

- **F1 — the edit gate is the whole latency budget.** `selectAffectedTests`
  is provably-complete-or-null (`coverage-test-selector.ts:186`); hub files
  (e.g. `evaluator.ts`) return null → full-suite fallback → 25–30s. On the
  current build the run crossed `COVERAGE_EDIT_PRE_TOOL_TIMEOUT_MS = 30_000`
  (`hook-entry.ts:273`): the client timed out with **no verdict delivered**
  while the server run completed anyway. Worst case is 30s burned for nothing
  (the immediate retry then costs 0.7s off the refreshed state).
- **F2 — cheap tool calls pay ~220ms, 72% of it node boot**, twice per tool
  call. Multiplies across parallel agents and thousand-call sessions.
- **F3 — the event loop stays healthy under overlay load.** During an active
  overlay window (RSS at 967MB), concurrent Bash-event RT held p50 ~1.0–1.1ms
  across 5×300-event rounds (worst round p99 6.6ms — CPU contention from
  vitest workers, not serialization). The async-spawn design
  (`coverage-runner.ts:43-46`) does its job. Remaining parallel risk: no
  overlay concurrency cap found on the write-guard path — N concurrently
  editing agents ⇒ N full vitest suites.
- **F4 — overlay memory is a transient, not a leak**: +~750MB in-daemon per
  run, fully released afterward. Parallel overlays stack transients under
  `--max-old-space-size=4096`.
- **F5 — longevity seams observed live this session:**
  - `harness restart` raced the hook self-heal → two daemons for one repo,
    raw socket lost until manual convergence. Needs singleton fencing.
  - Session/trajectory state is in-memory only → lost on every build-refresh
    handover (frequent during active development).
  - Aged-daemon tail: p99 6.5ms at 2 days vs 2.6ms fresh (minor).
  - The debt-focus gate (WIP) blocked an unrelated `scratch/` probe write
    while `spec/ledger.ts` debt was outstanding — intended focus enforcement,
    but long-running multi-task agents will trip it; the escape is config-level,
    not per-write.
  - Steady-state RSS hygiene is good: ~3MB growth over 2 days; caches are
    capped/evicted (FileContentCache cap+TTL, SessionEnd cleanup, lost-session
    sweep).

## Plan

**T1 — edit-gate latency (dominant; 100× everything else)**
1. *Deadline-aware policy:* both inputs are known before spawning (selection
   fell back to full suite; `suite_ms` estimate ≥ client budget). Don't
   run-and-lose: either return advisory immediately, or run async and deliver
   the verdict as a next-event warning (async-findings channel already exists).
2. *Warm runner:* persistent vitest worker/pool to amortize per-run boot.
3. *Explicit overlay result reuse* keyed by (file, content-hash) so the
   block→fix→retry loop never re-pays a completed run.
4. *Capped-narrowing advisory mode* for full-suite fallbacks (nearest-N tests
   by import distance) — trades provable completeness for latency; keep the
   strict run for the commit gate.

**T2 — hook client boot (~220ms → ~10–40ms per tool call)**
Native static client (stdin → UnifiedHookEvent → socket RPC → encode, plus the
cold-fallback subset), node client kept as fallback. Low-effort intermediate:
bun (~15–25ms boot).

**T3 — parallel-editing throughput**
Overlay semaphore (1–2 concurrent; queue + coalesce identical pending
requests), `--maxWorkers` cap when >1 session is active, stream/dispose parse
state to cut the 967MB transient.

**T4 — longevity & handover**
Singleton daemon fencing (bind-first-wins + stale-pidfile takeover);
serialize session state across build-refresh handover (live-snapshot infra
exists); memory watchdog (idle-time self-restart above threshold).

**T5 — done 2026-07-17:** trigram index data removed (−139MB resident; code
intact; `interlinked index build` restores; grep acceleration was never
functional here — no rg binary visible to the daemon, and native rg full-scans
in ~18ms anyway).

## Non-goals

- Rewriting the daemon in Rust for latency: the daemon is ~1% of the hook
  path. The memory argument weakened once the index block was removed and the
  overlay peak proved transient.
- Re-enabling grep acceleration at this repo's scale.
