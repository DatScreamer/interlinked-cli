# Coverage debt — pair-scoped per-edit TDD

**Status:** design + Phase-1/2 landing, 2026-06-25. Settled with the user across
the "agent shouldn't need workarounds to edit a source+test pair" thread.
Supersedes the per-edit-coverage *block* with a debt lifecycle; the
commit-time gate (`evaluator/commit-gate.ts`) remains the hard backstop.

## Why

The strict per-edit coverage gate (`coverage-write-guard.ts`) blocks the *first*
edit that adds an uncovered executable line. Because TDD is a two-edit
transaction (code + its test) and the gate judges one edit in isolation, the
agent is forced into atomic workarounds — `interlinked write --batch`,
whole-file manifests, the test-first-trips-tsc dance. That friction is the bug.
An agent should write source then test (or test then source) as two ordinary
edits and only be stopped if it **provably leaves code uncovered and then walks
away from it.**

## Principle

> **You may always make progress; you may not _bank_ uncovered behavior.**

"Bank" = move to unrelated work, or commit. Everything below is the mechanism
that makes that invariant deterministic and low-friction.

## Model — one obligation with a lifecycle

The agent carries coverage **debt**. It is event-sourced through the metric-
agnostic engine in `obligations.ts` (`open` / `discharge` / `escalate`
transitions, replay == live; the same single-source-of-truth shape as
`reservations.ts`). `coverage` is the first `kind`; `mutation` (cloud-async)
is the designed-in second.

| Lifecycle part | Definition |
|---|---|
| **Trigger (open)** | an edit adds **executable lines the suite doesn't cover** — exactly the signal the per-edit overlay already produces. |
| **Scope** | the source's *pair-stem* `{foo.ts, foo.test.ts}` (`pairStem()` strips a `.test`/`.spec` infix + extension). Edits inside the scope are always allowed. |
| **Discharge** | the suite **actually covers** those lines — verified by a coverage run (`source: "local" \| "observed"`). A touched-but-introverted test does NOT discharge. |
| **Nudge (surface 1)** | while debt is open, PostToolUse reminds: "cover `foo.ts` in `foo.test.ts` before moving on." |
| **Block (surface 2)** | a PreToolUse edit that **leaves the scope** while debt is open (a "wander"). |
| **Backstop** | commit / push blocked while any debt is open (`commit-gate.ts`). |

It is **one obligation, two surfaces** — a nudge while you carry it, a block only
when you try to bank it.

## Why this beats the literal rules it replaces

1. **Trigger on uncovered executable delta, not "source edited unless comment."**
   Comments, whitespace, type annotations, renames, and pure code-moves add zero
   executable lines, so they never open debt — the comment carve-out *falls out*
   of the real signal instead of being a special case, and it's strictly more
   correct (a comment-parser would still fire on a reformat or a type-only edit).
2. **Discharge is ground truth; scope is a heuristic.** Discharge is a real
   coverage run, so *any* test that covers `foo.ts` (including an integration
   test) closes it. Scope (`pairStem`) is only the *soft* "where may I freely
   edit" boundary, so its blind spots (`__tests__/` dirs, shared fixtures) can
   never cause a false block or false discharge.
3. **Boundaries, not windows.** The gate is *scope exit* + *commit*, not a
   tool-call counter — a Read or a same-file edit is not "moving on"; editing an
   unrelated file is.

## WIP policy (configurable — both modes ship)

`per_edit_coverage.debt_wip_limit` (default **1**):

- **(a) WIP = 1 (default, strict).** At most one open pair; the first edit
  outside it blocks. Coordinated multi-file changes use the existing batch
  escape. Cleanest invariant.
- **(b) WIP = N (relaxed).** Up to N open debts at once; scope-exit only blocks
  when you'd exceed N (and otherwise escalates the nudge). The hard stop is the
  commit backstop. More ergonomic for extract-helper-style changes.

`decideCoverageDebt` takes `wipLimit`; the call site reads the config.

## Symmetric test side (designed, not in the first cut)

A test edit that adds assertions but contributes **no coverage to its companion
source** opens a mirror debt (discharged when the test actually exercises the
SUT). That trigger is the existing `introverted_test` static signal, so it
reuses machinery rather than adding a parser.

## Mapping to code

| Piece | File | Status |
|---|---|---|
| Obligation engine (transitions, replay, descriptors) | `src/harness/obligations.ts` | landed (100% cov) |
| Canonical edit-pairs A–C (engine demo) | `src/harness/obligations-pairs.test.ts` | landed |
| Pair-scoped decision (`decideCoverageDebt`, `pairStem`, WIP) | `src/harness/coverage-debt.ts` | landed (100% cov) |
| Ledger I/O (`.interlinked/obligations.jsonl`) | `src/harness/obligation-ledger-io.ts` | Phase 2 |
| Call-site glue + nudge (behind `per_edit_coverage.debt_mode`, default OFF) | `src/harness/server/pre-tool-coverage-gates.ts` | Phase 2 |
| Config fields (`debt_mode`, `debt_wip_limit`) | `types/config.ts` + `rules/default-config.ts` | Phase 2 |

The wrapper, behind the off-by-default flag, derives the trigger from the base
gate's existing uncovered verdict (`isUncoveredBlock`), re-checks debted files'
coverage by reusing `checkCoverageWrite` on current disk, calls
`decideCoverageDebt`, appends the returned transitions, and surfaces the nudge.
No new coverage runner; the discharge re-check is the same overlay the gate
already runs.

## Build order

1. Engine + pair-scoped decision + canonical pairs. ✅ landed.
2. Ledger I/O + config fields. ← Phase 2a.
3. Call-site glue (PreToolUse block/allow + open/discharge) + PostToolUse nudge,
   `debt_mode` default OFF. ← Phase 2b.
4. Flip the flag in this repo; dogfood pairs A–C live. ← Phase 2c.
5. `interlinked debt list/show/resolve` inspection. ← Phase 3.
6. Mutation `kind` over the same ledger (cloud-async discharge). ← Phase 4.

## Red debt — the red-bar's twin (landed 2026-07)

The original scope stopped at the uncovered verdict: the red-bar
(`block_on_test_failure`) stayed STRICT, and its documented workflow was "write
the code and the test together in one `interlinked write --batch`". In practice
that forced agents into a scratchpad+batch dance for every behavior change
(source and tests must move together, so landing either alone was refused as a
"transiently-red state") — the exact too-soon blocking this doc's principle
("you may always make progress; you may not *bank* it") was written to end.

Red debt closes the gap by reusing the machine unchanged:

- **Kind** `red_suite` (registered descriptor: local/observed discharge,
  trajectory cadence, coverage's staleness default).
- **Open**: a red-bar verdict downgrades to ALLOW + opens the pair's red debt
  (`foldRedBar` in `coverage-debt.ts`); same-pair red iterations don't
  double-open. Landing the failing test FIRST is the canonical opener — the
  red→green loop is progress, not a violation.
- **Free while red**: any edit inside the pair (source or companion test).
- **Blocked while red**: wandering to an unrelated file (`blockForWander`, now
  kind-aware) — and the commit gate remains the ground-truth backstop.
- **Discharge**: optimistic, like every debt-mode discharge — ANY same-pair
  edit that LANDS with a non-red base verdict discharges the pair's red debt
  (`foldRedBar`). That includes verdicts produced WITHOUT a suite run: a
  pure-test-file edit (ungated plan → null verdict), a budget defer (null),
  and a loud degrade (allow-with-warnings) all read as non-red. This optimism
  is LOAD-BEARING — the happy path (a source edit whose overlay runs clean
  returns the same null verdict) rides the identical null-discharge — and the
  commit gate is the ground-truth backstop that actually re-runs the suite.
  A non-red verdict can also be an uncovered one, which then opens its own
  `coverage` debt on the same edit (red retired, coverage opened). The one
  non-red shape that does NOT discharge is a pass-through BLOCK (drop / floor /
  CRAP): the edit is refused, nothing lands, so the pair is exactly as red as
  before.
- **Off-switch**: `debt_mode: false` restores strict red blocking;
  `block_on_test_failure: false` removes red verdicts entirely.

`readOpenDebts` now nets both pair-scoped kinds, so the wander rule and the
WIP limit are shared across coverage + red debts. Regression suites:
`coverage-debt.test.ts` (pure fold) + `coverage-debt-gate.test.ts` (ledger
lifecycle, wander, mixed red→uncovered handoff, strict-mode preservation).
