# Coverage gate redesign — minimum-coverage floor over wander-lock

Status: proposal. Motivated by a dogfood failure on 2026-06-28 (below). Captures
the direction the user asked for: replace the pair-scoped **debt wander-lock**
with a permanent **minimum-coverage threshold** — only flag/block/warn when an
edit would take coverage *below* a committed floor, rather than blocking a
"wander" to an unrelated file.

## The failure that motivated this

While building the timeline-capture feature, the per-edit coverage gate blocked
**read-only `Read` calls** on files unrelated to any edit. Two compounding
layers:

1. **Read-gating false positive.** `Read` (and `Grep`/`Glob`) carries a
   `file_path`, but edits nothing — so the debt lifecycle treated it as a
   "wander" away from an open debt and false-blocked it. Found and fixed the
   same day in `coverage-debt-gate.ts` (the wander rule now skips read-only
   tools). The running daemon was still on the pre-fix compiled code, so it kept
   blocking until a rebuild + restart.

2. **Stale daemon config.** `.interlinked/guard-rules.local.json` already had
   `per_edit_coverage.enabled: false` (turned off for the `cloud/mutation-worker`
   campaign — a gitignored Cloudflare Sandbox entrypoint that can't be
   unit-tested locally). Had the live daemon read that config, the gate's fast
   path (`if (!enabled) return null`) would have made it a complete no-op. It
   fired because the daemon (started before those changes landed on disk) held
   stale config + pre-fix code.

Layer 1 is a check bug (already fixed). Layer 2 is an operational footgun
(a long-lived daemon drifting from on-disk config/code). But both point at a
deeper design problem in Layer 3 below.

## The deeper problem: the wander-lock is the wrong primitive

The pair-scoped debt lifecycle (`debt_mode`) blocks "a wander to an unrelated
file" until an opened coverage debt is discharged by editing the companion
test. The intent is good — *don't let an agent open an uncovered-code debt and
then walk away from it*. But the mechanism conflates two unrelated facts:

- **"File X has uncovered new lines."** A property of X.
- **"You may not touch file Y."** A constraint on *unrelated* work.

Coupling them means a single uncovered line anywhere freezes the agent onto one
file, and *any* tool touching another path (even a read) is collateral. It is
trajectory-stateful (so it drifts across sessions and daemon restarts), and the
escape hatch (edit the companion test) is wrong when the open debt belongs to a
file the current task legitimately shouldn't be testing right now (the
`cloud/mutation-worker` case).

## Proposed model: a permanent minimum-coverage floor

Replace the wander-lock with a **stateless, per-file (and/or per-project)
minimum-coverage threshold**, enforced purely on the edit in front of the gate:

- Each cappable file has a committed coverage **floor** (a water-line, like the
  existing `coverage-baseline.json` high-water marks — see
  `docs/design/baseline-integrity-gate.md`). Default floor = the project
  minimum (e.g. the `min_coverage` already in the metric caps).
- On a Write/Edit, compute the file's coverage **after** the edit (the same
  apply-before-disk overlay the current gate already builds).
  - **≥ floor →** allow, no matter what other files exist or what was edited
    before. No trajectory, no wander concept.
  - **< floor →** the configured action: `warn` (advisory), `ask`, or `block`.
    The message names the specific uncovered lines and the floor — actionable
    on *this* file, never "go edit some other file first."
- New files start exempt until they have a companion test, or start at the floor
  (configurable) — they cannot silently lower the project floor.
- The floor only ratchets **up** (tightens), enforced by the existing
  baseline-integrity gate, so the guarantee is monotonic: *no edit leaves any
  file below its established coverage floor.*

### Why this is better

- **No collateral blocking.** Editing (or reading) an unrelated file is never
  blocked by another file's coverage. The gate's scope is exactly the file being
  edited.
- **Stateless.** No per-pair debt ledger, no trajectory that drifts across
  sessions/restarts — the decision is a pure function of (edited file, floor,
  post-edit coverage). The Layer-1 read-gating class cannot recur, because a
  read changes no file's coverage and so is never evaluated.
- **Honors the same north star.** "~100% coverage, ratcheted" is preserved as a
  *floor that only rises*, rather than as a *lock that blocks adjacent work*.
- **Per-repo escape valve stays sane.** A path like `cloud/mutation-worker/`
  that can't be unit-tested locally gets floor `0` (or an exemption glob), not a
  global `enabled: false` — the rest of the repo keeps its floor.

### What carries over

- The apply-before-disk overlay + affected-test selection (already built in
  `coverage-write-guard.ts`) computes post-edit coverage — reuse it.
- The floor is a committed water-line governed by the baseline-integrity gate
  (`docs/design/baseline-integrity-gate.md`): may only tighten, never loosen.
- `coverage-baseline.json` high-water (per-file, may only rise) and the floor
  are complementary: the high-water says "don't regress from where we are," the
  floor says "never below this absolute line." A repo can run either or both.

## Migration

1. Land the floor gate alongside `debt_mode` behind a config switch
   (`per_edit_coverage.mode: "floor" | "debt"`), default `debt` initially.
2. Seed per-file floors from current coverage (so day one is a no-op).
3. Flip the default to `floor`; delete the debt ledger + wander-lock once no
   repo depends on it.

## Operational footgun (Layer 2) — separate fix

Independently of the redesign: a long-lived daemon should not silently run with
stale config/code. Options (not blocking this proposal): re-read
`guard-rules*.json` on each event (already hot-reloaded for rules — extend to
`per_edit_coverage`), and/or surface a startup banner when the compiled daemon
build predates the newest `src/harness` mtime. The standing workaround is the
one used here — `npm run build && interlinked harness restart`.
