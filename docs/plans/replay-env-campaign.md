# CAMPAIGN — Reproducibility / RL-environment build (2026-07-24)

Implements `docs/design/reproducibility/` (audited specs). Owner: replay-env
session. Sibling `CAMPAIGN.md` belongs to another live session — do not merge.
Sequencing per README: G3 → G1 → G2 → T1 (then T3; G4/T2 later program).
Rules: each unit lands compiling + tested + daemon-restarted; tree committable
after each; NO commits without per-turn authorization.

| # | Unit | Status | Verified by |
|---|------|--------|-------------|
| 1 | G3 event ordinal: `SessionTracker.nextSeq` (counter map beside trajectory — types/session.ts is AT the 500 cap, so NOT on the interface; serialized as `last_seq`), mint in event-loop after recordEvent, stamped on activity/guard + collection records, `event_id` via legacy-client `copyDeliveryId` helper | **VERIFIED 2026-07-24** | event-ordinal.test.ts (9 cases) + 6 adjacent suites (170 tests) + typecheck + LIVE probe: post-restart records carry seq in activity+collection; concurrent sibling session got independent counter incl. guard_warn |
| 2 | G1 inference proxy: `src/harness/replay/{inference-store,sse-reassembly,inference-envelope,inference-proxy}.ts` + `interlinked replay capture\|status` (commands/replay.ts, registrars/replay.ts) + tsup entry `dist/harness/replay/inference-proxy.js` | **VERIFIED 2026-07-24** | 28 tests (store round-trip, SSE chunk-agnostic reassembly, credential-strip, capture contract, proxy integration vs mock upstream) + typecheck + LIVE smoke vs real api.anthropic.com (keyless 401 relayed byte-faithful; envelope captured; headers empty at rest) |
| 3 | G2 tree snapshots: `tree-snapshot.ts` (temp-index write-tree, warm per-session `.gitindex`, commit-chain anchor `refs/interlinked/replay/<session>`, `restoreTree`, `phaseForHookEvent` + env-gated `maybeRecordReplaySnapshots`) + `state-archive.ts` (live-snapshot + 6 baselines, sha-dedup gzip blobs) + event-loop finally wiring | **VERIFIED 2026-07-24** | 67 tests (isolation/ignores, chain-survives-gc, dedup, restore byte-identical, fail-open, gate on/off) + typecheck + LIVE: daemon restarted with `INTERLINKED_REPLAY_TREE_SNAPSHOTS=1`, probe caught its own pre at seq 114 with post(113).tree == pre(114).tree (continuity invariant in production), chain ref advancing, state blobs deduping. Gate env stays ON for this daemon. |
| 4a | T1 assembler: `trace-assembler.ts` (collection ⋈ envelopes ⋈ snapshots → replay-trace.v1; stamps session/seq onto joined envelopes; idempotent wholesale rewrite; degraded-not-dropped for envelope-less steps) + `interlinked replay assemble --session` | **VERIFIED 2026-07-24** | 5 assembler tests + 47 replay-surface tests + typecheck + LIVE: assembled THIS session → 579 steps, 14 with tree+state refs (post-G2-enable), 0 envelopes (runner not behind proxy — expected) |
| 4b | T1 scorers + candidate runner: `scorers/action-match.ts` (key-order-insensitive canonical input), `scorers/ast-edit-diff.ts` (createRequire TS load à la cyclomatic-ast; node-multiset distance, formatting-insensitive; argv multiset for Bash), `candidate-runner.ts` (thinking-strip default + model swap + stream-off; connect-capped cloud POST), `eval-runner.ts` (injectable, skip-and-count envelope-less steps) + `interlinked replay eval` | **VERIFIED 2026-07-24** | 18 scorer + 3 runner + 5 candidate tests (incl. mock-upstream integration); NLL deferred until a local logits backend exists (documented seam: `--base-url`) |
| 5 | T3 ledger + report: `eval-ledger.ts` (deterministic allocRunId, per-run JSONL), `eval-aggregator.ts` (pure, byte-deterministic, per-tool breakdown, nearest-rank percentiles), `interlinked replay report --run [--compare]` | **VERIFIED 2026-07-24** | 5 ledger + 3 aggregator tests incl. byte-determinism; renders wired |
| 6 | G4 determinism: `harness-clock.ts` (ALS `harnessNow`/`runWithClock`), event-loop replay mode (`INTERLINKED_REPLAY_CLOCK=event` freezes eval clock to event ts; live default unchanged), 12 decision-affecting `Date.now` sites converted (reservations ×3 incl. TTL write, error-history ×2, active-when, stale-read, pattern-detector, session-skills ×2, cohort lost-sweep, pre-tool-helpers fallback) + injected defaults unified (break-glass, coverage-obligation-ledger), 7 walkers byte-order-sorted (trigram-git, project-graph ×2, graph-prediction-classifier, manifest-file-walk, discovered-primitives-fs, coverage-shards/vitest) | **VERIFIED 2026-07-24** | 5 clock tests (ALS isolation under interleave) + 489-test behavioral sweep green (conversions behavior-neutral live; no order-pinned test broke) |
| 7 | T2 restore foundation: `toolchain-manifest.ts` (node/tools/lockfile-sha pinning), `sandbox-restore.ts` (`restoreSessionStep` = tree + live-snapshot + baselines materialized under dest/.interlinked/; `rebuildReservationCacheAt` — FIRST production consumption of `replayTransitions`, ts-cutoff until reservation-log seq lands) + `interlinked replay restore` | **VERIFIED 2026-07-24** | 2+4 tests + LIVE: forked THIS session at seq 114 — tree 97cc5adab3b3, 4 baselines, live snapshot last_seq=114, toolchain manifest recorded |
| 8 | First fully-enveloped episode (MANUAL step): start `node dist/harness/replay/inference-proxy.js`, launch a runner with `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`, work, then `replay assemble` + `replay eval --candidate <model> --limit N` | TODO (user-in-loop) | `replay status` envelope counts; eval ledger on real observations |
| 9 | T2 rollout driver (future program): sandbox exec loop over restored fork points (candidate acts → real tools respond → repeat), cross-machine determinism proof via the conformance-test pattern, flaky-tool quarantine | TODO (week-scale per spec) | no-divergence identity test: fork at N, replay recorded actions, byte-identical post_tree chain |

Deviations from spec (deliberate, revisit later):
- G1 proxy lives in `src/harness/replay/` (tested modules) + a tsup dist entry,
  NOT a self-contained `scripts/*.mjs` — testability beat duplication. Spike
  compression (gzip) deferred; envelopes are plain JSONL for now.
- G2 gate is env-var (`INTERLINKED_REPLAY_TREE_SNAPSHOTS=1`) not
  `replay.tree_snapshots` config — config plumbing (types + defaults +
  merge classification + parity test) lands when the knob stabilizes.
- G2 max_dirty_files cap deferred (warm cost measured ~50 ms on this repo;
  cap matters only for much bigger dirty trees).
- G3 `replay.event_ordinal` config knob SKIPPED — always-on (8 bytes/record; add
  an off switch only if someone needs it).
- G3 reservation-events.jsonl seq stamping DEFERRED to unit 3/T2 groundwork
  (ReservationLogEvent has no session context at the emit site; ts-cutoff
  suffices until reservation replay is wired).
- G3 timeline.jsonl seq stamping DEFERRED to unit 4 (assembler matches
  tool_use/tool_result records by tool_use_id — transcript records don't map
  1:1 to observed hook events at write time).
- Plan-17 `_replay/` dir reconciliation: recorder never built; doc-only note,
  no code.

Environment notes for resume:
- Sibling session's uncommitted harness work shares the tree (verify/*,
  check-registry/*, cyclomatic-ast.ts etc.) — my units touch disjoint files;
  re-check `git status` before each unit.
- Daemon restart activates BOTH sessions' built code. Overlay `$`-pattern +
  segment-scan guard fixes landed earlier today (all live).
- `interlinked harness test` does NOT route the destructive-guard layer — use
  real Bash probes for that family.
