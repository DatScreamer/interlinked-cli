# Monotonic metric ratchet — no session makes any metric worse

**Goal (user, 2026-06-12):** every change holds-or-improves coverage, CRAP, and
cyclomatic complexity — *ideally per tool call (trajectory-aware), at minimum by
end of session*. Built so a future fully-parallel mutation suite slots into the
same machinery (test-the-tests within ~25s, **all** results returned per edit so
a coding agent fixes them in one pass).

## The three metrics and how each is ratcheted

| Metric | Granularity | Baseline | Enforcement |
|---|---|---|---|
| **Cyclomatic** | per function | on-disk before-state | `complexity-write-guard.ts` — a uniquely-named function present before+after may rise by at most `SUB_CAP_RATCHET_TOLERANCE` (= 2) branches **per edit** while at/under the cap; a larger one-edit jump blocks. Any end-state over the absolute cap (`DEFAULT_MAX_CYCLOMATIC = 25`), plus new/anonymous/collision functions, are bounded by the cap (the over-cap path, unchanged). |
| **Coverage** | per file | `coverage-baseline.json` (high-water mark) | `coverage-write-decision.ts` — blocks an uncovered added line or a per-file coverage drop; baseline only ratchets up. |
| **CRAP** | per function | *implied* | CRAP = cyclomatic²·(1−coverage)³ + cyclomatic. Monotonically ↑ in cyclomatic, ↓ in coverage. It inherits the cyclomatic slew automatically — a bounded per-edit cyclomatic rise is a bounded CRAP rise, and a coverage drop is independently gated. There is no separate sub-cap CRAP ratchet: every CRAP gate (`decideCrap` block, `computeCrapRisers` advisory) fires only at/over the absolute cap (30), which bounds new/touched functions and is the end-state backstop. |

### Why "per tool call" is achieved, not just "by end of session"

The cyclomatic and coverage baselines are the **on-disk / high-water state**,
which already includes every prior edit this session. So checking each edit
against that baseline IS the trajectory-aware, cumulative check. For coverage,
there is no way to leave a file less covered than it has ever been this session,
because the worsening edit was blocked when attempted. For cyclomatic, the
per-edit slew tolerance relaxes strict monotonicity: a uniquely-named function
*may* creep upward by up to `SUB_CAP_RATCHET_TOLERANCE` branches per edit, and
across several edits can walk toward — but never past — the absolute cap, which
is enforced on every edit's end-state. So the invariant is "no function ever
exceeds the cap, and no single edit jumps one by more than the slew tolerance,"
rather than strict per-session monotonicity below the cap. The per-tool-call
check still implies the end-of-session **cap** guarantee; no separate session
snapshot is needed for the dominant case.

### Residual gaps (small, documented)

- **Anonymous / collision-named functions** have no reliable cross-edit identity,
  so they are bounded by the absolute cap only, not the sub-cap ratchet.
- **Intra-file coverage redistribution** (file coverage holds while one
  function's coverage drops and another's rises) could raise one function's CRAP
  without tripping the per-file coverage gate. Rare; the optional session
  backstop (below) is the belt-and-suspenders.
- **Cross-file aggregate** regressions are not summed per edit (each edit checks
  its own file). The session backstop covers this if/when built.

### Optional session backstop (designed, not yet built)

A Stop-event check that snapshots per-file metrics at session start and blocks
the stop if the net session worsened any aggregate — the explicit "at least by
end of session" floor for the residual gaps above. Deliberately the only Stop
check that *enforces* rather than reflects (an explicit exception to the
Stop-is-reflection rule, like the fail-closed crash gate).

## Collect-ALL-regressions contract (the mutation-extension seam)

The endgame: on a code edit, run every metric and return the **complete** list
of regressions in one decision, so a future agent fixes them all at once rather
than one-block-at-a-time. The shape every metric produces:

```ts
interface MetricRegression {
  metric: "cyclomatic" | "coverage" | "crap" | "mutation";
  file: string;
  symbol?: string;        // function/line/mutant locus
  detail: string;         // human-readable ("demo: cyclomatic 3 → 4")
  before?: number;
  after?: number;
}
```

A future **mutation** metric plugs in here unchanged: the per-edit overlay run
(coverage-runner.ts) already builds the apply-before-disk overlay and runs the
affected tests; a mutation pass mutates the edited file's functions, runs the
*same scoped affected-test set* against each mutant **in parallel** (the 25s
budget is wall-clock ≈ warmup + one covering-suite run, constant in mutant count
when fully fanned out), and emits one `MetricRegression{metric:"mutation"}` per
surviving mutant. Because selection is already scoped to the affected tests
(`coverage-test-selector.ts`) and the overlay is already built, mutation reuses
the entire substrate — it is "another metric in the same pass," not a new
pipeline. Keeping files small (the 800→500 line-cap ratchet) is what keeps that
per-edit mutation run inside the 25s budget.

**Status:** cyclomatic ratchet shipped + live (2026-06-12, proven on the daemon);
relaxed from strict-monotonic to a per-edit slew tolerance (`SUB_CAP_RATCHET_TOLERANCE = 2`,
2026-06-14) so small incremental growth toward the cap is allowed while big
one-edit jumps still block; coverage ratchet pre-existing; CRAP by implication.
Collect-all aggregation and the mutation metric are the next builds; this doc is
their contract.
