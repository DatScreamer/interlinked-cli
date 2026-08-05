# Multi-edit keep-vs-delete review — scheduled 2026-08-12

**Status:** deferred decision, awaiting execution
**Decided:** 2026-08-05 — delete, but not for one week
**Executed by:** cloud routine `trig_01D81bmfV4qWbt8NeRasDs3T` (one-shot, 2026-08-12 09:00 EDT)

This file is the routine's entire brief. It assumes zero context.

## The decision being revisited

`interlinked multi-edit` was slated for deletion on 2026-08-05. The deletion was
held for one week so its replacement could accumulate real-world mileage. That
week is up.

## Why it was slated for deletion

**It documents its own obsolescence.** `src/commands/multi-edit.ts` lines 11–15:

> This exists because the Edit tool applies one replacement at a time, and the
> tsc/biome diff-overlays check each intermediate state. Coordinated changes
> that cross multiple sites in one file … deadlock under serial Edits because
> one half of the change is invalid without the other.

That is a bypass lane around a gate this repo installs itself — not a capability
an agent would otherwise want.

**The gate stopped deadlocking.** `src/harness/transient-debt.ts` plus
`src/harness/evaluator/transient-debt-guard.ts` now *defer* that finding class:
the write is allowed, a transient debt opens, and the counterpart edit
discharges it. Verified live 2026-08-05 against the running daemon — a simulated
write adding an import of a not-yet-existing symbol returned `ALLOWED` with
`[interlinked:transient-debt] … Land that half next`.

**The usage record shows no compelling case** (measured 2026-08-05 over
`.interlinked/activity.jsonl` and `scratchpad-archive/`):

| Evidence | Result |
|---|---|
| Real invocations | ~40, **every one** via `--manifest <scratchpad file>` |
| Archived uses of the multi-file `batches` shape | **0** |
| Multi-file uses in live scratchpads | 4, all one session, all 2-file |
| Those 4 | union-member + `Record` key, config field + consumer — exactly what transient debt now allows |

**Its interface manufactured ephemeral writes.** `--manifest` takes a file path,
so every use staged a throwaway JSON manifest in a temp directory. ~20 of the
148 archived scratchpad artifacts are these manifests. (`--stdin` always
accepted the multi-file `{batches}` form with no temp file; the help text
wrongly claimed it needed a positional `<path>`, which is what drove the
file-staging. Fixed 2026-08-05.)

## Keep-side arguments — test these, do not assume they failed

1. **Fallback if transient debt has a hole.** It was days old at decision time,
   proven on one simulated case.
2. **Gate runs once, not N times.** A 6-file refactor pays the tsc/biome overlay
   once. Latency only.
3. **True all-or-none across files.** Transient debt lets a half-landed state
   exist on disk between edits; multi-edit never does. Git covers this.
4. **Already written and tested.** ~1,015 lines of passing tests, zero
   maintenance cost while nothing around it changes.

## Step 1 — gather evidence (report every item; skip none)

- [ ] Does `src/harness/evaluator/transient-debt-guard.ts` still exist, and is
      `applyTransientDebt` still called from
      `src/harness/evaluator/write-content-guards.ts`? **If it was reverted or
      disabled, STOP and recommend KEEP.**
- [ ] `git log --since=2026-08-05 --oneline` — any transient-debt revert, bug
      fix, or commit message describing a coordinated-edit deadlock? Each is
      evidence for KEEP.
- [ ] Production importers of `multi-edit*` outside `src/registrars/quality.ts`
      (dynamic import) and `src/commands/completions.ts` (a string)? There were
      **zero** on 2026-08-05.
- [ ] `npx vitest run src/harness/evaluator/transient-debt-guard.test.ts` —
      green?
- [ ] `npm run typecheck` and the full `npx vitest run` — baseline green before
      touching anything.

**You cannot see the local evidence.** `.interlinked/activity.jsonl`,
`ephemeral-writes.jsonl`, and `scratchpad-archive/` are gitignored and do not
exist in a cloud checkout. Say so explicitly in your report, and note that the
usage half of the argument rests on the 2026-08-05 measurement recorded above.

## Step 2 — decide

Delete only if **all** hold:

1. Transient debt is present, wired, and its tests pass.
2. No commit since 2026-08-05 indicates it was reverted, disabled, or worked
   around.
3. No new production importer of the multi-edit modules appeared.

Otherwise **KEEP** and report which condition failed. A keep is a legitimate
outcome, not a failure of this task.

## Step 3 — execute the deletion (only if Step 2 says delete)

1. Delete `src/commands/multi-edit.ts`, `multi-edit-apply.ts`,
   `multi-edit-manifest.ts`, `multi-edit.test.ts`,
   `src/commands/__tests__/multi-edit.test.ts`.
2. Remove the `multi-edit` command block from `src/registrars/quality.ts` and
   the `"multi-edit"` entry from `src/commands/completions.ts`.
3. Remove the `--batch` path from `src/commands/write.ts` and its registrar
   option — the second overlapping primitive for the same non-problem.
4. `src/registrars/quality.test.ts` pins the option list and **will fail** —
   update it.
5. Check these before assuming they are clean:
   - `isTscFindingBlocking` is only *re-exported* by `multi-edit-apply.ts`;
     canonical home is `src/harness/diff-overlay.ts:176`. Re-point importers.
   - `countOccurrences` in `multi-edit-apply.ts` duplicates
     `src/harness/edit-diagnostics.ts:219`. Deleting removes the clone; check
     nothing imported the multi-edit copy.
   - `atomicBatchWrite` had zero consumers.
6. Grep for the string `multi-edit` across `src/`, `docs/`, `skills/` and update
   every hit. Known: `skills/interlinked-verify/SKILL.md` (lines ~94–141),
   `docs/design/multi-edit-atomic-coordinated-edits.md` (mark superseded, do not
   delete the design record), `docs/generated/cli-reference.md` (regenerate with
   `npm run docs`).
7. The block message in `src/harness/evaluator/pre-tool-rules.ts` mentions
   `interlinked multi-edit --stdin` as the atomic escape hatch. If the command
   is gone, that clause must go too — steer entirely to sequential Edits and
   transient debt. `src/harness/evaluator/pre-tool-rules.test.ts` pins this
   message; update it.
8. `npm run typecheck && npx vitest run` must be green.
9. Open a PR titled `refactor: delete multi-edit — transient debt replaced its
   reason to exist`. Do **not** push to `main`.

## Step 4 — report

State the verdict, every evidence item with its result, what you changed, the
PR link, and anything you could not verify from a cloud checkout.
