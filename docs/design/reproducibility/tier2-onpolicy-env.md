# Tier 2 — Deterministic environment for on-policy rollout

**Status:** Design. **Effort:** 1–2 weeks (the expensive tier — build only if you need divergent rollout).
**Scope:** a sandbox runner that restores any step's world-state and lets a candidate take its **own** actions on-policy against real tools + the deterministic harness; toolchain pinning; cross-machine determinism proof.
**Depends on:** [G1](./g1-inference-capture.md), [G2](./g2-tree-snapshots.md), [G4](./g4-harness-determinism.md). **Also folds in G5** (toolchain pinning).

## When you need this (and when you don't)

Tier 1 answers "would the candidate make the same move here?" without executing.
Tier 2 answers "if the candidate takes over at step N and **diverges**, where does
it end up?" — a real rollout where the environment must respond deterministically
to novel actions. Needed for offline RL and multi-step behavior comparison; **not**
needed for the per-step model comparison in your original ask. Do Tier 1 + Tier 3
first; reach for Tier 2 only when single-step scoring isn't enough.

## Design

### The sandbox

A container with a **pinned toolchain** (this is G5): record every tool version
in a session manifest (`node`, `tsc`/`tsgo`, `biome`, `oxlint`, `vitest`,
`gitleaks`, `semgrep`, package-lock hash) at capture time; the sandbox image pins
them. Options: local Docker for dev; **Cloudflare Sandbox / Containers** for
scale + the cross-machine determinism proof.

Cloudflare mapping (from the skill roster):

| Need | Cloudflare piece |
|---|---|
| Execute candidate actions in isolation, pinned toolchain | **Sandbox SDK / Containers** |
| Per-step tree store, off-machine, git-compatible, deduped | **Artifacts** (G2's `post_tree` SHAs push here) |
| Deny/record egress so tool network is deterministic | **Sandbox outbound Workers** (see `cloudflare:sandbox-auth`) |

### Restore step N (the fork point)

1. **Filesystem** — G2 `restoreTree(pre_tree[N])` into the empty sandbox (`git archive` + CAS overlay).
2. **Harness state** — restore the daemon's state as of `seq=N` from **G2's
   per-step state archive** (`replay/state/<session>/<seq>.json.gz`). That
   archive exists precisely because nothing else does: `<id>.live.json` is
   overwritten per event and deleted at SessionEnd
   (`server/lifecycle-persist.ts:104`), and the baseline water-lines are NOT in
   the captured tree (`.interlinked/` is excluded from snapshots; the audit
   shows only large-files + untested-files baselines are even git-tracked —
   coverage/coverage-edit exist but are gitignored, mutation/metric-caps may be
   absent). Specifically:
   - trajectory: hydrate from the archived live-snapshot for `seq=N`.
   - reservations: **wire `replayTransitions`** (defined
     `reservations-state-machine.ts:187`, re-exported `reservations.ts:38`;
     audit-confirmed zero production call sites — all 8 invocations are tests)
     to rebuild the cache from `.interlinked/reservation-events.jsonl`
     (writer `server.ts:342,:350`) up to the `seq=N` cutoff (G3 stamps seq).
   - error-history / recurrence: append-only logs — replay to the cutoff.
   - baselines: from the state archive (above).
   - trigram/coverage index: derived — rebuild from the restored tree.
3. **Clock** — G4 `runWithClock` frozen to `event.ts_ms[N]` (and advancing deterministically per emitted action, not wall time).
4. **Network** — G4 cassettes for any on-path call; egress otherwise denied.

### Roll forward on-policy

- Teacher-force the prefix (steps `0..N−1` use recorded observations) to seat the candidate in context, then at step N hand control over: the candidate emits an action → the sandbox **executes it for real** (tool runs, harness evaluates with the frozen-then-advancing clock) → produces a genuine observation → feed back → loop until the candidate stops or a budget is hit.
- `interlinked replay rollout --session <id> --fork-at <seq> --candidate <model>` → records a new divergent trace (`replay-trace.v1` with `origin: "rollout"`).

### The honest limit

Novel actions hit **real** tools. Determinism holds only as far as the tools are
pinned + sandboxed. A test that reads the wall clock, a genuinely flaky test, or
an unpinned network dep can still introduce noise. **Bound it, don't claim
perfection:** run the pinned suite; flag any tool whose output isn't reproducible
across two identical rollouts (reuse the G4 driver's byte-diff) and quarantine it.
Reproducibility here is "deterministic modulo declared-flaky tools," logged
explicitly — never silently.

## Files to change / add

| File | Status | Purpose |
|---|---|---|
| `src/harness/replay/sandbox-runner.ts` | new | Restore + roll-forward orchestration. |
| `src/harness/replay/toolchain-manifest.ts` | new | Record/verify pinned tool versions (G5). |
| `src/harness/reservations.ts` | edit | Wire `replayTransitions` into a restore entry point. |
| `src/commands/replay.ts` | edit | `interlinked replay rollout`. |
| `containers/replay-sandbox/Dockerfile` (or Cloudflare Container config) | new | Pinned image. |
| `src/harness/replay/__tests__/sandbox-restore.test.ts` | new | See test plan. |

## Test plan

- Restore fidelity: restore `pre_tree[N]` → files byte-identical to capture; harness state (`seq`, trajectory counters, reservations) equals the recorded `seq=N` state.
- No-divergence identity: fork at N and replay the **recorded** actions → reach a `post_tree` byte-identical to the original session's `post_tree` (proves restore + determinism end-to-end).
- Divergence: fork at N with a candidate that makes one different edit → a valid new trace; a second identical rollout reproduces it byte-for-byte (modulo declared-flaky).
- Flaky detection: a deliberately clock-reading test is flagged and quarantined, not silently absorbed.
- Cross-machine: the no-divergence identity test passes local and in the Sandbox.

## Validation

- [ ] Fork-and-replay-recorded-actions reproduces the original `post_tree` chain byte-identically on the same machine.
- [ ] Same, cross-machine (Sandbox), modulo an explicit quarantine list.
- [ ] A divergent rollout is itself reproducible run-to-run.

## Open questions

1. Harness-in-sandbox: run the real daemon inside the sandbox, or a headless evaluator? Headless (`evaluator-replay-driver` from G4) is lighter and avoids the socket; prefer it unless a rollout needs full daemon behavior.
2. Prefix cost: teacher-forcing a long prefix each rollout is expensive — cache the restored context/kv where the backend allows.
3. Budget: max steps / wall-clock per rollout before abort (mirror the mutation-gate `budget_ms` discipline).
