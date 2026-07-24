# G2 — Per-tool-call working-tree snapshots

**Status:** Design. **Effort:** 2–3 days.
**Scope:** new `src/harness/replay/tree-snapshot.ts` + `state-archive.ts`; wiring at `src/harness/server-event-loop.ts:232` (the per-event `finally` that calls `writeLiveSnapshot`); a shared CAS extracted from `scratchpad-archive.ts`.
**Depends on:** [G3](./g3-event-ordinal.md) (`seq` keys the snapshot). **Consumed by:** [Tier 2](./tier2-onpolicy-env.md) (restore), [Tier 1](./tier1-teacher-forced-eval.md) (diff context).
**Extends:** the session-start anchor from plan 11 WS-B — **already shipped** in the generated hook (`src/lib/hook-template-chunks/session-state.ts:1180-1198`, `git stash create` gated on `event_type === "session_start"`) — from session-boundary to per-call.

## Problem

No mechanism snapshots file contents at a tool-call boundary. `activity.jsonl`
holds sha256 fingerprints + line deltas; `file_edit`/`file_write` observations
store only `applied` + `result_message` (+ a null `provider_echo_ref`)
(`src/lib/collection/builder.ts:131-138`) — **not** post-edit content.
Working-tree content capture exists only at coarser granularity: the generated
hook records a `git stash create` anchor at **session start**
(`session-state.ts:1180-1198`), `session-git-baseline.ts:22` records path sets
(no content), and `checkpoints.ts:145` stashes at manual/session/task
boundaries. You cannot reconstruct the tree the model was looking at, at step N.

## Goal

Record a content-addressed identifier of the **complete** working tree
(tracked + index + untracked-not-ignored) immediately **before** and **after**
every tool call, keyed by `seq`, cheaply enough to run on every call, and
restore any snapshot into a clean sandbox for Tier 2.

## Non-goals

- Not a backup/checkpoint UX (that's `interlinked checkpoint`). This is machine substrate.
- No content in the hot log — snapshots are SHAs; bytes live in a store.
- Never mutates the user's working tree, index, or refs (see `git write-tree` note).

## Design

### Use git's object database as the CAS (tracked + index state)

`git write-tree` and `git stash create` write tree/commit objects to `.git`
**without touching HEAD, the working tree, or the stash ref**, and print a SHA.
git's object store is already content-addressed and deduped — a snapshot of an
unchanged tree costs nothing new. Plan 11 chose `stash create`; G2 standardizes
on the **temp-index `write-tree` flow as the single primitive** instead — it
also captures untracked files, has no empty-output edge on clean trees, and
(probed on this machine, 2026-07-24) isolates perfectly.

- **Pre-snapshot** (at PreToolUse, before the tool runs): capture current tree.
- **Post-snapshot** (at PostToolUse, after the result): capture again → `post_tree`.
  The next call's `pre_tree` should equal the previous `post_tree` (invariant to assert).

Capturing tracked + index + untracked in one tree, without disturbing state:

```
GIT_INDEX_FILE=$tmpindex  git read-tree HEAD          # seed a scratch index from HEAD
GIT_INDEX_FILE=$tmpindex  git add -A                  # stage tracked changes + untracked-not-ignored
GIT_INDEX_FILE=$tmpindex  git write-tree              # -> tree SHA (no ref, no worktree change)
```

`GIT_INDEX_FILE` pointed at a temp file means the real index is untouched.
`.gitignore` is honored, so ignored bulk is excluded automatically — **including
`.interlinked/` itself**, which must stay out (the harness socket lives there;
tree-copy of a live socket crashes, same failure mode Stryker hits per CLAUDE.md).

**Probe-verified (2026-07-24, this machine):** the captured tree contained the
tracked modification + the untracked file and excluded ignored dirs (including
`.interlinked/`); `git status` before/after was byte-identical; and `git add`
**silently skips sockets** (exit 0, absent from the tree) — a live socket in
scope is harmless. Measured cost on this repo (2,319 tracked files): seed
`read-tree` 39 ms; **cold `add .` 245 ms** (empty stat cache → full re-hash);
`write-tree` 47 ms; **warm `add .` 36 ms / warm `write-tree` 17 ms**. So keep
ONE persistent per-session index file
(`.interlinked/replay/snapshots/index-cache/<session>.gitindex`): seed once,
then every per-call snapshot rides the warm ~50 ms path.

### CAS for untracked/non-git bytes (fallback)

For non-git repos, or to also capture ignored-but-wanted files, reuse the
`scratchpad-archive` store. **Extract its blob core** into a shared module rather
than duplicating:

- New `src/harness/replay/content-store.ts` with `putBlob(destRoot, bytes) → sha256`
  and `putTree(destRoot, dir, budget) → ManifestEntry[]`, lifted from
  `scratchpad-archive.ts:188-193` (`archiveOneFile`) and `:221-253`
  (`archiveScratchpadDir`). Refactor `scratchpad-archive.ts` to consume it (keeps
  one CAS implementation; pinned by its existing tests).

### Snapshot index

```jsonc
// .interlinked/replay/snapshots/index.jsonl  — schema "tree-snapshot.v1"
{
  "schema": "tree-snapshot.v1",
  "session_id": "...",
  "seq": 42,
  "tool_use_id": "toolu_...",
  "phase": "pre",                 // "pre" | "post"
  "backend": "git",               // "git" | "cas"
  "tree": "<git-tree-sha>",       // when backend=git
  "manifest_ref": null,           // when backend=cas: snapshots/manifests/<seq>.json
  "untracked_count": 3,
  "capped": false                 // true if the dirty-tree cap skipped full capture
}
```

### Restore (Tier 2 needs this)

```
git archive <tree-sha> | tar -x -C <sandbox>        # tracked+index state, clean
# then overlay CAS untracked manifest if backend=cas
```

`git archive` reconstructs the exact tree into an empty dir with no `.git`
required at the destination beyond the object source. For Tier 2 the sandbox is
seeded from a bare clone + the snapshot objects (see Tier 2 spec).

### Wiring point

`src/harness/server-event-loop.ts:230-232` already calls `writeLiveSnapshot` on
every event. Add `recordTreeSnapshot(cwd, session, seq, tool_use_id, phase)`
adjacent to it (pre at PreToolUse dispatch, post at PostToolUse). Same
best-effort/never-throw contract as `live-snapshot.ts`.

### Minimal snapshot (first-spike version)

Same temp-index `write-tree` flow, minus chain-anchoring and caps: seed the
session index once, then per PreToolUse run `add . && write-tree` and record the
SHA into `snapshots/index.jsonl`. (`git stash create` was considered and
dropped: no untracked coverage, empty output on clean trees, and the agent-facing
guard blocks `git stash` under multi-agent sessions — one primitive everywhere.)

## Cost & caps

- Measured on this repo (2,319 files): warm per-call ≈ 50 ms (add 36 +
  write-tree 17); one-time cold seed ≈ 330 ms. Larger/dirtier trees still owe
  plan 11's open question 4 respect: above
  `replay.tree_snapshots.max_dirty_files` (default 1000) record path-list only,
  set `capped: true` (no silent truncation — mirror the scratchpad-archive
  skip-list discipline).
- **GC hazard — probe-verified real:** `git gc --prune=now` deleted an
  unanchored snapshot tree in testing. Anchor via a **snapshot chain**: after
  each `write-tree`, mint `git commit-tree <tree> -p <previous-snapshot-commit>`
  (message carries `seq`, `tool_use_id`, phase) and advance ONE ref,
  `refs/interlinked/replay/<session>`. A ref on the latest **tree** would NOT
  protect earlier trees (trees don't reference each other); the commit chain
  makes every snapshot reachable from the single ref — probe-confirmed (the
  commit+ref-anchored tree survived the same gc). Delete the ref when the
  session's replay data is deleted.
- The daemon runs these git commands via `child_process` — not through the
  agent hook path — so guard rules don't constrain the implementation.
  Agent-run probes/dogfooding must use pathspec adds: `git add <path>` and bare
  `git add .` pass the guard; `-A`/`--all` forms, and compound commands mixing
  `git add` with any `-p`-bearing token (`mkdir -p`, `--porcelain`,
  `rev-parse`), currently trip the interactive-add rule (FP reported
  2026-07-24).

### Per-step harness-state archive (new duty — Tier 2 depends on it)

The tree snapshot deliberately excludes `.interlinked/`, and nothing else
retains harness state historically:

- `<id>.live.json` is **overwritten in place** every event and **deleted at
  SessionEnd** (`src/harness/server/lifecycle-persist.ts:104`, after the
  trajectory archive) — no per-seq history exists.
- The ratchet water-lines are excluded from the captured tree **twice over**:
  `.interlinked/` is ignored as a whole, and per the audit only
  `large-files-baseline.json` + `untested-files-baseline.json` are git-tracked —
  `coverage-baseline.json` / `coverage-edit-baseline.json` exist on disk but are
  gitignored; `mutation-baseline.json` / `metric-caps.json` may be absent.

So at the same wiring point, also archive per step:
`replay/state/<session>/<seq>.json.gz` = `{ live_snapshot, baselines: {<the six
files, content-or-null>} }` — content-addressed through `content-store.ts` so
unchanged-state steps dedup to one blob (the common case; harness state changes
far less often than the tree). Tier 2's restore reads THIS, never `live.json`.

## Files to change / add

| File | Status | Purpose |
|---|---|---|
| `src/harness/replay/tree-snapshot.ts` | new | `recordTreeSnapshot`, `restoreTree`, the `GIT_INDEX_FILE` capture, ref-anchoring, cap logic. |
| `src/harness/replay/content-store.ts` | new | Shared CAS (`putBlob`/`putTree`) extracted from `scratchpad-archive.ts`. |
| `src/harness/scratchpad-archive.ts` | edit | Consume `content-store.ts` (no behavior change; keep tests green). |
| `src/harness/replay/state-archive.ts` | new | Per-step live-snapshot + baseline-file archive (section above). |
| `src/harness/server-event-loop.ts` | edit | Call `recordTreeSnapshot` + `recordStateSnapshot` at pre + post, adjacent to the per-event `writeLiveSnapshot` (`finally` at `:232`), behind `replay.tree_snapshots`. |
| `src/harness/replay/__tests__/tree-snapshot.test.ts` | new | See test plan. |

## Test plan

- Clean tree: `pre_tree` equals `git rev-parse HEAD^{tree}`.
- Dirty tracked change: `write-tree` SHA differs from HEAD tree; real index unchanged (`git status` identical before/after).
- Untracked file present: captured tree contains it; a gitignored file (`.interlinked/x`) is **absent**.
- Continuity invariant: for consecutive calls, `snapshot[n].post_tree == snapshot[n+1].pre_tree` when no out-of-band edit occurred.
- Restore: `restoreTree(sha, tmp)` reproduces byte-identical files (probe-verified via `git archive | tar -x` + `cmp`).
- Cap: a >max_dirty_files tree records `capped:true` + path list, does not hang.
- GC survival: `git gc --prune=now` after snapshotting does not drop chain-anchored trees (probe-verified: unanchored pruned, anchored survived).
- State archive: a per-seq state blob exists for each step; unchanged-state steps dedup to one blob; the six baseline files round-trip (content preserved; absent files recorded as null, not skipped).

## Validation

- [ ] A real edit session yields a `snapshots/index.jsonl` with pre+post per tool call, joinable to `activity.jsonl` by `seq`/`tool_use_id`.
- [ ] The user's working tree, index, and refs are provably untouched by snapshotting (dedicated test + manual `git status` audit).
- [ ] `.interlinked/` never appears in any captured tree.
- [ ] The per-step state archive restores a byte-identical live-snapshot + baseline set for any `seq`.

## Open questions

1. Retain-all vs windowed retention — per-call snapshots over long sessions could accumulate many refs. Default: retain all for a session, GC on replay-data deletion. Add `replay.tree_snapshots.retain_last_n` if disk becomes an issue.
2. Non-git repos: is CAS-backend worth shipping in v1, or git-only first? Recommend git-only for the spike; CAS fallback second.
