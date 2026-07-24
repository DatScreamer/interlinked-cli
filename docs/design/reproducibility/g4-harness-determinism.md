# G4 — Harness-as-environment determinism

**Status:** Design. **Effort:** 3–5 days (the largest gap-closer).
**Scope:** an ambient `harnessNow()` clock; convert the ~10 decision-affecting time sites (audited 2026-07-24); sort the 7 `readdir` walkers; neutralize id-gen in the determinism comparison; a cassette for the one on-path network call; extend the determinism-conformance test pattern to the stateful path.
**Depends on:** [G3](./g3-event-ordinal.md). **Consumed by:** [Tier 2](./tier2-onpolicy-env.md).
**Adopts:** plan `docs/plans/free-cli-adoption/17-...md` §17.4 wholesale, and extends it to the stateful surfaces plan 17 scoped out.

## Problem

When the harness is active, its block/allow/warn decision is **part of the
observation** the model sees (a BLOCKED reason changes the next action). So
"reproduce the environment" requires the harness to return identical decisions
given identical inputs. It doesn't today:

- **~10 decision-affecting time branches** read the wall clock directly (audited 2026-07-24; the trajectory windows turned out to be event-driven already — see below). A verdict or an agent-visible warning depends on `Date.now()`.
- **7 `readdir` walkers** iterate in raw OS order, assigning trigram file-ids and building the project graph — machine-order-dependent.
- RNG is trivial (id-gen only) and network is nearly all off-path (the one exception is default-off).

The good news: the "checks must be deterministic" policy already made the check
layer pure, and `coverage-index`/`grep-index` staleness is content-hash/git-state
based, not mtime. The residue is the **stateful fringe** below.

## Goal

Make the harness a deterministic function of `(observed event stream, clock)`. In
replay mode, freeze the clock to each event's recorded time (`seq`-indexed) so
every time-branch reproduces its recorded verdict. Prove it cross-machine.

## Design

### Ambient clock (low blast radius — do NOT thread 13 signatures)

Use `AsyncLocalStorage` so sites change by one token, not by signature:

```ts
// src/harness/replay/harness-clock.ts (new)
import { AsyncLocalStorage } from "node:async_hooks";
const als = new AsyncLocalStorage<{ now: number }>();
export function harnessNow(): number { return als.getStore()?.now ?? Date.now(); }
export function runWithClock<T>(now: number, fn: () => T): T { return als.run({ now }, fn); }
```

At the event-loop entry (`src/harness/server-event-loop.ts`), wrap each event's
evaluation in `runWithClock(replayMode ? event.ts_ms : Date.now(), ...)`. The
recorded `event.ts_ms` is already parsed at
`src/harness/evaluator/pre-tool-helpers.ts:104-107`.

**Why ALS and not a module-global set/restore (settled during review):** the
daemon is per-connection serial but **cross-connection interleavable** — each
socket connection gets its own async data-handler + `LineFramer`
(`server-socket-lifecycle.ts:213-233`) with no global queue or mutex, and
`evaluateEventLine` awaits internally, so two connections' evaluations
interleave at await points (falsifier-confirmed: no serialization primitive
exists). A module-global clock would bleed between concurrent evaluations; ALS
isolates each logical evaluation.

Then each decision-affecting site swaps `Date.now()` → `harnessNow()` (and
`new Date()` → `new Date(harnessNow())`). No signature changes.

### The sites to convert (decision-affecting only — labels stay `Date.now`)

| Site | Gates |
|---|---|
| `src/harness/reservations.ts:114` (checkAndReserve), `:312-314` (getAll) | reservation-expiry prune → block/allow |
| `src/harness/error-history.ts:91-92`,`:191-196` | freshness window for the error-memory warning (def `evaluator/pre-tool-phases.ts:272`, wired `pre-tool-decision-phases.ts:474`) |
| `src/harness/evaluator/active-when.ts:122-125` | rule active-when skill-axis expiry |
| `src/harness/structural-checks-pre-context.ts:138-143` | `[interlinked:stale-read]` warning content |
| `src/harness/pattern-detector.ts:208-217` | frequency-window counts feeding `getPatternWarnings` (`:444`; wired `evaluator/pre-tool-phases.ts:16`,`:297`; the rendered warning uses the 1-hour count) |
| `src/harness/break-glass.ts:149`,`:152`,`:157` | recent-usage rollup window *(already injects a `clock` — unify)* |
| `src/harness/quality-checks/lockfile-drift.ts:57`,`:84`,`:91` | lockfile-drift grace window vs manifest mtime *(already injects `now`)* |
| `src/harness/async-finding-queue.ts:82`,`:104`,`:205`,`:210` | deferred-finding aging *(already injects `now`)* |
| `src/harness/cohort.ts:141-144` + `src/harness/server.ts:695-698` | lost-agent cutoff → **reservation auto-release** on the 2-min sweep (changes later conflict verdicts). *Corrected during review: the local-vs-remote label is pure `hasAgent` membership (`reservations.ts:118`, `cohort.ts:153-155`) and NOT time-dependent — an earlier draft claimed otherwise.* |
| `src/harness/trajectory/block-fingerprint.ts:70`,`:73` | block-fingerprint TTL dedup (`nowMs` param) |
| `src/harness/session-skills.ts:56-59`, `evaluator/active-when.ts:125` | skill/suppression marker expiry |

**Already deterministic — no conversion needed:** the trajectory windows
(`trajectory.ts:147`,`:213`,`:224`,`:280`) compare **event-carried `ts_ms`**,
not the wall clock (audited: zero `Date.now()` in `trajectory.ts`). The only
clock on that path is the missing-timestamp fallback at
`evaluator/pre-tool-helpers.ts:107` — convert just that fallback to
`harnessNow()`.

Sites that already take an injected clock (`break-glass`, `lockfile-drift`,
`async-finding-queue`, `coverage-write-guard.ts:76`, `commit-gate-suite.ts:39`,
`sponsor/runtime.ts:48`) should default their injector to `harnessNow` so
there's **one** clock.

### Sort the walkers

Add an explicit sort after each raw `readdir` that feeds an index/graph/decision:
`src/harness/trigram-git.ts:82-96` (assigns trigram file-ids — highest impact),
`src/harness/project-graph.ts:309`,`:447`, `graph-prediction-classifier.ts:110`,
`manifest-file-walk.ts:45`, `discovered-primitives-fs.ts:42`,
`coverage-shards/vitest.ts:303`. (`coverage-index/invalidation.ts:98`,`:117`
already sort — copy that pattern.) All seven audited: no `.sort()` exists
between readdir and consumption — the only sorts in those files serialize
posting lists (`trigram-index.ts:393`) or build a memo key
(`project-graph.ts:239`), neither reorders the walk; trigram file-ids are the
`fileEntries` array index over walk order (`trigram-index.ts:116-118`).

### RNG — neutralize in comparison, don't seed

The RNG sites (`failure-record.ts:23`,`:56` + the `mintFailureIdFromTimestamp`
helper `:89-101`; `daemon-client.ts:125`; `unified-event.ts:157`) are ids that
don't affect decisions — falsifier-swept: every other RNG-pattern hit in
`src/harness` is detector code scanning *user* code. Two options:
- **(recommended)** strip ids in the canonical comparison — extend
  `determinism-conformance.ts::canonicalizeFindings` (`:90`; `runInlinePipeline`
  `:41`, `CorpusItem` `:201`) to redact id-shaped fields, same as it already
  canonicalizes findings.
- (alternative) thread plan-17's `mulberry32(seed)`, `seed = sha256(session_id‖seq)`.
Recommend the first — less code, and ids genuinely don't matter to the verdict.

### Network — one cassette

Only the cloud mutation runner (`src/harness/mutation/cloud-runner.ts:55`, invoked
in `server/pre-tool-coverage-gates.ts:207-246`, awaited in the pipeline at
`pre-tool-pipeline.ts:355`) is synchronously on the block path, and it's
**default off** (`per_edit_mutation.enabled: false` — `rules/default-config.ts:414`). For deterministic replay
with it on, record a VCR cassette keyed by request hash under
`replay/cassettes/`; in replay mode, serve from the cassette, never the network.
Everything else (reservations server-confirm, telemetry, registry/OSV) is off the
decision path — no work needed.

### Prove it — extend the existing driver

`src/harness/determinism-replay-driver.ts` + its conformance test already run the
*pure check pipeline* in a fresh process under perturbed TZ/locale and byte-diff —
the actual fresh-process proof lives in
`__tests__/determinism-conformance.integration.test.ts:205-234` (spawn `:219`;
`TZ=Asia/Kolkata` + `LC_ALL=de_DE.UTF-8` env `:222`; the driver's own unit test
is in-process by design). Extend that pattern (or add a sibling
`evaluator-replay-driver.ts`) to run the **stateful evaluator** over a recorded
event stream with a frozen clock, and byte-diff the decision sequence:

1. in-process run vs fresh-process run (catches import-time / TZ / locale leaks),
2. **cross-machine** run (local vs Cloudflare Sandbox — the driver comment already names this as its purpose) → the real reproducibility proof.

This is plan 17's `replay-determinism.test.ts`, extended cross-machine (plan 17
declined cross-machine for its support goal; the RL-eval goal needs it).

## Files to change / add

| File | Status | Purpose |
|---|---|---|
| `src/harness/replay/harness-clock.ts` | new | `harnessNow` / `runWithClock`. |
| `src/harness/server-event-loop.ts` | edit | Wrap evaluation in `runWithClock`; set replay clock from `event.ts_ms`. |
| the ~13 sites above | edit | `Date.now()` → `harnessNow()`; unify existing injectors onto it. |
| the ~6 walker sites above | edit | Explicit `.sort()`. |
| `src/harness/determinism-conformance.ts` | edit | Canonicalize/redact id-shaped fields. |
| `src/harness/evaluator-replay-driver.ts` | new | Stateful-path fresh-process + cross-machine determinism driver. |
| `src/harness/replay/cassette.ts` | new | VCR for the mutation-runner call (only if `per_edit_mutation` is used in replay). |
| `src/harness/__tests__/harness-determinism.test.ts` | new | See test plan. |

## Test plan

- Frozen clock: with `runWithClock(T)`, a reservation whose expiry straddles `T` produces the same verdict on every run regardless of real time.
- Each converted site: unit test that the verdict depends on `harnessNow()`, not the wall clock (drive it with two clocks, assert the branch flips at the boundary).
- Walker order: build the trigram index twice with entries created in different FS order → identical file-id assignment (post-sort).
- Fresh-process byte-diff: recorded event stream → in-process decisions == fresh-process decisions under `TZ=Asia/Kolkata LC_ALL=tr_TR.UTF-8`.
- Cross-machine: same stream, local vs Sandbox → byte-identical decision sequence.

## Validation

- [ ] A recorded session replays with a byte-identical decision sequence on the same machine.
- [ ] Same session replays byte-identically in a fresh process under perturbed TZ/locale.
- [ ] Same session replays byte-identically on a different machine (Sandbox).
- [ ] No decision-affecting `Date.now()`/`new Date()` remains in `src/harness/**` outside `harness-clock.ts` (add a lint/grep guard, mirroring `@determinism-critical`).

## Open questions

1. Some sites are reached from non-`async` contexts where the ALS store may not propagate (sync callbacks scheduled outside `runWithClock`). Audit for ALS-context loss; those few may need explicit clock passing.
2. Is `per_edit_mutation` ever on during eval runs? If never, drop the cassette from v1.
3. The determinism guard (no raw `Date.now` in decision paths) — ship as a `pre_block` check or a verify-only check? Recommend verify-only first, promote after the conversion lands clean.
